/**
 * Slides and handouts: speaker uploads on their speaker page (/speak/:token),
 * staff view and upload on the session, attendee downloads in the app.
 *
 * Big files never go through tRPC. They stream in through
 * POST /api/upload/session-file and out through GET /api/session-file/:id
 * (which checks access, counts attendee downloads, then hands over a signed
 * file link) and GET /api/slides/:eventId/slides.zip (staff).
 */
import fs from "node:fs";
import { crc32 } from "node:zlib";
import { z } from "zod";
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { protectedProcedure, publicProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { attendeeFor, audit, forbidden, getEvent, notFound, requireArea } from "../../_core/access";
import { userFromCookie } from "../../_core/context";
import { randomToken } from "../../_core/crypto";
import { ENV } from "../../_core/env";
import { DOC_MAX_BYTES, UploadError, deleteFile, docBadge, filePath, fileUrl, saveFile, saveStream } from "../../_core/files";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { fmtDate } from "@shared/format";
import type { User } from "../../../drizzle/schema";
import { bad, eventMailStyle, isEventStaff, sessionStart, speakerFullName, speakersBySession, viewer, type EventRow } from "./util";

type SessionRow = typeof schema.sessions.$inferSelect;
type SpeakerRow = typeof schema.speakers.$inferSelect;
export type SlidesShare = SessionRow["slidesShare"];
const SHARES = ["after_start", "now", "hidden"] as const;
/** Breaks and meals have no slides. */
const NO_SLIDES = new Set(["break", "meal"]);

/* ---------------- Helpers other areas use ---------------- */

/** The speaker's secret page token, made the first time it is needed. */
export function ensurePortalToken(speakerId: number): string {
  const db = getDb();
  const s = db.select({ portalToken: schema.speakers.portalToken }).from(schema.speakers).where(eq(schema.speakers.id, speakerId)).get();
  if (!s) throw notFound("That speaker");
  if (s.portalToken) return s.portalToken;
  const token = randomToken(24);
  db.update(schema.speakers).set({ portalToken: token }).where(and(eq(schema.speakers.id, speakerId), sql`${schema.speakers.portalToken} is null`)).run();
  return db.select({ portalToken: schema.speakers.portalToken }).from(schema.speakers).where(eq(schema.speakers.id, speakerId)).get()!.portalToken!;
}

/** Full link to the speaker's page (slides, bio, agreement). Use it behind "Upload slides" buttons in emails. */
export function speakerPageUrl(speakerId: number): string {
  return `${ENV.appUrl}/speak/${ensurePortalToken(speakerId)}`;
}

/** Whether attendees may download a session's files right now. */
export function slidesOpen(s: Pick<SessionRow, "slidesShare" | "date" | "startTime">, timeZone: string, now = Date.now()) {
  if (s.slidesShare === "now") return true;
  if (s.slidesShare === "hidden") return false;
  return now >= sessionStart(s, timeZone).getTime();
}

/** "Session slides" from "Session-Slides_final.pptx". */
export const labelFromName = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

const fileRows = (sessionIds: number[]) =>
  sessionIds.length
    ? getDb()
        .select({ sf: schema.sessionFiles, file: schema.files })
        .from(schema.sessionFiles)
        .innerJoin(schema.files, eq(schema.files.id, schema.sessionFiles.fileId))
        .where(inArray(schema.sessionFiles.sessionId, sessionIds))
        .orderBy(asc(schema.sessionFiles.createdAt), asc(schema.sessionFiles.id))
        .all()
    : [];

const downloadPath = (sessionFileId: number, token?: string) => `/api/session-file/${sessionFileId}${token ? `?token=${encodeURIComponent(token)}` : ""}`;

function speakerByToken(token: string) {
  if (!token || token.length < 20) throw notFound("That speaker page");
  const s = getDb().select().from(schema.speakers).where(eq(schema.speakers.portalToken, token)).get();
  if (!s) throw notFound("That speaker page");
  return s;
}

function speakerSessionIds(speakerId: number) {
  return getDb().select({ id: schema.sessionSpeakers.sessionId }).from(schema.sessionSpeakers).where(eq(schema.sessionSpeakers.speakerId, speakerId)).all().map((r) => r.id);
}

/** A session the speaker presents (throws otherwise). */
function speakerSession(speaker: SpeakerRow, sessionId: number) {
  const s = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!s || s.eventId !== speaker.eventId || !speakerSessionIds(speaker.id).includes(s.id)) throw notFound("That session");
  return s;
}

