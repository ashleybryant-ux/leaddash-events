/**
 * Registration rules shared by the routes, the webhook and the jobs:
 * which tickets are on sale, prices and coupons, and fulfillment (one
 * function for the webhook and the confirmation page, safe to call twice).
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../../_core/db";
import { randomToken } from "../../_core/crypto";
import { queueContact } from "../../_core/platform";
import { dateToZoned } from "@shared/time";
import type { CheckoutQuestion, TicketType } from "../../../drizzle/schema";
import { sendWelcome } from "./messages";

type Event = typeof schema.events.$inferSelect;
type Coupon = typeof schema.coupons.$inferSelect;

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

/** Today's calendar date where the event happens ("2027-02-01"). */
export const eventToday = (ev: Pick<Event, "timezone">, now = new Date()) => dateToZoned(now, ev.timezone || "America/Chicago").date;

/** A sale that ends on a date runs through the end of that day in the event's time zone. */
export const saleEnded = (t: Pick<TicketType, "saleEndsOn">, today: string) => !!t.saleEndsOn && t.saleEndsOn < today;

/** Paid and free registrations per ticket (what counts against quantity). */
export function soldByTicket(eventId: number) {
  const rows = getDb()
    .select({ ticketTypeId: schema.orders.ticketTypeId, status: schema.orders.status })
    .from(schema.orders)
    .where(and(eq(schema.orders.eventId, eventId), inArray(schema.orders.status, ["paid", "free"])))
    .all();
  const sold = new Map<number, number>();
  for (const r of rows) sold.set(r.ticketTypeId, (sold.get(r.ticketTypeId) ?? 0) + 1);
  return sold;
}

export function registeredCount(eventId: number) {
  return getDb()
    .select({ id: schema.attendees.id })
    .from(schema.attendees)
    .where(and(eq(schema.attendees.eventId, eventId), eq(schema.attendees.status, "registered")))
    .all().length;
}

export type TicketOffer = {
  id: number;
  name: string;
  description: string;
  priceCents: number;
  includes: string;
  saleEndsOn: string | null;
  membersOnly: boolean;
  left: number | null;
  soldOut: boolean;
};

/**
 * Tickets a buyer can see right now. A ticket whose sale ended is hidden. If
 * it was set to switch, the ticket it switches to shows from then on (and
 * stays hidden while the first one is still on sale).
 */
export function ticketsOnSale(ev: Event, opts: { onlyIds?: number[]; now?: Date } = {}): TicketOffer[] {
  const db = getDb();
  const all = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, ev.id)).all();
  const today = eventToday(ev, opts.now);
  const sold = soldByTicket(ev.id);
  const pool = opts.onlyIds?.length ? all.filter((t) => opts.onlyIds!.includes(t.id)) : all;
  const waiting = new Set<number>();
  const switchedOn = new Set<number>();
  for (const t of pool) {
    if (!t.active || t.afterSale !== "switch" || !t.switchToTicketId) continue;
    if (saleEnded(t, today)) switchedOn.add(t.switchToTicketId);
    else waiting.add(t.switchToTicketId);
  }
  const full = ev.capacity ? registeredCount(ev.id) >= ev.capacity : false;
  const visible = all.filter((t) => {
    const listed = pool.includes(t) || switchedOn.has(t.id);
    if (!listed || saleEnded(t, today) || waiting.has(t.id)) return false;
    return t.active || switchedOn.has(t.id);
  });
  return visible
    .sort((a, b) => a.sort - b.sort || a.id - b.id)
    .map((t) => {
      const left = t.quantity == null ? null : Math.max(0, t.quantity - (sold.get(t.id) ?? 0));
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        priceCents: t.priceCents,
        includes: t.includes,
        saleEndsOn: t.saleEndsOn,
        membersOnly: t.audience === "members",
        left,
        soldOut: full || left === 0,
      };
    });
}

/** An active member of the association with this email. */
export function isActiveMember(orgId: number, email: string, today: string) {
  const m = getDb()
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.orgId, orgId), eq(schema.members.email, email.trim().toLowerCase())))
    .get();
  return !!m && m.status === "active" && (!m.expiresOn || m.expiresOn >= today);
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

export function findCoupon(ev: Event, code: string | undefined | null): Coupon | null {
  if (!code?.trim()) return null;
  const c = getDb()
    .select()
    .from(schema.coupons)
    .where(and(eq(schema.coupons.eventId, ev.id), eq(schema.coupons.code, normalizeCode(code))))
    .get();
  const today = eventToday(ev);
  if (!c || !c.active || (c.endsOn && c.endsOn < today) || (c.maxUses != null && c.used >= c.maxUses)) {
    throw bad("That coupon code is not valid.");
  }
  return c;
}

export function priceWith(priceCents: number, coupon: Coupon | null) {
  let discount = 0;
  if (coupon?.percentOff) discount = Math.round((priceCents * Math.min(100, coupon.percentOff)) / 100);
  else if (coupon?.amountOffCents) discount = Math.min(priceCents, coupon.amountOffCents);
  return { subtotalCents: priceCents, discountCents: discount, amountCents: Math.max(0, priceCents - discount) };
}

/** Default questions on a new checkout page. */
export const DEFAULT_QUESTIONS: CheckoutQuestion[] = [
  { key: "name_email", label: "Name and email", kind: "text", required: true, locked: true },
  { key: "mobile", label: "Mobile number", kind: "phone", required: true },
  { key: "credentials", label: "Credentials", kind: "text", required: false },
  { key: "license", label: "License number and state (for CE)", kind: "license", required: true },
  { key: "dietary", label: "Dietary needs", kind: "text", required: false },
  { key: "accessibility", label: "Accessibility needs", kind: "textarea", required: false },
];

