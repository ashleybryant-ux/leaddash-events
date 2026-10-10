/**
 * Reports across programs: membership, events, CE, groups and other programs
 * (webinar series, mentoring) in one place.
 *
 * Renewal rate is an approximation from the status field, because the
 * LeadDash platform holds the dues records: among members whose expires-on
 * date passed during the period, active members count as renewed and lapsed
 * or cancelled members count as not renewed. Members in their grace period
 * are left out until they renew or lapse.
 */
import { z } from "zod";
import { and, eq, inArray, lte } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, notFound, requireOrgAdmin } from "../../_core/access";
import { queueContact } from "../../_core/platform";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { ENV } from "../../_core/env";
import { fmtDate, fullName } from "@shared/format";
import type { Member } from "../../../drizzle/schema";
import type { Job } from "../types";
import { daysFromNow, getOrg, isActive, normalizeDate, parseCsv, toCsv, today } from "./shared";

const RANGE = z.enum(["12m", "year", "3y"]);
type Range = z.infer<typeof RANGE>;
const DAY = 86400_000;

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function rangeDates(range: Range) {
  const end = today();
  const now = Date.now();
  const start = range === "year" ? `${end.slice(0, 4)}-01-01` : iso(now - (range === "3y" ? 3 * 365 : 365) * DAY);
  const len = new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime();
  const prevStart = iso(new Date(`${start}T00:00:00Z`).getTime() - len - DAY);
  const prevEnd = iso(new Date(`${start}T00:00:00Z`).getTime() - DAY);
  return { start, end, prevStart, prevEnd };
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);

/** Who used which program in a window: events attended, groups, other programs. */
function usage(orgId: number, start: string, end: string) {
  const db = getDb();
  const events = db.select().from(schema.events).where(eq(schema.events.orgId, orgId)).all().filter((e) => e.status !== "draft" && e.startDate >= start && e.startDate <= end);
  const regs = events.length
    ? db
        .select({ eventId: schema.attendees.eventId, email: schema.attendees.email, status: schema.attendees.status })
        .from(schema.attendees)
        .where(inArray(schema.attendees.eventId, events.map((e) => e.id)))
        .all()
        .filter((a) => a.status !== "cancelled")
    : [];
  const programs = db.select().from(schema.programs).where(eq(schema.programs.orgId, orgId)).all();
  const parts = programs.length
    ? db
        .select()
        .from(schema.programParticipants)
        .where(inArray(schema.programParticipants.programId, programs.map((p) => p.id)))
        .all()
        .filter((p) => p.date >= start && p.date <= end)
    : [];
  const grouped = new Set(
    db
      .select({ memberId: schema.groupMembers.memberId })
      .from(schema.groupMembers)
      .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
      .where(eq(schema.groups.orgId, orgId))
      .all()
      .map((r) => r.memberId)
  );
  const eventsByEmail = new Map<string, Set<number>>();
  for (const r of regs) eventsByEmail.set(r.email, (eventsByEmail.get(r.email) ?? new Set()).add(r.eventId));
  const programsByEmail = new Map<string, Set<number>>();
  for (const p of parts) programsByEmail.set(p.email.toLowerCase(), (programsByEmail.get(p.email.toLowerCase()) ?? new Set()).add(p.programId));
  const of = (m: Member) => {
    const ev = eventsByEmail.get(m.email)?.size ?? 0;
    const pr = programsByEmail.get(m.email)?.size ?? 0;
    const gr = grouped.has(m.id) ? 1 : 0;
    return { events: ev, programs: pr, group: gr, total: ev + pr + gr };
  };
  return { events, regs, programs, parts, grouped, of };
}

