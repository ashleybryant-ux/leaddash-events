import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, caller, setupEvent, addAttendee, outbox, getDb, schema } from "./helpers";
import { setStripeClient, type StripeLike } from "../server/areas/registration/stripe";
import { handleStripeEvent } from "../server/areas/registration/http";
import { businessDaysAfter, vendorStatus } from "../server/areas/network/vendors";
import type Stripe from "stripe";

function fakeStripe() {
  const fake = {
    checkout: {
      sessions: {
        create: vi.fn(async (..._args: unknown[]) => ({ id: `cs_link_${Math.random().toString(36).slice(2)}`, client_secret: "cs_secret_link" })),
        retrieve: vi.fn(async (id: string) => ({ id, status: "open", payment_status: "unpaid", client_secret: "cs_secret_again" })),
      },
    },
  };
  setStripeClient(fake as unknown as StripeLike);
  return fake;
}

async function setup() {
  const s = await setupEvent();
  const db = getDb();
  const ticket = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, s.event.id)).all()[0];
  db.update(schema.ticketTypes).set({ priceCents: 39500, active: true, name: "Full conference" }).where(eq(schema.ticketTypes.id, ticket.id)).run();
  const gold = await s.admin.network.packages.save({
    eventId: s.event.id,
    name: "Gold",
    kind: "sponsor",
    priceCents: 1_000_000,
    quantity: 2,
    passes: 2,
    passTicketTypeId: ticket.id,
    includesBooth: true,
    logoSpots: { welcome: true, topOfList: true, sessionPages: false },
    benefits: ["Logo on the welcome screen", "Booth in the exhibit hall"],
  });
  const bronze = await s.admin.network.packages.save({ eventId: s.event.id, name: "Bronze", kind: "sponsor", priceCents: 150_000, quantity: null, passes: 1, passTicketTypeId: null, includesBooth: false, logoSpots: { welcome: false, topOfList: false, sessionPages: false }, benefits: [] });
  return { ...s, ticket, goldId: gold.id, bronzeId: bronze.id };
}

const vendorRow = (list: Awaited<ReturnType<ReturnType<typeof caller>["network"]["vendors"]["list"]>>, id: number) => list.vendors.find((v) => v.id === id)!;

