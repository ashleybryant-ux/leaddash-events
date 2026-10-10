/** Speakers: admin profiles and the attendee speaker directory. */
import { z } from "zod";
import { and, asc, eq, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, notFound, requireArea } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { bad, eventMailStyle, speakerAttendeeIds, speakerFullName, url, viewer } from "./util";

const ROLES = ["presenter", "co-presenter", "moderator", "panelist"] as const;

const speakerInput = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(""),
  credentials: z.string().trim().max(80).default(""),
  jobTitle: z.string().trim().max(120).default(""),
  organization: z.string().trim().max(160).default(""),
  city: z.string().trim().max(120).default(""),
  bio: z.string().max(5000).default(""),
  headshotFileId: z.number().int().nullable().default(null),
  website: url.default(""),
  email: z.union([z.literal(""), z.string().trim().email().max(200)]).default(""),
  featured: z.boolean().default(false),
  allowMessages: z.boolean().default(true),
  sort: z.number().int().min(0).max(10000).default(0),
});

type SpeakerRow = typeof schema.speakers.$inferSelect;

function getSpeaker(eventId: number, speakerId: number) {
  const s = getDb().select().from(schema.speakers).where(eq(schema.speakers.id, speakerId)).get();
  if (!s || s.eventId !== eventId) throw notFound("That speaker");
  return s;
}

function checkFile(orgId: number, fileId: number | null) {
  if (!fileId) return;
  const f = getDb().select().from(schema.files).where(eq(schema.files.id, fileId)).get();
  if (!f || (f.orgId !== null && f.orgId !== orgId)) throw bad("Upload the headshot again.");
  if (!f.mime.startsWith("image/")) throw bad("The headshot must be an image.");
}

/** Sessions each speaker is on (all sessions, or only published ones for attendees). */
function sessionsBySpeaker(speakerIds: number[], publishedOnly: boolean) {
  const out = new Map<number, { id: number; title: string; date: string; startTime: string; room: string; ceHours: number; role: string }[]>();
  if (!speakerIds.length) return out;
  const rows = getDb()
    .select({ speakerId: schema.sessionSpeakers.speakerId, role: schema.sessionSpeakers.role, s: schema.sessions })
    .from(schema.sessionSpeakers)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionSpeakers.sessionId))
    .where(inArray(schema.sessionSpeakers.speakerId, speakerIds))
    .all()
    .filter((r) => !publishedOnly || r.s.published)
    .sort((a, b) => (a.s.date + a.s.startTime).localeCompare(b.s.date + b.s.startTime));
  for (const r of rows) {
    const list = out.get(r.speakerId) ?? [];
    list.push({ id: r.s.id, title: r.s.title, date: r.s.date, startTime: r.s.startTime, room: r.s.room, ceHours: r.s.ceHours, role: r.role });
    out.set(r.speakerId, list);
  }
  return out;
}

function profileStatus(s: SpeakerRow) {
  if (!s.headshotFileId) return "needs_headshot" as const;
  if (!s.bio.trim()) return "needs_bio" as const;
  return "complete" as const;
}

/** What attendees see on a speaker card and bio sheet. */
function attendeeCard(s: SpeakerRow, sessions: ReturnType<typeof sessionsBySpeaker>, messageIds: Map<string, number>, messaging: boolean) {
  return {
    id: s.id,
    name: speakerFullName(s),
    jobTitle: s.jobTitle,
    organization: s.organization,
    city: s.city,
    bio: s.bio,
    headshotUrl: fileUrl(s.headshotFileId),
    website: s.website,
    featured: s.featured,
    /** Attendee to message (the speaker's own registration), when messaging is on. */
    messageAttendeeId: messaging && s.allowMessages && s.email ? messageIds.get(s.email.toLowerCase()) ?? null : null,
    sessions: (sessions.get(s.id) ?? []).map(({ role, ...rest }) => ({ ...rest, role })),
  };
}

const fullNameOf = (i: { firstName: string; lastName: string }) => `${i.firstName} ${i.lastName}`.trim();

