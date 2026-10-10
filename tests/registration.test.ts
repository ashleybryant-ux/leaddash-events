import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { freshDb, caller, setupEvent, addAttendee, outbox, getDb, schema, user } from "./helpers";
import { ENV } from "../server/_core/env";
import { textLog } from "../server/_core/platform";
import { setStripeClient, type StripeLike } from "../server/areas/registration/stripe";
import { fulfillOrder, ticketsOnSale } from "../server/areas/registration/logic";
import { runFollowUps } from "../server/areas/registration/messages";
import { handleWebhookRequest } from "../server/areas/registration/http";
import { registrationArea } from "../server/areas/registration";
import { finishConnect, signState } from "../server/areas/registration/connect";

const WEBHOOK_SECRET = "whsec_test_secret";
const realWebhooks = new Stripe("sk_test_not_used").webhooks;

function fakeStripe() {
  const fake = {
    accounts: {
      create: vi.fn(async (..._args: unknown[]) => ({ id: "acct_test_1" })),
      retrieve: vi.fn(async () => ({ id: "acct_test_1", charges_enabled: true, payouts_enabled: true, details_submitted: true, business_profile: { name: "NABC" }, capabilities: { card_payments: "active", klarna_payments: "active", afterpay_clearpay_payments: "inactive" }, settings: { payouts: { schedule: { interval: "daily" } }, payments: { statement_descriptor: "NABC CONFERENCE" } } })),
      update: vi.fn(async () => ({ id: "acct_test_1" })),
      listExternalAccounts: vi.fn(async () => ({ data: [{ object: "bank_account", last4: "6789" }] })),
    },
    oauth: {
      token: vi.fn(async (..._args: unknown[]) => ({ stripe_user_id: "acct_test_1", livemode: false, scope: "read_write" })),
      deauthorize: vi.fn(async (..._args: unknown[]) => ({ stripe_user_id: "acct_test_1" })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async (..._args: unknown[]) => ({ id: `cs_test_${Math.random().toString(36).slice(2)}`, client_secret: "cs_secret_123" })),
        retrieve: vi.fn(async (id: string, ..._rest: unknown[]) => ({ id, status: "complete", payment_status: "paid", payment_intent: "pi_test_1" })),
      },
    },
    refunds: { create: vi.fn(async () => ({ id: "re_test_1" })) },
    webhooks: realWebhooks,
  };
  setStripeClient(fake as unknown as StripeLike);
  return fake;
}

const buyer = (email: string, extra: Record<string, unknown> = {}) => ({
  firstName: "Jordan",
  lastName: "Ellis",
  email,
  phone: "(405) 555-0142",
  credentials: "LPC",
  licenseNumber: "12345",
  licenseState: "OK",
  answers: {},
  textConsent: true,
  ...extra,
});

async function setup() {
  const s = await setupEvent();
  const db = getDb();
  const tickets = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, s.event.id)).all();
  const byName = (n: string) => tickets.find((t) => t.name === n)!;
  return { ...s, member: byName("Member"), nonmember: byName("Nonmember"), student: byName("Student") };
}

function connectStripe(orgId: number) {
  getDb().insert(schema.stripeAccounts).values({ orgId, accountId: "acct_test_1", businessName: "NABC", chargesEnabled: true, payoutsEnabled: true }).run();
}

function setTicket(id: number, values: Partial<typeof schema.ticketTypes.$inferInsert>) {
  getDb().update(schema.ticketTypes).set(values).where(eq(schema.ticketTypes.id, id)).run();
}

