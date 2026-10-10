/** Sessions: the admin agenda builder, the attendee agenda, and My agenda. */
import { z } from "zod";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, notFound, requireArea } from "../../_core/access";
import { randomToken } from "../../_core/crypto";
import { notify } from "../../_core/push";
import { fileUrl } from "../../_core/files";
import { fmtDate, fmtTime } from "@shared/format";
import { attendeeViewer, bad, hhmm, isoDate, prefsFor, sessionEnd, sessionStart, speakerFullName, speakersBySession, viewer } from "./util";

const ROLES = ["presenter", "co-presenter", "moderator", "panelist"] as const;
const KINDS = ["session", "keynote", "workshop", "break", "meal", "general"] as const;

const sessionInput = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().max(5000).default(""),
  kind: z.enum(KINDS).default("session"),
  date: isoDate,
  startTime: hhmm,
  endTime: hhmm,
  room: z.string().trim().max(120).default(""),
  track: z.string().trim().max(80).default(""),
  ceHours: z.number().min(0).max(40).default(0),
  capacity: z.number().int().positive().max(100000).nullable().default(null),
  requiresSignup: z.boolean().default(false),
  published: z.boolean().default(true),
  evaluationId: z.number().int().nullable().default(null),
  evaluationOpens: z.enum(["end", "checkin"]).default("end"),
  certificateTemplateId: z.number().int().nullable().default(null),
  certificateAfter: z.enum(["evaluation", "checkin"]).nullable().default(null),
});

function checkTimes(ev: { startDate: string; endDate: string }, s: { date: string; startTime: string; endTime: string }) {
  if (s.endTime <= s.startTime) throw bad("The session ends before it starts.");
  if (s.date < ev.startDate || s.date > ev.endDate) throw bad(`The date must be between ${fmtDate(ev.startDate)} and ${fmtDate(ev.endDate)}.`);
}

function getSession(eventId: number, sessionId: number) {
  const s = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!s || s.eventId !== eventId) throw notFound("That session");
  return s;
}

/** Make sure linked forms and templates belong to the same event. */
function checkLinks(eventId: number, input: { evaluationId: number | null; certificateTemplateId: number | null }) {
  const db = getDb();
  if (input.evaluationId) {
    const e = db.select().from(schema.evaluations).where(eq(schema.evaluations.id, input.evaluationId)).get();
    if (!e || e.eventId !== eventId) throw bad("Pick an evaluation form from this event.");
  }
  if (input.certificateTemplateId) {
    const t = db.select().from(schema.certificateTemplates).where(eq(schema.certificateTemplates.id, input.certificateTemplateId)).get();
    if (!t || t.eventId !== eventId) throw bad("Pick a certificate template from this event.");
  }
}

const countBy = (table: typeof schema.scheduleItems | typeof schema.sessionCheckins | typeof schema.evaluationResponses, ids: number[]) => {
  const map = new Map<number, number>();
  if (!ids.length) return map;
  const rows = getDb()
    .select({ sessionId: table.sessionId, n: sql<number>`count(*)` })
    .from(table)
    .where(inArray(table.sessionId, ids))
    .groupBy(table.sessionId)
    .all();
  for (const r of rows) map.set(r.sessionId, Number(r.n));
  return map;
};

/** Seats taken for sessions that need sign-up. */
const signups = (ids: number[]) => countBy(schema.scheduleItems, ids);

function overlaps(a: { date: string; startTime: string; endTime: string }, b: { date: string; startTime: string; endTime: string }) {
  return a.date === b.date && a.startTime < b.endTime && b.startTime < a.endTime;
}