function getSession(eventId: number, sessionId: number) {
  const s = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!s || s.eventId !== eventId) throw notFound("That session");
  return s;
}

/** Who uploaded each file, by name. */
function uploaderNames(rows: { sf: typeof schema.sessionFiles.$inferSelect }[]) {
  const db = getDb();
  const sIds = Array.from(new Set(rows.map((r) => r.sf.uploadedBySpeakerId).filter((x): x is number => !!x)));
  const uIds = Array.from(new Set(rows.map((r) => r.sf.uploadedByUserId).filter((x): x is number => !!x)));
  const speakers = new Map(sIds.length ? db.select().from(schema.speakers).where(inArray(schema.speakers.id, sIds)).all().map((s) => [s.id, s.name] as const) : []);
  const users = new Map(uIds.length ? db.select().from(schema.users).where(inArray(schema.users.id, uIds)).all().map((u) => [u.id, u.name || u.email] as const) : []);
  return (sf: typeof schema.sessionFiles.$inferSelect) => (sf.uploadedBySpeakerId ? speakers.get(sf.uploadedBySpeakerId) : sf.uploadedByUserId ? users.get(sf.uploadedByUserId) : undefined) ?? "";
}

/** Emails a speaker a branded reminder with their speaker page link. Returns false when they have no email. */
async function sendSlidesReminder(ev: EventRow, speaker: SpeakerRow, sessions: SessionRow[], replyTo?: string) {
  if (!speaker.email.trim()) return false;
  const style = eventMailStyle(ev);
  const link = speakerPageUrl(speaker.id);
  const due = sessions.map((s) => s.slidesDueOn).filter(Boolean).sort()[0];
  const titles = sessions.map((s) => s.title);
  const what = titles.length === 1 ? titles[0] : `${titles.length} sessions`;
  const dueLine = due ? ` They are due ${fmtDate(due)}.` : "";
  const text = `Hi ${speaker.firstName || speaker.name},\n\nWe do not have your slides for ${what} yet.${dueLine} Upload them on your speaker page:\n${link}\n\nThank you,\n${style.fromName}`;
  await sendEmail({
    to: speaker.email,
    subject: `Your slides for ${ev.shortName || ev.name}`,
    text,
    fromName: style.fromName,
    replyTo,
    html: emailLayout({
      ...style,
      title: "Your slides",
      blocks: [
        `<p>Hi ${escapeHtml(speaker.firstName || speaker.name)},</p>`,
        `<p>We do not have your slides for <strong>${escapeHtml(what)}</strong> yet.${escapeHtml(dueLine)} Upload them on your speaker page.</p>`,
        emailButton("Upload slides", link, ev.branding),
        `<p>Thank you,<br>${escapeHtml(style.fromName)}</p>`,
      ],
    }),
  });
  return true;
}

/* ---------------- tRPC ---------------- */

