/**
 * Attendees admin (area "attendees"): the list, editing in place, adding,
 * cancelling and restoring, CSV import and export.
 * The welcome email and receipts belong to registration.
 */
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, requireArea } from "../../_core/access";
import { randomToken } from "../../_core/crypto";
import { ENV } from "../../_core/env";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { fmtDates, fmtMoney, fullName } from "@shared/format";
import { badRequest, evaluationWindow, formForSession, getAttendee, parseCsv, toCsv } from "./shared";
import { coverFor, sendWelcome } from "../registration/messages";
import { newDoneToken } from "../registration/logic";
import { accountRow } from "../registration/connect";
import { stripeConfigured } from "../registration/stripe";
import { vendorPassSummary } from "../network/vendors";

const KINDS = ["attendee", "speaker", "vendor", "staff", "guest", "volunteer", "sponsor"] as const;

const details = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  credentials: z.string().trim().max(80).default(""),
  phone: z.string().trim().max(40).default(""),
  city: z.string().trim().max(120).default(""),
  organization: z.string().trim().max(160).default(""),
  jobTitle: z.string().trim().max(160).default(""),
  licenseNumber: z.string().trim().max(60).default(""),
  licenseState: z.string().trim().max(40).default(""),
  ticketTypeId: z.number().int().nullable(),
  kind: z.enum(KINDS),
});

function checkTicket(eventId: number, ticketTypeId: number | null) {
  if (!ticketTypeId) return;
  const t = getDb().select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, ticketTypeId)).get();
  if (!t || t.eventId !== eventId) throw badRequest("Pick a ticket for this event.");
}

/** Every attendee with check-in, sessions attended, CE hours and whether an evaluation is waiting. */
export function attendeeRows(eventId: number) {
  const db = getDb();
  const ev = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get()!;
  const people = db.select().from(schema.attendees).where(eq(schema.attendees.eventId, eventId)).all();
  const tickets = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, eventId)).all();
  const sessions = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, eventId)).all();
  const sessionIds = sessions.map((s) => s.id);
  const checkins = sessionIds.length ? db.select().from(schema.sessionCheckins).where(inArray(schema.sessionCheckins.sessionId, sessionIds)).all() : [];
  const responses = sessionIds.length ? db.select({ sessionId: schema.evaluationResponses.sessionId, attendeeId: schema.evaluationResponses.attendeeId }).from(schema.evaluationResponses).where(inArray(schema.evaluationResponses.sessionId, sessionIds)).all() : [];
  const certs = db.select().from(schema.certificates).where(eq(schema.certificates.eventId, eventId)).all().filter((c) => !c.revokedAt);
  const orders = db.select().from(schema.orders).where(eq(schema.orders.eventId, eventId)).orderBy(desc(schema.orders.id)).all().filter((o) => o.attendeeId);
  const latestOrder = new Map<number, (typeof orders)[number]>();
  for (const o of orders) {
    // The newest order that counts: paid, free, refunded, or a payment link still waiting.
    if (!latestOrder.has(o.attendeeId!) && (o.status !== "pending" || o.method === "link") && o.status !== "failed" && o.status !== "expired") latestOrder.set(o.attendeeId!, o);
  }
  const openEval = new Map<number, boolean>();
  for (const s of sessions) {
    if (!(s.ceHours > 0)) continue;
    const form = formForSession(s);
    openEval.set(s.id, !!form && evaluationWindow(form, s, ev.timezone).state === "open");
  }
  const done = new Set(responses.map((r) => `${r.sessionId}:${r.attendeeId}`));
  return people.map((a) => {
    const mine = checkins.filter((c) => c.attendeeId === a.id);
    return {
      id: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      name: fullName(a),
      credentials: a.credentials,
      email: a.email,
      phone: a.phone,
      city: a.city,
      organization: a.organization,
      jobTitle: a.jobTitle,
      licenseNumber: a.licenseNumber,
      licenseState: a.licenseState,
      ticketTypeId: a.ticketTypeId,
      ticket: tickets.find((t) => t.id === a.ticketTypeId)?.name ?? "",
      kind: a.kind,
      status: a.status,
      vendorId: a.vendorId,
      payment: paymentOf(latestOrder.get(a.id)),
      checkedInAt: a.checkedInAt,
      badgePrints: a.badgePrints,
      appOpenedAt: a.appOpenedAt,
      sessions: mine.length,
      ceHours: Math.round(certs.filter((c) => c.attendeeId === a.id).reduce((n, c) => n + c.hours, 0) * 100) / 100,
      evaluationsDue: mine.filter((c) => openEval.get(c.sessionId) && !done.has(`${c.sessionId}:${a.id}`)).length,
    };
  });
}

