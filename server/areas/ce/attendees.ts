/**
 * Attendees admin (area "attendees"): the list, editing in place, adding,
 * cancelling and restoring, CSV import and export.
 * The welcome email and receipts belong to registration.
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, requireArea } from "../../_core/access";
import { randomToken } from "../../_core/crypto";
import { fullName } from "@shared/format";
import { badRequest, evaluationWindow, formForSession, getAttendee, parseCsv, toCsv } from "./shared";

const KINDS = ["attendee", "speaker", "vendor", "staff", "guest"] as const;

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
      checkedInAt: a.checkedInAt,
      badgePrints: a.badgePrints,
      appOpenedAt: a.appOpenedAt,
      sessions: mine.length,
      ceHours: Math.round(certs.filter((c) => c.attendeeId === a.id).reduce((n, c) => n + c.hours, 0) * 100) / 100,
      evaluationsDue: mine.filter((c) => openEval.get(c.sessionId) && !done.has(`${c.sessionId}:${a.id}`)).length,
    };
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
    return getDb().select({ id: schema.ticketTypes.id, name: schema.ticketTypes.name }).from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, input.eventId)).all();
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

  /** Add someone by hand (no payment). */
  add: protectedProcedure.input(details.extend({ eventId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "attendees", "edit");
    checkTicket(event.id, input.ticketTypeId);
    const db = getDb();
    const email = input.email.toLowerCase();
    const taken = db.select().from(schema.attendees).where(and(eq(schema.attendees.eventId, event.id), eq(schema.attendees.email, email))).get();
    if (taken) throw badRequest(`${taken.firstName} ${taken.lastName} is already on the list with that email.`);
    const { eventId: _e, ...rest } = input;
    const u = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
    const row = db
      .insert(schema.attendees)
      .values({ ...rest, eventId: event.id, email, qrToken: randomToken(12), userId: u?.id ?? null })
      .returning()
      .get();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "attendee.add", detail: `${input.firstName} ${input.lastName}` });
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
      ["First name", "Last name", "Credentials", "Email", "Phone", "Organization", "Job title", "City", "License number", "License state", "Ticket", "Badge type", "Status", "Checked in", "Badge prints", "Sessions attended", "CE hours", "Opened the app"],
      rows.map((r) => [r.firstName, r.lastName, r.credentials, r.email, r.phone, r.organization, r.jobTitle, r.city, r.licenseNumber, r.licenseState, r.ticket, r.kind, r.status, r.checkedInAt ? r.checkedInAt.toISOString() : "", r.badgePrints, r.sessions, r.ceHours, r.appOpenedAt ? "Yes" : "No"])
    );
    return { filename: `${event.slug}-attendees.csv`, csv };
  }),
});