export const slidesRouter = router({
  /** Staff: a session's files, sharing and due date. */
  forSession: protectedProcedure.input(z.object({ eventId: z.number(), sessionId: z.number() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "sessions");
    const s = getSession(input.eventId, input.sessionId);
    const rows = fileRows([s.id]);
    const who = uploaderNames(rows);
    return {
      slidesShare: s.slidesShare,
      slidesDueOn: s.slidesDueOn,
      downloads: rows.reduce((a, r) => a + r.sf.downloads, 0),
      maxBytes: DOC_MAX_BYTES,
      files: rows.map((r) => ({ id: r.sf.id, name: r.file.name, label: r.sf.label, badge: docBadge(r.file.name), size: r.file.size, by: who(r.sf), at: r.sf.createdAt, downloads: r.sf.downloads, url: downloadPath(r.sf.id) })),
    };
  }),

  /** Staff: Share with attendees and the due date for speakers. */
  update: protectedProcedure
    .input(z.object({ eventId: z.number(), sessionId: z.number(), slidesShare: z.enum(SHARES), slidesDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }))
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "sessions", "edit");
      const s = getSession(input.eventId, input.sessionId);
      getDb().update(schema.sessions).set({ slidesShare: input.slidesShare, slidesDueOn: input.slidesDueOn }).where(eq(schema.sessions.id, s.id)).run();
      audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "slides.update", detail: s.title });
      return { ok: true };
    }),

  /** Staff: remove a file from a session. */
  remove: protectedProcedure.input(z.object({ eventId: z.number(), sessionFileId: z.number() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "sessions", "edit");
    const sf = getDb().select().from(schema.sessionFiles).where(eq(schema.sessionFiles.id, input.sessionFileId)).get();
    if (!sf || sf.eventId !== input.eventId) throw notFound("That file");
    deleteFile(sf.fileId);
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "slides.remove", detail: String(sf.sessionId) });
    return { ok: true };
  }),

  /** Staff: every session that takes slides, with its files and speakers (Slides tab). */
  overview: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "sessions");
    const sessions = getDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.eventId, input.eventId))
      .orderBy(asc(schema.sessions.date), asc(schema.sessions.startTime))
      .all()
      .filter((s) => !NO_SLIDES.has(s.kind));
    const ids = sessions.map((s) => s.id);
    const speakers = speakersBySession(ids);
    const files = new Map<number, { id: number; name: string; url: string }[]>();
    for (const r of fileRows(ids)) {
      const list = files.get(r.sf.sessionId) ?? [];
      list.push({ id: r.sf.id, name: r.file.name, url: downloadPath(r.sf.id) });
      files.set(r.sf.sessionId, list);
    }
    const rows = sessions.map((s) => ({
      id: s.id,
      title: s.title,
      date: s.date,
      startTime: s.startTime,
      slidesShare: s.slidesShare,
      slidesDueOn: s.slidesDueOn,
      speakers: (speakers.get(s.id) ?? []).map((p) => p.name),
      files: files.get(s.id) ?? [],
    }));
    return { rows, missing: rows.filter((r) => !r.files.length).length, withFiles: rows.filter((r) => r.files.length).length };
  }),

  /** Staff: emails the speakers of sessions with no files (all of them, or the ones picked). */
  remind: protectedProcedure.input(z.object({ eventId: z.number(), sessionIds: z.array(z.number()).max(500).optional() })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "sessions", "edit");
    const db = getDb();
    let sessions = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, input.eventId)).all().filter((s) => !NO_SLIDES.has(s.kind));
    if (input.sessionIds) sessions = sessions.filter((s) => input.sessionIds!.includes(s.id));
    const have = new Set(fileRows(sessions.map((s) => s.id)).map((r) => r.sf.sessionId));
    const missing = sessions.filter((s) => !have.has(s.id));
    if (!missing.length) return { sent: 0, noEmail: 0 };
    const links = db.select().from(schema.sessionSpeakers).where(inArray(schema.sessionSpeakers.sessionId, missing.map((s) => s.id))).all();
    const bySpeaker = new Map<number, SessionRow[]>();
    for (const l of links) bySpeaker.set(l.speakerId, [...(bySpeaker.get(l.speakerId) ?? []), missing.find((s) => s.id === l.sessionId)!]);
    let sent = 0;
    let noEmail = 0;
    const speakers = bySpeaker.size ? db.select().from(schema.speakers).where(inArray(schema.speakers.id, Array.from(bySpeaker.keys()))).all() : [];
    for (const sp of speakers) {
      if (await sendSlidesReminder(event, sp, bySpeaker.get(sp.id)!, ctx.user.email)) sent++;
      else noEmail++;
    }
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "slides.remind", detail: `${sent} sent` });
    return { sent, noEmail };
  }),

  /** Staff: the speaker page link for a speaker (to copy or open). */
  speakerLink: protectedProcedure.input(z.object({ eventId: z.number(), speakerId: z.number() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "sessions");
    const sp = getDb().select().from(schema.speakers).where(eq(schema.speakers.id, input.speakerId)).get();
    if (!sp || sp.eventId !== input.eventId) throw notFound("That speaker");
    return { url: speakerPageUrl(sp.id) };
  }),

  /** Speaker page: everything on /speak/:token. */
  page: publicProcedure.input(z.object({ token: z.string().max(100) })).query(({ input }) => {
    const sp = speakerByToken(input.token);
    const db = getDb();
    const ev = getEvent(sp.eventId);
    const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
    const ids = speakerSessionIds(sp.id);
    const sessions = ids.length ? db.select().from(schema.sessions).where(inArray(schema.sessions.id, ids)).orderBy(asc(schema.sessions.date), asc(schema.sessions.startTime)).all() : [];
    const people = speakersBySession(ids);
    const rows = fileRows(ids);
    const agreement = db
      .select()
      .from(schema.agreements)
      .where(and(eq(schema.agreements.speakerId, sp.id), inArray(schema.agreements.status, ["sent", "signed"])))
      .orderBy(desc(schema.agreements.id))
      .get();
    const attendee = sp.email.trim()
      ? db
          .select({ a: schema.attendees, ticket: schema.ticketTypes.name })
          .from(schema.attendees)
          .leftJoin(schema.ticketTypes, eq(schema.ticketTypes.id, schema.attendees.ticketTypeId))
          .where(and(eq(schema.attendees.eventId, ev.id), eq(schema.attendees.email, sp.email.trim().toLowerCase())))
          .all()
          .find((r) => r.a.status !== "cancelled")
      : undefined;
    return {
      event: {
        name: ev.name,
        shortName: ev.shortName || ev.name,
        slug: ev.slug,
        startDate: ev.startDate,
        endDate: ev.endDate,
        venueName: ev.venueName,
        orgName: org.name,
        branding: ev.branding,
        logoUrl: fileUrl(ev.branding.logoFileId ?? org.logoFileId),
        coverUrl: fileUrl(ev.branding.coverFileId),
      },
      speaker: {
        id: sp.id,
        name: sp.name,
        fullName: speakerFullName(sp),
        firstName: sp.firstName,
        lastName: sp.lastName,
        credentials: sp.credentials,
        jobTitle: sp.jobTitle,
        organization: sp.organization,
        bio: sp.bio,
        headshotFileId: sp.headshotFileId,
        headshotUrl: fileUrl(sp.headshotFileId),
      },
      maxBytes: DOC_MAX_BYTES,
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        kind: s.kind,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        room: s.room,
        slidesShare: s.slidesShare,
        slidesDueOn: s.slidesDueOn,
        others: (people.get(s.id) ?? []).filter((p) => p.id !== sp.id).map((p) => ({ name: p.name, role: p.role })),
        files: rows
          .filter((r) => r.sf.sessionId === s.id)
          .map((r) => ({ id: r.sf.id, name: r.file.name, badge: docBadge(r.file.name), size: r.file.size, at: r.sf.createdAt, mine: r.sf.uploadedBySpeakerId === sp.id, url: downloadPath(r.sf.id, input.token) })),
      })),
      agreement: agreement ? { status: agreement.status as "sent" | "signed", code: agreement.code, signedAt: agreement.signedAt, recordingAllowed: agreement.recordingAllowed } : null,
      registration: attendee ? { ticket: attendee.ticket ?? "", checkedIn: !!attendee.a.checkedInAt } : null,
    };
  }),

  /** Speaker page: Share with attendees. */
  setShare: publicProcedure.input(z.object({ token: z.string().max(100), sessionId: z.number(), slidesShare: z.enum(SHARES) })).mutation(({ input }) => {
    const sp = speakerByToken(input.token);
    const s = speakerSession(sp, input.sessionId);
    getDb().update(schema.sessions).set({ slidesShare: input.slidesShare }).where(eq(schema.sessions.id, s.id)).run();
    return { ok: true };
  }),

  /** Speaker page: remove a file the speaker uploaded. */
  removeFile: publicProcedure.input(z.object({ token: z.string().max(100), sessionFileId: z.number() })).mutation(({ input }) => {
    const sp = speakerByToken(input.token);
    const sf = getDb().select().from(schema.sessionFiles).where(eq(schema.sessionFiles.id, input.sessionFileId)).get();
    if (!sf || sf.eventId !== sp.eventId) throw notFound("That file");
    speakerSession(sp, sf.sessionId);
    if (sf.uploadedBySpeakerId !== sp.id) throw forbidden("Only the person who uploaded a file can remove it. Ask event staff.");
    deleteFile(sf.fileId);
    return { ok: true };
  }),

  /** Speaker page: bio, credentials, job title, organization and headshot. */
  updateBio: publicProcedure
    .input(
      z.object({
        token: z.string().max(100),
        credentials: z.string().trim().max(80),
        jobTitle: z.string().trim().max(120),
        organization: z.string().trim().max(160),
        bio: z.string().max(5000),
        headshotFileId: z.number().int().nullable(),
      })
    )
    .mutation(({ input }) => {
      const sp = speakerByToken(input.token);
      const db = getDb();
      if (input.headshotFileId && input.headshotFileId !== sp.headshotFileId) {
        const f = db.select().from(schema.files).where(eq(schema.files.id, input.headshotFileId)).get();
        const ev = getEvent(sp.eventId);
        if (!f || !f.isPublic || !f.mime.startsWith("image/") || f.orgId !== ev.orgId) throw bad("Upload the photo again.");
      }
      const { token, ...rest } = input;
      void token;
      db.update(schema.speakers).set(rest).where(eq(schema.speakers.id, sp.id)).run();
      return { ok: true };
    }),

  /** Speaker page: upload a headshot (base64 image, like every other photo). */
  uploadPhoto: publicProcedure
    .input(z.object({ token: z.string().max(100), name: z.string().min(1).max(200), mime: z.enum(["image/png", "image/jpeg", "image/webp"]), base64: z.string().max(22_000_000) }))
    .mutation(({ input }) => {
      const sp = speakerByToken(input.token);
      const ev = getEvent(sp.eventId);
      const f = saveFile({ orgId: ev.orgId, name: input.name, mime: input.mime, base64: input.base64, isPublic: true, userId: null });
      return { id: f.id, url: fileUrl(f.id)! };
    }),

  /** Attendee app: the session's shared files (staff and the session's speakers see them before sharing opens). */
  forAttendee: protectedProcedure.input(z.object({ slug: z.string().max(120), sessionId: z.number() })).query(({ ctx, input }) => {
    const { event, staff } = viewer(ctx.user, input.slug);
    const s = getSession(event.id, input.sessionId);
    if (!s.published && !staff) throw notFound("That session");
    const presenter = isSessionSpeaker(ctx.user, s);
    const open = slidesOpen(s, event.timezone);
    if (!open && !staff && !presenter) return { files: [] };
    return {
      files: fileRows([s.id]).map((r) => ({ id: r.sf.id, label: r.sf.label || labelFromName(r.file.name), badge: docBadge(r.file.name), size: r.file.size, url: downloadPath(r.sf.id) })),
    };
  }),

  /** Attendee app: the signed-in person's speaker page, when their email belongs to a speaker. */
  mySpeakerPage: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const { event } = viewer(ctx.user, input.slug);
    const sp = getDb()
      .select({ id: schema.speakers.id })
      .from(schema.speakers)
      .where(and(eq(schema.speakers.eventId, event.id), sql`lower(${schema.speakers.email}) = ${ctx.user.email.toLowerCase()}`))
      .get();
    return { url: sp ? `/speak/${ensurePortalToken(sp.id)}` : null };
  }),
});