type Order = typeof schema.orders.$inferSelect;
export type PaymentKind = "online" | "outside" | "sponsor_pass" | "comp" | "free" | "unpaid" | "refunded";

/** How a person's registration was paid, for the Payment column. */
function paymentOf(o: Order | undefined): { kind: PaymentKind; method: Order["method"]; amountCents: number } | null {
  if (!o) return null;
  const kind: PaymentKind =
    o.status === "refunded" ? "refunded"
    : o.status === "pending" ? "unpaid"
    : o.method === "sponsor_pass" ? "sponsor_pass"
    : o.method === "comp" ? "comp"
    : o.status === "free" ? "free"
    : o.method === "stripe" || o.method === "link" ? "online"
    : "outside";
  return { kind, method: o.method, amountCents: o.amountCents };
}

const paymentIn = z.object({
  mode: z.enum(["sponsor_pass", "comp", "outside", "link"]),
  amountCents: z.number().int().min(0).max(10_000_000).default(0),
  method: z.enum(["check", "cash", "invoice", "other"]).default("check"),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).default(""),
  reference: z.string().trim().max(60).default(""),
});

/** The link that pays a pending order on the event's checkout page. */
export const payLink = (slug: string, doneToken: string) => `${ENV.appUrl}/r/${slug}/pay?order=${encodeURIComponent(doneToken)}`;

/** Emails the person the link to pay for the ticket staff added them with. Branded like the other attendee emails. */
async function sendPayLinkEmail(order: Order, attendee: typeof schema.attendees.$inferSelect) {
  const db = getDb();
  const ev = db.select().from(schema.events).where(eq(schema.events.id, order.eventId)).get()!;
  const ticket = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, order.ticketTypeId)).get();
  const welcome = db.select().from(schema.messageTemplates).where(and(eq(schema.messageTemplates.eventId, ev.id), eq(schema.messageTemplates.kind, "welcome"))).get();
  const brand = ev.branding.colorPrimary || "#1F5F4A";
  const accent = ev.branding.colorAccent || "#e88a3a";
  const link = payLink(ev.slug, order.doneToken!);
  const where = [fmtDates(ev.startDate, ev.endDate), ev.venueName].filter(Boolean).join(" · ");
  const name = ticket?.name ?? "Registration";
  await sendEmail({
    to: attendee.email,
    fromName: welcome?.fromName || `${ev.shortName || ev.name} Team`,
    replyTo: welcome?.replyTo || undefined,
    subject: `Pay for your ticket: ${ev.shortName || ev.name}`,
    text: `Hello ${attendee.firstName},\n\nYou are on the list for ${ev.name}. Pay for your ticket here:\n${link}\n\n${name}: ${fmtMoney(order.amountCents)}\n${where}`,
    html: emailLayout({
      brand,
      accent,
      look: ev.branding,
      coverUrl: coverFor(ev),
      eventName: ev.name,
      title: "Pay for your ticket",
      blocks: [
        `<p style="margin:0 0 12px">Hello ${escapeHtml(attendee.firstName)},</p>`,
        `<p style="margin:0 0 12px">You are on the list for ${escapeHtml(ev.name)}. Pay for your ticket to finish registering.</p>`,
        `<div style="background:#F4F8F6;border-radius:10px;padding:10px 12px;font-size:13px;margin:0 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-weight:bold">${escapeHtml(name)}</td><td align="right" style="font-weight:800">${escapeHtml(fmtMoney(order.amountCents))}</td></tr></table><div style="color:#4B5B57;margin-top:4px">${escapeHtml(where)}</div></div>`,
        emailButton("Pay for your ticket", link, { ...ev.branding, colorAccent: accent }),
      ],
    }),
  });
}

/** Splits "Jordan Mitchell" into first and last name. */
function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

