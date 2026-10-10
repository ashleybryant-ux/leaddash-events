/**
 * CE area: check-in desk, badges, session check-in, evaluations,
 * certificates, attendees admin, staff roles and event reports.
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { notify } from "../../_core/push";
import type { AreaModule, Job } from "../types";
import { checkinRouter } from "./checkin";
import { evaluationsRouter, DEFAULT_QUESTIONS } from "./evaluations";
import { certificatesRouter } from "./certificates";
import { attendeesRouter } from "./attendees";
import { staffRouter, seedStaffRoles } from "./staff";
import { reportsRouter } from "./reports";
import { evaluationWindow, formForSession, sessionTimes } from "./shared";

export const ceRouter = router({
  checkin: checkinRouter,
  evaluations: evaluationsRouter,
  certificates: certificatesRouter,
  attendees: attendeesRouter,
  staff: staffRouter,
  reports: reportsRouter,
});

/** Defaults for a new event: built-in staff roles, the standard evaluation form and a CE certificate template. */
function seedEvent(eventId: number) {
  const db = getDb();
  const ev = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get();
  if (!ev) return;
  seedStaffRoles(eventId);
  if (!db.select().from(schema.evaluations).where(eq(schema.evaluations.eventId, eventId)).get()) {
    db.insert(schema.evaluations).values({ eventId, name: "Standard session evaluation", questions: DEFAULT_QUESTIONS, isDefault: true, closesAfterHours: 14 * 24 }).run();
  }
  if (!db.select().from(schema.certificateTemplates).where(eq(schema.certificateTemplates.eventId, eventId)).get()) {
    const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get();
    db.insert(schema.certificateTemplates)
      .values({ eventId, name: "CE certificate", title: "Certificate of Completion", providerName: org?.name ?? "", isDefault: true, requireEvaluation: true })
      .run();
  }
}

const REMINDER_DELAY_MS = 5 * 60_000;
/** Sessions that ended more than a day ago are skipped (no late notices after a restart). */
const REMINDER_WINDOW_MS = 24 * 3600_000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Five minutes after a session ends, tells each person who checked in and has
 * not submitted the evaluation that it is ready. Each person and session is
 * told once (evaluation_reminders).
 */
export async function sendEvaluationReminders(now = Date.now()) {
  const db = getDb();
  const events = db
    .select()
    .from(schema.events)
    .where(and(lte(schema.events.startDate, isoDay(now + 86400_000)), gte(schema.events.endDate, isoDay(now - 3 * 86400_000))))
    .all();
  let sent = 0;
  for (const ev of events) {
    const sessions = db
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.eventId, ev.id), gte(schema.sessions.date, isoDay(now - 2 * 86400_000)), lte(schema.sessions.date, isoDay(now + 86400_000))))
      .all();
    for (const s of sessions) {
      const { end } = sessionTimes(s, ev.timezone);
      if (now < end + REMINDER_DELAY_MS || now > end + REMINDER_WINDOW_MS) continue;
      const form = formForSession(s);
      if (!form || evaluationWindow(form, s, ev.timezone, now).state !== "open") continue;
      const checkins = db.select().from(schema.sessionCheckins).where(eq(schema.sessionCheckins.sessionId, s.id)).all();
      if (!checkins.length) continue;
      const ids = checkins.map((c) => c.attendeeId);
      const done = new Set(db.select({ a: schema.evaluationResponses.attendeeId }).from(schema.evaluationResponses).where(eq(schema.evaluationResponses.sessionId, s.id)).all().map((r) => r.a));
      const told = new Set(db.select({ a: schema.evaluationReminders.attendeeId }).from(schema.evaluationReminders).where(eq(schema.evaluationReminders.sessionId, s.id)).all().map((r) => r.a));
      const todo = ids.filter((id) => !done.has(id) && !told.has(id));
      if (!todo.length) continue;
      const people = db.select().from(schema.attendees).where(inArray(schema.attendees.id, todo)).all();
      for (const a of people) {
        const row = db.insert(schema.evaluationReminders).values({ sessionId: s.id, attendeeId: a.id }).onConflictDoNothing().returning().get();
        if (!row || !a.userId || a.status === "cancelled") continue;
        await notify([a.userId], ev.id, {
          kind: "evaluation",
          title: "Your evaluation is ready",
          body: s.ceHours > 0 ? `${s.title}. Submit it to get your CE certificate.` : s.title,
          url: `/e/${ev.slug}/eval/${s.id}`,
        });
        sent++;
      }
    }
  }
  return sent;
}

const jobs: Job[] = [{ name: "ce evaluation reminders", run: () => sendEvaluationReminders().then(() => undefined) }];

export const ceArea: AreaModule<typeof ceRouter> = { router: ceRouter, seedEvent, jobs };