/** Tells people with a session on My agenda that its room or time changed. */
async function noticeChange(ev: { id: number; slug: string }, before: typeof schema.sessions.$inferSelect, after: typeof schema.sessions.$inferSelect) {
  const moved = before.room !== after.room;
  const retimed = before.date !== after.date || before.startTime !== after.startTime || before.endTime !== after.endTime;
  if (!after.published || (!moved && !retimed)) return;
  const rows = getDb()
    .select({ attendeeId: schema.attendees.id, userId: schema.attendees.userId })
    .from(schema.scheduleItems)
    .innerJoin(schema.attendees, eq(schema.attendees.id, schema.scheduleItems.attendeeId))
    .where(eq(schema.scheduleItems.sessionId, after.id))
    .all()
    .filter((r) => r.userId);
  if (!rows.length) return;
  const prefs = prefsFor(rows.map((r) => r.attendeeId));
  const title = retimed ? "Time change" : "Room change";
  const body = retimed
    ? `${after.title} is now ${fmtDate(after.date)}, ${fmtTime(after.startTime)}${after.room ? `, ${after.room}` : ""}.`
    : `${after.title} moved to ${after.room || "a new room"}.`;
  const notice = { title, body, url: `/e/${ev.slug}/session/${after.id}`, kind: "change" };
  const on = rows.filter((r) => prefs.get(r.attendeeId)?.changes !== false).map((r) => r.userId!);
  const off = rows.filter((r) => prefs.get(r.attendeeId)?.changes === false).map((r) => r.userId!);
  await notify(on, ev.id, notice);
  await notify(off, ev.id, { ...notice, push: false });
  // Their reminder should follow the new time.
  if (retimed) getDb().update(schema.scheduleItems).set({ remindedAt: null }).where(eq(schema.scheduleItems.sessionId, after.id)).run();
}