export const attendeesRouter = router({
  list: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "attendees");
    return attendeeRows(input.eventId).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  }),

  tickets: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "attendees");
    return getDb()
      .select({ id: schema.ticketTypes.id, name: schema.ticketTypes.name, priceCents: schema.ticketTypes.priceCents, active: schema.ticketTypes.active })
      .from(schema.ticketTypes)
      .where(eq(schema.ticketTypes.eventId, input.eventId))
      .orderBy(schema.ticketTypes.sort, schema.ticketTypes.id)
      .all();
  }),

  /** Sponsors and exhibitors with their passes, for the Add attendee sheet. */
  vendors: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "attendees");
    return vendorPassSummary(input.eventId);
  }),

  /** Sessions staff can add a check-in for. */
  sessions: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "attendees");
    return getDb()
      .select({ id: schema.sessions.id, title: schema.sessions.title, date: schema.sessions.date, startTime: schema.sessions.startTime, ceHours: schema.sessions.ceHours, kind: schema.sessions.kind })
      .from(schema.sessions)
      .where(eq(schema.sessions.eventId, input.eventId))
      .all()
      .filter((s) => s.kind !== "break" && s.kind !== "meal")
      .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  }),

  update: protectedProcedure.input(details.extend({ eventId: z.number().int(), attendeeId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "attendees", "edit");
    const a = getAttendee(input.attendeeId, event.id);
    checkTicket(event.id, input.ticketTypeId);
    const email = input.email.toLowerCase();
    const db = getDb();
    if (email !== a.email) {
      const taken = db.select().from(schema.attendees).where(and(eq(schema.attendees.eventId, event.id), eq(schema.attendees.email, email))).get();
      if (taken) throw badRequest("Someone else is registered with that email.");
    }
    const { eventId: _e, attendeeId: _a, ...rest } = input;
    db.update(schema.attendees)
      .set({ ...rest, email, ...(email !== a.email ? { userId: db.select().from(schema.users).where(eq(schema.users.email, email)).get()?.id ?? null } : {}) })
      .where(eq(schema.attendees.id, a.id))
      .run();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "attendee.update", detail: `${input.firstName} ${input.lastName}` });
    return { ok: true };
  }),

  /**
   * Add someone by hand. Every add with a ticket gets an order for the record:
   * a sponsor pass, complimentary, paid outside the app, or a payment link
   * (the person stays unpaid until they pay on the checkout page).
   */
  add: protectedProcedure
    .input(details.extend({ eventId: z.number().int(), vendorId: z.number().int().positive().nullable().default(null), payment: paymentIn.optional(), sendWelcome: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "attendees", "edit");
      checkTicket(event.id, input.ticketTypeId);
      const db = getDb();
      const email = input.email.toLowerCase();
      const taken = db.select().from(schema.attendees).where(and(eq(schema.attendees.eventId, event.id), eq(schema.attendees.email, email))).get();
      if (taken) throw badRequest(`${taken.firstName} ${taken.lastName} is already on the list with that email.`);
      const { eventId: _e, vendorId, payment, sendWelcome: welcome, ...rest } = input;
      const withVendor = rest.kind === "sponsor" || rest.kind === "vendor";
      if (vendorId) {
        const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get();
        if (!v || v.eventId !== event.id) throw badRequest("Pick a sponsor or exhibitor for this event.");
      }
      const pay = payment ?? { mode: "comp" as const, amountCents: 0, method: "check" as const, paidOn: "", reference: "" };
      if (pay.mode === "sponsor_pass" && !(withVendor && vendorId)) throw badRequest("Pick the sponsor or exhibitor whose pass this is.");
      const ticket = rest.ticketTypeId ? db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, rest.ticketTypeId)).get() : undefined;
      if ((pay.mode === "outside" || pay.mode === "link") && !ticket) throw badRequest("Pick a ticket.");
      if (pay.mode === "link") {
        if (!ticket!.priceCents) throw badRequest("This ticket is free. Choose Complimentary instead.");
        const row = accountRow(event.orgId);
        if (!row?.chargesEnabled || !stripeConfigured()) throw badRequest("Connect Stripe before sending payment links.");
      }
      const u = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
      const row = db
        .insert(schema.attendees)
        .values({ ...rest, eventId: event.id, email, vendorId: withVendor ? vendorId : null, status: pay.mode === "link" ? "pending" : "registered", qrToken: randomToken(12), userId: u?.id ?? null })
        .returning()
        .get();
      let order: Order | undefined;
      if (ticket) {
        const base = { eventId: event.id, attendeeId: row.id, email, ticketTypeId: ticket.id, buyer: { firstName: row.firstName, lastName: row.lastName, email, phone: row.phone, credentials: row.credentials, licenseNumber: row.licenseNumber, licenseState: row.licenseState, answers: row.answers, textConsent: row.textConsent } };
        const values =
          pay.mode === "outside" ? { ...base, subtotalCents: pay.amountCents, amountCents: pay.amountCents, status: "paid" as const, method: pay.method, reference: pay.reference, paidOn: pay.paidOn, recordedBy: ctx.user.id, paidAt: new Date() }
          : pay.mode === "link" ? { ...base, subtotalCents: ticket.priceCents, amountCents: ticket.priceCents, status: "pending" as const, method: "link" as const, doneToken: newDoneToken(), recordedBy: ctx.user.id }
          : { ...base, subtotalCents: 0, amountCents: 0, status: "free" as const, method: pay.mode, recordedBy: ctx.user.id, paidAt: new Date() };
        order = db.insert(schema.orders).values(values).returning().get();
      }
      audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "attendee.add", detail: `${input.firstName} ${input.lastName} (${pay.mode})` });
      if (order && pay.mode === "link") await sendPayLinkEmail(order, row);
      if (welcome && row.status === "registered") await sendWelcome(row.id);
      return { id: row.id };
    }),

  setStatus: protectedProcedure.input(z.object({ eventId: z.number().int(), attendeeId: z.number().int(), status: z.enum(["registered", "cancelled"]) })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "attendees", "edit");
    const a = getAttendee(input.attendeeId, event.id);
    getDb().update(schema.attendees).set({ status: input.status }).where(eq(schema.attendees.id, a.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: input.status === "cancelled" ? "attendee.cancel" : "attendee.restore", detail: `${a.firstName} ${a.lastName}` });
    return { ok: true };
  }),

  /** CSV import. Columns: name, email, ticket name, credentials, phone (a header row is optional). */
  importCsv: protectedProcedure.input(z.object({ eventId: z.number().int(), csv: z.string().max(5_000_000) })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "attendees", "edit");
    const db = getDb();
    const rows = parseCsv(input.csv);
    const tickets = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, event.id)).all();
    let col = { name: 0, email: 1, ticket: 2, credentials: 3, phone: 4 };
    if (rows.length && rows[0].some((c) => /e-?mail/i.test(c))) {
      const h = rows.shift()!.map((c) => c.trim().toLowerCase());
      const find = (re: RegExp, fallback: number) => {
        const i = h.findIndex((c) => re.test(c));
        return i >= 0 ? i : fallback;
      };
      col = { name: find(/name/, 0), email: find(/e-?mail/, 1), ticket: find(/ticket/, 2), credentials: find(/credential/, 3), phone: find(/phone|mobile/, 4) };
    }
    const result = { added: 0, skipped: 0, errors: [] as string[] };
    rows.forEach((r, i) => {
      const line = i + 1;
      const email = (r[col.email] ?? "").trim().toLowerCase();
      const { firstName, lastName } = splitName(r[col.name] ?? "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return void result.errors.push(`Row ${line}: the email is missing or not valid.`);
      if (!firstName || !lastName) return void result.errors.push(`Row ${line}: add a first and last name.`);
      const ticketName = (r[col.ticket] ?? "").trim();
      const ticket = ticketName ? tickets.find((t) => t.name.toLowerCase() === ticketName.toLowerCase()) : undefined;
      if (ticketName && !ticket) return void result.errors.push(`Row ${line}: no ticket named "${ticketName}".`);
      const exists = db.select({ id: schema.attendees.id }).from(schema.attendees).where(and(eq(schema.attendees.eventId, event.id), eq(schema.attendees.email, email))).get();
      if (exists) return void result.skipped++;
      const u = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
      db.insert(schema.attendees)
        .values({
          eventId: event.id,
          email,
          firstName: firstName.slice(0, 80),
          lastName: lastName.slice(0, 80),
          credentials: (r[col.credentials] ?? "").trim().slice(0, 80),
          phone: (r[col.phone] ?? "").trim().slice(0, 40),
          ticketTypeId: ticket?.id ?? null,
          qrToken: randomToken(12),
          userId: u?.id ?? null,
        })
        .run();
      result.added++;
    });
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "attendee.import", detail: `${result.added} added, ${result.skipped} already on the list` });
    return result;
  }),

  exportCsv: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "attendees");
    const rows = attendeeRows(event.id);
    const csv = toCsv(
      ["First name", "Last name", "Credentials", "Email", "Phone", "Organization", "Job title", "City", "License number", "License state", "Ticket", "Badge type", "Status", "Checked in", "Badge prints", "Sessions attended", "CE hours", "Opened the app", "Payment"],
      rows.map((r) => [r.firstName, r.lastName, r.credentials, r.email, r.phone, r.organization, r.jobTitle, r.city, r.licenseNumber, r.licenseState, r.ticket, r.kind, r.status, r.checkedInAt ? r.checkedInAt.toISOString() : "", r.badgePrints, r.sessions, r.ceHours, r.appOpenedAt ? "Yes" : "No", r.payment ? `${r.payment.kind}${r.payment.kind === "outside" ? ` (${r.payment.method})` : ""}` : ""])
    );
    return { filename: `${event.slug}-attendees.csv`, csv };
  }),
});
