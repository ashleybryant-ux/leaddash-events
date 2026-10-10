/**
 * Event reports (area "reports"). Reads other areas' tables directly.
 */
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { requireArea } from "../../_core/access";
import { fmtDate } from "@shared/format";
import { dateToZoned } from "@shared/time";
import { formForSession, toCsv } from "./shared";
import { ratingAverage } from "./evaluations";

export function eventReport(eventId: number) {
  const db = getDb();
  const ev = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get()!;
  const people = db.select().from(schema.attendees).where(eq(schema.attendees.eventId, eventId)).all();
  const registered = people.filter((p) => p.status === "registered");
  const tickets = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, eventId)).all();
  const sessions = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, eventId)).all();
  const sessionIds = sessions.map((s) => s.id);
  const checkins = sessionIds.length ? db.select().from(schema.sessionCheckins).where(inArray(schema.sessionCheckins.sessionId, sessionIds)).all() : [];
  const scheduled = sessionIds.length ? db.select({ sessionId: schema.scheduleItems.sessionId }).from(schema.scheduleItems).where(inArray(schema.scheduleItems.sessionId, sessionIds)).all() : [];
  const responses = sessionIds.length ? db.select().from(schema.evaluationResponses).where(inArray(schema.evaluationResponses.sessionId, sessionIds)).all() : [];
  const certs = db.select().from(schema.certificates).where(eq(schema.certificates.eventId, eventId)).all().filter((c) => !c.revokedAt);

  // Returning: registered here and at an earlier event of the same association.
  const earlier = db
    .select()
    .from(schema.events)
    .where(eq(schema.events.orgId, ev.orgId))
    .all()
    .filter((e) => e.id !== ev.id && e.startDate < ev.startDate)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  let returning: { label: string; percent: number } | null = null;
  if (earlier.length) {
    const prev = db.select({ email: schema.attendees.email }).from(schema.attendees).where(inArray(schema.attendees.eventId, earlier.map((e) => e.id))).all();
    const emails = new Set(prev.map((p) => p.email));
    const n = registered.filter((p) => emails.has(p.email)).length;
    returning = { label: `Returning from ${earlier[0].startDate.slice(0, 4)}`, percent: registered.length ? Math.round((n / registered.length) * 100) : 0 };
  }

  const byTicket = [...tickets, { id: 0, name: "No ticket" } as (typeof tickets)[number]]
    .map((t) => ({ ticket: t.name, count: registered.filter((p) => (p.ticketTypeId ?? 0) === t.id).length }))
    .filter((t) => t.count > 0);

  const dayCounts = new Map<string, number>();
  for (const p of registered) {
    const d = dateToZoned(p.createdAt, ev.timezone).date;
    dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
  }
  const byDay = Array.from(dayCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));

  const sessionRows = sessions
    .filter((s) => s.kind !== "break" && s.kind !== "meal")
    .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))
    .map((s) => {
      const ci = checkins.filter((c) => c.sessionId === s.id).length;
      const sch = scheduled.filter((x) => x.sessionId === s.id).length;
      const form = formForSession(s);
      const mine = responses.filter((r) => r.sessionId === s.id);
      return {
        id: s.id,
        title: s.title,
        date: s.date,
        startTime: s.startTime,
        ceHours: s.ceHours,
        checkedIn: ci,
        scheduled: sch,
        capacity: s.capacity,
        ofScheduled: sch ? Math.min(100, Math.round((ci / sch) * 100)) : null,
        ofCapacity: s.capacity ? Math.min(100, Math.round((ci / s.capacity) * 100)) : null,
        evaluations: mine.length,
        evalScore: form ? ratingAverage(form.questions, mine) : null,
      };
    });

  const vendors = db.select().from(schema.vendors).where(eq(schema.vendors.eventId, eventId)).all();
  const leads = vendors.length ? db.select({ vendorId: schema.leads.vendorId }).from(schema.leads).where(inArray(schema.leads.vendorId, vendors.map((v) => v.id))).all() : [];
  const channels = db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.eventId, eventId)).all();
  const threads = db.select({ id: schema.threads.id }).from(schema.threads).where(eq(schema.threads.eventId, eventId)).all();
  const posts = channels.length ? db.select({ id: schema.posts.id }).from(schema.posts).where(inArray(schema.posts.channelId, channels.map((c) => c.id))).all().length : 0;
  const messages = threads.length ? db.select({ id: schema.messages.id }).from(schema.messages).where(inArray(schema.messages.threadId, threads.map((t) => t.id))).all().length : 0;
  const meetings = db.select({ status: schema.meetingRequests.status }).from(schema.meetingRequests).where(eq(schema.meetingRequests.eventId, eventId)).all().filter((m) => m.status === "accepted").length;

  const checkedIn = registered.filter((p) => p.checkedInAt).length;
  return {
    kpis: {
      registered: registered.length,
      checkedIn,
      checkInRate: registered.length ? Math.round((checkedIn / registered.length) * 100) : 0,
      openedApp: registered.filter((p) => p.appOpenedAt).length,
      ceHours: Math.round(certs.reduce((n, c) => n + c.hours, 0) * 10) / 10,
      certificates: certs.length,
      returning,
    },
    byTicket,
    byDay,
    sessions: sessionRows,
    vendors: vendors
      .map((v) => ({ id: v.id, company: v.company, leads: leads.filter((l) => l.vendorId === v.id).length }))
      .sort((a, b) => b.leads - a.leads),
    engagement: { posts, messages, meetings },
  };
}

export const reportsRouter = router({
  event: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "reports");
    return eventReport(input.eventId);
  }),

  /** One CSV per section, or all sections in one file. */
  exportCsv: protectedProcedure.input(z.object({ eventId: z.number().int(), section: z.enum(["sessions", "registrations", "all"]) })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "reports");
    const r = eventReport(event.id);
    const sessions = toCsv(
      ["Session", "Date", "Start", "CE hours", "Checked in", "Scheduled", "Of those scheduled (%)", "Capacity", "Of capacity (%)", "Evaluations", "Eval score"],
      r.sessions.map((s) => [s.title, fmtDate(s.date), s.startTime, s.ceHours, s.checkedIn, s.scheduled, s.ofScheduled ?? "", s.capacity ?? "", s.ofCapacity ?? "", s.evaluations, s.evalScore ?? ""])
    );
    const registrations = toCsv(["Ticket", "Registered"], r.byTicket.map((t) => [t.ticket, t.count])) + "\r\n" + toCsv(["Day", "Registered"], r.byDay.map((d) => [fmtDate(d.date), d.count]));
    const summary = toCsv(
      ["Measure", "Value"],
      [
        ["Registered", r.kpis.registered],
        ["Checked in", r.kpis.checkedIn],
        ["Check-in rate (%)", r.kpis.checkInRate],
        ["Opened the app", r.kpis.openedApp],
        ["CE hours issued", r.kpis.ceHours],
        ["Certificates issued", r.kpis.certificates],
        ...(r.kpis.returning ? [[`${r.kpis.returning.label} (%)`, r.kpis.returning.percent]] : []),
        ["Community posts", r.engagement.posts],
        ["Messages sent", r.engagement.messages],
        ["Meetings booked", r.engagement.meetings],
      ]
    );
    const vendors = toCsv(["Vendor", "Leads"], r.vendors.map((v) => [v.company, v.leads]));
    const csv = input.section === "sessions" ? sessions : input.section === "registrations" ? registrations : [summary, registrations, sessions, vendors].join("\r\n");
    return { filename: `${event.slug}-${input.section === "all" ? "report" : input.section}.csv`, csv };
  }),
});