describe("registration", () => {
  beforeEach(async () => {
    await freshDb();
    textLog.length = 0;
    ENV.stripeConnectWebhookSecret = WEBHOOK_SECRET;
    ENV.platformFeeCents = 0;
    ENV.platformFeePercent = 0;
    fakeStripe();
  });
  afterAll(() => setStripeClient(null));

  it("seeds three inactive tickets, five messages and a checkout page", async () => {
    const { event, admin } = await setup();
    const tickets = await admin.registration.tickets.list({ eventId: event.id });
    expect(tickets.map((t) => [t.name, t.priceCents, t.active])).toEqual([
      ["Member", 0, false],
      ["Nonmember", 0, false],
      ["Student", 0, false],
    ]);
    const templates = await admin.registration.templates.list({ eventId: event.id });
    expect(templates.map((t) => t.kind)).toEqual(["welcome", "text_app", "app_reminder", "know_before", "morning_text"]);
    expect(templates.find((t) => t.kind === "morning_text")!.enabled).toBe(false);
    const page = await admin.registration.checkout.get({ eventId: event.id });
    expect(page.questions[0]).toMatchObject({ key: "name_email", locked: true });
    expect(page.platformTag).toBe("NABC 2027 registered");
  });

  it("registers a free ticket, creates the attendee and sends the welcome email", async () => {
    const { event, org, nonmember } = await setup();
    getDb().update(schema.organizations).set({ platformLocationId: "loc_1" }).where(eq(schema.organizations.id, org.id)).run();
    setTicket(nonmember.id, { active: true });
    const pub = caller(null);
    const page = await pub.registration.page({ slug: event.slug });
    expect(page.tickets.map((t) => t.name)).toEqual(["Nonmember"]);
    const res = await pub.registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("Jordan@Example.com") });
    expect(res.kind).toBe("free");
    const attendee = getDb().select().from(schema.attendees).where(eq(schema.attendees.eventId, event.id)).get()!;
    expect(attendee).toMatchObject({ email: "jordan@example.com", firstName: "Jordan", licenseState: "OK", status: "registered", textConsent: true });
    expect(attendee.qrToken.length).toBeGreaterThan(10);
    const welcome = outbox.filter((m) => m.to === "jordan@example.com");
    expect(welcome).toHaveLength(1);
    expect(welcome[0].subject).toBe("You're registered for NABC 2027, Jordan");
    expect(welcome[0].html).toContain(`${ENV.appUrl}/get/${event.slug}`);
    expect(welcome[0].html).toContain(`/r/${event.slug}/calendar.ics`);
    expect(welcome[0].html).toContain(`/r/${event.slug}/qr/`);
    const outboxRow = getDb().select().from(schema.platformOutbox).get()!;
    expect(outboxRow.payload).toMatchObject({ email: "jordan@example.com", tags: ["NABC 2027 registered"] });
    const token = (res as { doneUrl: string }).doneUrl.match(/order=([^&]+)/)![1];
    const done = await pub.registration.done({ slug: event.slug, order: token });
    expect(done).toMatchObject({ status: "registered", firstName: "Jordan" });
    // Registering again with the same email is refused.
    await expect(pub.registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("jordan@example.com") })).rejects.toThrow(/already registered/);
  });

  it("requires the questions the page marks required", async () => {
    const { event, nonmember } = await setup();
    setTicket(nonmember.id, { active: true });
    await expect(caller(null).registration.check({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("a@example.com", { licenseNumber: "" }) })).rejects.toThrow(/License number/);
  });

  it("applies coupons and counts their use", async () => {
    const { event, org, admin, nonmember } = await setup();
    connectStripe(org.id);
    setTicket(nonmember.id, { active: true, priceCents: 40000 });
    await admin.registration.coupons.save({ eventId: event.id, code: "group10", percentOff: 10, amountOffCents: null, maxUses: null, endsOn: null, active: true });
    await admin.registration.coupons.save({ eventId: event.id, code: "SPEAKER27", percentOff: 100, amountOffCents: null, maxUses: 1, endsOn: null, active: true });
    const pub = caller(null);
    const q = await pub.registration.quote({ slug: event.slug, ticketId: nonmember.id, coupon: "Group10" });
    expect(q).toMatchObject({ subtotalCents: 40000, discountCents: 4000, amountCents: 36000, couponCode: "GROUP10" });
    await expect(pub.registration.quote({ slug: event.slug, ticketId: nonmember.id, coupon: "NOPE" })).rejects.toThrow(/not valid/);
    const res = await pub.registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("speaker@example.com"), coupon: "speaker27" });
    expect(res.kind).toBe("free");
    const c = getDb().select().from(schema.coupons).where(eq(schema.coupons.code, "SPEAKER27")).get()!;
    expect(c.used).toBe(1);
    await expect(pub.registration.quote({ slug: event.slug, ticketId: nonmember.id, coupon: "SPEAKER27" })).rejects.toThrow(/not valid/);
  });

  it("hides a ticket after its sale ends and shows the one it switches to", async () => {
    const { event, admin, member } = await setup();
    setTicket(member.id, { active: true, priceCents: 30000 });
    const { id: earlyId } = await admin.registration.tickets.save({ eventId: event.id, name: "Member, early bird", priceCents: 25000, quantity: 300, saleEndsOn: "2027-02-01", afterSale: "switch", switchToTicketId: member.id, includes: "All 3 days", audience: "members", active: true });
    const ev = getDb().select().from(schema.events).where(eq(schema.events.id, event.id)).get()!;
    const before = ticketsOnSale(ev, { now: new Date("2027-02-01T20:00:00Z") }).map((t) => t.name);
    expect(before).toContain("Member, early bird");
    expect(before).not.toContain("Member");
    const after = ticketsOnSale(ev, { now: new Date("2027-02-02T12:00:00Z") }).map((t) => t.name);
    expect(after).toContain("Member");
    expect(after).not.toContain("Member, early bird");
    // Switching needs a date.
    await expect(admin.registration.tickets.save({ eventId: event.id, id: earlyId, name: "Member, early bird", priceCents: 25000, quantity: 300, saleEndsOn: null, afterSale: "switch", switchToTicketId: member.id, includes: "All 3 days", audience: "members", active: true })).rejects.toThrow();
  });

  it("sells member tickets only to active members", async () => {
    const { event, org, member } = await setup();
    setTicket(member.id, { active: true });
    const pub = caller(null);
    await expect(pub.registration.check({ slug: event.slug, ticketId: member.id, buyer: buyer("guest@example.com") })).rejects.toThrow(/active members/);
    getDb().insert(schema.members).values({ orgId: org.id, email: "member@example.com", firstName: "Mia", lastName: "Member", memberNumber: "1001", cardToken: "card-1", status: "active" }).run();
    getDb().insert(schema.members).values({ orgId: org.id, email: "lapsed@example.com", firstName: "Lee", lastName: "Lapsed", memberNumber: "1002", cardToken: "card-2", status: "lapsed" }).run();
    await expect(pub.registration.check({ slug: event.slug, ticketId: member.id, buyer: buyer("Member@Example.com") })).resolves.toMatchObject({ amountCents: 0 });
    await expect(pub.registration.check({ slug: event.slug, ticketId: member.id, buyer: buyer("lapsed@example.com") })).rejects.toThrow(/active members/);
  });

  it("pays on the connected account and fulfills only once", async () => {
    const stripe = fakeStripe();
    ENV.platformFeeCents = 100;
    ENV.platformFeePercent = 2;
    const { event, org, nonmember } = await setup();
    connectStripe(org.id);
    setTicket(nonmember.id, { active: true, priceCents: 40000 });
    const pub = caller(null);
    const res = await pub.registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("pay@example.com") });
    expect(res).toEqual({ kind: "paid", clientSecret: "cs_secret_123" });
    const [params, opts] = stripe.checkout.sessions.create.mock.calls[0] as unknown as [Record<string, any>, Record<string, any>];
    expect(opts.stripeAccount).toBe("acct_test_1");
    expect(params.ui_mode).toBe("embedded_page");
    expect(params.payment_intent_data.application_fee_amount).toBe(100 + 800);
    expect(params.return_url).toBe(`${ENV.appUrl}/r/${event.slug}/done?session_id={CHECKOUT_SESSION_ID}`);
    const order = getDb().select().from(schema.orders).where(eq(schema.orders.email, "pay@example.com")).get()!;
    expect(order.status).toBe("pending");
    await Promise.all([fulfillOrder(order.id, { paymentIntentId: "pi_test_1" }), fulfillOrder(order.id, { paymentIntentId: "pi_test_1" })]);
    const done = await pub.registration.done({ slug: event.slug, sessionId: order.stripeSessionId! });
    expect(done.status).toBe("registered");
    expect(getDb().select().from(schema.attendees).where(eq(schema.attendees.email, "pay@example.com")).all()).toHaveLength(1);
    expect(outbox.filter((m) => m.to === "pay@example.com")).toHaveLength(1);
    expect(getDb().select().from(schema.orders).where(eq(schema.orders.id, order.id)).get()).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_test_1", feeCents: 900 });
  });

  it("the confirmation page fulfills a paid session the webhook has not reached", async () => {
    const stripe = fakeStripe();
    const { event, org, nonmember } = await setup();
    connectStripe(org.id);
    setTicket(nonmember.id, { active: true, priceCents: 40000 });
    const pub = caller(null);
    await pub.registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("done@example.com") });
    const order = getDb().select().from(schema.orders).where(eq(schema.orders.email, "done@example.com")).get()!;
    const done = await pub.registration.done({ slug: event.slug, sessionId: order.stripeSessionId! });
    expect(done).toMatchObject({ status: "registered", firstName: "Jordan", email: "done@example.com" });
    expect(stripe.checkout.sessions.retrieve.mock.calls[0][2]).toEqual({ stripeAccount: "acct_test_1" });
  });

  it("refuses payment when the organization has not connected Stripe", async () => {
    const { event, nonmember } = await setup();
    setTicket(nonmember.id, { active: true, priceCents: 40000 });
    await expect(caller(null).registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("x@example.com") })).rejects.toThrow(/not taking payments/);
  });

  it("rejects webhooks with a bad signature and handles signed ones", async () => {
    const { event, org, nonmember } = await setup();
    connectStripe(org.id);
    setTicket(nonmember.id, { active: true, priceCents: 40000 });
    await caller(null).registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("hook@example.com") });
    const order = getDb().select().from(schema.orders).where(eq(schema.orders.email, "hook@example.com")).get()!;
    const payload = JSON.stringify({
      id: "evt_1",
      object: "event",
      type: "checkout.session.completed",
      account: "acct_test_1",
      data: { object: { id: order.stripeSessionId, object: "checkout.session", payment_status: "paid", payment_intent: "pi_hook_1" } },
    });
    const bad = await handleWebhookRequest(payload, "t=1,v1=nope");
    expect(bad.status).toBe(400);
    expect(getDb().select().from(schema.orders).where(eq(schema.orders.id, order.id)).get()!.status).toBe("pending");

    // Through Express too, on the raw body.
    const app = express();
    registrationArea.registerRawHttp!(app);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const r1 = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=nope" }, body: payload });
      expect(r1.status).toBe(400);
      const header = realWebhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
      const r2 = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": header }, body: payload });
      expect(r2.status).toBe(200);
      // Stripe retries: the second delivery changes nothing.
      const r3 = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": header }, body: payload });
      expect(r3.status).toBe(200);
    } finally {
      server.close();
    }
    expect(getDb().select().from(schema.orders).where(eq(schema.orders.id, order.id)).get()).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_hook_1" });
    expect(outbox.filter((m) => m.to === "hook@example.com")).toHaveLength(1);

    // An event from a different account is ignored.
    const other = JSON.stringify({ id: "evt_2", object: "event", type: "charge.refunded", account: "acct_other", data: { object: { id: "ch_1", object: "charge", payment_intent: "pi_hook_1", refunded: true, amount: 40000, amount_refunded: 40000 } } });
    await handleWebhookRequest(other, realWebhooks.generateTestHeaderString({ payload: other, secret: WEBHOOK_SECRET }));
    expect(getDb().select().from(schema.orders).where(eq(schema.orders.id, order.id)).get()!.status).toBe("paid");
    const refund = other.replace("acct_other", "acct_test_1");
    await handleWebhookRequest(refund, realWebhooks.generateTestHeaderString({ payload: refund, secret: WEBHOOK_SECRET }));
    expect(getDb().select().from(schema.orders).where(eq(schema.orders.id, order.id)).get()!.status).toBe("refunded");
    expect(getDb().select().from(schema.attendees).where(eq(schema.attendees.email, "hook@example.com")).get()!.status).toBe("cancelled");
  });

  it("refunds on the connected account from the Payments tab", async () => {
    const stripe = fakeStripe();
    const { event, org, admin, nonmember } = await setup();
    connectStripe(org.id);
    setTicket(nonmember.id, { active: true, priceCents: 40000 });
    await caller(null).registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("refund@example.com") });
    const order = getDb().select().from(schema.orders).where(eq(schema.orders.email, "refund@example.com")).get()!;
    await fulfillOrder(order.id, { paymentIntentId: "pi_refund_1" });
    const list = await admin.registration.payments.list({ eventId: event.id });
    expect(list[0]).toMatchObject({ name: "Jordan Ellis", ticketName: "Nonmember", status: "paid", amountCents: 40000 });
    expect((await admin.registration.summary({ eventId: event.id })).revenueCents).toBe(40000);
    const orgList = await admin.registration.payments.forOrg({ orgId: org.id });
    expect(orgList[0]).toMatchObject({ name: "Jordan Ellis", eventName: "NABC 2027", eventId: event.id, status: "paid" });
    expect(orgList[0]).not.toHaveProperty("buyer");
    await admin.registration.payments.refund({ eventId: event.id, orderId: order.id });
    expect(stripe.refunds.create.mock.calls[0]).toEqual([expect.objectContaining({ payment_intent: "pi_refund_1" }), { stripeAccount: "acct_test_1" }]);
    expect(getDb().select().from(schema.orders).where(eq(schema.orders.id, order.id)).get()!.status).toBe("refunded");
    expect(getDb().select().from(schema.attendees).where(eq(schema.attendees.email, "refund@example.com")).get()!.status).toBe("cancelled");
    await expect(admin.registration.payments.refund({ eventId: event.id, orderId: order.id })).rejects.toThrow(/Only paid/);
  });

  it("connects the organization's own Stripe account with Connect with Stripe, like LeadDash EHR", async () => {
    const stripe = fakeStripe();
    const { org, admin, owner } = await setup();
    const prev = ENV.stripeConnectClientId;
    (ENV as { stripeConnectClientId: string }).stripeConnectClientId = "ca_test_1";
    try {
      const { url } = await admin.registration.stripe.connect({ orgId: org.id });
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe("https://connect.stripe.com/oauth/authorize");
      expect(u.searchParams.get("client_id")).toBe("ca_test_1");
      expect(u.searchParams.get("scope")).toBe("read_write");
      expect(u.searchParams.get("redirect_uri")).toBe(`${ENV.appUrl}/api/stripe/connect/callback`);
      // A forged or stale state is refused; the real one connects the account.
      await expect(finishConnect("code_1", "1.1.1.bad")).rejects.toThrow(/did not start/);
      const out = await finishConnect("code_1", u.searchParams.get("state")!);
      expect(out).toMatchObject({ orgId: org.id, accountId: "acct_test_1", userId: owner.id });
      expect(stripe.oauth.token.mock.calls[0][0]).toMatchObject({ grant_type: "authorization_code", code: "code_1" });
      const status = await admin.registration.stripe.status({ orgId: org.id });
      expect(status).toMatchObject({ connected: true, chargesEnabled: true, bankLast4: "6789", payMethods: { card: "active", klarna: "active", afterpay: "inactive" } });
      expect(signState(org.id, owner.id, Date.now() - 31 * 60_000)).toBeTruthy();
      await expect(finishConnect("code_2", signState(org.id, owner.id, Date.now() - 31 * 60_000))).rejects.toThrow(/30 minutes/);
      await admin.registration.stripe.disconnect({ orgId: org.id });
      expect(stripe.oauth.deauthorize.mock.calls[0][0]).toMatchObject({ client_id: "ca_test_1", stripe_user_id: "acct_test_1" });
      expect((await admin.registration.stripe.status({ orgId: org.id })).connected).toBe(false);
    } finally {
      (ENV as { stripeConnectClientId: string }).stripeConnectClientId = prev;
    }
  });

  it("leaves Klarna and Afterpay out of checkout when the event turns pay over time off", async () => {
    const stripe = fakeStripe();
    const { event, org, admin, nonmember } = await setup();
    connectStripe(org.id);
    setTicket(nonmember.id, { active: true, priceCents: 25000 });
    const pub = caller(null);
    await pub.registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("bnpl-on@example.com") });
    expect(stripe.checkout.sessions.create.mock.calls.at(-1)![0]).not.toHaveProperty("excluded_payment_method_types");
    expect(stripe.checkout.sessions.create.mock.calls.at(-1)![0]).not.toHaveProperty("payment_method_types");
    const page = await admin.registration.checkout.get({ eventId: event.id });
    await admin.registration.checkout.save({ eventId: event.id, coverFileId: page.coverFileId, headline: page.headline, description: page.description, buttonLabel: page.buttonLabel, ticketIds: page.ticketIds, questions: page.questions, showConfirmation: page.showConfirmation, sendWelcome: page.sendWelcome, platformTag: page.platformTag, embedStyle: page.embedStyle, payOverTime: false });
    await pub.registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("bnpl-off@example.com") });
    expect(stripe.checkout.sessions.create.mock.calls.at(-1)![0]).toMatchObject({ excluded_payment_method_types: ["klarna", "afterpay_clearpay"] });
  });

  it("sends follow-ups when they are due, honoring text consent and app opens", async () => {
    const { event, nonmember } = await setup();
    setTicket(nonmember.id, { active: true });
    const pub = caller(null);
    await pub.registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("texts@example.com") });
    await pub.registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("notexts@example.com", { textConsent: false }) });
    await pub.registration.start({ slug: event.slug, ticketId: nonmember.id, buyer: buyer("hasapp@example.com") });
    getDb().update(schema.attendees).set({ appOpenedAt: new Date() }).where(eq(schema.attendees.email, "hasapp@example.com")).run();
    outbox.length = 0;

    await runFollowUps(new Date());
    expect(textLog.map((t) => t.phone)).toHaveLength(2); // texts and hasapp agreed to texts
    expect(textLog[0].message).toContain(`/get/${event.slug}`);
    const logFor = (email: string, kind: string) => {
      const a = getDb().select().from(schema.attendees).where(eq(schema.attendees.email, email)).get()!;
      return getDb().select().from(schema.messageLog).all().find((l) => l.attendeeId === a.id && l.kind === kind);
    };
    expect(logFor("notexts@example.com", "text_app")?.status).toBe("skipped");
    expect(outbox).toHaveLength(0);

    // App reminder: 7 days before the Apr 22, 2027 start, 9:00 AM Chicago (14:00 UTC).
    await runFollowUps(new Date("2027-04-15T13:59:00Z"));
    expect(outbox).toHaveLength(0);
    await runFollowUps(new Date("2027-04-15T14:01:00Z"));
    expect(outbox.map((m) => m.to).sort()).toEqual(["notexts@example.com", "texts@example.com"]);
    expect(logFor("hasapp@example.com", "app_reminder")?.status).toBe("skipped");
    await runFollowUps(new Date("2027-04-15T15:00:00Z"));
    expect(outbox).toHaveLength(2);

    // Know before you go: 2 days before.
    await runFollowUps(new Date("2027-04-20T14:05:00Z"));
    expect(outbox.filter((m) => m.subject.startsWith("Know before you go"))).toHaveLength(3);

    // The morning-of text is off by default; turned on, it goes at 7:00 AM.
    getDb().update(schema.messageTemplates).set({ enabled: true }).where(eq(schema.messageTemplates.kind, "morning_text")).run();
    textLog.length = 0;
    await runFollowUps(new Date("2027-04-22T11:59:00Z"));
    expect(textLog).toHaveLength(0);
    await runFollowUps(new Date("2027-04-22T12:01:00Z"));
    expect(textLog).toHaveLength(2);
  });

  it("previews and sends a test of the welcome email", async () => {
    const { event, admin } = await setup();
    const [welcome] = await admin.registration.templates.list({ eventId: event.id });
    const draft = { kind: welcome.kind, enabled: true, sendRule: welcome.sendRule, onlyIfNoApp: false, fromName: "NABC Conference Team", replyTo: "", subject: welcome.subject, body: welcome.body, includes: welcome.includes };
    const preview = await admin.registration.templates.preview({ eventId: event.id, ...draft });
    expect(preview.subject).toBe("You're registered for NABC 2027, Olivia");
    expect(preview.html).toContain("data:image/png;base64");
    const sent = await admin.registration.templates.sendTest({ eventId: event.id, ...draft });
    expect(sent.to).toBe("owner@example.org");
    expect(outbox.at(-1)!.subject).toBe("Test: You're registered for NABC 2027, Olivia");
  });

  it("keeps attendees and the public out of admin routes", async () => {
    const { event, org } = await setup();
    const { api } = addAttendee(event.id, "a@example.com");
    await expect(api.registration.tickets.list({ eventId: event.id })).rejects.toThrow(/access/);
    await expect(api.registration.payments.list({ eventId: event.id })).rejects.toThrow(/access/);
    await expect(api.registration.stripe.connect({ orgId: org.id })).rejects.toThrow(/access/);
    await expect(api.registration.payments.forOrg({ orgId: org.id })).rejects.toThrow(/access/);
    await expect(api.registration.templates.list({ eventId: event.id })).rejects.toThrow(/access/);
    await expect(caller(null).registration.summary({ eventId: event.id })).rejects.toThrow(/sign in/i);
    const outsider = caller(user("other-admin@example.org"));
    await expect(outsider.registration.checkout.get({ eventId: event.id })).rejects.toThrow(/access/);
  });

  it("serves the calendar file and the embed script", async () => {
    const { event } = await setup();
    const app = express();
    registrationArea.registerHttp!(app);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const ics = await fetch(`http://127.0.0.1:${port}/r/${event.slug}/calendar.ics`);
      expect(ics.headers.get("content-type")).toContain("text/calendar");
      const body = await ics.text();
      expect(body).toContain("DTSTART;VALUE=DATE:20270422");
      expect(body).toContain("DTEND;VALUE=DATE:20270425");
      const js = await fetch(`http://127.0.0.1:${port}/embed.js`);
      expect(await js.text()).toContain("leaddash-checkout");
      const { attendee } = addAttendee(event.id, "qr@example.com");
      const png = await fetch(`http://127.0.0.1:${port}/r/${event.slug}/qr/${attendee.qrToken}.png`);
      expect(png.headers.get("content-type")).toBe("image/png");
      expect((await fetch(`http://127.0.0.1:${port}/r/${event.slug}/qr/nope.png`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
