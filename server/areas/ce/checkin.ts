/**
 * Check-in desk (area "checkin"), badges, and session check-in for CE.
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, eventAccess, forbidden, getEventBySlug, requireArea, requireAttendee } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { randomToken, safeEqual } from "../../_core/crypto";
import { ENV } from "../../_core/env";
import { fmtTime } from "@shared/format";
import { dateToZoned } from "@shared/time";
import { attendeeName, badRequest, evaluationWindow, formForSession, getAttendee, getSession, issueEligible, sessionTimes, userNames } from "./shared";

type Attendee = typeof schema.attendees.$inferSelect;

const KIND_LABEL: Record<Attendee["kind"], string> = { attendee: "Attendee", speaker: "Speaker", vendor: "Exhibitor", staff: "Staff", guest: "Walk-in" };

/** The token in a scanned badge: either the full badge link (`.../badge?t=<token>`) or just the token. */
export function tokenFromScan(raw: string) {
  const v = raw.trim();
  const m = v.match(/[?&]t=([A-Za-z0-9_-]+)/);
  return m ? m[1] : v;
}

export const badgeUrl = (slug: string, qrToken: string) => `${ENV.appUrl}/e/${slug}/badge?t=${qrToken}`;

function ticketsById(eventId: number) {
  const rows = getDb().select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, eventId)).all();
  return new Map(rows.map((t) => [t.id, t]));
}

/** The badge as it prints: names, credentials, organization, city and ribbon per the event's badge settings. */
export function badgeData(ev: typeof schema.events.$inferSelect, a: Attendee) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get();
  const b = ev.branding.badge ?? { showCredentials: true, showOrg: true, showCity: true, ribbonByTicket: true, size: "4x3" as const };
  const ticket = a.ticketTypeId ? getDb().select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, a.ticketTypeId)).get() : undefined;
  const ribbon = (b.ribbonByTicket && ticket?.ribbon ? ticket.ribbon : KIND_LABEL[a.kind]).toUpperCase();
  return {
    attendeeId: a.id,
    firstName: a.firstName,
    lastName: a.lastName,
    credentials: b.showCredentials ? a.credentials : "",
    organization: b.showOrg ? a.organization : "",
    city: b.showCity ? a.city : "",
    ribbon,
    size: b.size ?? "4x3",
    qr: badgeUrl(ev.slug, a.qrToken),
    eventName: ev.name,
    colorPrimary: ev.branding.colorPrimary,
    colorAccent: ev.branding.colorAccent,
    logoUrl: fileUrl(ev.branding.logoFileId ?? org?.logoFileId),
  };
}

function deskRow(a: Attendee, tickets: Map<number, typeof schema.ticketTypes.$inferSelect>, names: Map<number, string>) {
  return {
    id: a.id,
    firstName: a.firstName,
    lastName: a.lastName,
    credentials: a.credentials,
    email: a.email,
    city: a.city,
    organization: a.organization,
    kind: a.kind,
    kindLabel: KIND_LABEL[a.kind],
    status: a.status,
    ticket: a.ticketTypeId ? tickets.get(a.ticketTypeId)?.name ?? "" : "",
    checkedInAt: a.checkedInAt,
    checkedInBy: a.checkedInBy ? names.get(a.checkedInBy) ?? "" : "",
    badgePrints: a.badgePrints,
  };
}

function counts(eventId: number) {
  const rows = getDb()
    .select({ status: schema.attendees.status, checkedInAt: schema.attendees.checkedInAt, kind: schema.attendees.kind })
    .from(schema.attendees)
    .where(eq(schema.attendees.eventId, eventId))
    .all()
    .filter((r) => r.status !== "cancelled");
  const checkedIn = rows.filter((r) => r.checkedInAt).length;
  return { total: rows.length, checkedIn, notYet: rows.length - checkedIn, walkIns: rows.filter((r) => r.kind === "guest").length };
}

const eventInput = z.object({ eventId: z.number().int() });