describe("sponsors and exhibitors", () => {
  beforeEach(async () => {
    await freshDb();
    setStripeClient(null);
  });

  it("creates a sponsor from a package and fills price, level and benefits", async () => {
    const { event, admin, goldId } = await setup();
    const v = await admin.network.vendors.create({ eventId: event.id, company: "Brightpath Health", kind: "sponsor", contactName: "Alex Morgan", email: "Alex@Example.com", status: "confirmed", packageId: goldId });
    expect(v).toMatchObject({ packageId: goldId, level: "Gold", amountCents: 1_000_000, email: "alex@example.com" });
    const list = await admin.network.vendors.list({ eventId: event.id });
    const row = vendorRow(list, v.id);
    expect(row.benefits.map((b) => b.label)).toEqual(["Logo on the welcome screen", "Booth in the exhibit hall"]);
    expect(row).toMatchObject({ packageName: "Gold", passesTotal: 2, passesUsed: 0, owedCents: 1_000_000, statusLabel: "Owed" });
    expect(list.packages.find((p) => p.id === goldId)!.sold).toBe(1);
    expect(list.strips.sponsors).toMatchObject({ soldCents: 1_000_000, owedCents: 1_000_000, passesTotal: 2 });
  });

  it("records payments, keeps paidCents in sync, and trims the scheduled charge", async () => {
    const { event, admin, owner, goldId } = await setup();
    const v = await admin.network.vendors.create({ eventId: event.id, company: "Brightpath Health", kind: "sponsor", status: "confirmed", packageId: goldId });
    getDb().update(schema.vendors).set({ nextChargeCents: 500_000, nextChargeOn: "2027-03-01", payMethodLabel: "Bank ending 6789" }).where(eq(schema.vendors.id, v.id)).run();
    getDb().insert(schema.vendorPayments).values({ eventId: event.id, vendorId: v.id, amountCents: 500_000, method: "bank", status: "pending", purpose: "deposit", paidOn: "2026-10-10", stripePaymentIntentId: "pi_1" }).run();
    let row = vendorRow(await admin.network.vendors.list({ eventId: event.id }), v.id);
    expect(row.statusLabel).toBe("Payment pending");
    expect(row.statusNote).toBe("bank deposit clears about Oct 16, 2026");
    expect(row.payments[0]).toMatchObject({ title: "$5,000.00 deposit", removable: false });
    expect(row.payments[0].detail).toBe("Bank ending 6789 · Oct 10, 2026 · Pending, clears about Oct 16, 2026");
    expect(row.nextChargeRemindOn).toBe("2027-02-22");

    await admin.network.packages.recordPayment({ eventId: event.id, vendorId: v.id, amountCents: 200_000, method: "check", paidOn: "2026-10-12", note: "2231" });
    let db = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
    expect(db.paidCents).toBe(200_000);
    expect(db.nextChargeCents).toBe(300_000);
    row = vendorRow(await admin.network.vendors.list({ eventId: event.id }), v.id);
    const check = row.payments.find((p) => p.method === "check")!;
    expect(check.detail).toBe(`Check 2231 · Oct 12, 2026 · Recorded by ${owner.name}`);
    expect(check.removable).toBe(true);

    await admin.network.packages.recordPayment({ eventId: event.id, vendorId: v.id, amountCents: 300_000, method: "cash", paidOn: "2026-10-13" });
    db = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
    expect(db).toMatchObject({ paidCents: 500_000, nextChargeCents: 0, nextChargeOn: null });

    await expect(admin.network.packages.removePayment({ eventId: event.id, paymentId: row.payments.find((p) => !p.removable)!.id })).rejects.toThrow(/Stripe/);
    await admin.network.packages.removePayment({ eventId: event.id, paymentId: check.id });
    expect(getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!.paidCents).toBe(300_000);
  });

  it("keeps an amount paid before payments were tracked", async () => {
    const { event, admin } = await setup();
    const v = await admin.network.vendors.create({ eventId: event.id, company: "Northline Billing", kind: "sponsor" });
    getDb().update(schema.vendors).set({ amountCents: 500_000, paidCents: 200_000 }).where(eq(schema.vendors.id, v.id)).run();
    expect(vendorRow(await admin.network.vendors.list({ eventId: event.id }), v.id).paidCents).toBe(200_000);
    await admin.network.packages.recordPayment({ eventId: event.id, vendorId: v.id, amountCents: 300_000, method: "card", paidOn: "2026-10-12" });
    const row = vendorRow(await admin.network.vendors.list({ eventId: event.id }), v.id);
    expect(row).toMatchObject({ paidCents: 500_000, statusLabel: "Paid" });
    expect(row.payments).toHaveLength(2);
  });

  it("works out the status from the agreement, payments and invoice hold", () => {
    const base = { status: "confirmed", amountCents: 1000, paidCents: 0, holdUntil: null, nextChargeCents: 0, nextChargeOn: null } as unknown as typeof schema.vendors.$inferSelect;
    const pay = (amountCents: number, status: "paid" | "pending") => ({ amountCents, status, paidOn: "2026-10-10" }) as unknown as typeof schema.vendorPayments.$inferSelect;
    const sent = { id: 1, status: "sent" } as unknown as typeof schema.agreements.$inferSelect;
    const signed = { id: 2, status: "signed" } as unknown as typeof schema.agreements.$inferSelect;
    expect(vendorStatus({ ...base, status: "cancelled" }, [], []).label).toBe("Cancelled");
    expect(vendorStatus(base, [], [sent]).label).toBe("Not signed");
    expect(vendorStatus(base, [], [sent, signed]).label).toBe("Owed");
    expect(vendorStatus(base, [pay(500, "pending")], []).label).toBe("Payment pending");
    expect(vendorStatus(base, [pay(1000, "paid")], []).label).toBe("Paid");
    expect(vendorStatus({ ...base, holdUntil: "2026-11-01" }, [], []).label).toBe("Invoice sent");
    expect(vendorStatus({ ...base, nextChargeCents: 500, nextChargeOn: "2027-03-01" }, [pay(500, "paid")], []).label).toBe("Deposit paid");
    expect(businessDaysAfter("2026-10-10", 5)).toBe("2026-10-16");
  });

  it("saves details, switches packages and toggles benefits", async () => {
    const { event, admin, goldId, bronzeId } = await setup();
    const v = await admin.network.vendors.create({ eventId: event.id, company: "Brightpath Health", kind: "sponsor", status: "confirmed", packageId: goldId });
    await admin.network.vendors.setBenefit({ eventId: event.id, vendorId: v.id, index: 1, done: true });
    const base = { eventId: event.id, vendorId: v.id, company: "Brightpath Health", kind: "both" as const, packageId: goldId, amountCents: 900_000, booth: "14", contactName: "Alex Morgan", email: "alex@example.com", phone: "(555) 555-0190", active: true, logoFileId: null, description: "", website: "", category: "", offer: "", notes: "", boothStaff: [], visible: true, leadScanning: true };
    await admin.network.vendors.saveDetails(base);
    let row = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
    expect(row).toMatchObject({ kind: "both", booth: "14", amountCents: 900_000 });
    expect(row.benefits[1]).toMatchObject({ status: "done" });
    await admin.network.vendors.saveDetails({ ...base, packageId: bronzeId, active: false });
    row = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
    expect(row).toMatchObject({ level: "Bronze", status: "cancelled", benefits: [] });
    await expect(admin.network.packages.remove({ eventId: event.id, packageId: bronzeId })).rejects.toThrow(/Brightpath Health has this package/);
  });

  it("orders sponsors in the app by package and shows the package name and logo spots", async () => {
    const { event, admin, goldId, bronzeId } = await setup();
    const a = addAttendee(event.id, "jordan@example.com");
    const big = await admin.network.vendors.create({ eventId: event.id, company: "Zed Bronze Giant", kind: "sponsor", status: "confirmed", packageId: bronzeId });
    getDb().update(schema.vendors).set({ amountCents: 5_000_000 }).where(eq(schema.vendors.id, big.id)).run();
    await admin.network.vendors.create({ eventId: event.id, company: "Alpha Gold", kind: "sponsor", status: "confirmed", packageId: goldId });
    await admin.network.packages.moveUp({ eventId: event.id, packageId: bronzeId });
    let list = await a.api.network.exhibitors.list({ slug: event.slug });
    expect(list.map((v) => v.company)).toEqual(["Zed Bronze Giant", "Alpha Gold"]);
    await admin.network.packages.moveUp({ eventId: event.id, packageId: goldId });
    list = await a.api.network.exhibitors.list({ slug: event.slug });
    expect(list.map((v) => v.level)).toEqual(["Gold", "Bronze"]);
    expect(list[0].logoSpots).toEqual({ welcome: true, topOfList: true, sessionPages: false });
  });

  it("guards add-on deletes and keeps writes to staff with edit access", async () => {
    const { event, admin, goldId } = await setup();
    const addon = await admin.network.packages.saveAddon({ eventId: event.id, name: "Extra booth staff pass", priceCents: 15000, quantity: null, packageIds: [goldId, 99999], addsPass: true });
    const v = await admin.network.vendors.create({ eventId: event.id, company: "Brightpath Health", kind: "sponsor", status: "confirmed", packageId: goldId });
    getDb().update(schema.vendors).set({ addons: [{ addonId: addon.id, name: "Extra booth staff pass", qty: 2, priceCents: 15000 }] }).where(eq(schema.vendors.id, v.id)).run();
    const pk = await admin.network.packages.list({ eventId: event.id });
    expect(pk.addons[0]).toMatchObject({ packageIds: [goldId], sold: 2 });
    expect(vendorRow(await admin.network.vendors.list({ eventId: event.id }), v.id).passesTotal).toBe(4);
    await expect(admin.network.packages.removeAddon({ eventId: event.id, addonId: addon.id })).rejects.toThrow(/cannot be deleted/);
    const a = addAttendee(event.id, "jordan@example.com");
    await expect(a.api.network.packages.list({ eventId: event.id })).rejects.toThrow();
    await expect(a.api.network.packages.recordPayment({ eventId: event.id, vendorId: v.id, amountCents: 100, method: "cash", paidOn: "2026-10-10" })).rejects.toThrow();
  });
});