function eventRating(eventId: number) {
  const db = getDb();
  const evals = db.select().from(schema.evaluations).where(eq(schema.evaluations.eventId, eventId)).all();
  if (!evals.length) return null;
  const responses = db.select().from(schema.evaluationResponses).where(inArray(schema.evaluationResponses.evaluationId, evals.map((e) => e.id))).all();
  const values: number[] = [];
  for (const r of responses) {
    const form = evals.find((e) => e.id === r.evaluationId)!;
    for (const q of form.questions) {
      if (q.kind !== "rating") continue;
      const v = Number(r.answers[q.id]);
      if (Number.isFinite(v) && v > 0) values.push((v / (q.scale || 5)) * 5);
    }
  }
  return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;
}

function ceIssued(orgId: number, start: string, end: string, emails: Set<string> | null) {
  const db = getDb();
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T23:59:59Z`).getTime();
  const certs = db
    .select({ hours: schema.certificates.hours, createdAt: schema.certificates.createdAt, revokedAt: schema.certificates.revokedAt, email: schema.attendees.email })
    .from(schema.certificates)
    .innerJoin(schema.events, eq(schema.events.id, schema.certificates.eventId))
    .innerJoin(schema.attendees, eq(schema.attendees.id, schema.certificates.attendeeId))
    .where(eq(schema.events.orgId, orgId))
    .all()
    .filter((c) => !c.revokedAt && c.createdAt.getTime() >= s && c.createdAt.getTime() <= e && (!emails || emails.has(c.email)));
  const entries = db
    .select()
    .from(schema.ceEntries)
    .where(eq(schema.ceEntries.orgId, orgId))
    .all()
    .filter((c) => c.date >= start && c.date <= end && (!emails || emails.has(c.email.toLowerCase())));
  return Math.round((certs.reduce((a, c) => a + c.hours, 0) + entries.reduce((a, c) => a + c.hours, 0)) * 10) / 10;
}

/** The whole report. Exported for tests and the scheduled email. */
export function buildReport(orgId: number, range: Range, level: string) {
  const db = getDb();
  const { start, end, prevStart, prevEnd } = rangeDates(range);
  const allMembers = db.select().from(schema.members).where(eq(schema.members.orgId, orgId)).all();
  const levels = Array.from(new Set(allMembers.map((m) => m.level))).sort();
  const members = level ? allMembers.filter((m) => m.level.toLowerCase() === level.toLowerCase()) : allMembers;
  const memberByEmail = new Map(members.map((m) => [m.email, m]));
  const startMs = new Date(`${start}T00:00:00Z`).getTime();

  const active = members.filter(isActive);
  const joinedInRange = members.filter((m) => m.createdAt.getTime() >= startMs).length;

  // Renewal cohort (see the note at the top of this file).
  const due = members.filter((m) => !!m.expiresOn && m.expiresOn >= start && m.expiresOn <= end && m.expiresOn < today());
  const renewed = due.filter((m) => m.status === "active");
  const notRenewed = due.filter((m) => m.status === "lapsed" || m.status === "cancelled");
  const cohort = [...renewed.map((m) => ({ m, renewed: true })), ...notRenewed.map((m) => ({ m, renewed: false }))];

  const inRange = usage(orgId, start, end);
  const last12 = range === "12m" ? inRange : usage(orgId, iso(Date.now() - 365 * DAY), end);

  const buckets = [
    { label: "None", test: (n: number) => n === 0 },
    { label: "1 program", test: (n: number) => n === 1 },
    { label: "2 programs", test: (n: number) => n === 2 },
    { label: "3 or more", test: (n: number) => n >= 3 },
  ].map((b) => {
    const rows = cohort.filter((c) => b.test(inRange.of(c.m).total));
    return { label: b.label, members: rows.length, rate: pct(rows.filter((r) => r.renewed).length, rows.length) };
  });

  const noActivity = active.filter((m) => last12.of(m).total === 0);

  const soon = daysFromNow(90);
  const atRisk = active
    .filter((m) => !!m.expiresOn && m.expiresOn >= today() && m.expiresOn <= soon)
    .map((m) => ({ m, u: last12.of(m) }))
    .filter(({ u }) => u.total <= 1)
    .sort((a, b) => (a.m.expiresOn! < b.m.expiresOn! ? -1 : 1))
    .map(({ m, u }) => ({
      memberId: m.id,
      name: fullName(m),
      email: m.email,
      level: m.level,
      expiresOn: m.expiresOn!,
      autoRenew: m.autoRenew,
      reason: u.total === 0 ? "No events, groups or programs in 12 months" : u.events === 0 ? "No events in 12 months" : "Only 1 program in 12 months",
    }));

  const renewedPct = (emails: Iterable<string>) => {
    const ms = Array.from(new Set(emails)).map((e) => memberByEmail.get(e)).filter((m): m is Member => !!m);
    return { members: ms.length, renewed: pct(ms.filter(isActive).length, ms.length) };
  };

  const engagement = [
    ...inRange.events.map((e) => {
      const emails = inRange.regs.filter((r) => r.eventId === e.id).map((r) => r.email);
      const r = renewedPct(emails);
      return { key: `event-${e.id}`, name: e.name, kind: "Event", people: new Set(emails).size, members: r.members, renewed: r.renewed, rating: eventRating(e.id) };
    }),
    (() => {
      const ms = members.filter((m) => inRange.grouped.has(m.id));
      return { key: "groups", name: "Divisions and committees", kind: "Groups", people: ms.length, members: ms.length, renewed: pct(ms.filter(isActive).length, ms.length), rating: null as number | null };
    })(),
    ...inRange.programs.map((p) => {
      const rows = inRange.parts.filter((x) => x.programId === p.id);
      const emails = rows.map((x) => x.email.toLowerCase());
      const r = renewedPct(emails);
      const ratings = rows.map((x) => x.rating).filter((v): v is number => typeof v === "number" && v > 0);
      return { key: `program-${p.id}`, name: p.name, kind: "Program", people: new Set(emails).size, members: r.members, renewed: r.renewed, rating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null };
    }),
  ];

  const emails = level ? new Set(members.map((m) => m.email)) : null;
  const ce = ceIssued(orgId, start, end, emails);
  const cePrev = ceIssued(orgId, prevStart, prevEnd, emails);

  return {
    range: { start, end },
    levels,
    kpis: {
      activeMembers: active.length,
      joinedInRange,
      renewalRate: pct(renewed.length, cohort.length),
      renewedCount: renewed.length,
      cohortCount: cohort.length,
      ceHours: ce,
      ceChange: cePrev ? Math.round(((ce - cePrev) / cePrev) * 100) : null,
      noActivity: noActivity.length,
    },
    byPrograms: buckets,
    atRisk,
    engagement,
  };
}

export function reportCsv(r: ReturnType<typeof buildReport>) {
  const rows: unknown[][] = [
    ["Summary", "Period", `${r.range.start} to ${r.range.end}`, "", "", ""],
    ["Summary", "Active members", r.kpis.activeMembers, "", "", ""],
    ["Summary", "Renewal rate", r.kpis.renewalRate === null ? "" : `${r.kpis.renewalRate}%`, "", "", ""],
    ["Summary", "CE hours issued", r.kpis.ceHours, "", "", ""],
    ["Summary", "Members with no activity", r.kpis.noActivity, "", "", ""],
    ...r.byPrograms.map((b) => ["Renewal by programs used", b.label, b.rate === null ? "" : `${b.rate}%`, b.members, "", ""]),
    ...r.engagement.map((e) => ["Program engagement", e.name, e.people, e.members, e.renewed === null ? "" : `${e.renewed}%`, e.rating === null ? "" : `${e.rating} of 5`]),
    ...r.atRisk.map((a) => ["Renewals at risk", a.name, a.email, a.expiresOn, a.reason, ""]),
  ];
  return toCsv(["section", "item", "value", "members", "renewed", "rating"], rows);
}

const filters = z.object({ orgId: z.number(), range: RANGE.default("12m"), level: z.string().max(60).default("") });

function getProgram(orgId: number, programId: number) {
  const p = getDb().select().from(schema.programs).where(eq(schema.programs.id, programId)).get();
  if (!p || p.orgId !== orgId) throw notFound("That program");
  return p;
}

const nextSend = (frequency: "weekly" | "monthly", from = Date.now()) => {
  const d = new Date(from);
  if (frequency === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d;
};

export const insightsRouter = router({
  report: protectedProcedure.input(filters).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    return buildReport(input.orgId, input.range, input.level);
  }),

  exportCsv: protectedProcedure.input(filters).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    return { filename: `reports-across-programs-${today()}.csv`, csv: reportCsv(buildReport(input.orgId, input.range, input.level)) };
  }),

  /** Queues the member on the LeadDash platform with the "renewal at risk" tag. */
  followUp: protectedProcedure.input(z.object({ orgId: z.number(), memberId: z.number() })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const m = getDb().select().from(schema.members).where(eq(schema.members.id, input.memberId)).get();
    if (!m || m.orgId !== input.orgId) throw notFound("That member");
    const queued = queueContact(input.orgId, { email: m.email, firstName: m.firstName, lastName: m.lastName, tags: ["renewal at risk"], source: "LeadDash Events member hub" });
    audit(ctx.user, { orgId: input.orgId, action: "member.follow_up", detail: m.email });
    return { queued };
  }),

  programs: router({
    list: protectedProcedure.input(z.object({ orgId: z.number() })).query(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      const db = getDb();
      const programs = db.select().from(schema.programs).where(eq(schema.programs.orgId, input.orgId)).orderBy(schema.programs.name).all();
      const parts = programs.length ? db.select().from(schema.programParticipants).where(inArray(schema.programParticipants.programId, programs.map((p) => p.id))).all() : [];
      return programs.map((p) => {
        const rows = parts.filter((x) => x.programId === p.id);
        const dates = rows.map((x) => x.date).sort();
        return { ...p, participants: rows.length, people: new Set(rows.map((x) => x.email)).size, firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null };
      });
    }),
    save: protectedProcedure.input(z.object({ orgId: z.number(), programId: z.number().optional(), name: z.string().min(2).max(120) })).mutation(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      if (input.programId) {
        getProgram(input.orgId, input.programId);
        return getDb().update(schema.programs).set({ name: input.name }).where(eq(schema.programs.id, input.programId)).returning().get();
      }
      return getDb().insert(schema.programs).values({ orgId: input.orgId, name: input.name }).returning().get();
    }),
    remove: protectedProcedure.input(z.object({ orgId: z.number(), programId: z.number() })).mutation(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      const p = getProgram(input.orgId, input.programId);
      getDb().delete(schema.programs).where(eq(schema.programs.id, p.id)).run();
      audit(ctx.user, { orgId: input.orgId, action: "program.remove", detail: p.name });
      return { ok: true };
    }),
    /** CSV columns: email, date, rating (1 to 5, optional). The same email and date are added once. */
    importParticipants: protectedProcedure.input(z.object({ orgId: z.number(), programId: z.number(), csv: z.string().max(5_000_000) })).mutation(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      const p = getProgram(input.orgId, input.programId);
      const db = getDb();
      const existing = new Set(db.select().from(schema.programParticipants).where(eq(schema.programParticipants.programId, p.id)).all().map((x) => `${x.email}|${x.date}`));
      let added = 0;
      let skipped = 0;
      const errors: string[] = [];
      parseCsv(input.csv).forEach((r, i) => {
        const line = i + 2;
        const email = (r.email || "").toLowerCase();
        if (!z.string().email().safeParse(email).success) return void errors.push(`Row ${line}: the email is missing or not valid.`);
        const date = normalizeDate(r.date);
        if (!date) return void errors.push(`Row ${line}: the date must look like 10/9/2026.`);
        const rating = r.rating ? Number(r.rating) : null;
        if (rating !== null && (!Number.isFinite(rating) || rating < 1 || rating > 5)) return void errors.push(`Row ${line}: the rating must be 1 to 5.`);
        if (existing.has(`${email}|${date}`)) return void skipped++;
        existing.add(`${email}|${date}`);
        db.insert(schema.programParticipants).values({ programId: p.id, email, date, rating: rating === null ? null : Math.round(rating) }).run();
        added++;
      });
      audit(ctx.user, { orgId: input.orgId, action: "program.import", detail: `${p.name}: ${added} added` });
      return { added, skipped, errors: errors.slice(0, 50) };
    }),
  }),

  schedules: router({
    list: protectedProcedure.input(z.object({ orgId: z.number() })).query(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      return getDb().select().from(schema.reportSchedules).where(eq(schema.reportSchedules.orgId, input.orgId)).all();
    }),
    create: protectedProcedure
      .input(z.object({ orgId: z.number(), email: z.string().email().max(200), frequency: z.enum(["weekly", "monthly"]), range: RANGE, level: z.string().max(60).default("") }))
      .mutation(({ ctx, input }) => {
        requireOrgAdmin(ctx.user, input.orgId);
        return getDb()
          .insert(schema.reportSchedules)
          .values({ orgId: input.orgId, email: input.email.toLowerCase(), frequency: input.frequency, range: input.range, level: input.level, nextSendAt: nextSend(input.frequency), createdBy: ctx.user.id })
          .returning()
          .get();
      }),
    remove: protectedProcedure.input(z.object({ orgId: z.number(), scheduleId: z.number() })).mutation(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      const s = getDb().select().from(schema.reportSchedules).where(eq(schema.reportSchedules.id, input.scheduleId)).get();
      if (!s || s.orgId !== input.orgId) throw notFound("That schedule");
      getDb().delete(schema.reportSchedules).where(eq(schema.reportSchedules.id, s.id)).run();
      return { ok: true };
    }),
  }),
});

/** Sends scheduled reports that are due. */
export async function sendDueReports() {
  const db = getDb();
  const due = db.select().from(schema.reportSchedules).where(lte(schema.reportSchedules.nextSendAt, new Date())).limit(10).all();
  for (const s of due) {
    try {
      const org = getOrg(s.orgId);
      const r = buildReport(s.orgId, s.range, s.level);
      const lines = [
        `Active members: ${r.kpis.activeMembers}`,
        `Renewal rate: ${r.kpis.renewalRate === null ? "Not enough data" : `${r.kpis.renewalRate}%`}`,
        `CE hours issued: ${r.kpis.ceHours}`,
        `Members with no activity: ${r.kpis.noActivity}`,
        `Renewals at risk: ${r.atRisk.length}`,
      ];
      await sendEmail({
        to: s.email,
        subject: `${org.name} reports across programs`,
        text: `${fmtDate(r.range.start)} to ${fmtDate(r.range.end)}${s.level ? ` (${s.level})` : ""}\n\n${lines.join("\n")}\n\n${ENV.appUrl}/admin/insights`,
        html: emailLayout({
          brand: "#1F5F4A",
          accent: "#e88a3a",
          title: "Reports across programs",
          blocks: [`<p>${escapeHtml(org.name)} · ${fmtDate(r.range.start)} to ${fmtDate(r.range.end)}${s.level ? ` · ${escapeHtml(s.level)}` : ""}</p>`, `<p>${lines.map(escapeHtml).join("<br>")}</p>`, emailButton("Open the reports", `${ENV.appUrl}/admin/insights`, "#e88a3a")],
        }),
      });
      db.update(schema.reportSchedules).set({ lastSentAt: new Date(), nextSendAt: nextSend(s.frequency) }).where(eq(schema.reportSchedules.id, s.id)).run();
    } catch (err) {
      console.error("[member] scheduled report failed:", (err as Error).message);
      db.update(schema.reportSchedules).set({ nextSendAt: new Date(Date.now() + 3600_000) }).where(and(eq(schema.reportSchedules.id, s.id))).run();
    }
  }
}

export const insightsJobs: Job[] = [{ name: "member.scheduled-reports", run: sendDueReports }];