export const sessionsRouter = router({
  /** Admin: every session with counts, plus the event totals. */
  adminList: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "sessions");
    const db = getDb();
    const rows = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, input.eventId)).orderBy(asc(schema.sessions.date), asc(schema.sessions.startTime)).all();
    const ids = rows.map((r) => r.id);
    const scheduled = countBy(schema.scheduleItems, ids);
    const checked = countBy(schema.sessionCheckins, ids);
    const evals = countBy(schema.evaluationResponses, ids);
    const speakers = speakersBySession(ids);
    const forms = db.select({ id: schema.evaluations.id, name: schema.evaluations.name, isDefault: schema.evaluations.isDefault }).from(schema.evaluations).where(eq(schema.evaluations.eventId, input.eventId)).all();
    const templates = db.select({ id: schema.certificateTemplates.id, name: schema.certificateTemplates.name, isDefault: schema.certificateTemplates.isDefault, requireEvaluation: schema.certificateTemplates.requireEvaluation }).from(schema.certificateTemplates).where(eq(schema.certificateTemplates.eventId, input.eventId)).all();
    const ev = db.select().from(schema.events).where(eq(schema.events.id, input.eventId)).get()!;
    const attendees = db.select({ n: sql<number>`count(*)` }).from(schema.attendees).where(and(eq(schema.attendees.eventId, input.eventId), eq(schema.attendees.status, "registered"))).get();
    const certs = db.select({ n: sql<number>`count(*)` }).from(schema.certificates).where(and(eq(schema.certificates.eventId, input.eventId), isNull(schema.certificates.revokedAt))).get();
    return {
      kpis: {
        attendees: Number(attendees?.n ?? 0),
        sessions: rows.length,
        checkins: Array.from(checked.values()).reduce((a, b) => a + b, 0),
        certificates: Number(certs?.n ?? 0),
      },
      forms,
      templates,
      sessions: rows.map((s) => ({
        ...s,
        speakers: speakers.get(s.id) ?? [],
        scheduled: scheduled.get(s.id) ?? 0,
        checkedIn: checked.get(s.id) ?? 0,
        evaluations: evals.get(s.id) ?? 0,
        endsAt: sessionEnd(s, ev.timezone).getTime(),
      })),
    };
  }),

  /** Admin: one session for its edit page (speakers, forms, templates, check-in code). */
  adminGet: protectedProcedure.input(z.object({ eventId: z.number(), sessionId: z.number() })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "sessions");
    const s = getSession(input.eventId, input.sessionId);
    const db = getDb();
    const ids = [s.id];
    const assigned = db
      .select({ id: schema.sessionSpeakers.id, role: schema.sessionSpeakers.role, speaker: schema.speakers })
      .from(schema.sessionSpeakers)
      .innerJoin(schema.speakers, eq(schema.speakers.id, schema.sessionSpeakers.speakerId))
      .where(eq(schema.sessionSpeakers.sessionId, s.id))
      .all()
      .map((r) => ({ speakerId: r.speaker.id, name: speakerFullName(r.speaker), role: r.role, headshotUrl: fileUrl(r.speaker.headshotFileId) }));
    const allSpeakers = db.select({ id: schema.speakers.id, name: schema.speakers.name, credentials: schema.speakers.credentials }).from(schema.speakers).where(eq(schema.speakers.eventId, input.eventId)).orderBy(asc(schema.speakers.name)).all();
    return {
      session: {
        ...s,
        scheduled: countBy(schema.scheduleItems, ids).get(s.id) ?? 0,
        checkedIn: countBy(schema.sessionCheckins, ids).get(s.id) ?? 0,
        evaluations: countBy(schema.evaluationResponses, ids).get(s.id) ?? 0,
        endsAt: sessionEnd(s, event.timezone).getTime(),
      },
      slug: event.slug,
      speakers: assigned,
      allSpeakers: allSpeakers.map((a) => ({ id: a.id, name: speakerFullName(a) })),
      forms: db.select({ id: schema.evaluations.id, name: schema.evaluations.name, isDefault: schema.evaluations.isDefault }).from(schema.evaluations).where(eq(schema.evaluations.eventId, input.eventId)).all(),
      templates: db.select({ id: schema.certificateTemplates.id, name: schema.certificateTemplates.name, isDefault: schema.certificateTemplates.isDefault, requireEvaluation: schema.certificateTemplates.requireEvaluation }).from(schema.certificateTemplates).where(eq(schema.certificateTemplates.eventId, input.eventId)).all(),
    };
  }),

  create: protectedProcedure.input(sessionInput.extend({ eventId: z.number() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "sessions", "edit");
    checkTimes(event, input);
    checkLinks(input.eventId, input);
    const row = getDb().insert(schema.sessions).values({ ...input, checkInCode: randomToken(6) }).returning().get();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "session.create", detail: row.title });
    return row;
  }),

  update: protectedProcedure.input(sessionInput.extend({ eventId: z.number(), sessionId: z.number() })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "sessions", "edit");
    const before = getSession(input.eventId, input.sessionId);
    checkTimes(event, input);
    checkLinks(input.eventId, input);
    const { eventId, sessionId, ...rest } = input;
    void eventId;
    const after = getDb().update(schema.sessions).set(rest).where(eq(schema.sessions.id, sessionId)).returning().get();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "session.update", detail: after.title });
    await noticeChange(event, before, after);
    return after;
  }),

  delete: protectedProcedure.input(z.object({ eventId: z.number(), sessionId: z.number() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "sessions", "edit");
    const s = getSession(input.eventId, input.sessionId);
    getDb().delete(schema.sessions).where(eq(schema.sessions.id, s.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "session.delete", detail: s.title });
    return { ok: true };
  }),

  /** Makes a new room check-in code (the old printed QR stops working). */
  newCode: protectedProcedure.input(z.object({ eventId: z.number(), sessionId: z.number() })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "sessions", "edit");
    getSession(input.eventId, input.sessionId);
    const code = randomToken(6);
    getDb().update(schema.sessions).set({ checkInCode: code }).where(eq(schema.sessions.id, input.sessionId)).run();
    return { checkInCode: code };
  }),

  /** Replaces the session's speakers and their roles. */
  setSpeakers: protectedProcedure
    .input(z.object({ eventId: z.number(), sessionId: z.number(), speakers: z.array(z.object({ speakerId: z.number(), role: z.enum(ROLES) })).max(40) }))
    .mutation(({ ctx, input }) => {
      requireArea(ctx.user, input.eventId, "sessions", "edit");
      getSession(input.eventId, input.sessionId);
      const db = getDb();
      const ids = Array.from(new Set(input.speakers.map((s) => s.speakerId)));
      if (ids.length) {
        const found = db.select({ id: schema.speakers.id, eventId: schema.speakers.eventId }).from(schema.speakers).where(inArray(schema.speakers.id, ids)).all();
        if (found.length !== ids.length || found.some((f) => f.eventId !== input.eventId)) throw bad("Pick speakers from this event.");
      }
      db.delete(schema.sessionSpeakers).where(eq(schema.sessionSpeakers.sessionId, input.sessionId)).run();
      const seen = new Set<number>();
      for (const s of input.speakers) {
        if (seen.has(s.speakerId)) continue;
        seen.add(s.speakerId);
        db.insert(schema.sessionSpeakers).values({ sessionId: input.sessionId, speakerId: s.speakerId, role: s.role }).run();
      }
      return { ok: true };
    }),

  /** Who has the session on their agenda and who checked in (for the attendance list). */
  attendance: protectedProcedure.input(z.object({ eventId: z.number(), sessionId: z.number() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "sessions");
    getSession(input.eventId, input.sessionId);
    const db = getDb();
    const scheduled = db
      .select({ a: schema.attendees })
      .from(schema.scheduleItems)
      .innerJoin(schema.attendees, eq(schema.attendees.id, schema.scheduleItems.attendeeId))
      .where(eq(schema.scheduleItems.sessionId, input.sessionId))
      .all()
      .map((r) => r.a);
    const checkins = db
      .select({ a: schema.attendees, at: schema.sessionCheckins.createdAt })
      .from(schema.sessionCheckins)
      .innerJoin(schema.attendees, eq(schema.attendees.id, schema.sessionCheckins.attendeeId))
      .where(eq(schema.sessionCheckins.sessionId, input.sessionId))
      .all();
    const byId = new Map<number, { id: number; name: string; email: string; licenseNumber: string; scheduled: boolean; checkedInAt: Date | null }>();
    const name = (a: typeof schema.attendees.$inferSelect) => `${a.firstName} ${a.lastName}${a.credentials ? `, ${a.credentials}` : ""}`;
    for (const a of scheduled) byId.set(a.id, { id: a.id, name: name(a), email: a.email, licenseNumber: a.licenseNumber, scheduled: true, checkedInAt: null });
    for (const c of checkins) {
      const cur = byId.get(c.a.id) ?? { id: c.a.id, name: name(c.a), email: c.a.email, licenseNumber: c.a.licenseNumber, scheduled: false, checkedInAt: null };
      cur.checkedInAt = c.at;
      byId.set(c.a.id, cur);
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }),

  /** Attendee app: the published agenda with the person's own picks. */
  agenda: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const { event, attendee } = viewer(ctx.user, input.slug);
    const db = getDb();
    const rows = db
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.eventId, event.id), eq(schema.sessions.published, true)))
      .orderBy(asc(schema.sessions.date), asc(schema.sessions.startTime))
      .all();
    const ids = rows.map((r) => r.id);
    const mine = new Set(attendee ? db.select({ id: schema.scheduleItems.sessionId }).from(schema.scheduleItems).where(eq(schema.scheduleItems.attendeeId, attendee.id)).all().map((r) => r.id) : []);
    const taken = signups(rows.filter((r) => r.requiresSignup && r.capacity).map((r) => r.id));
    const speakers = speakersBySession(ids);
    return {
      tracks: Array.from(new Set(rows.map((r) => r.track).filter(Boolean))).sort(),
      sessions: rows.map((s) => ({
        id: s.id,
        title: s.title,
        kind: s.kind,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        room: s.room,
        track: s.track,
        ceHours: s.ceHours,
        requiresSignup: s.requiresSignup,
        seatsLeft: s.requiresSignup && s.capacity ? Math.max(0, s.capacity - (taken.get(s.id) ?? 0)) : null,
        onMy: mine.has(s.id),
        speakers: (speakers.get(s.id) ?? []).map((p) => p.name),
      })),
    };
  }),

  /** Attendee app: one session with its speakers and the person's progress toward CE. */
  get: protectedProcedure.input(z.object({ slug: z.string().max(120), sessionId: z.number() })).query(({ ctx, input }) => {
    const { event, attendee } = viewer(ctx.user, input.slug);
    const s = getSession(event.id, input.sessionId);
    if (!s.published) throw notFound("That session");
    const db = getDb();
    const item = attendee ? db.select().from(schema.scheduleItems).where(and(eq(schema.scheduleItems.attendeeId, attendee.id), eq(schema.scheduleItems.sessionId, s.id))).get() : undefined;
    const checkin = attendee ? db.select().from(schema.sessionCheckins).where(and(eq(schema.sessionCheckins.attendeeId, attendee.id), eq(schema.sessionCheckins.sessionId, s.id))).get() : undefined;
    const evaluated = attendee ? db.select({ id: schema.evaluationResponses.id }).from(schema.evaluationResponses).where(and(eq(schema.evaluationResponses.attendeeId, attendee.id), eq(schema.evaluationResponses.sessionId, s.id))).get() : undefined;
    const cert = attendee ? db.select({ id: schema.certificates.id, revokedAt: schema.certificates.revokedAt }).from(schema.certificates).where(and(eq(schema.certificates.attendeeId, attendee.id), eq(schema.certificates.sessionId, s.id))).get() : undefined;
    const taken = s.requiresSignup && s.capacity ? signups([s.id]).get(s.id) ?? 0 : 0;
    const speakerRows = db
      .select({ role: schema.sessionSpeakers.role, speaker: schema.speakers })
      .from(schema.sessionSpeakers)
      .innerJoin(schema.speakers, eq(schema.speakers.id, schema.sessionSpeakers.speakerId))
      .where(eq(schema.sessionSpeakers.sessionId, s.id))
      .all();
    const order = Object.fromEntries(ROLES.map((r, i) => [r, i]));
    speakerRows.sort((a, b) => order[a.role] - order[b.role]);
    return {
      session: {
        id: s.id,
        title: s.title,
        description: s.description,
        kind: s.kind,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        room: s.room,
        track: s.track,
        ceHours: s.ceHours,
        requiresSignup: s.requiresSignup,
        seatsLeft: s.requiresSignup && s.capacity ? Math.max(0, s.capacity - taken) : null,
        startsAt: sessionStart(s, event.timezone).getTime(),
        endsAt: sessionEnd(s, event.timezone).getTime(),
      },
      speakers: speakerRows.map((r) => ({ id: r.speaker.id, role: r.role, name: speakerFullName(r.speaker), headshotUrl: fileUrl(r.speaker.headshotFileId) })),
      registered: !!attendee,
      onMy: !!item,
      remind: item?.remind ?? true,
      checkedIn: !!checkin,
      evaluated: !!evaluated,
      certified: !!cert && !cert.revokedAt,
    };
  }),

  /** Attendee app: My agenda with check-in, evaluation and certificate status. */
  my: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const { event, attendee } = attendeeViewer(ctx.user, input.slug);
    const db = getDb();
    const items = db
      .select({ item: schema.scheduleItems, s: schema.sessions })
      .from(schema.scheduleItems)
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.scheduleItems.sessionId))
      .where(eq(schema.scheduleItems.attendeeId, attendee.id))
      .all()
      .filter((r) => r.s.published)
      .sort((a, b) => (a.s.date + a.s.startTime).localeCompare(b.s.date + b.s.startTime));
    const checked = new Set(db.select({ id: schema.sessionCheckins.sessionId }).from(schema.sessionCheckins).where(eq(schema.sessionCheckins.attendeeId, attendee.id)).all().map((r) => r.id));
    const evaluated = new Set(db.select({ id: schema.evaluationResponses.sessionId }).from(schema.evaluationResponses).where(eq(schema.evaluationResponses.attendeeId, attendee.id)).all().map((r) => r.id));
    const certs = db
      .select({ sessionId: schema.certificates.sessionId, hours: schema.certificates.hours })
      .from(schema.certificates)
      .where(and(eq(schema.certificates.attendeeId, attendee.id), eq(schema.certificates.eventId, event.id), isNull(schema.certificates.revokedAt)))
      .all();
    const certified = new Set(certs.map((c) => c.sessionId));
    const now = Date.now();
    return {
      stats: { sessions: items.length, attended: checked.size, ceEarned: certs.reduce((a, c) => a + c.hours, 0) },
      items: items.map(({ item, s }) => {
        const startsAt = sessionStart(s, event.timezone).getTime();
        const endsAt = sessionEnd(s, event.timezone).getTime();
        const conflicts = items.filter((o) => o.s.id !== s.id && overlaps(o.s, s)).map((o) => ({ title: o.s.title, startTime: o.s.startTime }));
        const isIn = checked.has(s.id);
        const evalOpen = isIn && s.ceHours > 0 && !evaluated.has(s.id) && (s.evaluationOpens === "checkin" || now >= endsAt);
        return {
          id: s.id,
          title: s.title,
          date: s.date,
          startTime: s.startTime,
          endTime: s.endTime,
          room: s.room,
          ceHours: s.ceHours,
          remind: item.remind,
          status: certified.has(s.id) ? ("certified" as const) : isIn ? ("attended" as const) : now > endsAt ? ("missed" as const) : ("upcoming" as const),
          canCheckIn: !isIn && now >= startsAt - 30 * 60_000 && now <= endsAt,
          evaluationOpen: evalOpen,
          conflicts,
        };
      }),
    };
  }),

  /** Adds a session to My agenda. Warns about overlaps but still adds it. */
  add: protectedProcedure.input(z.object({ slug: z.string().max(120), sessionId: z.number() })).mutation(({ ctx, input }) => {
    const { event, attendee } = attendeeViewer(ctx.user, input.slug);
    const s = getSession(event.id, input.sessionId);
    if (!s.published) throw notFound("That session");
    const db = getDb();
    const existing = db.select().from(schema.scheduleItems).where(and(eq(schema.scheduleItems.attendeeId, attendee.id), eq(schema.scheduleItems.sessionId, s.id))).get();
    if (existing) return { ok: true, conflicts: [] as { title: string; startTime: string }[] };
    if (s.requiresSignup && s.capacity) {
      const taken = signups([s.id]).get(s.id) ?? 0;
      if (taken >= s.capacity) throw bad("This session is full.");
    }
    const others = db
      .select({ s: schema.sessions })
      .from(schema.scheduleItems)
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.scheduleItems.sessionId))
      .where(eq(schema.scheduleItems.attendeeId, attendee.id))
      .all()
      .map((r) => r.s)
      .filter((o) => overlaps(o, s));
    db.insert(schema.scheduleItems).values({ attendeeId: attendee.id, sessionId: s.id }).onConflictDoNothing().run();
    return { ok: true, conflicts: others.map((o) => ({ title: o.title, startTime: o.startTime })) };
  }),

  remove: protectedProcedure.input(z.object({ slug: z.string().max(120), sessionId: z.number() })).mutation(({ ctx, input }) => {
    const { attendee } = attendeeViewer(ctx.user, input.slug);
    getDb().delete(schema.scheduleItems).where(and(eq(schema.scheduleItems.attendeeId, attendee.id), eq(schema.scheduleItems.sessionId, input.sessionId))).run();
    return { ok: true };
  }),

  setRemind: protectedProcedure.input(z.object({ slug: z.string().max(120), sessionId: z.number(), remind: z.boolean() })).mutation(({ ctx, input }) => {
    const { attendee } = attendeeViewer(ctx.user, input.slug);
    const res = getDb()
      .update(schema.scheduleItems)
      .set({ remind: input.remind })
      .where(and(eq(schema.scheduleItems.attendeeId, attendee.id), eq(schema.scheduleItems.sessionId, input.sessionId)))
      .run();
    if (!res.changes) throw bad("Add the session to My agenda first.");
    return { ok: true };
  }),
});
