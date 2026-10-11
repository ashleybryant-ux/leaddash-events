/**
 * Regression tests for sponsor and exhibitor money fixes: payments recorded
 * once, orders never lost, the pay link and the scheduled charge never both
 * collecting, holds, refunds, uploads and pass holders.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { freshDb, caller, setupEvent, outbox, getDb, schema, addAttendee } from "./helpers";
import { ENV } from "../server/_core/env";
import { setStripeClient, type StripeLike } from "../server/areas/registration/stripe";
import { handleStripeEvent, mayBeFramed } from "../server/areas/registration/http";
import { runVendorCharges } from "../server/areas/registration/vendorCharges";
import { completeBalance, completeCheckout } from "../server/areas/registration/vendorCheckout";

// Lets a test make every email send fail (one failure must never stop a webhook).
const mail = vi.hoisted(() => ({ fail: false }));
vi.mock("../server/_core/email", async (orig) => {
  const real = await orig<typeof import("../server/_core/email")>();
  return { ...real, sendEmail: async (m: Parameters<typeof real.sendEmail>[0]) => (mail.fail ? Promise.reject(new Error("SES is down")) : real.sendEmail(m)) };
});

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")}`;

function fakeStripe() {
  const fake = {
    accounts: { retrieve: vi.fn(), update: vi.fn(), listExternalAccounts: vi.fn() },
    oauth: { token: vi.fn(), deauthorize: vi.fn() },
    checkout: {
      sessions: {
        create: vi.fn(async (..._args: unknown[]) => ({ id: `cs_test_${Math.random().toString(36).slice(2)}`, client_secret: "cs_secret_vendor", expires_at: Math.floor(Date.now() / 1000) + 3600 })),
        retrieve: vi.fn(async (id: string, ..._rest: unknown[]) => ({ id, status: "open", payment_status: "unpaid", client_secret: "cs_secret_vendor" }) as Record<string, unknown>),
        expire: vi.fn(async (id: string, ..._rest: unknown[]) => ({ id, status: "expired" })),
      },
    },
    paymentIntents: {
      retrieve: vi.fn(async (id: string, ..._rest: unknown[]) => ({ id, payment_method: { id: "pm_card_1", type: "card", card: { brand: "visa", last4: "4242" } } })),
      create: vi.fn(async (..._args: unknown[]) => ({ id: "pi_balance_1", status: "succeeded" }) as Record<string, unknown>),
    },
    setupIntents: { retrieve: vi.fn() },
    refunds: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  };
  setStripeClient(fake as unknown as StripeLike);
  return fake;
}

async function setup() {
  const s = await setupEvent({ orgName: "Sample Organization" });
  const db = getDb();
  db.insert(schema.stripeAccounts).values({ orgId: s.org.id, accountId: "acct_test_1", businessName: "Sample Organization", chargesEnabled: true, payoutsEnabled: true }).run();
  const ticket = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, s.event.id)).all()[0];
  db.update(schema.ticketTypes).set({ active: true }).where(eq(schema.ticketTypes.id, ticket.id)).run();
  const pk = (name: string, priceCents: number, quantity: number | null, passes = 2) =>
    s.admin.network.packages.save({ eventId: s.event.id, name, kind: "sponsor", priceCents, quantity, passes, passTicketTypeId: ticket.id, includesBooth: false, logoSpots: { welcome: false, topOfList: false, sessionPages: false }, benefits: [] });
  const gold = await pk("Gold", 1_000_000, 1);
  const silver = await pk("Silver", 500_000, 10);
  await s.admin.registration.vendorCheckout.admin.saveSettings({
    eventId: s.event.id,
    kind: "sponsor",
    open: true,
    closesOn: null,
    title: "Sponsor",
    intro: "",
    packageIds: [],
    payFull: true,
    payDeposit: true,
    payInvoice: true,
    methods: "card",
    depositPercent: 50,
    balanceDueOn: "2027-03-01",
    invoiceHoldDays: 14,
    agreementTemplateId: null,
    notifyEmail: "events@example.org",
  });
  return { ...s, ticket, goldId: gold.id, silverId: silver.id };
}

const buyer = (extra: Record<string, unknown> = {}) => ({
  company: "Brightpath Health",
  firstName: "Alex",
  lastName: "Morgan",
  email: "alex@example.com",
  phone: "(555) 555-0190",
  people: [{ name: "Alex Morgan", email: "alex@example.com" }],
  ...extra,
});

const ev = (type: string, obj: Record<string, unknown>, account = "acct_test_1") => ({ id: `evt_${Math.random()}`, type, account, data: { object: obj } }) as unknown as Stripe.Event;

async function buy(s: Awaited<ReturnType<typeof setup>>, payOption: "full" | "deposit" | "invoice", packageId = s.goldId, b = buyer()) {
  const pub = caller(null);
  const prep = await pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", packageId, buyer: b, payOption });
  const res = await pub.registration.vendorCheckout.start({ slug: s.event.slug, kind: "sponsor", token: prep.token, payOption });
  const c = getDb().select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.doneToken, prep.token)).get()!;
  return { prep, res, c };
}

const vendorOf = (company = "Brightpath Health") => getDb().select().from(schema.vendors).where(eq(schema.vendors.company, company)).get()!;
const paymentsOf = (vendorId: number) => getDb().select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, vendorId)).all();

/** A paid deposit: the sponsor owes the rest on Mar 1, 2027, charged to a saved card. */
async function depositSponsor(s: Awaited<ReturnType<typeof setup>>) {
  const { c } = await buy(s, "deposit");
  await handleStripeEvent(ev("checkout.session.completed", { id: c.stripeSessionId, payment_status: "paid", payment_intent: "pi_dep", customer: "cus_1", amount_total: 500_000 }));
  return vendorOf();
}

