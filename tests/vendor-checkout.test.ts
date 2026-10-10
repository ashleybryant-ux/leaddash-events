import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { freshDb, caller, setupEvent, outbox, getDb, schema, user } from "./helpers";
import { ENV } from "../server/_core/env";
import { setStripeClient, type StripeLike } from "../server/areas/registration/stripe";
import { handleStripeEvent } from "../server/areas/registration/http";
import { runVendorCharges } from "../server/areas/registration/vendorCharges";
import { saveAccountStatus } from "../server/areas/registration/connect";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function fakeStripe() {
  const fake = {
    accounts: { retrieve: vi.fn(), update: vi.fn(), listExternalAccounts: vi.fn() },
    oauth: { token: vi.fn(), deauthorize: vi.fn() },
    checkout: {
      sessions: {
        create: vi.fn(async (..._args: unknown[]) => ({ id: `cs_test_${Math.random().toString(36).slice(2)}`, client_secret: "cs_secret_vendor" })),
        retrieve: vi.fn(async (id: string, ..._rest: unknown[]) => ({ id, status: "open", payment_status: "unpaid", client_secret: "cs_secret_vendor" })),
        expire: vi.fn(async (id: string) => ({ id, status: "expired" })),
      },
    },
    paymentIntents: {
      retrieve: vi.fn(async (id: string, ..._rest: unknown[]) => ({ id, payment_method: { id: "pm_bank_1", type: "us_bank_account", us_bank_account: { last4: "6789" } } })),
      create: vi.fn(async (..._args: unknown[]) => ({ id: "pi_balance_1", status: "processing" })),
    },
    setupIntents: { retrieve: vi.fn(async (id: string) => ({ id, payment_method: { id: "pm_card_2", type: "card", card: { brand: "visa", last4: "4242" } } })) },
    refunds: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  };
  setStripeClient(fake as unknown as StripeLike);
  return fake;
}

async function setup(opts: { methods?: "both" | "ach" | "card"; agreement?: boolean } = {}) {
  const s = await setupEvent({ orgName: "Sample Organization" });
  const db = getDb();
  db.insert(schema.stripeAccounts).values({ orgId: s.org.id, accountId: "acct_test_1", businessName: "Sample Organization", chargesEnabled: true, payoutsEnabled: true }).run();
  const ticket = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, s.event.id)).all()[0];
  db.update(schema.ticketTypes).set({ active: true, priceCents: 39500 }).where(eq(schema.ticketTypes.id, ticket.id)).run();
  const pk = (name: string, kind: "sponsor" | "exhibitor", priceCents: number, quantity: number | null, passes: number) =>
    s.admin.network.packages.save({ eventId: s.event.id, name, kind, priceCents, quantity, passes, passTicketTypeId: ticket.id, includesBooth: kind === "sponsor", logoSpots: { welcome: name === "Gold", topOfList: false, sessionPages: false }, benefits: ["Stage mention at the opening session"] });
  const gold = await pk("Gold", "sponsor", 1_000_000, 1, 4);
  const platinum = await pk("Platinum", "sponsor", 2_000_000, 1, 6);
  const booth = await pk("Standard booth", "exhibitor", 95_000, 30, 2);
  const corner = await pk("Corner booth", "exhibitor", 125_000, 2, 2);
  const staffPass = await s.admin.network.packages.saveAddon({ eventId: s.event.id, name: "Extra booth staff pass", priceCents: 15_000, quantity: null, packageIds: [booth.id], addsPass: true });
  const power = await s.admin.network.packages.saveAddon({ eventId: s.event.id, name: "Electricity", priceCents: 7_500, quantity: 1, packageIds: [], addsPass: false });
  // Platinum is sold out.
  await s.admin.network.vendors.create({ eventId: s.event.id, company: "River Street Labs", kind: "sponsor", status: "confirmed", packageId: platinum.id });
  let templateId: number | null = null;
  if (opts.agreement) {
    const t = await s.admin.agreements.templates.create({ eventId: s.event.id, starter: "sponsor" });
    templateId = t.id;
  }
  await s.admin.registration.vendorCheckout.admin.saveSettings({
    eventId: s.event.id,
    kind: "sponsor",
    open: true,
    closesOn: "2027-03-01",
    title: "Sponsor Annual Conference 2027",
    intro: "Put your brand in front of counselors.",
    packageIds: [],
    payFull: true,
    payDeposit: true,
    payInvoice: true,
    methods: opts.methods ?? "ach",
    depositPercent: 50,
    balanceDueOn: "2027-03-01",
    invoiceHoldDays: 14,
    agreementTemplateId: templateId,
    notifyEmail: "events@example.org",
  });
  await s.admin.registration.vendorCheckout.admin.saveSettings({
    eventId: s.event.id,
    kind: "exhibitor",
    open: true,
    closesOn: null,
    title: "Exhibit at Annual Conference 2027",
    intro: "",
    packageIds: [],
    payFull: true,
    payDeposit: false,
    payInvoice: true,
    methods: "both",
    depositPercent: 50,
    balanceDueOn: null,
    invoiceHoldDays: 14,
    agreementTemplateId: null,
    notifyEmail: "",
  });
  return { ...s, ticket, goldId: gold.id, platinumId: platinum.id, boothId: booth.id, cornerId: corner.id, staffPassId: staffPass.id, powerId: power.id };
}