/** The signed-in person is a speaker on this session (matched by email or linked account). */
function isSessionSpeaker(user: User, s: SessionRow) {
  return getDb()
    .select({ id: schema.speakers.id })
    .from(schema.sessionSpeakers)
    .innerJoin(schema.speakers, eq(schema.speakers.id, schema.sessionSpeakers.speakerId))
    .where(and(eq(schema.sessionSpeakers.sessionId, s.id), sql`(${schema.speakers.userId} = ${user.id} or lower(${schema.speakers.email}) = ${user.email.toLowerCase()})`))
    .all().length > 0;
}

/* ---------------- Plain HTTP: streamed upload, download, zip ---------------- */

/** Whoever is calling: a speaker (by page token) or a signed-in person. */
function whoIsCalling(req: Request) {
  const token = String(req.query.token || req.header("x-speaker-token") || "");
  if (token) {
    try {
      return { speaker: speakerByToken(token), user: null };
    } catch {
      return { speaker: null, user: null };
    }
  }
  let user: User | null = null;
  try {
    user = userFromCookie(req.headers.cookie);
  } catch {
    user = null;
  }
  return { speaker: null, user };
}

function canStaff(user: User | null, eventId: number, level: "view" | "edit") {
  if (!user) return false;
  try {
    requireArea(user, eventId, "sessions", level);
    return true;
  } catch {
    return false;
  }
}

