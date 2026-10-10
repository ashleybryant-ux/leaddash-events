/**
 * Rules shared by the CE area: session check-in windows, which evaluation a
 * session uses, when an evaluation is open, and issuing certificates.
 *
 * NBCC-style audits expect attendance verification (session check-in), an
 * evaluation, and a certificate. Certificates are issued only after the
 * session check-in and, when the template asks for it, the evaluation.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "../../_core/db";
import { notify } from "../../_core/push";
import { shortCode } from "../../_core/crypto";
import { zonedToDate } from "@shared/time";
import { fullName } from "@shared/format";
import type { Event } from "../../../drizzle/schema";

type Session = typeof schema.sessions.$inferSelect;
type Attendee = typeof schema.attendees.$inferSelect;

export const badRequest = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

/** Session check-in by QR opens 30 minutes before the start and closes 15 minutes after the end. */
export const CHECKIN_OPENS_MIN = 30;
export const CHECKIN_CLOSES_MIN = 15;

export function sessionTimes(session: Pick<Session, "date" | "startTime" | "endTime">, timezone: string) {
  const start = zonedToDate(session.date, session.startTime, timezone).getTime();
  const end = zonedToDate(session.date, session.endTime, timezone).getTime();
  return { start, end, opens: start - CHECKIN_OPENS_MIN * 60_000, closes: end + CHECKIN_CLOSES_MIN * 60_000 };
}

export function getSession(sessionId: number, eventId?: number) {
  const s = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!s || (eventId !== undefined && s.eventId !== eventId)) throw new TRPCError({ code: "NOT_FOUND", message: "That session was not found." });
  return s;
}

export function getAttendee(attendeeId: number, eventId: number) {
  const a = getDb().select().from(schema.attendees).where(eq(schema.attendees.id, attendeeId)).get();
  if (!a || a.eventId !== eventId) throw new TRPCError({ code: "NOT_FOUND", message: "That attendee was not found." });
  return a;
}

/** The evaluation form a session uses: its own pick, else the event's default form. */
export function formForSession(session: Pick<Session, "evaluationId" | "eventId">) {
  const db = getDb();
  if (session.evaluationId) {
    const f = db.select().from(schema.evaluations).where(eq(schema.evaluations.id, session.evaluationId)).get();
    if (f && f.eventId === session.eventId) return f;
  }
  return db
    .select()
    .from(schema.evaluations)
    .where(and(eq(schema.evaluations.eventId, session.eventId), eq(schema.evaluations.isDefault, true)))
    .get();
}

/** Whether the evaluation can be taken now, and when it opens or closed. */
export function evaluationWindow(form: { opensAt: "session_end" | "checkin"; closesAfterHours: number }, session: Session, timezone: string, now = Date.now()) {
  const { end } = sessionTimes(session, timezone);
  const opensAt = form.opensAt === "checkin" ? 0 : end;
  const closesAt = form.closesAfterHours > 0 ? end + form.closesAfterHours * 3600_000 : null;
  const state: "upcoming" | "open" | "closed" = now < opensAt ? "upcoming" : closesAt !== null && now > closesAt ? "closed" : "open";
  return { state, opensAt, closesAt };
}

/** The certificate template certificates are issued with: the default one, else the first. */
export function defaultTemplate(eventId: number) {
  const rows = getDb().select().from(schema.certificateTemplates).where(eq(schema.certificateTemplates.eventId, eventId)).all();
  return rows.find((r) => r.isDefault) ?? rows[0];
}

/** Minutes the person was in the room: from check-in (or the start) to the end (or check-out). Staff check-ins count the full session. */
export function minutesAttended(checkin: typeof schema.sessionCheckins.$inferSelect, session: Session, timezone: string) {
  const { start, end } = sessionTimes(session, timezone);
  if (checkin.method !== "qr") return Math.round((end - start) / 60_000);
  const from = Math.max(start, checkin.createdAt.getTime());
  const to = checkin.checkedOutAt ? Math.min(end, checkin.checkedOutAt.getTime()) : end;
  return Math.max(0, Math.round((to - from) / 60_000));
}

/** Why a checked-in session has not earned a certificate yet (null when it qualifies). */
export function sessionBlocker(attendee: Attendee, session: Session, checkin: typeof schema.sessionCheckins.$inferSelect, template: typeof schema.certificateTemplates.$inferSelect, timezone: string): null | "no_ce" | "minutes" | "evaluation" {
  if (!(session.ceHours > 0)) return "no_ce";
  if (template.minMinutes > 0 && minutesAttended(checkin, session, timezone) < template.minMinutes) return "minutes";
  if (template.requireEvaluation) {
    const form = formForSession(session);
    if (form && form.neededForCertificate) {
      const done = getDb()
        .select({ id: schema.evaluationResponses.id })
        .from(schema.evaluationResponses)
        .where(and(eq(schema.evaluationResponses.sessionId, session.id), eq(schema.evaluationResponses.attendeeId, attendee.id)))
        .get();
      if (!done) return "evaluation";
    }
  }
  return null;
}