describe("add attendee with payment", () => {
  beforeEach(async () => {
    await freshDb();
    setStripeClient(null);
  });

  it("adds a sponsor guest on a sponsor pass and lists the pass on the sponsor", async () => {
    const { event, admin, ticket, goldId } = await setup();
    const v = await admin.network.vendors.create({ eventId: event.id, company: "Brightpath Health", kind: "sponsor", status: "confirmed", packageId: goldId });
    const people = await admin.ce.attendees.vendors({ eventId: event.id });
    expect(people[0]).toMatchObject({ company: "Brightpath Health", packageName: "Gold", passesTotal: 2, passesUsed: 0 });
    const { id } = await admin.ce.attendees.add({ eventId: event.id, firstName: "Chris", lastName: "Patel", email: "chris@example.com", ticketTypeId: ticket.id, kind: "sponsor", vendorId: v.id, payment: { mode: "sponsor_pass" }, sendWelcome: true });
    const order = getDb().select().from(schema.orders).where(eq(schema.orders.attendeeId, id)).get()!;
    expect(order).toMatchObject({ status: "free", method: "sponsor_pass", amountCents: 0 });
    expect(outbox.some((m) => m.to === "chris@example.com")).toBe(true);
    const row = vendorRow(await admin.network.vendors.list({ eventId: event.id }), v.id);
    expect(row.passPeople.map((p) => p.name)).toEqual(["Chris Patel"]);
    const list = await admin.ce.attendees.list({ eventId: event.id });
    expect(list.find((r) => r.id === id)!.payment).toMatchObject({ kind: "sponsor_pass" });
    await admin.network.packages.removePass({ eventId: event.id, attendeeId: id });
    expect(getDb().select().from(schema.attendees).where(eq(schema.attendees.id, id)).get()).toMatchObject({ status: "cancelled", vendorId: null });
  });

  it("records a ticket paid outside the app and a complimentary one", async () => {
    const { event, admin, owner, ticket } = await setup();
    const { id } = await admin.ce.attendees.add({ eventId: event.id, firstName: "Maya", lastName: "Torres", email: "maya@example.com", ticketTypeId: ticket.id, kind: "attendee", payment: { mode: "outside", amountCents: 39500, method: "check", paidOn: "2026-10-09", reference: "1042" } });
    expect(getDb().select().from(schema.orders).where(eq(schema.orders.attendeeId, id)).get()).toMatchObject({ status: "paid", method: "check", amountCents: 39500, reference: "1042", paidOn: "2026-10-09", recordedBy: owner.id });
    const comp = await admin.ce.attendees.add({ eventId: event.id, firstName: "Sam", lastName: "Rivera", email: "sam@example.com", ticketTypeId: ticket.id, kind: "volunteer", payment: { mode: "comp" } });
    const rows = await admin.ce.attendees.list({ eventId: event.id });
    expect(rows.find((r) => r.id === id)!.payment).toMatchObject({ kind: "outside", method: "check" });
    expect(rows.find((r) => r.id === comp.id)!).toMatchObject({ kind: "volunteer", payment: { kind: "comp" } });
    expect(outbox).toHaveLength(0);
  });

  it("emails a payment link and registers the person when the order is paid", async () => {
    const { event, org, admin, ticket } = await setup();
    await expect(admin.ce.attendees.add({ eventId: event.id, firstName: "Dana", lastName: "Brooks", email: "dana@example.com", ticketTypeId: ticket.id, kind: "attendee", payment: { mode: "link" } })).rejects.toThrow(/Connect Stripe/);
    const stripe = fakeStripe();
    getDb().insert(schema.stripeAccounts).values({ orgId: org.id, accountId: "acct_test_1", businessName: "Sample", chargesEnabled: true, payoutsEnabled: true }).run();
    const { id } = await admin.ce.attendees.add({ eventId: event.id, firstName: "Dana", lastName: "Brooks", email: "dana@example.com", ticketTypeId: ticket.id, kind: "attendee", payment: { mode: "link" }, sendWelcome: true });
    expect(getDb().select().from(schema.attendees).where(eq(schema.attendees.id, id)).get()!.status).toBe("pending");
    const order = getDb().select().from(schema.orders).where(eq(schema.orders.attendeeId, id)).get()!;
    expect(order).toMatchObject({ status: "pending", method: "link", amountCents: 39500 });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].subject).toMatch(/^Pay for your ticket/);
    expect(outbox[0].text).toContain(`/r/${event.slug}/pay?order=${order.doneToken}`);
    expect((await admin.ce.attendees.list({ eventId: event.id })).find((r) => r.id === id)!.payment).toMatchObject({ kind: "unpaid" });

    const pub = caller(null);
    const started = await pub.registration.payOrder({ slug: event.slug, order: order.doneToken! });
    expect(started).toMatchObject({ kind: "pay", clientSecret: "cs_secret_link", amountCents: 39500 });
    const [params, opts] = stripe.checkout.sessions.create.mock.calls[0] as unknown as [Record<string, any>, Record<string, any>];
    expect(opts.stripeAccount).toBe("acct_test_1");
    expect(params.line_items[0].price_data.unit_amount).toBe(39500);
    // Opening the link again reuses the open session.
    expect(await pub.registration.payOrder({ slug: event.slug, order: order.doneToken! })).toMatchObject({ kind: "pay", clientSecret: "cs_secret_again" });

    const sessionId = getDb().select().from(schema.orders).where(eq(schema.orders.id, order.id)).get()!.stripeSessionId!;
    const result = await handleStripeEvent({ type: "checkout.session.completed", account: "acct_test_1", data: { object: { id: sessionId, payment_status: "paid", payment_intent: "pi_link_1" } } } as unknown as Stripe.Event);
    expect(result).toBe("fulfilled");
    expect(getDb().select().from(schema.attendees).where(eq(schema.attendees.eventId, event.id)).all().filter((a) => a.email === "dana@example.com")).toHaveLength(1);
    expect(getDb().select().from(schema.attendees).where(eq(schema.attendees.id, id)).get()).toMatchObject({ status: "registered", kind: "attendee" });
    expect((await admin.ce.attendees.list({ eventId: event.id })).find((r) => r.id === id)!.payment).toMatchObject({ kind: "online" });
    expect(await pub.registration.payOrder({ slug: event.slug, order: order.doneToken! })).toMatchObject({ kind: "done" });
  });
});