/** Questions with name and email always first and locked. */
export function cleanQuestions(qs: CheckoutQuestion[]): CheckoutQuestion[] {
  const rest = qs.filter((q) => q.key !== "name_email");
  return [DEFAULT_QUESTIONS[0], ...rest];
}

export type Buyer = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  credentials: string;
  licenseNumber: string;
  licenseState: string;
  answers: Record<string, string>;
  textConsent: boolean;
};

/** Checks the buyer's answers against the page's required questions. */
export function checkAnswers(questions: CheckoutQuestion[], b: Buyer) {
  if (!b.firstName.trim() || !b.lastName.trim()) throw bad("Enter your first and last name.");
  for (const q of questions) {
    if (!q.required || q.locked) continue;
    const missing =
      q.key === "mobile" ? !b.phone.trim()
      : q.key === "credentials" ? !b.credentials.trim()
      : q.kind === "license" ? !b.licenseNumber.trim() || !b.licenseState.trim()
      : !(b.answers[q.key] ?? "").trim();
    if (missing) throw bad(`${q.label} is required.`);
  }
  if (b.textConsent && !b.phone.trim()) throw bad("Add a mobile number to get texts.");
}

export function checkoutPageFor(eventId: number) {
  const db = getDb();
  let page = db.select().from(schema.checkoutPages).where(eq(schema.checkoutPages.eventId, eventId)).get();
  if (!page) page = db.insert(schema.checkoutPages).values({ eventId, questions: DEFAULT_QUESTIONS }).returning().get();
  return page;
}

export function newDoneToken() {
  return randomToken(18);
}

/**
 * Turns a pending order into a registration. Used by the Stripe webhook, the
 * confirmation page and free registrations. Safe to call more than once: the
 * order moves from pending exactly once, and the welcome email is logged
 * once per attendee.
 */
export async function fulfillOrder(orderId: number, opts: { paymentIntentId?: string | null; free?: boolean } = {}) {
  const db = getDb();
  let order = db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  if (!order) return null;
  // The status change and everything after it run without awaiting, so two callers cannot both win.
  const won =
    order.status === "pending" &&
    db
      .update(schema.orders)
      .set({ status: opts.free ? "free" : "paid", paidAt: new Date(), stripePaymentIntentId: opts.paymentIntentId ?? order.stripePaymentIntentId })
      .where(and(eq(schema.orders.id, order.id), eq(schema.orders.status, "pending")))
      .run().changes === 1;
  if (won) {
    const b = order.buyer as Buyer;
    const email = order.email.toLowerCase();
    const ev = db.select().from(schema.events).where(eq(schema.events.id, order.eventId)).get()!;
    const existing = db
      .select()
      .from(schema.attendees)
      .where(and(eq(schema.attendees.eventId, order.eventId), eq(schema.attendees.email, email)))
      .get();
    const details = {
      firstName: b.firstName.trim(),
      lastName: b.lastName.trim(),
      phone: (b.phone ?? "").trim(),
      credentials: (b.credentials ?? "").trim(),
      licenseNumber: (b.licenseNumber ?? "").trim(),
      licenseState: (b.licenseState ?? "").trim().toUpperCase(),
      answers: b.answers ?? {},
      ...(b.answers?.organization ? { organization: b.answers.organization.trim() } : {}),
      ...(b.answers?.job_title ? { jobTitle: b.answers.job_title.trim() } : {}),
      textConsent: !!b.textConsent,
      ticketTypeId: order.ticketTypeId,
      status: "registered" as const,
    };
    const attendee = existing
      ? db.update(schema.attendees).set(details).where(eq(schema.attendees.id, existing.id)).returning().get()
      : db.insert(schema.attendees).values({ eventId: order.eventId, email, qrToken: randomToken(12), ...details }).returning().get();
    db.update(schema.orders).set({ attendeeId: attendee.id }).where(eq(schema.orders.id, order.id)).run();
    if (order.couponId) {
      const c = db.select().from(schema.coupons).where(eq(schema.coupons.id, order.couponId)).get();
      if (c) db.update(schema.coupons).set({ used: c.used + 1 }).where(eq(schema.coupons.id, c.id)).run();
    }
    const page = checkoutPageFor(order.eventId);
    if (page.platformTag.trim()) {
      queueContact(ev.orgId, { email, firstName: details.firstName, lastName: details.lastName, phone: details.phone, tags: [page.platformTag.trim()], source: "LeadDash Events" });
    }
  }
  order = db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get()!;
  if ((order.status === "paid" || order.status === "free") && order.attendeeId) {
    const page = checkoutPageFor(order.eventId);
    if (page.sendWelcome) await sendWelcome(order.attendeeId, { onlyIfDueNow: true });
  }
  return order;
}

/** A full refund: the order is refunded and the person's registration is cancelled. Safe to call twice. */
export function markRefunded(orderId: number) {
  const db = getDb();
  const order = db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  if (!order || order.status === "refunded") return order;
  db.update(schema.orders).set({ status: "refunded", refundedAt: new Date() }).where(eq(schema.orders.id, order.id)).run();
  if (order.attendeeId) {
    // Cancel only if no other paid or free order still covers this person.
    const others = db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.attendeeId, order.attendeeId), inArray(schema.orders.status, ["paid", "free"])))
      .all()
      .filter((o) => o.id !== order.id);
    if (!others.length) db.update(schema.attendees).set({ status: "cancelled" }).where(eq(schema.attendees.id, order.attendeeId)).run();
  }
  return db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
}