/** POST /api/upload/session-file?sessionId=..&name=..[&token=..][&replace=..] with the file bytes as the body. */
async function handleUpload(req: Request, res: Response) {
  const fail = (status: number, error: string) => {
    // Stop reading a body we are refusing.
    res.setHeader("Connection", "close");
    res.status(status).json({ error });
    req.unpipe();
    req.resume();
  };
  const declared = Number(req.header("content-length") || 0);
  if (declared > DOC_MAX_BYTES) return fail(413, `Files can be up to ${Math.round(DOC_MAX_BYTES / 1024 / 1024)} MB.`);
  const sessionId = Number(req.query.sessionId);
  const name = String(req.query.name || req.header("x-file-name") || "");
  const session = sessionId ? getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get() : undefined;
  if (!session) return fail(404, "That session was not found.");
  const ev = getDb().select().from(schema.events).where(eq(schema.events.id, session.eventId)).get()!;
  const { speaker, user } = whoIsCalling(req);
  if (speaker) {
    if (speaker.eventId !== ev.id || !speakerSessionIds(speaker.id).includes(session.id)) return fail(403, "You can upload files only for your own sessions.");
  } else if (!canStaff(user, ev.id, "edit")) {
    return fail(user ? 403 : 401, user ? "You do not have access to change this session." : "Sign in again, then try the upload.");
  }
  const replaceId = Number(req.query.replace || 0);
  const replacing = replaceId ? getDb().select().from(schema.sessionFiles).where(eq(schema.sessionFiles.id, replaceId)).get() : undefined;
  if (replaceId && (!replacing || replacing.sessionId !== session.id || (speaker && replacing.uploadedBySpeakerId !== speaker.id))) return fail(403, "That file cannot be replaced here.");
  try {
    const f = await saveStream(req, { orgId: ev.orgId, name, userId: user?.id ?? null });
    const row = getDb()
      .insert(schema.sessionFiles)
      .values({ eventId: ev.id, sessionId: session.id, fileId: f.id, label: labelFromName(f.name), uploadedBySpeakerId: speaker?.id ?? null, uploadedByUserId: speaker ? null : user!.id })
      .returning()
      .get();
    if (replacing) deleteFile(replacing.fileId);
    if (user) audit(user, { orgId: ev.orgId, eventId: ev.id, action: "slides.upload", detail: f.name });
    res.json({ fileId: f.id, sessionFileId: row.id, name: f.name, size: f.size });
  } catch (err) {
    if (err instanceof UploadError) return fail(err.status, err.message);
    console.error("[slides] upload failed:", err);
    fail(500, "The upload did not finish. Try again.");
  }
}