describe("sponsor and exhibitor money fixes", () => {
  let stripe: ReturnType<typeof fakeStripe>;
  beforeEach(async () => {
    await freshDb();
    ENV.platformFeeCents = 0;
    ENV.platformFeePercent = 0;
    mail.fail = false;
    stripe = fakeStripe();
  });
  afterEach(() => vi.useRealTimers());
  afterAll(() => setStripeClient(null));

  it("records a pay link payment once when the webhook and the returning buyer arrive together", async () => {
    const s = await setup();
    await buy(s, "invoice");
    const v = vendorOf();
    const session = { id: "cs_pay_1", payment_status: "paid", payment_intent: "pi_pay_1", customer: "cus_9", amount_total: 1_000_000, metadata: { leaddash_vendor_pay: String(v.id) } };
    stripe.checkout.sessions.retrieve.mockResolvedValue({ ...session, status: "complete" });
    const results = await Promise.all([
      handleStripeEvent(ev("checkout.session.completed", session)),
      caller(null).registration.vendorCheckout.payInfo({ slug: s.event.slug, v: v.payToken!, sessionId: "cs_pay_1" }),
      completeBalance(v.id, session as never, "acct_test_1"),
    ]);
    expect(paymentsOf(v.id)).toHaveLength(1);
    expect(vendorOf().paidCents).toBe(1_000_000);
    expect((results[1] as { justPaid: boolean }).justPaid).toBe(true);
    // The database itself refuses a second row for one session.
    expect(() =>
      getDb().insert(schema.vendorPayments).values({ eventId: s.event.id, vendorId: v.id, amountCents: 1, stripeSessionId: "cs_pay_1" }).run()
    ).toThrow();
  });

  it("finishes an order that was claimed but never created, and never loops on a failed bank payment", async () => {
    const s = await setup();
    const { c } = await buy(s, "full");
    // The old code could crash here: the checkout says paid but has no sponsor.
    getDb().update(schema.vendorCheckouts).set({ status: "paid" }).where(eq(schema.vendorCheckouts.id, c.id)).run();
    const session = { id: c.stripeSessionId, payment_status: "unpaid", payment_intent: "pi_1", customer: "cus_1", amount_total: 1_000_000 };
    expect(await handleStripeEvent(ev("checkout.session.async_payment_failed", session))).toBe("vendor_failed");
    const v = vendorOf();
    expect(v).toBeTruthy();
    expect(paymentsOf(v.id).map((p) => p.status)).toEqual(["failed"]);

    // A failed event for a checkout that can no longer make a sponsor returns instead of recursing.
    const other = await buy(s, "full", s.silverId, buyer({ company: "Meadow Wellness", email: "pat@example.com", people: [] }));
    getDb().update(schema.vendorCheckouts).set({ status: "failed" }).where(eq(schema.vendorCheckouts.id, other.c.id)).run();
    expect(await handleStripeEvent(ev("checkout.session.async_payment_failed", { id: other.c.stripeSessionId, payment_status: "unpaid", payment_intent: "pi_2", amount_total: 500_000 }))).toBe("ignored");

    // Two completions at once make one sponsor, one payment.
    const third = await buy(s, "full", s.silverId, buyer({ company: "Cedar Supply", email: "sam@example.com", people: [] }));
    const done = { id: third.c.stripeSessionId!, payment_status: "paid" as const, payment_intent: "pi_3", customer: "cus_3", amount_total: 500_000 };
    await Promise.all([completeCheckout(third.c.id, done), completeCheckout(third.c.id, done)]);
    const cedar = getDb().select().from(schema.vendors).where(eq(schema.vendors.company, "Cedar Supply")).all();
    expect(cedar).toHaveLength(1);
    expect(paymentsOf(cedar[0].id)).toHaveLength(1);
  });

  it("does not run the scheduled charge while a pay link session is open, and flags an overpayment", async () => {
    const s = await setup();
    const v = await depositSponsor(s);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-03-01T17:00:00Z"));
    await caller(null).registration.vendorCheckout.payBalance({ slug: s.event.slug, v: v.payToken! });
    const paySession = vendorOf().paySessionId!;
    expect(paySession).toBeTruthy();
    await runVendorCharges(new Date("2027-03-01T17:30:00Z"));
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    await expect(s.admin.registration.vendorCheckout.admin.chargeNow({ eventId: s.event.id, vendorId: v.id })).rejects.toThrow(/pay link/);

    // Past its expiry: checked, closed at Stripe, then the charge runs.
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({ id: paySession, status: "expired" });
    await runVendorCharges(new Date("2027-03-01T19:00:00Z"));
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(vendorOf().paySessionId).toBeNull();

    // The buyer had paid through an older pay link too: recorded, and the organization is told to refund.
    outbox.length = 0;
    await completeBalance(v.id, { id: "cs_late", payment_status: "paid", payment_intent: "pi_late", customer: "cus_1", amount_total: 500_000 } as never, "acct_test_1");
    expect(paymentsOf(v.id).filter((p) => p.status === "paid")).toHaveLength(3);
    const notice = outbox.find((m) => m.to === "events@example.org" && /refund needed/.test(m.subject))!;
    expect(notice.text).toContain("Refund $5,000.00");
  });

  it("lets the sponsor and exhibitor checkout pages be framed, and nothing else new", () => {
    expect(mayBeFramed("/embed/ev-1")).toBe(true);
    expect(mayBeFramed("/r/ev-1/sponsor")).toBe(true);
    expect(mayBeFramed("/r/ev-1/exhibit/")).toBe(true);
    expect(mayBeFramed("/r/ev-1/sponsor/done")).toBe(true);
    expect(mayBeFramed("/r/ev-1/exhibit/step/2")).toBe(true);
    expect(mayBeFramed("/r/ev-1")).toBe(false);
    expect(mayBeFramed("/r/ev-1/register")).toBe(false);
    expect(mayBeFramed("/r/ev-1/sponsor/pay")).toBe(false);
    expect(mayBeFramed("/admin")).toBe(false);
  });

  it("gets a new session after the old one expired, and never opens a second while the old one may be payable", async () => {
    const s = await setup();
    const { prep, c } = await buy(s, "full");
    const firstKey = (stripe.checkout.sessions.create.mock.calls[0] as [unknown, { idempotencyKey: string }])[1].idempotencyKey;
    await handleStripeEvent(ev("checkout.session.expired", { id: c.stripeSessionId }));
    const pub = caller(null);
    await pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", token: prep.token, packageId: s.goldId, buyer: buyer(), payOption: "full" });
    await pub.registration.vendorCheckout.start({ slug: s.event.slug, kind: "sponsor", token: prep.token, payOption: "full" });
    const secondKey = (stripe.checkout.sessions.create.mock.calls[1] as [unknown, { idempotencyKey: string }])[1].idempotencyKey;
    expect(secondKey).not.toBe(firstKey);

    // Stripe cannot be reached about the open session: no new session is made.
    stripe.checkout.sessions.retrieve.mockRejectedValueOnce(new Error("timeout"));
    stripe.checkout.sessions.expire.mockRejectedValueOnce(new Error("timeout"));
    await expect(pub.registration.vendorCheckout.start({ slug: s.event.slug, kind: "sponsor", token: prep.token, payOption: "deposit" })).rejects.toThrow(/could not start/);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
  });

  it("holds the last package before Stripe answers, lets it go on an error, and flags an oversold order", async () => {
    const s = await setup();
    const pub = caller(null);
    let heldDuringCall = false;
    stripe.checkout.sessions.create.mockImplementationOnce(async () => {
      const page = await pub.registration.vendorCheckout.page({ slug: s.event.slug, kind: "sponsor" });
      heldDuringCall = page.packages.find((p) => p.id === s.goldId)!.soldOut;
      throw new Error("Stripe is down");
    });
    const prep = await pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", packageId: s.goldId, buyer: buyer(), payOption: "full" });
    await expect(pub.registration.vendorCheckout.start({ slug: s.event.slug, kind: "sponsor", token: prep.token, payOption: "full" })).rejects.toThrow(/could not start/);
    expect(heldDuringCall).toBe(true);
    let c = getDb().select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.doneToken, prep.token)).get()!;
    expect(c).toMatchObject({ status: "started", pendingAt: null });

    await pub.registration.vendorCheckout.start({ slug: s.event.slug, kind: "sponsor", token: prep.token, payOption: "full" });
    c = getDb().select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.doneToken, prep.token)).get()!;
    expect(c.status).toBe("pending");
    expect(c.pendingAt).toBeTruthy();
    // Staff sell the last Gold by hand meanwhile; the paid order is still recorded and the organization told.
    await s.admin.network.vendors.create({ eventId: s.event.id, company: "Walk-in Sponsor", kind: "sponsor", status: "confirmed", packageId: s.goldId });
    outbox.length = 0;
    await handleStripeEvent(ev("checkout.session.completed", { id: c.stripeSessionId, payment_status: "paid", payment_intent: "pi_x", customer: "cus_x", amount_total: 1_000_000 }));
    expect(vendorOf().paidCents).toBe(1_000_000);
    expect(outbox.some((m) => m.to === "events@example.org" && /Gold oversold/.test(m.subject))).toBe(true);
  });

  it("blocks deleting a sponsor with online payments or a signed agreement, but not a manual one", async () => {
    const s = await setup();
    const v = await depositSponsor(s);
    await expect(s.admin.network.vendors.remove({ eventId: s.event.id, vendorId: v.id })).rejects.toThrow(/cannot be deleted. Set Status to Cancelled instead/);
    expect(paymentsOf(v.id)).toHaveLength(1);
    const manual = await s.admin.network.vendors.create({ eventId: s.event.id, company: "Manual Co", kind: "sponsor" });
    const signed = await s.admin.network.vendors.create({ eventId: s.event.id, company: "Signed Co", kind: "sponsor" });
    getDb().insert(schema.agreements).values({ eventId: s.event.id, kind: "sponsor", vendorId: signed.id, code: "agr-signed-1", status: "signed" }).run();
    await expect(s.admin.network.vendors.remove({ eventId: s.event.id, vendorId: signed.id })).rejects.toThrow(/signed agreement/);
    expect(await s.admin.network.vendors.remove({ eventId: s.event.id, vendorId: manual.id })).toEqual({ ok: true });
  });

  it("keeps a timed-out scheduled charge pending, retries with the same key, and lets the webhook settle it", async () => {
    const s = await setup();
    const v = await depositSponsor(s);
    stripe.paymentIntents.create.mockRejectedValueOnce(Object.assign(new Error("Request timed out"), { type: "StripeConnectionError" }));
    await runVendorCharges(new Date("2027-03-01T18:00:00Z"));
    let rows = paymentsOf(v.id).filter((p) => p.purpose === "balance");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", note: "Waiting for Stripe to confirm", stripePaymentIntentId: null });
    expect(vendorOf().nextChargeError).toBe("");

    // Charge now tries again with the same key: Stripe would hand back the same PaymentIntent.
    stripe.paymentIntents.create.mockRejectedValueOnce(Object.assign(new Error("Request timed out"), { type: "StripeConnectionError" }));
    await expect(s.admin.registration.vendorCheckout.admin.chargeNow({ eventId: s.event.id, vendorId: v.id })).rejects.toThrow(/not confirmed/);
    const keys = stripe.paymentIntents.create.mock.calls.map((call) => (call as [unknown, { idempotencyKey: string }])[1].idempotencyKey);
    expect(keys).toEqual([`vendor-balance-${v.id}-2027-03-01-1`, `vendor-balance-${v.id}-2027-03-01-1`]);
    expect(paymentsOf(v.id).filter((p) => p.purpose === "balance")).toHaveLength(1);

    // The webhook finds the row by the charge key in the metadata.
    const meta = (stripe.paymentIntents.create.mock.calls[0] as [{ metadata: Record<string, string> }])[0].metadata;
    expect(await handleStripeEvent(ev("payment_intent.succeeded", { id: "pi_late_ok", metadata: meta }))).toBe("vendor_paid");
    rows = paymentsOf(v.id).filter((p) => p.purpose === "balance");
    expect(rows[0]).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_late_ok", note: "" });
    expect(vendorOf()).toMatchObject({ paidCents: 1_000_000, nextChargeCents: 0 });
  });

  it("sets the invoice due date like the agreement, tells the organization once when it ends, and frees the package", async () => {
    const s = await setup();
    await buy(s, "invoice");
    const v = vendorOf();
    const c = getDb().select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.vendorId, v.id)).get()!;
    const due = new Date(new Date(c.createdAt!).getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    expect(v.holdUntil).toBe(due);
    outbox.length = 0;
    await runVendorCharges(new Date(`${due}T20:00:00Z`));
    expect(outbox).toHaveLength(0);
    const later = new Date(new Date(`${due}T15:00:00Z`).getTime() + 2 * 86_400_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(later);
    await runVendorCharges(later);
    await runVendorCharges(new Date(later.getTime() + 60_000));
    const notices = outbox.filter((m) => /invoice hold ended/.test(m.subject));
    expect(notices.map((m) => m.to)).toEqual(["events@example.org"]);
    expect(vendorOf()).toMatchObject({ status: "confirmed" });
    const page = await caller(null).registration.vendorCheckout.page({ slug: s.event.slug, kind: "sponsor" });
    expect(page.packages.find((p) => p.id === s.goldId)).toMatchObject({ soldOut: false, left: 1 });
  });

  it("marks a refunded vendor payment, emails the organization, and keeps a dispute webhook alive when email fails", async () => {
    const s = await setup();
    const v = await depositSponsor(s);
    outbox.length = 0;
    expect(await handleStripeEvent(ev("charge.refunded", { id: "ch_1", payment_intent: "pi_dep", amount: 500_000, amount_refunded: 100_000, refunded: false }))).toBe("vendor_refunded");
    expect(paymentsOf(v.id)[0]).toMatchObject({ status: "paid", amountCents: 400_000 });
    expect(await handleStripeEvent(ev("charge.refunded", { id: "ch_1", payment_intent: "pi_dep", amount: 500_000, amount_refunded: 500_000, refunded: true }))).toBe("vendor_refunded");
    expect(paymentsOf(v.id)[0].status).toBe("refunded");
    expect(vendorOf().paidCents).toBe(0);
    expect(outbox.filter((m) => m.to === "events@example.org" && /refund for/.test(m.subject))).toHaveLength(2);

    // A ticket order dispute: the order is marked failed even when every email fails.
    const a = addAttendee(s.event.id, "jordan@example.com");
    const order = getDb()
      .insert(schema.orders)
      .values({ eventId: s.event.id, attendeeId: a.attendee.id, email: "jordan@example.com", ticketTypeId: s.ticket.id, subtotalCents: 39_500, amountCents: 39_500, status: "paid", method: "stripe", stripePaymentIntentId: "pi_ticket", stripeAccountId: "acct_test_1", buyer: { firstName: "Jordan", lastName: "Ellis", email: "jordan@example.com" } })
      .returning()
      .get();
    mail.fail = true;
    expect(await handleStripeEvent(ev("charge.dispute.created", { id: "dp_1", payment_intent: "pi_ticket", reason: "fraudulent" }))).toBe("order_dispute");
    expect(getDb().select().from(schema.orders).where(eq(schema.orders.id, order.id)).get()!.status).toBe("failed");
  });

  it("takes logos only with a page or checkout token, only as PNG, JPEG or WebP, a few times", async () => {
    const s = await setup();
    const pub = caller(null);
    const page = await pub.registration.vendorCheckout.page({ slug: s.event.slug, kind: "sponsor" });
    const base = { slug: s.event.slug, kind: "sponsor" as const, name: "logo.png", mime: "image/png" as const, base64: PNG };
    await expect(pub.registration.vendorCheckout.uploadLogo(base)).rejects.toThrow(/Reload the page/);
    await expect(pub.registration.vendorCheckout.uploadLogo({ ...base, uploadToken: `${Date.now() + 60_000}.abc.forged` })).rejects.toThrow(/Reload the page/);
    await expect(pub.registration.vendorCheckout.uploadLogo({ ...base, uploadToken: page.uploadToken, mime: "image/svg+xml" as never, base64: SVG })).rejects.toThrow();
    await expect(pub.registration.vendorCheckout.uploadLogo({ ...base, uploadToken: page.uploadToken, mime: "image/jpeg" })).rejects.toThrow(/PNG, JPEG or WebP/);
    for (let i = 0; i < 5; i++) expect((await pub.registration.vendorCheckout.uploadLogo({ ...base, uploadToken: page.uploadToken })).fileId).toBeGreaterThan(0);
    await expect(pub.registration.vendorCheckout.uploadLogo({ ...base, uploadToken: page.uploadToken })).rejects.toThrow(/a lot of uploads/);
    const prep = await pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", packageId: s.goldId, buyer: buyer(), payOption: "full" });
    expect((await pub.registration.vendorCheckout.uploadLogo({ ...base, token: prep.token })).fileId).toBeGreaterThan(0);
  });

  it("never re-registers or moves people already on the event when they are named as passes", async () => {
    const s = await setup();
    const db = getDb();
    const other = await s.admin.network.vendors.create({ eventId: s.event.id, company: "Other Sponsor", kind: "sponsor", status: "confirmed" });
    const cancelled = addAttendee(s.event.id, "gone@example.com", "Gale", "Gone", { status: "cancelled" }).attendee;
    const registered = addAttendee(s.event.id, "reg@example.com", "Rae", "Reg", { status: "registered", organization: "Own Clinic", ticketTypeId: null }).attendee;
    const taken = addAttendee(s.event.id, "taken@example.com", "Tay", "Taken", { status: "registered", vendorId: other.id }).attendee;
    outbox.length = 0;
    const people = [
      { name: "Gale Gone", email: "gone@example.com" },
      { name: "Rae Reg", email: "reg@example.com" },
      { name: "Tay Taken", email: "taken@example.com" },
      { name: "New Person", email: "new@example.com" },
    ];
    await buy(s, "invoice", s.silverId, buyer({ people: people.slice(0, 2) }));
    const v = vendorOf();
    await caller(null).registration.vendorCheckout.addPasses({ slug: s.event.slug, kind: "sponsor", c: db.select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.vendorId, v.id)).get()!.doneToken, people: people.slice(2) });
    const get = (id: number) => db.select().from(schema.attendees).where(eq(schema.attendees.id, id)).get()!;
    expect(get(cancelled.id)).toMatchObject({ status: "cancelled", vendorId: null });
    expect(get(registered.id)).toMatchObject({ status: "registered", vendorId: v.id, organization: "Own Clinic", ticketTypeId: null });
    expect(get(taken.id)).toMatchObject({ vendorId: other.id });
    expect(db.select().from(schema.attendees).where(and(eq(schema.attendees.eventId, s.event.id), eq(schema.attendees.email, "new@example.com"))).get()).toMatchObject({ vendorId: v.id, status: "registered", organization: "Brightpath Health" });
    const notes = outbox.filter((m) => m.to === "events@example.org" && /already registered/.test(m.subject));
    expect(notes.map((m) => m.text).join(" ")).toContain("gone@example.com");
    expect(notes.map((m) => m.text).join(" ")).toContain("reg@example.com");
    expect(notes.map((m) => m.text).join(" ")).toContain("taken@example.com");
  });

  it("checks the next charge date against the event's today, and lists sponsors by package order", async () => {
    const s = await setup();
    const v = await depositSponsor(s);
    vi.useFakeTimers({ toFake: ["Date"] });
    // 9 PM in Chicago on Nov 9, 2026 is already Nov 10 in UTC.
    vi.setSystemTime(new Date("2026-11-10T03:00:00Z"));
    expect(await s.admin.network.packages.setNextChargeOn({ eventId: s.event.id, vendorId: v.id, date: "2026-11-09" })).toEqual({ ok: true });
    await expect(s.admin.network.packages.setNextChargeOn({ eventId: s.event.id, vendorId: v.id, date: "2026-11-08" })).rejects.toThrow(/today or a later date/);
    vi.useRealTimers();

    await s.admin.network.vendors.create({ eventId: s.event.id, company: "Aaron Labs", kind: "sponsor", status: "confirmed", packageId: s.silverId });
    await s.admin.network.vendors.create({ eventId: s.event.id, company: "Zed Health", kind: "sponsor", status: "confirmed" });
    const list = await s.admin.network.vendors.list({ eventId: s.event.id });
    expect(list.vendors.map((x) => x.company)).toEqual(["Brightpath Health", "Aaron Labs", "Zed Health"]);
  });
});