const buyer = (extra: Record<string, unknown> = {}) => ({
  company: "Brightpath Health",
  website: "brightpath.example.com",
  firstName: "Alex",
  lastName: "Morgan",
  email: "Alex@Example.com",
  phone: "(555) 555-0190",
  about: "Practice software for group practices.",
  people: [
    { name: "Alex Morgan", email: "alex@example.com" },
    { name: "Chris Patel", email: "chris@example.com" },
    { name: "", email: "" },
  ],
  ...extra,
});

const sessionEvent = (type: string, s: Record<string, unknown>, account = "acct_test_1") => ({ id: `evt_${Math.random()}`, type, account, data: { object: s } }) as unknown as Stripe.Event;

/** Package and Company steps, then Pay. Returns the token and the session id. */
async function buySponsor(s: Awaited<ReturnType<typeof setup>>, payOption: "full" | "deposit" | "invoice" = "deposit") {
  const pub = caller(null);
  const prep = await pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", packageId: s.goldId, buyer: buyer(), payOption });
  const res = await pub.registration.vendorCheckout.start({ slug: s.event.slug, kind: "sponsor", token: prep.token, payOption });
  const c = getDb().select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.doneToken, prep.token)).get()!;
  return { prep, res, c };
}

describe("sponsor and exhibitor checkout", () => {
  beforeEach(async () => {
    await freshDb();
    ENV.platformFeeCents = 0;
    ENV.platformFeePercent = 0;
    fakeStripe();
  });
  afterAll(() => setStripeClient(null));

  it("creates page settings with defaults, saves them, and checks access", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    const first = await s.admin.registration.vendorCheckout.admin.settings({ eventId: s.event.id, kind: "exhibitor" });
    expect(first).toMatchObject({ title: "Exhibit at NABC Annual Conference", open: false, payFull: true, methods: "both", invoiceHoldDays: 14, link: `${ENV.appUrl}/r/${s.event.slug}/exhibit`, live: false });
    expect(first.embedCode).toContain(`/r/${s.event.slug}/exhibit`);
    const base = { eventId: s.event.id, kind: "sponsor" as const, open: true, closesOn: null, title: "Sponsor us", intro: "", packageIds: [], payFull: true, payInvoice: false, methods: "card" as const, depositPercent: 50, invoiceHoldDays: 14 as const, agreementTemplateId: null, notifyEmail: "" };
    await expect(s.admin.registration.vendorCheckout.admin.saveSettings({ ...base, payDeposit: true, balanceDueOn: null })).rejects.toThrow(/date the rest is charged/);
    await s.admin.registration.vendorCheckout.admin.saveSettings({ ...base, payDeposit: true, balanceDueOn: "2027-03-01", notifyEmail: "Events@Example.org" });
    const saved = await s.admin.registration.vendorCheckout.admin.settings({ eventId: s.event.id, kind: "sponsor" });
    expect(saved).toMatchObject({ title: "Sponsor us", payDeposit: true, balanceDueOn: "2027-03-01", methods: "card", notifyEmail: "events@example.org", live: true, achActive: false });
    const stranger = caller(user("stranger@example.com"));
    await expect(stranger.registration.vendorCheckout.admin.settings({ eventId: s.event.id, kind: "sponsor" })).rejects.toThrow();
    await expect(stranger.registration.vendorCheckout.admin.saveSettings({ ...base, payDeposit: false, balanceDueOn: null })).rejects.toThrow();
  });

  it("stores the bank (ACH) capability from Stripe", async () => {
    const s = await setup();
    saveAccountStatus({ id: "acct_test_1", charges_enabled: true, payouts_enabled: true, details_submitted: true, capabilities: { card_payments: "active", us_bank_account_ach_payments: "active" } } as unknown as Stripe.Account);
    expect((await s.admin.registration.vendorCheckout.admin.settings({ eventId: s.event.id, kind: "sponsor" })).achActive).toBe(true);
  });

  it("shows packages with what is left and validates everything on the server", async () => {
    const s = await setup();
    const pub = caller(null);
    const page = await pub.registration.vendorCheckout.page({ slug: s.event.slug, kind: "sponsor" });
    expect(page.closed).toBe("");
    expect(page.page.options).toEqual(["full", "deposit", "invoice"]);
    const gold = page.packages.find((p) => p.id === s.goldId)!;
    expect(gold).toMatchObject({ left: 1, soldOut: false });
    expect(gold.includes).toEqual(["4 event passes", "Booth in the exhibit hall", "Logo on the app welcome screen", "Stage mention at the opening session"]);
    expect(page.packages.find((p) => p.id === s.platinumId)).toMatchObject({ left: 0, soldOut: true });
    await expect(pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", packageId: s.platinumId, buyer: buyer() })).rejects.toThrow(/sold out/);
    await expect(pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", packageId: s.boothId, buyer: buyer() })).rejects.toThrow(/not on this page/);
    await expect(pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", packageId: s.goldId, buyer: buyer({ phone: "" }) })).rejects.toThrow(/mobile/);
    await expect(pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", packageId: s.goldId, buyer: buyer({ logoFileId: 1, logoToken: "forged" }) })).rejects.toThrow(/logo/);

    const prep = await pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", packageId: s.goldId, buyer: buyer(), payOption: "deposit" });
    expect(prep).toMatchObject({ totalCents: 1_000_000, dueTodayCents: 500_000, payOption: "deposit", agreement: null });

    // Exhibitors: add-ons only with their package, stock respected, totals recomputed.
    const ex = buyer({ company: "Cedar Counseling Supply", category: "Office and testing supplies", people: [{ name: "Jamie Fox", email: "jamie@example.com" }] });
    await expect(pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "exhibitor", packageId: s.cornerId, buyer: { ...ex, addons: [{ addonId: s.staffPassId, qty: 1 }] } })).rejects.toThrow(/not offered/);
    await expect(pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "exhibitor", packageId: s.boothId, buyer: { ...ex, addons: [{ addonId: s.powerId, qty: 2 }] } })).rejects.toThrow(/Only 1 electricity left/);
    await expect(pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "exhibitor", packageId: s.boothId, buyer: { ...ex, category: "" } })).rejects.toThrow(/category/);
    const exPrep = await pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "exhibitor", packageId: s.boothId, buyer: { ...ex, addons: [{ addonId: s.staffPassId, qty: 1 }, { addonId: s.powerId, qty: 1 }] }, payOption: "deposit" });
    expect(exPrep).toMatchObject({ totalCents: 117_500, dueTodayCents: 117_500, payOption: "full" });
    expect(exPrep.lines.map((l) => l.label)).toEqual(["Standard booth", "Extra booth staff pass x 1", "Electricity x 1"]);
  });

  it("charges a deposit to a bank account only, then creates the sponsor from the webhook (once)", async () => {
    const stripe = fakeStripe();
    const s = await setup({ methods: "ach" });
    const { res, c } = await buySponsor(s, "deposit");
    expect(res).toEqual({ kind: "pay", clientSecret: "cs_secret_vendor" });
    const [params, opts] = stripe.checkout.sessions.create.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(params).toMatchObject({ mode: "payment", allowed_payment_method_types: ["us_bank_account"], customer_creation: "always", metadata: { leaddash_vendor_checkout_id: String(c.id) }, payment_intent_data: { setup_future_usage: "off_session" } });
    expect((params.line_items as { price_data: { unit_amount: number } }[])[0].price_data.unit_amount).toBe(500_000);
    expect(opts).toMatchObject({ stripeAccount: "acct_test_1" });
    expect(c).toMatchObject({ status: "pending", dueTodayCents: 500_000 });

    // The package is held while the buyer is on Stripe.
    const page = await caller(null).registration.vendorCheckout.page({ slug: s.event.slug, kind: "sponsor" });
    expect(page.packages.find((p) => p.id === s.goldId)).toMatchObject({ left: 0, soldOut: true });

    const session = { id: c.stripeSessionId, payment_status: "unpaid", payment_intent: "pi_dep_1", customer: "cus_1", amount_total: 500_000 };
    outbox.length = 0;
    expect(await handleStripeEvent(sessionEvent("checkout.session.completed", session, "acct_other"))).toBe("ignored");
    expect(await handleStripeEvent(sessionEvent("checkout.session.completed", session))).toBe("vendor_created");
    expect(await handleStripeEvent(sessionEvent("checkout.session.completed", session))).toBe("vendor_created");
    const db = getDb();
    const vendors = db.select().from(schema.vendors).where(eq(schema.vendors.company, "Brightpath Health")).all();
    expect(vendors).toHaveLength(1);
    const v = vendors[0];
    expect(v).toMatchObject({ kind: "sponsor", packageId: s.goldId, amountCents: 1_000_000, source: "checkout", email: "alex@example.com", contactName: "Alex Morgan", nextChargeCents: 500_000, nextChargeOn: "2027-03-01", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_bank_1", payMethodLabel: "Bank ending 6789", status: "confirmed" });
    expect(v.benefits.map((b) => b.label)).toEqual(["Stage mention at the opening session"]);
    const pays = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ amountCents: 500_000, status: "pending", purpose: "deposit", method: "bank", reference: "Bank ending 6789", stripePaymentIntentId: "pi_dep_1" });
    const passes = db.select().from(schema.attendees).where(eq(schema.attendees.vendorId, v.id)).all();
    expect(passes.map((p) => [p.email, p.kind, p.ticketTypeId, p.status])).toEqual([
      ["alex@example.com", "sponsor", s.ticket.id, "registered"],
      ["chris@example.com", "sponsor", s.ticket.id, "registered"],
    ]);
    const orders = db.select().from(schema.orders).where(eq(schema.orders.method, "sponsor_pass")).all();
    expect(orders).toHaveLength(2);
    const list = await s.admin.network.vendors.list({ eventId: s.event.id });
    expect(list.vendors.find((x) => x.id === v.id)).toMatchObject({ statusLabel: "Payment pending", passesUsed: 2, passesTotal: 4 });
    expect(outbox.filter((m) => m.to === "alex@example.com" && /receipt/.test(m.subject))).toHaveLength(1);
    expect(outbox.filter((m) => m.to === "events@example.org" && /new sponsor/.test(m.subject))).toHaveLength(1);

    // The bank payment clears.
    expect(await handleStripeEvent(sessionEvent("checkout.session.async_payment_succeeded", { ...session, payment_status: "paid" }))).toBe("vendor_paid");
    expect(await handleStripeEvent(sessionEvent("checkout.session.async_payment_succeeded", { ...session, payment_status: "paid" }))).toBe("ignored");
    expect(db.select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!.paidCents).toBe(500_000);
    const after = await s.admin.network.vendors.list({ eventId: s.event.id });
    expect(after.vendors.find((x) => x.id === v.id)).toMatchObject({ statusLabel: "Deposit paid" });

    const done = await caller(null).registration.vendorCheckout.done({ slug: s.event.slug, kind: "sponsor", c: c.doneToken });
    expect(done).toMatchObject({ status: "paid", restCents: 500_000, restOn: "2027-03-01", passes: { total: 4, named: 2 } });
  });

  it("records a card payment in full as paid and returns the done page", async () => {
    const stripe = fakeStripe();
    const s = await setup({ methods: "card" });
    const { c } = await buySponsor(s, "full");
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as [Record<string, unknown>];
    expect(params).toMatchObject({ allowed_payment_method_types: ["card"] });
    expect((params.payment_intent_data as Record<string, unknown>).setup_future_usage).toBeUndefined();
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_card", payment_method: { id: "pm_card", type: "card", card: { brand: "visa", last4: "4242" } } } as never);
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({ id: c.stripeSessionId!, status: "complete", payment_status: "paid", payment_intent: "pi_card", customer: "cus_2", amount_total: 1_000_000 } as never);
    const done = await caller(null).registration.vendorCheckout.done({ slug: s.event.slug, kind: "sponsor", c: c.doneToken });
    expect(done).toMatchObject({ status: "paid", firstName: "Alex", packageName: "Gold", restCents: 0 });
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.company, "Brightpath Health")).get()!;
    expect(v).toMatchObject({ paidCents: 1_000_000, payMethodLabel: "Visa ending 4242", nextChargeCents: 0 });
  });

  it("marks a failed bank payment and emails the organization and the buyer", async () => {
    const s = await setup();
    const { c } = await buySponsor(s, "full");
    const session = { id: c.stripeSessionId, payment_status: "unpaid", payment_intent: "pi_fail_1", customer: "cus_1", amount_total: 1_000_000 };
    await handleStripeEvent(sessionEvent("checkout.session.completed", session));
    outbox.length = 0;
    expect(await handleStripeEvent(sessionEvent("checkout.session.async_payment_failed", session))).toBe("vendor_failed");
    expect(await handleStripeEvent(sessionEvent("checkout.session.async_payment_failed", session))).toBe("ignored");
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.company, "Brightpath Health")).get()!;
    const pay = getDb().select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).get()!;
    expect(pay.status).toBe("failed");
    const row = (await s.admin.network.vendors.list({ eventId: s.event.id })).vendors.find((x) => x.id === v.id)!;
    expect(row).toMatchObject({ statusLabel: "Owed", owedCents: 1_000_000 });
    expect(outbox.some((m) => m.to === "events@example.org" && /payment failed/.test(m.subject))).toBe(true);
    const buyerMail = outbox.find((m) => m.to === "alex@example.com")!;
    expect(buyerMail.subject).toMatch(/did not go through/);
    expect(buyerMail.text).toContain(`/r/${s.event.slug}/sponsor/pay?v=`);
  });

  it("asks for the signed agreement before paying, and a new one when how they pay changes", async () => {
    const s = await setup({ agreement: true });
    const pub = caller(null);
    const prep = await pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", packageId: s.goldId, buyer: buyer(), payOption: "deposit" });
    expect(prep.agreement).toMatchObject({ signed: false });
    expect(prep.agreement!.html).toContain("Brightpath Health");
    await expect(pub.registration.vendorCheckout.start({ slug: s.event.slug, kind: "sponsor", token: prep.token, payOption: "deposit" })).rejects.toThrow(/Sign the agreement/);
    outbox.length = 0;
    await pub.registration.vendorCheckout.sign({ slug: s.event.slug, kind: "sponsor", token: prep.token, name: "Alex Morgan", title: "Marketing Director", signaturePng: PNG });
    expect(outbox).toHaveLength(0);
    const same = await pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", token: prep.token, packageId: s.goldId, buyer: buyer(), payOption: "deposit" });
    expect(same.agreement).toMatchObject({ code: prep.agreement!.code, signed: true });
    const changed = await pub.registration.vendorCheckout.prepare({ slug: s.event.slug, kind: "sponsor", token: prep.token, packageId: s.goldId, buyer: buyer(), payOption: "full" });
    expect(changed.agreement!.signed).toBe(false);
    expect(changed.agreement!.code).not.toBe(prep.agreement!.code);
    await pub.registration.vendorCheckout.sign({ slug: s.event.slug, kind: "sponsor", token: prep.token, name: "Alex Morgan", title: "", signaturePng: PNG });
    const res = await pub.registration.vendorCheckout.start({ slug: s.event.slug, kind: "sponsor", token: prep.token, payOption: "full" });
    expect(res.kind).toBe("pay");
    const c = getDb().select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.doneToken, prep.token)).get()!;
    await handleStripeEvent(sessionEvent("checkout.session.completed", { id: c.stripeSessionId, payment_status: "paid", payment_intent: "pi_x", customer: "cus_x", amount_total: 1_000_000 }));
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.company, "Brightpath Health")).get()!;
    const agr = getDb().select().from(schema.agreements).where(eq(schema.agreements.vendorId, v.id)).all();
    expect(agr.map((a) => a.status)).toEqual(["signed"]);
    const notice = outbox.find((m) => m.to === "events@example.org" && /new sponsor/.test(m.subject))!;
    expect(notice.attachments?.[0]?.contentType).toBe("application/pdf");
  });

  it("holds the package for an invoice and emails the pay link", async () => {
    const stripe = fakeStripe();
    const s = await setup();
    const { res } = await buySponsor(s, "invoice");
    expect(res.kind).toBe("done");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.company, "Brightpath Health")).get()!;
    expect(v.holdUntil).toBeTruthy();
    expect(v.holdUntil! > "2026-01-01").toBe(true);
    const row = (await s.admin.network.vendors.list({ eventId: s.event.id })).vendors.find((x) => x.id === v.id)!;
    expect(row).toMatchObject({ statusLabel: "Invoice sent", owedCents: 1_000_000 });
    const invoice = outbox.find((m) => m.to === "alex@example.com" && /invoice/.test(m.subject))!;
    expect(invoice.text).toContain(`/r/${s.event.slug}/sponsor/pay?v=${v.payToken}`);

    // Pay link: pays what is owed and saves the method.
    const info = await caller(null).registration.vendorCheckout.payInfo({ slug: s.event.slug, v: v.payToken! });
    expect(info).toMatchObject({ owedCents: 1_000_000, what: "Gold sponsorship" });
    await caller(null).registration.vendorCheckout.payBalance({ slug: s.event.slug, v: v.payToken! });
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as [Record<string, unknown>];
    expect(params).toMatchObject({ metadata: { leaddash_vendor_pay: String(v.id) }, payment_intent_data: { setup_future_usage: "off_session" } });
    const pay = { id: "cs_pay_1", payment_status: "paid", payment_intent: "pi_pay_1", customer: "cus_9", amount_total: 1_000_000, metadata: { leaddash_vendor_pay: String(v.id) } };
    expect(await handleStripeEvent(sessionEvent("checkout.session.completed", pay))).toBe("vendor_balance");
    expect(await handleStripeEvent(sessionEvent("checkout.session.completed", pay))).toBe("ignored");
    const after = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
    expect(after).toMatchObject({ paidCents: 1_000_000, holdUntil: null });
  });

  it("sends the reminder once 7 days before and charges once on the date", async () => {
    const stripe = fakeStripe();
    const s = await setup();
    const { c } = await buySponsor(s, "deposit");
    await handleStripeEvent(sessionEvent("checkout.session.completed", { id: c.stripeSessionId, payment_status: "paid", payment_intent: "pi_dep", customer: "cus_1", amount_total: 500_000 }));
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.company, "Brightpath Health")).get()!;
    outbox.length = 0;
    await runVendorCharges(new Date("2027-02-20T18:00:00Z"));
    expect(outbox).toHaveLength(0);
    await runVendorCharges(new Date("2027-02-22T18:00:00Z"));
    await runVendorCharges(new Date("2027-02-23T18:00:00Z"));
    const reminders = outbox.filter((m) => /next sponsorship payment/.test(m.subject));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].text).toContain("On Mar 1, 2027, we will charge $5,000.00 to the bank account ending in 6789. This is the second half of the Gold sponsorship for Brightpath Health.");
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();

    await runVendorCharges(new Date("2027-03-01T18:00:00Z"));
    await runVendorCharges(new Date("2027-03-01T18:01:00Z"));
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    const [params, opts] = stripe.paymentIntents.create.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(params).toMatchObject({ amount: 500_000, customer: "cus_1", payment_method: "pm_bank_1", confirm: true, off_session: true, metadata: { leaddash_vendor_id: String(v.id) } });
    expect(opts).toMatchObject({ stripeAccount: "acct_test_1", idempotencyKey: `vendor-balance-${v.id}-2027-03-01-1` });
    let fresh = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
    expect(fresh).toMatchObject({ nextChargeCents: 0, nextChargeOn: null });
    const balance = getDb().select().from(schema.vendorPayments).where(eq(schema.vendorPayments.stripePaymentIntentId, "pi_balance_1")).get()!;
    expect(balance).toMatchObject({ status: "pending", purpose: "balance", amountCents: 500_000 });
    expect(await handleStripeEvent(sessionEvent("payment_intent.succeeded", { id: "pi_balance_1" }))).toBe("vendor_paid");
    fresh = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
    expect(fresh.paidCents).toBe(1_000_000);

    // A bank return after it showed as paid: owed again, the organization is told.
    outbox.length = 0;
    expect(await handleStripeEvent(sessionEvent("charge.dispute.created", { id: "dp_1", payment_intent: "pi_balance_1", reason: "insufficient_funds" }))).toBe("vendor_dispute");
    expect(getDb().select().from(schema.vendorPayments).where(eq(schema.vendorPayments.id, balance.id)).get()).toMatchObject({ status: "failed", failureReason: "Insufficient funds" });
    const row = (await s.admin.network.vendors.list({ eventId: s.event.id })).vendors.find((x) => x.id === v.id)!;
    expect(row).toMatchObject({ statusLabel: "Owed", owedCents: 500_000 });
    expect(outbox.map((m) => m.to)).toEqual(["events@example.org"]);
  });

  it("keeps the schedule and emails both sides when the automatic charge fails, and Charge now retries", async () => {
    const stripe = fakeStripe();
    const s = await setup({ methods: "card" });
    const { c } = await buySponsor(s, "deposit");
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_dep", payment_method: { id: "pm_card", type: "card", card: { brand: "visa", last4: "4242" } } } as never);
    await handleStripeEvent(sessionEvent("checkout.session.completed", { id: c.stripeSessionId, payment_status: "paid", payment_intent: "pi_dep", customer: "cus_1", amount_total: 500_000 }));
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.company, "Brightpath Health")).get()!;
    stripe.paymentIntents.create.mockRejectedValueOnce(Object.assign(new Error("Your card was declined."), { raw: { payment_intent: { id: "pi_declined" } } }));
    outbox.length = 0;
    await runVendorCharges(new Date("2027-03-02T18:00:00Z"));
    await runVendorCharges(new Date("2027-03-02T18:01:00Z"));
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    const fresh = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
    expect(fresh).toMatchObject({ nextChargeCents: 500_000, nextChargeOn: "2027-03-01", nextChargeError: "Your card was declined." });
    expect(getDb().select().from(schema.vendorPayments).where(eq(schema.vendorPayments.stripePaymentIntentId, "pi_declined")).get()).toMatchObject({ status: "failed" });
    expect(outbox.some((m) => m.to === "events@example.org" && /payment failed/.test(m.subject))).toBe(true);
    expect(outbox.some((m) => m.to === "alex@example.com" && /did not go through/.test(m.subject))).toBe(true);
    const row = (await s.admin.network.vendors.list({ eventId: s.event.id })).vendors.find((x) => x.id === v.id)!;
    expect(row.statusLabel).toBe("Deposit paid");
    expect(row.nextChargeError).toBe("Your card was declined.");

    stripe.paymentIntents.create.mockResolvedValueOnce({ id: "pi_ok", status: "succeeded" } as never);
    const r = await s.admin.registration.vendorCheckout.admin.chargeNow({ eventId: s.event.id, vendorId: v.id });
    expect(r.status).toBe("paid");
    expect((stripe.paymentIntents.create.mock.calls[1] as [unknown, { idempotencyKey: string }])[1].idempotencyKey).toBe(`vendor-balance-${v.id}-2027-03-01-2`);
    expect(getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()).toMatchObject({ paidCents: 1_000_000, nextChargeCents: 0 });
    await expect(s.admin.registration.vendorCheckout.admin.chargeNow({ eventId: s.event.id, vendorId: v.id })).rejects.toThrow(/Nothing is scheduled/);
  });

  it("sends the invoice and gives the pay link from the sponsor row", async () => {
    const s = await setup();
    const v = await s.admin.network.vendors.create({ eventId: s.event.id, company: "Meadow Wellness", kind: "sponsor", contactName: "Pat Lee", email: "pat@example.com", status: "confirmed", packageId: s.goldId });
    outbox.length = 0;
    expect(await s.admin.registration.vendorCheckout.admin.sendPayLink({ eventId: s.event.id, vendorId: v.id })).toEqual({ to: "pat@example.com" });
    const { url } = await s.admin.registration.vendorCheckout.admin.payLink({ eventId: s.event.id, vendorId: v.id });
    expect(url).toMatch(new RegExp(`/r/${s.event.slug}/sponsor/pay\\?v=`));
    expect(outbox[0].text).toContain(url);
    const stranger = caller(user("nobody@example.com"));
    await expect(stranger.registration.vendorCheckout.admin.payLink({ eventId: s.event.id, vendorId: v.id })).rejects.toThrow();
  });

  it("lets the buyer add pass names from the confirmation page", async () => {
    const s = await setup();
    const { c } = await buySponsor(s, "invoice");
    const pub = caller(null);
    const r = await pub.registration.vendorCheckout.addPasses({ slug: s.event.slug, kind: "sponsor", c: c.doneToken, people: [{ name: "Robin Hale", email: "robin@example.com" }, { name: "Sam Ortiz", email: "sam@example.com" }, { name: "Extra Person", email: "extra@example.com" }] });
    expect(r.added).toBe(2);
    const done = await pub.registration.vendorCheckout.done({ slug: s.event.slug, kind: "sponsor", c: c.doneToken });
    expect(done).toMatchObject({ status: "invoice", passes: { total: 4, named: 4 } });
  });
});