/** GET /api/session-file/:id: checks access, counts attendee downloads, then hands over a signed link. */
function handleDownload(req: Request, res: Response) {
  const db = getDb();
  const sf = db.select().from(schema.sessionFiles).where(eq(schema.sessionFiles.id, Number(req.params.id))).get();
  if (!sf) return res.status(404).send("That file was not found.");
  const s = db.select().from(schema.sessions).where(eq(schema.sessions.id, sf.sessionId)).get()!;
  const ev = db.select().from(schema.events).where(eq(schema.events.id, sf.eventId)).get()!;
  const { speaker, user } = whoIsCalling(req);
  let ok = false;
  let count = false;
  if (speaker) ok = speaker.eventId === ev.id && speakerSessionIds(speaker.id).includes(s.id);
  else if (user) {
    if (isEventStaff(user, ev.id)) ok = true;
    else if (isSessionSpeaker(user, s)) ok = true;
    else if (attendeeFor(user, ev.id) && ev.status !== "draft" && s.published && slidesOpen(s, ev.timezone)) ok = count = true;
  }
  if (!ok) return res.status(user || speaker ? 403 : 401).send(user || speaker ? "These files are not shared yet." : "Sign in to the event app to download this file.");
  if (count) db.update(schema.sessionFiles).set({ downloads: sql`${schema.sessionFiles.downloads} + 1` }).where(eq(schema.sessionFiles.id, sf.id)).run();
  res.setHeader("Cache-Control", "private, no-store");
  res.redirect(302, fileUrl(sf.fileId, false, true)!);
}

