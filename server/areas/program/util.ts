/** Helpers shared by the program routes. */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import type { User } from "../../../drizzle/schema";
import { attendeeFor, eventAccess, forbidden, getEventBySlug, requireAttendee } from "../../_core/access";
import { getDb, schema } from "../../_core/db";
import { fileUrl } from "../../_core/files";
import { zonedToDate } from "@shared/time";
import { fmtDate, fmtTime } from "@shared/format";

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2027-04-22.");
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 10:30.");
export const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const url = z.string().trim().max(500).refine((v) => v === "" || /^(https?:\/\/|mailto:|tel:|\/)/i.test(v), "Links start with https://");

export const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

export type EventRow = typeof schema.events.$inferSelect;
export type AttendeeRow = typeof schema.attendees.$inferSelect;

export function isEventStaff(user: User, eventId: number) {
  const a = eventAccess(user, eventId);
  return a.admin || a.kinds.size > 0 || Object.values(a.areas).some((v) => v !== "none");
}

/**
 * Who is looking at the attendee app: their attendee row (if registered) and
 * whether they are event staff. Staff without a registration can browse but
 * have no personal agenda.
 */
export function viewer(user: User, slug: string): { event: EventRow; attendee: AttendeeRow | null; staff: boolean } {
  const event = getEventBySlug(slug);
  const staff = isEventStaff(user, event.id);
  const row = attendeeFor(user, event.id);
  if (!row && !staff) throw forbidden("You are not registered for this event.");
  if (event.status === "draft" && !staff) throw forbidden("The app opens soon.");
  const attendee = row ? requireAttendee(user, event.id) : null;
  return { event, attendee, staff };
}

/** Like viewer(), but the person must be registered (their own agenda, requests, reports). */
export function attendeeViewer(user: User, slug: string) {
  const v = viewer(user, slug);
  if (!v.attendee) throw forbidden("Register for this event to use this.");
  return { event: v.event, attendee: v.attendee, staff: v.staff };
}

export const sessionStart = (s: { date: string; startTime: string }, tz: string) => zonedToDate(s.date, s.startTime, tz);
export const sessionEnd = (s: { date: string; endTime: string }, tz: string) => zonedToDate(s.date, s.endTime, tz);

/** "Apr 22, 2027 · 10:30 AM · Room 204" */
export const whenLine = (s: { date: string; startTime: string; room: string }) => [fmtDate(s.date), fmtTime(s.startTime), s.room].filter(Boolean).join(" · ");

export const speakerFullName = (s: { name: string; credentials: string }) => `${s.name}${s.credentials ? `, ${s.credentials}` : ""}`;

/** Speakers of each session, presenters first. */
export function speakersBySession(sessionIds: number[]) {
  const out = new Map<number, { id: number; name: string; role: string; headshotUrl: string | null }[]>();
  if (!sessionIds.length) return out;
  const rows = getDb()
    .select({ sessionId: schema.sessionSpeakers.sessionId, role: schema.sessionSpeakers.role, speaker: schema.speakers })
    .from(schema.sessionSpeakers)
    .innerJoin(schema.speakers, eq(schema.speakers.id, schema.sessionSpeakers.speakerId))
    .where(inArray(schema.sessionSpeakers.sessionId, sessionIds))
    .all();
  const order = { presenter: 0, "co-presenter": 1, moderator: 2, panelist: 3 } as Record<string, number>;
  rows.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.speaker.sort - b.speaker.sort);
  for (const r of rows) {
    const list = out.get(r.sessionId) ?? [];
    list.push({ id: r.speaker.id, name: speakerFullName(r.speaker), role: r.role, headshotUrl: fileUrl(r.speaker.headshotFileId) });
    out.set(r.sessionId, list);
  }
  return out;
}

/** The person's push choices for this event (all on unless they changed them). */
export function prefsFor(attendeeIds: number[]) {
  const map = new Map<number, typeof schema.alertPrefs.$inferSelect>();
  if (!attendeeIds.length) return map;
  for (const p of getDb().select().from(schema.alertPrefs).where(inArray(schema.alertPrefs.attendeeId, attendeeIds)).all()) map.set(p.attendeeId, p);
  return map;
}

/** The attendee row that belongs to a speaker (same event, same email), for messaging. */
export function speakerAttendeeIds(eventId: number, emails: string[]) {
  const clean = emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  const map = new Map<string, number>();
  if (!clean.length) return map;
  for (const a of getDb()
    .select({ id: schema.attendees.id, email: schema.attendees.email, status: schema.attendees.status })
    .from(schema.attendees)
    .where(and(eq(schema.attendees.eventId, eventId), inArray(schema.attendees.email, clean)))
    .all()) {
    if (a.status !== "cancelled") map.set(a.email, a.id);
  }
  return map;
}

/** Event colors, cover and sender name for emails. */
export function eventMailStyle(ev: EventRow) {
  return {
    brand: ev.branding.colorPrimary,
    accent: ev.branding.colorAccent,
    coverUrl: fileUrl(ev.branding.coverFileId, true),
    fromName: ev.shortName || ev.name,
    eventName: ev.name,
    look: ev.branding,
  };
}