export const checkinRouter = router({
  counts: protectedProcedure.input(eventInput).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "checkin");
    return counts(input.eventId);
  }),

  /** Search by name or email (or a scanned code). */
  search: protectedProcedure.input(z.object({ eventId: z.number().int(), q: z.string().max(400) })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "checkin");
    const q = input.q.trim().toLowerCase();
    if (!q) return [];
    const db = getDb();
    const token = tokenFromScan(input.q);
    const byToken = db.select().from(schema.attendees).where(and(eq(schema.attendees.eventId, event.id), eq(schema.attendees.qrToken, token))).get();
    const all = byToken
      ? [byToken]
      : db
          .select()
          .from(schema.attendees)
          .where(eq(schema.attendees.eventId, event.id))
          .all()
          .filter((a) => `${a.firstName} ${a.lastName}`.toLowerCase().includes(q) || a.email.includes(q) || a.lastName.toLowerCase().startsWith(q))
          .slice(0, 25);
    const tickets = ticketsById(event.id);
    const names = userNames(all.map((a) => a.checkedInBy));
    return all.map((a) => deskRow(a, tickets, names));
  }),

  /** Look up a scanned badge. Accepts the badge link or just the token. */
  lookup: protectedProcedure.input(z.object({ eventId: z.number().int(), code: z.string().min(1).max(400) })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "checkin");
    const a = getDb()
      .select()
      .from(schema.attendees)
      .where(and(eq(schema.attendees.eventId, event.id), eq(schema.attendees.qrToken, tokenFromScan(input.code))))
      .get();
    if (!a) return null;
    return deskRow(a, ticketsById(event.id), userNames([a.checkedInBy]));
  }),

  checkIn: protectedProcedure.input(z.object({ eventId: z.number().int(), attendeeId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "checkin", "edit");
    const a = getAttendee(input.attendeeId, event.id);
    if (a.status === "cancelled") throw badRequest("This registration was cancelled.");
    if (a.checkedInAt) return { ok: true, already: true, checkedInAt: a.checkedInAt };
    const now = new Date();
    getDb().update(schema.attendees).set({ checkedInAt: now, checkedInBy: ctx.user.id }).where(eq(schema.attendees.id, a.id)).run();
    return { ok: true, already: false, checkedInAt: now };
  }),

  undo: protectedProcedure.input(z.object({ eventId: z.number().int(), attendeeId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "checkin", "edit");
    const a = getAttendee(input.attendeeId, event.id);
    getDb().update(schema.attendees).set({ checkedInAt: null, checkedInBy: null }).where(eq(schema.attendees.id, a.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "checkin.undo", detail: `${a.firstName} ${a.lastName}` });
    return { ok: true };
  }),

  badgePrinted: protectedProcedure.input(z.object({ eventId: z.number().int(), attendeeId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "checkin", "edit");
    const a = getAttendee(input.attendeeId, event.id);
    getDb().update(schema.attendees).set({ badgePrints: a.badgePrints + 1, badgePrintedAt: new Date() }).where(eq(schema.attendees.id, a.id)).run();
    return { ok: true, prints: a.badgePrints + 1 };
  }),

  /** Fix the name on a badge at the desk. */
  editBadge: protectedProcedure
    .input(z.object({ eventId: z.number().int(), attendeeId: z.number().int(), firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80), credentials: z.string().trim().max(80) }))
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "checkin", "edit");
      const a = getAttendee(input.attendeeId, event.id);
      getDb().update(schema.attendees).set({ firstName: input.firstName, lastName: input.lastName, credentials: input.credentials }).where(eq(schema.attendees.id, a.id)).run();
      return { ok: true };
    }),

  /** Walk-up registration at the desk: no payment, kind guest, checked in right away. */
  walkUp: protectedProcedure
    .input(
      z.object({
        eventId: z.number().int(),
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().min(1).max(80),
        email: z.string().trim().email().max(200),
        credentials: z.string().trim().max(80).default(""),
        city: z.string().trim().max(120).default(""),
        phone: z.string().trim().max(40).default(""),
        ticketTypeId: z.number().int().nullable(),
      })
    )
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "checkin", "edit");
      const db = getDb();
      const email = input.email.toLowerCase();
      if (input.ticketTypeId && ticketsById(event.id).get(input.ticketTypeId) === undefined) throw badRequest("Pick a ticket for this event.");
      const existing = db.select().from(schema.attendees).where(and(eq(schema.attendees.eventId, event.id), eq(schema.attendees.email, email))).get();
      if (existing && existing.status !== "cancelled") throw badRequest(`${existing.firstName} ${existing.lastName} is already registered with that email.`);
      const u = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
      const now = new Date();
      const values = {
        firstName: input.firstName,
        lastName: input.lastName,
        credentials: input.credentials,
        city: input.city,
        phone: input.phone,
        ticketTypeId: input.ticketTypeId,
        status: "registered" as const,
        kind: "guest" as const,
        checkedInAt: now,
        checkedInBy: ctx.user.id,
        userId: u?.id ?? null,
      };
      let id: number;
      if (existing) {
        db.update(schema.attendees).set(values).where(eq(schema.attendees.id, existing.id)).run();
        id = existing.id;
      } else {
        id = db.insert(schema.attendees).values({ eventId: event.id, email, qrToken: randomToken(12), ...values }).returning().get().id;
      }
      audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "checkin.walkup", detail: `${input.firstName} ${input.lastName}` });
      return { id };
    }),

  /** Tickets for the walk-up form. */
  tickets: protectedProcedure.input(eventInput).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "checkin");
    return getDb()
      .select({ id: schema.ticketTypes.id, name: schema.ticketTypes.name, ribbon: schema.ticketTypes.ribbon })
      .from(schema.ticketTypes)
      .where(eq(schema.ticketTypes.eventId, input.eventId))
      .all();
  }),

  /** Badge print page data (desk staff or attendee managers). */
  badge: protectedProcedure.input(z.object({ eventId: z.number().int(), attendeeId: z.number().int() })).query(({ ctx, input }) => {
    const access = eventAccess(ctx.user, input.eventId);
    if (access.areas.checkin === "none" && access.areas.attendees === "none") throw forbidden();
    const { event } = requireArea(ctx.user, input.eventId, access.areas.checkin !== "none" ? "checkin" : "attendees");
    return badgeData(event, getAttendee(input.attendeeId, event.id));
  }),

  /** The signed-in attendee's own badge (My badge screen). */
  myBadge: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const ev = getEventBySlug(input.slug);
    const a = requireAttendee(ctx.user, ev.id);
    return { ...badgeData(ev, a), checkedInAt: a.checkedInAt };
  }),

  /** Room check-in for CE: the attendee scans the code at the door. */
  session: router({
    /** What the check-in screen shows for a session. */
    status: protectedProcedure.input(z.object({ slug: z.string().max(120), sessionId: z.number().int() })).query(({ ctx, input }) => {
      const ev = getEventBySlug(input.slug);
      const a = requireAttendee(ctx.user, ev.id);
      const s = getSession(input.sessionId, ev.id);
      const t = sessionTimes(s, ev.timezone);
      const row = getDb()
        .select()
        .from(schema.sessionCheckins)
        .where(and(eq(schema.sessionCheckins.sessionId, s.id), eq(schema.sessionCheckins.attendeeId, a.id)))
        .get();
      const form = formForSession(s);
      const win = form ? evaluationWindow(form, s, ev.timezone) : null;
      const submitted = !!getDb()
        .select({ id: schema.evaluationResponses.id })
        .from(schema.evaluationResponses)
        .where(and(eq(schema.evaluationResponses.sessionId, s.id), eq(schema.evaluationResponses.attendeeId, a.id)))
        .get();
      return {
        session: { id: s.id, title: s.title, room: s.room, date: s.date, startTime: s.startTime, endTime: s.endTime, ceHours: s.ceHours },
        checkedInAt: row?.createdAt ?? null,
        opensAt: t.opens,
        closesAt: t.closes,
        evaluation: form ? { state: win!.state, opensAt: win!.opensAt, opensAtLocal: dateToZoned(new Date(win!.opensAt), ev.timezone).time, submitted } : null,
      };
    }),

    /** Check in with the room's code. Works from 30 minutes before the start until 15 minutes after the end. */
    checkIn: protectedProcedure
      .input(z.object({ slug: z.string().max(120), sessionId: z.number().int(), code: z.string().trim().min(1).max(200) }))
      .mutation(async ({ ctx, input }) => {
        const ev = getEventBySlug(input.slug);
        const a = requireAttendee(ctx.user, ev.id);
        const s = getSession(input.sessionId, ev.id);
        const code = input.code.match(/[?&]code=([^&#]+)/)?.[1] ?? input.code;
        if (!safeEqual(decodeURIComponent(code).trim().toUpperCase(), s.checkInCode.trim().toUpperCase())) throw badRequest("That code is not for this session. Scan the code posted at this room's door.");
        const t = sessionTimes(s, ev.timezone);
        const now = Date.now();
        if (now < t.opens) throw badRequest(`Check-in opens at ${fmtTime(dateToZoned(new Date(t.opens), ev.timezone).time)}.`);
        if (now > t.closes) throw badRequest("Check-in for this session has closed. Ask the CE desk for help.");
        const db = getDb();
        const existing = db.select().from(schema.sessionCheckins).where(and(eq(schema.sessionCheckins.sessionId, s.id), eq(schema.sessionCheckins.attendeeId, a.id))).get();
        if (existing) return { ok: true, already: true, checkedInAt: existing.createdAt };
        const row = db.insert(schema.sessionCheckins).values({ sessionId: s.id, attendeeId: a.id, method: "qr", createdAt: new Date(now) }).returning().get();
        await issueEligible(a.id);
        return { ok: true, already: false, checkedInAt: row.createdAt };
      }),

    /** Staff add a session check-in by hand (CE desk, attendee record). */
    add: protectedProcedure.input(z.object({ eventId: z.number().int(), sessionId: z.number().int(), attendeeId: z.number().int() })).mutation(async ({ ctx, input }) => {
      const access = eventAccess(ctx.user, input.eventId);
      if (access.areas.checkin !== "edit" && access.areas.attendees !== "edit") throw forbidden();
      const s = getSession(input.sessionId, input.eventId);
      const a = getAttendee(input.attendeeId, input.eventId);
      getDb().insert(schema.sessionCheckins).values({ sessionId: s.id, attendeeId: a.id, method: "staff", createdAt: new Date() }).onConflictDoNothing().run();
      audit(ctx.user, { eventId: input.eventId, action: "checkin.session_staff", detail: `${a.firstName} ${a.lastName}: ${s.title}` });
      await issueEligible(a.id);
      return { ok: true };
    }),

    remove: protectedProcedure.input(z.object({ eventId: z.number().int(), sessionId: z.number().int(), attendeeId: z.number().int() })).mutation(({ ctx, input }) => {
      const access = eventAccess(ctx.user, input.eventId);
      if (access.areas.checkin !== "edit" && access.areas.attendees !== "edit") throw forbidden();
      const s = getSession(input.sessionId, input.eventId);
      const a = getAttendee(input.attendeeId, input.eventId);
      getDb().delete(schema.sessionCheckins).where(and(eq(schema.sessionCheckins.sessionId, s.id), eq(schema.sessionCheckins.attendeeId, a.id))).run();
      audit(ctx.user, { eventId: input.eventId, action: "checkin.session_remove", detail: `${a.firstName} ${a.lastName}: ${s.title}` });
      return { ok: true };
    }),

    /** Sessions an attendee checked in to (attendee record). */
    forAttendee: protectedProcedure.input(z.object({ eventId: z.number().int(), attendeeId: z.number().int() })).query(({ ctx, input }) => {
      requireArea(ctx.user, input.eventId, "attendees");
      const a = getAttendee(input.attendeeId, input.eventId);
      const rows = getDb().select().from(schema.sessionCheckins).where(eq(schema.sessionCheckins.attendeeId, a.id)).all();
      if (!rows.length) return [];
      const sessions = getDb().select().from(schema.sessions).where(inArray(schema.sessions.id, rows.map((r) => r.sessionId))).all();
      return rows
        .map((r) => {
          const s = sessions.find((x) => x.id === r.sessionId)!;
          return { sessionId: s.id, title: s.title, date: s.date, startTime: s.startTime, ceHours: s.ceHours, method: r.method, at: r.createdAt };
        })
        .sort((x, y) => `${x.date}${x.startTime}`.localeCompare(`${y.date}${y.startTime}`));
    }),
  }),
});

export { attendeeName };