export const speakersRouter = router({
  adminList: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "speakers");
    const rows = getDb().select().from(schema.speakers).where(eq(schema.speakers.eventId, input.eventId)).orderBy(asc(schema.speakers.sort), asc(schema.speakers.name)).all();
    const sessions = sessionsBySpeaker(rows.map((r) => r.id), false);
    return rows.map((s) => ({ ...s, fullName: speakerFullName(s), headshotUrl: fileUrl(s.headshotFileId), status: profileStatus(s), sessions: sessions.get(s.id) ?? [] }));
  }),

  adminGet: protectedProcedure.input(z.object({ eventId: z.number(), speakerId: z.number() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "speakers");
    const s = getSpeaker(input.eventId, input.speakerId);
    const all = getDb()
      .select({ id: schema.sessions.id, title: schema.sessions.title, date: schema.sessions.date, startTime: schema.sessions.startTime })
      .from(schema.sessions)
      .where(eq(schema.sessions.eventId, input.eventId))
      .orderBy(asc(schema.sessions.date), asc(schema.sessions.startTime))
      .all();
    return { speaker: { ...s, fullName: speakerFullName(s), headshotUrl: fileUrl(s.headshotFileId), status: profileStatus(s) }, sessions: sessionsBySpeaker([s.id], false).get(s.id) ?? [], allSessions: all };
  }),

  create: protectedProcedure.input(speakerInput.extend({ eventId: z.number() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "speakers", "edit");
    checkFile(event.orgId, input.headshotFileId);
    const row = getDb()
      .insert(schema.speakers)
      .values({ ...input, email: input.email.toLowerCase(), name: fullNameOf(input) })
      .returning()
      .get();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "speaker.create", detail: row.name });
    return row;
  }),

  update: protectedProcedure.input(speakerInput.extend({ eventId: z.number(), speakerId: z.number() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "speakers", "edit");
    getSpeaker(input.eventId, input.speakerId);
    checkFile(event.orgId, input.headshotFileId);
    const { eventId, speakerId, ...rest } = input;
    void eventId;
    const row = getDb()
      .update(schema.speakers)
      .set({ ...rest, email: rest.email.toLowerCase(), name: fullNameOf(rest) })
      .where(eq(schema.speakers.id, speakerId))
      .returning()
      .get();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "speaker.update", detail: row.name });
    return row;
  }),

  delete: protectedProcedure.input(z.object({ eventId: z.number(), speakerId: z.number() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "speakers", "edit");
    const s = getSpeaker(input.eventId, input.speakerId);
    getDb().delete(schema.speakers).where(eq(schema.speakers.id, s.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "speaker.delete", detail: s.name });
    return { ok: true };
  }),

  /** Puts the speaker on a session (from the speaker's editor). */
  addSession: protectedProcedure
    .input(z.object({ eventId: z.number(), speakerId: z.number(), sessionId: z.number(), role: z.enum(ROLES).default("presenter") }))
    .mutation(({ ctx, input }) => {
      requireArea(ctx.user, input.eventId, "speakers", "edit");
      getSpeaker(input.eventId, input.speakerId);
      const s = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, input.sessionId)).get();
      if (!s || s.eventId !== input.eventId) throw notFound("That session");
      getDb().insert(schema.sessionSpeakers).values({ sessionId: input.sessionId, speakerId: input.speakerId, role: input.role }).onConflictDoNothing().run();
      return { ok: true };
    }),

  removeSession: protectedProcedure.input(z.object({ eventId: z.number(), speakerId: z.number(), sessionId: z.number() })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "speakers", "edit");
    getSpeaker(input.eventId, input.speakerId);
    getDb()
      .delete(schema.sessionSpeakers)
      .where(and(eq(schema.sessionSpeakers.speakerId, input.speakerId), eq(schema.sessionSpeakers.sessionId, input.sessionId)))
      .run();
    return { ok: true };
  }),

  /** Emails the speaker asking for an updated bio, headshot or website. */
  requestUpdate: protectedProcedure.input(z.object({ eventId: z.number(), speakerId: z.number() })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "speakers", "edit");
    const s = getSpeaker(input.eventId, input.speakerId);
    if (!s.email) throw bad("Add the speaker's email first.");
    const style = eventMailStyle(event);
    const missing = [!s.headshotFileId ? "a headshot" : "", !s.bio.trim() ? "your bio" : "", !s.website ? "your website" : ""].filter(Boolean);
    const ask = missing.length ? `Please reply with ${missing.join(", ")}.` : "Please reply with any changes to your bio, headshot or website.";
    const text = `Hi ${s.firstName || s.name},\n\nWe are getting the ${event.name} app ready. ${ask} Attendees see your profile when they open your sessions.\n\nThank you,\n${style.fromName}`;
    await sendEmail({
      to: s.email,
      subject: `Your speaker profile for ${event.shortName || event.name}`,
      text,
      fromName: style.fromName,
      replyTo: ctx.user.email,
      html: emailLayout({ ...style, title: "Your speaker profile", blocks: [`<p>Hi ${escapeHtml(s.firstName || s.name)},</p>`, `<p>We are getting the ${escapeHtml(event.name)} app ready. ${escapeHtml(ask)} Attendees see your profile when they open your sessions.</p>`, `<p>Thank you,<br>${escapeHtml(style.fromName)}</p>`] }),
    });
    return { ok: true };
  }),

  /** Attendee app: the speaker directory. */
  list: protectedProcedure.input(z.object({ slug: z.string().max(120), q: z.string().max(120).default("") })).query(({ ctx, input }) => {
    const { event } = viewer(ctx.user, input.slug);
    const rows = getDb().select().from(schema.speakers).where(eq(schema.speakers.eventId, event.id)).all();
    const sessions = sessionsBySpeaker(rows.map((r) => r.id), true);
    const ids = speakerAttendeeIds(event.id, rows.map((r) => r.email));
    const q = input.q.trim().toLowerCase();
    return rows
      .filter((s) => (sessions.get(s.id) ?? []).length > 0 || s.featured)
      .map((s) => attendeeCard(s, sessions, ids, event.features.messaging))
      .filter((c) => !q || [c.name, c.jobTitle, c.organization, c.city, ...c.sessions.map((x) => x.title)].some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.featured) - Number(a.featured) || (rows.find((r) => r.id === a.id)!.sort - rows.find((r) => r.id === b.id)!.sort) || a.name.localeCompare(b.name));
  }),

  /** Attendee app: one speaker for the bio sheet. */
  get: protectedProcedure.input(z.object({ slug: z.string().max(120), speakerId: z.number() })).query(({ ctx, input }) => {
    const { event } = viewer(ctx.user, input.slug);
    const s = getSpeaker(event.id, input.speakerId);
    return attendeeCard(s, sessionsBySpeaker([s.id], true), speakerAttendeeIds(event.id, [s.email]), event.features.messaging);
  }),
});