/* A zip written as it streams: stored entries (decks are already compressed), CRC computed on the way through. */

function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const safePart = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "file";

async function writeZip(res: Response, entries: { name: string; path: string; at: Date }[]) {
  let offset = 0;
  const central: Buffer[] = [];
  const write = (buf: Buffer) =>
    new Promise<void>((resolve) => {
      offset += buf.length;
      if (res.write(buf)) resolve();
      else res.once("drain", resolve);
    });
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const { time, date } = dosTime(e.at);
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // sizes follow the data; UTF-8 names
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    await write(Buffer.concat([local, name]));
    let crc = 0;
    let size = 0;
    for await (const chunk of fs.createReadStream(e.path)) {
      crc = crc32(chunk as Buffer, crc);
      size += (chunk as Buffer).length;
      await write(chunk as Buffer);
    }
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    await write(desc);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0808, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(size, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(start, 42);
    central.push(c, name);
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(cd);
  await write(end);
  res.end();
}

/** GET /api/slides/:eventId/slides.zip[?sessionId=..]: staff download every file (or one session's) as one zip. */
async function handleZip(req: Request, res: Response) {
  const eventId = Number(req.params.eventId);
  const { user } = whoIsCalling(req);
  if (!eventId || !canStaff(user, eventId, "view")) return res.status(user ? 403 : 401).send("Sign in as event staff to download slides.");
  const ev = getDb().select().from(schema.events).where(eq(schema.events.id, eventId)).get();
  if (!ev) return res.status(404).send("That event was not found.");
  const one = Number(req.query.sessionId || 0);
  const sessions = getDb().select().from(schema.sessions).where(eq(schema.sessions.eventId, eventId)).all().filter((s) => !one || s.id === one);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rows = fileRows(sessions.map((s) => s.id));
  const used = new Set<string>();
  const entries: { name: string; path: string; at: Date }[] = [];
  let total = 0;
  for (const r of rows) {
    const p = filePath(r.file.key);
    if (!fs.existsSync(p)) continue;
    const s = byId.get(r.sf.sessionId)!;
    let name = one ? safePart(r.file.name) : `${safePart(s.title)}/${safePart(r.file.name)}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = name.replace(/(\.[^./]+)?$/, (ext) => ` (${i})${ext}`);
    used.add(name.toLowerCase());
    entries.push({ name, path: p, at: r.sf.createdAt });
    total += r.file.size;
  }
  if (!entries.length) return res.status(404).send("No slides have been uploaded yet.");
  if (total > 3.5 * 1024 ** 3 || entries.length > 60000) return res.status(413).send("Too many files for one download. Download them by session.");
  const zipName = `${safePart(one ? sessions[0].title : `${ev.shortName || ev.name} slides`)}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  res.setHeader("Cache-Control", "private, no-store");
  try {
    await writeZip(res, entries);
  } catch (err) {
    console.error("[slides] zip failed:", err);
    res.destroy();
  }
}

/** Registered before JSON parsing, so the upload body is never parsed or buffered. */
export function registerSlidesHttp(app: Express) {
  app.post("/api/upload/session-file", (req, res) => void handleUpload(req, res));
  app.get("/api/session-file/:id", handleDownload);
  app.get("/api/slides/:eventId/slides.zip", (req, res) => void handleZip(req, res));
}

/** Text for the Shared column and read views. */
export const SHARE_LABELS: Record<SlidesShare, string> = { after_start: "After the session starts", now: "Right away", hidden: "Do not share" };
