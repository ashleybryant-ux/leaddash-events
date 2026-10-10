/**
 * Session evaluations (area "evaluations"): forms, the attendee's evaluation
 * for a session they checked in to, and results.
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, getEventBySlug, requireArea, requireAttendee } from "../../_core/access";
import { randomToken } from "../../_core/crypto";
import { fmtDate } from "@shared/format";
import type { EvalQuestion } from "../../../drizzle/schema";
import { badRequest, evaluationWindow, formForSession, getSession, issueEligible, toCsv } from "./shared";

const question = z.object({
  id: z.string().max(40).optional(),
  kind: z.enum(["rating", "choice", "text", "yesno"]),
  label: z.string().trim().min(1).max(300),
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  scale: z.number().int().min(2).max(10).optional(),
});

const formInput = z.object({
  name: z.string().trim().min(1).max(160),
  questions: z.array(question).max(40),
  isDefault: z.boolean(),
  closesAfterHours: z.number().int().min(0).max(24 * 365),
  opensAt: z.enum(["session_end", "checkin"]),
  neededForCertificate: z.boolean(),
  /** Sessions that use this form instead of the default. */
  sessionIds: z.array(z.number().int()).max(1000).optional(),
});

export const DEFAULT_QUESTIONS: EvalQuestion[] = [
  { id: "q1", kind: "rating", label: "The learning objectives were met", required: true, scale: 5 },
  { id: "q2", kind: "rating", label: "The presenter knew the material", required: true, scale: 5 },
  { id: "q3", kind: "rating", label: "I can use this in my practice", required: true, scale: 5 },
  { id: "q4", kind: "text", label: "Comments for the presenter", required: false },
];

function getForm(evaluationId: number, eventId: number) {
  const f = getDb().select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)).get();
  if (!f || f.eventId !== eventId) throw badRequest("That form was not found.");
  return f;
}

function cleanQuestions(qs: z.infer<typeof question>[]): EvalQuestion[] {
  const used = new Set<string>();
  return qs.map((q) => {
    let id = q.id && !used.has(q.id) ? q.id : `q${randomToken(4)}`;
    while (used.has(id)) id = `q${randomToken(4)}`;
    used.add(id);
    if (q.kind === "choice" && !(q.options && q.options.length >= 2)) throw badRequest(`Add at least two choices for "${q.label}".`);
    return { id, kind: q.kind, label: q.label, required: q.required, ...(q.kind === "choice" ? { options: q.options } : {}), ...(q.kind === "rating" ? { scale: q.scale ?? 5 } : {}) };
  });
}

/** Sessions that use a form: those that picked it, plus (for the default form) CE sessions that picked none. */
function sessionsUsing(form: typeof schema.evaluations.$inferSelect, sessions: (typeof schema.sessions.$inferSelect)[]) {
  return sessions.filter((s) => s.evaluationId === form.id || (form.isDefault && !s.evaluationId && s.ceHours > 0));
}

/** Per-question summary: average for ratings, yes share for yes/no, counts for choices, comments for text. */
function summarize(questions: EvalQuestion[], responses: { answers: Record<string, string | number> }[]) {
  return questions.map((q) => {
    const vals = responses.map((r) => r.answers[q.id]).filter((v) => v !== undefined && v !== "");
    if (q.kind === "rating") {
      const nums = vals.map(Number).filter((n) => !Number.isNaN(n));
      return { id: q.id, count: nums.length, average: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null };
    }
    if (q.kind === "yesno") {
      const yes = vals.filter((v) => String(v) === "yes").length;
      return { id: q.id, count: vals.length, yesShare: vals.length ? Math.round((yes / vals.length) * 100) : null };
    }
    if (q.kind === "choice") {
      const counts: Record<string, number> = {};
      for (const v of vals) counts[String(v)] = (counts[String(v)] ?? 0) + 1;
      return { id: q.id, count: vals.length, choices: counts };
    }
    return { id: q.id, count: vals.length };
  });
}

/** Mean of every rating answer in a set of responses. */
export function ratingAverage(questions: EvalQuestion[], responses: { answers: Record<string, string | number> }[]) {
  const ids = questions.filter((q) => q.kind === "rating").map((q) => q.id);
  const nums = responses.flatMap((r) => ids.map((id) => Number(r.answers[id]))).filter((n) => !Number.isNaN(n) && n > 0);
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
}