function eventUrl(ev: Pick<Event, "slug">, path: string) {
  return `/e/${ev.slug}${path}`;
}

/**
 * Issues every certificate the attendee has earned and does not have yet.
 * Safe to call any number of times (after a check-in, after an evaluation).
 * Revoked certificates are never issued again automatically.
 */
export async function issueEligible(attendeeId: number) {
  const db = getDb();
  const attendee = db.select().from(schema.attendees).where(eq(schema.attendees.id, attendeeId)).get();
  if (!attendee || attendee.status === "cancelled") return [];
  const ev = db.select().from(schema.events).where(eq(schema.events.id, attendee.eventId)).get();
  if (!ev) return [];
  const template = defaultTemplate(ev.id);
  if (!template) return [];
  const checkins = db.select().from(schema.sessionCheckins).where(eq(schema.sessionCheckins.attendeeId, attendee.id)).all();
  if (!checkins.length) return [];
  const sessions = db
    .select()
    .from(schema.sessions)
    .where(inArray(schema.sessions.id, checkins.map((c) => c.sessionId)))
    .all()
    .filter((s) => s.eventId === ev.id);
  const existing = db.select().from(schema.certificates).where(eq(schema.certificates.attendeeId, attendee.id)).all();
  const issued: (typeof schema.certificates.$inferSelect)[] = [];

  const qualifying = sessions.filter((s) => {
    const c = checkins.find((x) => x.sessionId === s.id)!;
    return sessionBlocker(attendee, s, c, template, ev.timezone) === null;
  });

  if (template.scope === "session") {
    for (const s of qualifying) {
      if (existing.some((c) => c.sessionId === s.id)) continue;
      const row = db
        .insert(schema.certificates)
        .values({ eventId: ev.id, attendeeId: attendee.id, sessionId: s.id, templateId: template.id, title: s.title, hours: s.ceHours, code: shortCode(10) })
        .onConflictDoNothing()
        .returning()
        .get();
      if (row) issued.push(row);
    }
  } else if (qualifying.length) {
    const hours = Math.round(qualifying.reduce((n, s) => n + s.ceHours, 0) * 100) / 100;
    const current = existing.find((c) => c.sessionId === null);
    if (!current) {
      const row = db
        .insert(schema.certificates)
        .values({ eventId: ev.id, attendeeId: attendee.id, sessionId: null, templateId: template.id, title: ev.name, hours, code: shortCode(10) })
        .returning()
        .get();
      issued.push(row);
    } else if (!current.revokedAt && current.hours !== hours) {
      db.update(schema.certificates).set({ hours }).where(eq(schema.certificates.id, current.id)).run();
    }
  }

  if (issued.length && attendee.userId) {
    await notify([attendee.userId], ev.id, {
      kind: "certificate",
      title: issued.length === 1 ? "Your CE certificate is ready" : `${issued.length} CE certificates are ready`,
      body: issued.map((c) => c.title).join(", "),
      url: eventUrl(ev, "/credits"),
    });
  }
  return issued;
}

/** Display name for a certificate or badge. */
export const attendeeName = (a: Pick<Attendee, "firstName" | "lastName" | "credentials">, withCredentials = true) =>
  withCredentials ? fullName(a) : `${a.firstName} ${a.lastName}`.trim();

/** Real names of users (for "checked in by"). */
export function userNames(ids: (number | null | undefined)[]) {
  const list = Array.from(new Set(ids.filter((x): x is number => !!x)));
  if (!list.length) return new Map<number, string>();
  const rows = getDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, list)).all();
  return new Map(rows.map((r) => [r.id, r.name || r.email]));
}

/** Active (not revoked) certificates for a set of attendees. */
export function activeCertificates(attendeeIds: number[]) {
  if (!attendeeIds.length) return [];
  return getDb()
    .select()
    .from(schema.certificates)
    .where(and(inArray(schema.certificates.attendeeId, attendeeIds), isNull(schema.certificates.revokedAt)))
    .all();
}

// ---------- CSV ----------

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

/** Rows to CSV text. Cells that start with a formula character are quoted and prefixed so spreadsheets do not run them. */
export function toCsv(header: string[], rows: unknown[][]) {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Parses CSV text (quoted cells, commas and new lines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