export const evaluationsRouter = router({
  list: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "evaluations");
    const db = getDb();
    const forms = db.select().from(schema.evaluations).where(eq(schema.evaluations.eventId, input.eventId)).all();
    const sessions = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, input.eventId)).all();
    const responses = forms.length ? db.select().from(schema.evaluationResponses).where(inArray(schema.evaluationResponses.evaluationId, forms.map((f) => f.id))).all() : [];
    return forms.map((f) => {
      const mine = responses.filter((r) => r.evaluationId === f.id);
      return { ...f, sessionCount: sessionsUsing(f, sessions).length, responseCount: mine.length, summary: summarize(f.questions, mine) };
    });
  }),

  get: protectedProcedure.input(z.object({ eventId: z.number().int(), evaluationId: z.number().int() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "evaluations");
    const f = getForm(input.evaluationId, input.eventId);
    const db = getDb();
    const sessions = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, input.eventId)).all();
    const responseCount = db.select({ id: schema.evaluationResponses.id }).from(schema.evaluationResponses).where(eq(schema.evaluationResponses.evaluationId, f.id)).all().length;
    return {
      form: f,
      responseCount,
      sessionCount: sessionsUsing(f, sessions).length,
      sessions: sessions
        .filter((s) => s.kind !== "break" && s.kind !== "meal")
        .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))
        .map((s) => ({ id: s.id, title: s.title, date: s.date, startTime: s.startTime, ceHours: s.ceHours, evaluationId: s.evaluationId })),
    };
  }),

  create: protectedProcedure.input(z.object({ eventId: z.number().int(), name: z.string().trim().min(1).max(160).default("New evaluation") })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "evaluations", "edit");
    const hasDefault = getDb().select().from(schema.evaluations).where(and(eq(schema.evaluations.eventId, event.id), eq(schema.evaluations.isDefault, true))).get();
    const row = getDb()
      .insert(schema.evaluations)
      .values({ eventId: event.id, name: input.name, questions: DEFAULT_QUESTIONS, isDefault: !hasDefault })
      .returning()
      .get();
    return row;
  }),

  update: protectedProcedure.input(formInput.extend({ eventId: z.number().int(), evaluationId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "evaluations", "edit");
    const f = getForm(input.evaluationId, event.id);
    const db = getDb();
    const questions = cleanQuestions(input.questions);
    if (input.isDefault) db.update(schema.evaluations).set({ isDefault: false }).where(eq(schema.evaluations.eventId, event.id)).run();
    db.update(schema.evaluations)
      .set({ name: input.name, questions, isDefault: input.isDefault, closesAfterHours: input.closesAfterHours, opensAt: input.opensAt, neededForCertificate: input.neededForCertificate })
      .where(eq(schema.evaluations.id, f.id))
      .run();
    if (input.sessionIds) {
      const sessions = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, event.id)).all();
      const want = new Set(input.sessionIds);
      for (const s of sessions) {
        if (want.has(s.id) && s.evaluationId !== f.id) db.update(schema.sessions).set({ evaluationId: f.id }).where(eq(schema.sessions.id, s.id)).run();
        if (!want.has(s.id) && s.evaluationId === f.id) db.update(schema.sessions).set({ evaluationId: null }).where(eq(schema.sessions.id, s.id)).run();
      }
    }
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "evaluation.update", detail: input.name });
    return { ok: true };
  }),

  /** Pick the form one session uses (null goes back to the default form). */
  setForSession: protectedProcedure.input(z.object({ eventId: z.number().int(), sessionId: z.number().int(), evaluationId: z.number().int().nullable() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "evaluations", "edit");
    const s = getSession(input.sessionId, event.id);
    if (input.evaluationId) getForm(input.evaluationId, event.id);
    getDb().update(schema.sessions).set({ evaluationId: input.evaluationId }).where(eq(schema.sessions.id, s.id)).run();
    return { ok: true };
  }),

  remove: protectedProcedure.input(z.object({ eventId: z.number().int(), evaluationId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "evaluations", "edit");
    const f = getForm(input.evaluationId, event.id);
    const db = getDb();
    const has = db.select({ id: schema.evaluationResponses.id }).from(schema.evaluationResponses).where(eq(schema.evaluationResponses.evaluationId, f.id)).get();
    if (has) throw badRequest("This form has responses. They are kept for CE records, so the form cannot be deleted.");
    db.update(schema.sessions).set({ evaluationId: null }).where(and(eq(schema.sessions.eventId, event.id), eq(schema.sessions.evaluationId, f.id))).run();
    db.delete(schema.evaluations).where(eq(schema.evaluations.id, f.id)).run();
    return { ok: true };
  }),

  /** Results for one form: per session averages and the comments. */
  results: protectedProcedure.input(z.object({ eventId: z.number().int(), evaluationId: z.number().int() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "evaluations");
    const f = getForm(input.evaluationId, input.eventId);
    const db = getDb();
    const responses = db.select().from(schema.evaluationResponses).where(eq(schema.evaluationResponses.evaluationId, f.id)).all();
    const sessionIds = Array.from(new Set(responses.map((r) => r.sessionId)));
    const sessions = sessionIds.length ? db.select().from(schema.sessions).where(inArray(schema.sessions.id, sessionIds)).all() : [];
    const textIds = f.questions.filter((q) => q.kind === "text").map((q) => q.id);
    return {
      perSession: sessions
        .map((s) => {
          const mine = responses.filter((r) => r.sessionId === s.id);
          return { sessionId: s.id, title: s.title, date: s.date, responses: mine.length, average: ratingAverage(f.questions, mine) };
        })
        .sort((a, b) => b.responses - a.responses),
      comments: responses
        .flatMap((r) => textIds.map((id) => ({ sessionId: r.sessionId, text: String(r.answers[id] ?? "").trim(), at: r.createdAt })))
        .filter((c) => c.text)
        .map((c) => ({ ...c, session: sessions.find((s) => s.id === c.sessionId)?.title ?? "" }))
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, 500),
    };
  }),

  /** CSV of every response (no attendee names: evaluations are reported without names). */
  exportCsv: protectedProcedure.input(z.object({ eventId: z.number().int(), evaluationId: z.number().int() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "evaluations");
    const f = getForm(input.evaluationId, input.eventId);
    const db = getDb();
    const responses = db.select().from(schema.evaluationResponses).where(eq(schema.evaluationResponses.evaluationId, f.id)).all();
    const sessionIds = Array.from(new Set(responses.map((r) => r.sessionId)));
    const sessions = sessionIds.length ? db.select().from(schema.sessions).where(inArray(schema.sessions.id, sessionIds)).all() : [];
    const csv = toCsv(
      ["Session", "Session date", "Submitted", ...f.questions.map((q) => q.label)],
      responses.map((r) => {
        const s = sessions.find((x) => x.id === r.sessionId);
        return [s?.title ?? "", fmtDate(s?.date), r.createdAt.toISOString(), ...f.questions.map((q) => r.answers[q.id] ?? "")];
      })
    );
    return { filename: `${f.name.replace(/[^\w-]+/g, "-").toLowerCase()}-responses.csv`, csv };
  }),

  /** Attendee: the evaluation for a session they checked in to. */
  forSession: protectedProcedure.input(z.object({ slug: z.string().max(120), sessionId: z.number().int() })).query(({ ctx, input }) => {
    const ev = getEventBySlug(input.slug);
    const a = requireAttendee(ctx.user, ev.id);
    const s = getSession(input.sessionId, ev.id);
    const db = getDb();
    const checkin = db.select().from(schema.sessionCheckins).where(and(eq(schema.sessionCheckins.sessionId, s.id), eq(schema.sessionCheckins.attendeeId, a.id))).get();
    const session = { id: s.id, title: s.title, ceHours: s.ceHours, date: s.date, endTime: s.endTime };
    if (!checkin) return { status: "not_checked_in" as const, session, form: null };
    const form = formForSession(s);
    if (!form) return { status: "none" as const, session, form: null };
    const done = db.select().from(schema.evaluationResponses).where(and(eq(schema.evaluationResponses.sessionId, s.id), eq(schema.evaluationResponses.attendeeId, a.id))).get();
    if (done) return { status: "submitted" as const, session, form: null };
    const win = evaluationWindow(form, s, ev.timezone);
    if (win.state !== "open") return { status: win.state, session, form: null, opensAt: win.opensAt };
    return { status: "open" as const, session, form: { id: form.id, name: form.name, questions: form.questions } };
  }),

  /** Attendee: submit once. Issues any certificate this completes. */
  submit: protectedProcedure
    .input(z.object({ slug: z.string().max(120), sessionId: z.number().int(), answers: z.record(z.string().max(40), z.union([z.string().max(4000), z.number()])) }))
    .mutation(async ({ ctx, input }) => {
      const ev = getEventBySlug(input.slug);
      const a = requireAttendee(ctx.user, ev.id);
      const s = getSession(input.sessionId, ev.id);
      const db = getDb();
      const checkin = db.select().from(schema.sessionCheckins).where(and(eq(schema.sessionCheckins.sessionId, s.id), eq(schema.sessionCheckins.attendeeId, a.id))).get();
      if (!checkin) throw badRequest("Check in to this session first. The evaluation opens for people who attended.");
      const form = formForSession(s);
      if (!form) throw badRequest("This session has no evaluation.");
      const win = evaluationWindow(form, s, ev.timezone);
      if (win.state === "upcoming") throw badRequest("The evaluation opens when the session ends.");
      if (win.state === "closed") throw badRequest("This evaluation has closed.");
      const answers: Record<string, string | number> = {};
      for (const q of form.questions) {
        const raw = input.answers[q.id];
        const v = typeof raw === "string" ? raw.trim() : raw;
        if (v === undefined || v === "") {
          if (q.required) throw badRequest(`Please answer "${q.label}".`);
          continue;
        }
        if (q.kind === "rating") {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > (q.scale ?? 5)) throw badRequest(`Pick a rating for "${q.label}".`);
          answers[q.id] = n;
        } else if (q.kind === "yesno") {
          if (v !== "yes" && v !== "no") throw badRequest(`Answer yes or no for "${q.label}".`);
          answers[q.id] = v;
        } else if (q.kind === "choice") {
          if (!q.options?.includes(String(v))) throw badRequest(`Pick one of the choices for "${q.label}".`);
          answers[q.id] = String(v);
        } else answers[q.id] = String(v).slice(0, 4000);
      }
      const row = db.insert(schema.evaluationResponses).values({ evaluationId: form.id, sessionId: s.id, attendeeId: a.id, answers }).onConflictDoNothing().returning().get();
      if (!row) throw badRequest("You already submitted this evaluation.");
      const issued = await issueEligible(a.id);
      return { ok: true, certificates: issued.map((c) => c.code) };
    }),
});
