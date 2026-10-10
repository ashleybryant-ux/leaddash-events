/** Live polls and audience Q&A for a session. Presenters (speakers linked to the session) and admins run them. */
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { User } from "../../../drizzle/schema";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { attendeeFor, eventAccess, forbidden, getEventBySlug, notFound } from "../../_core/access";
import { zonedToDate } from "@shared/time";
import { id, personCard, requireFeature, slug } from "./common";

type Session = typeof schema.sessions.$inferSelect;

/** Speakers linked to the session by their sign-in, plus event admins and session editors. */
export function isPresenter(user: User, session: Session) {
  const access = eventAccess(user, session.eventId);
  if (access.admin || access.areas.sessions === "edit") return true;
  return !!getDb()
    .select({ id: schema.sessionSpeakers.id })
    .from(schema.sessionSpeakers)
    .innerJoin(schema.speakers, eq(schema.speakers.id, schema.sessionSpeakers.speakerId))
    .where(and(eq(schema.sessionSpeakers.sessionId, session.id), eq(schema.speakers.userId, user.id)))
    .get();
}

function sessionCtx(user: User, eventSlug: string, sessionId: number) {
  const event = getEventBySlug(eventSlug);
  requireFeature(event, "polls", "Polls and Q&A");
  const session = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!session || session.eventId !== event.id) throw notFound("That session");
  const presenter = isPresenter(user, session);
  const me = attendeeFor(user, event.id) ?? null;
  if (!presenter && !me) throw forbidden("You are not registered for this event.");
  return { event, session, presenter, me };
}

function pollCtx(user: User, eventSlug: string, pollId: number) {
  const poll = getDb().select().from(schema.polls).where(eq(schema.polls.id, pollId)).get();
  if (!poll) throw notFound("That poll");
  return { ...sessionCtx(user, eventSlug, poll.sessionId), poll };
}

function questionCtx(user: User, eventSlug: string, questionId: number) {
  const q = getDb().select().from(schema.sessionQuestions).where(eq(schema.sessionQuestions.id, questionId)).get();
  if (!q) throw notFound("That question");
  return { ...sessionCtx(user, eventSlug, q.sessionId), question: q };
}

const requirePresenter = (presenter: boolean) => {
  if (!presenter) throw forbidden("Only the presenters can do that.");
};

export const pollsRouter = router({
  /** Everything on the live screen: polls, results (after you vote) and questions. */
  live: protectedProcedure.input(z.object({ slug, sessionId: id })).query(({ ctx, input }) => {
    const { event, session, presenter, me } = sessionCtx(ctx.user, input.slug, input.sessionId);
    const db = getDb();
    const polls = db.select().from(schema.polls).where(eq(schema.polls.sessionId, session.id)).orderBy(schema.polls.id).all();
    const votes = polls.length ? db.select().from(schema.pollVotes).where(inArray(schema.pollVotes.pollId, polls.map((p) => p.id))).all() : [];
    const questions = db.select().from(schema.sessionQuestions).where(eq(schema.sessionQuestions.sessionId, session.id)).all();
    const myQVotes = me && questions.length
      ? new Set(db.select().from(schema.questionVotes).where(and(eq(schema.questionVotes.attendeeId, me.id), inArray(schema.questionVotes.questionId, questions.map((q) => q.id)))).all().map((v) => v.questionId))
      : new Set<number>();
    const askers = questions.some((q) => q.attendeeId && !q.anonymous)
      ? new Map(db.select().from(schema.attendees).where(inArray(schema.attendees.id, questions.map((q) => q.attendeeId ?? 0))).all().map((a) => [a.id, personCard(a).name]))
      : new Map<number, string>();
    const now = Date.now();
    const start = zonedToDate(session.date, session.startTime, event.timezone).getTime();
    const end = zonedToDate(session.date, session.endTime, event.timezone).getTime();
    return {
      session: { id: session.id, title: session.title, room: session.room, date: session.date, startTime: session.startTime, endTime: session.endTime, live: now >= start && now <= end },
      presenter,
      canVote: !!me,
      polls: polls
        .filter((p) => presenter || p.status !== "draft")
        .map((p) => {
          const mine = me ? votes.find((v) => v.pollId === p.id && v.attendeeId === me.id) : undefined;
          const own = votes.filter((v) => v.pollId === p.id);
          const showResults = presenter || !!mine;
          return {
            id: p.id,
            question: p.question,
            options: p.options,
            status: p.status,
            total: own.length,
            myVote: mine?.option ?? null,
            results: showResults ? p.options.map((_, i) => own.filter((v) => v.option === i).length) : null,
          };
        })
        .reverse(),
      questions: questions
        .filter((q) => presenter || !q.hidden)
        .sort((a, b) => Number(a.answered) - Number(b.answered) || b.votes - a.votes || a.id - b.id)
        .map((q) => ({
          id: q.id,
          body: q.body,
          votes: q.votes,
          answered: q.answered,
          hidden: q.hidden,
          voted: myQVotes.has(q.id),
          mine: !!me && q.attendeeId === me.id,
          askedBy: q.anonymous || !q.attendeeId ? "" : askers.get(q.attendeeId) ?? "",
        })),
    };
  }),

  create: protectedProcedure
    .input(z.object({ slug, sessionId: id, question: z.string().trim().min(3).max(300), options: z.array(z.string().trim().min(1).max(120)).min(2).max(6), open: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => {
      const { session, presenter } = sessionCtx(ctx.user, input.slug, input.sessionId);
      requirePresenter(presenter);
      return getDb()
        .insert(schema.polls)
        .values({ sessionId: session.id, question: input.question, options: input.options, status: input.open ? "open" : "draft" })
        .returning()
        .get();
    }),

  setStatus: protectedProcedure.input(z.object({ slug, pollId: id, status: z.enum(["draft", "open", "closed"]) })).mutation(({ ctx, input }) => {
    const { poll, presenter } = pollCtx(ctx.user, input.slug, input.pollId);
    requirePresenter(presenter);
    getDb().update(schema.polls).set({ status: input.status }).where(eq(schema.polls.id, poll.id)).run();
    return { ok: true };
  }),

  remove: protectedProcedure.input(z.object({ slug, pollId: id })).mutation(({ ctx, input }) => {
    const { poll, presenter } = pollCtx(ctx.user, input.slug, input.pollId);
    requirePresenter(presenter);
    getDb().delete(schema.polls).where(eq(schema.polls.id, poll.id)).run();
    return { ok: true };
  }),

  /** One vote per attendee per poll. */
  vote: protectedProcedure.input(z.object({ slug, pollId: id, option: z.number().int().min(0).max(5) })).mutation(({ ctx, input }) => {
    const { poll, me } = pollCtx(ctx.user, input.slug, input.pollId);
    if (!me) throw forbidden("Only attendees can vote.");
    if (poll.status !== "open") throw new TRPCError({ code: "BAD_REQUEST", message: "This poll is closed." });
    if (input.option >= poll.options.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick one of the answers." });
    const res = getDb().insert(schema.pollVotes).values({ pollId: poll.id, attendeeId: me.id, option: input.option }).onConflictDoNothing().run();
    if (!res.changes) throw new TRPCError({ code: "BAD_REQUEST", message: "You already voted." });
    return { ok: true };
  }),

  ask: protectedProcedure.input(z.object({ slug, sessionId: id, body: z.string().trim().min(3).max(500), anonymous: z.boolean().default(false) })).mutation(({ ctx, input }) => {
    const { session, me } = sessionCtx(ctx.user, input.slug, input.sessionId);
    if (!me) throw forbidden("Only attendees can ask questions.");
    return getDb().insert(schema.sessionQuestions).values({ sessionId: session.id, attendeeId: me.id, anonymous: input.anonymous, body: input.body }).returning({ id: schema.sessionQuestions.id }).get();
  }),

  /** One upvote per attendee per question. */
  upvote: protectedProcedure.input(z.object({ slug, questionId: id })).mutation(({ ctx, input }) => {
    const { question, me } = questionCtx(ctx.user, input.slug, input.questionId);
    if (!me) throw forbidden("Only attendees can vote.");
    if (question.hidden) throw notFound("That question");
    const db = getDb();
    const res = db.insert(schema.questionVotes).values({ questionId: question.id, attendeeId: me.id }).onConflictDoNothing().run();
    if (res.changes) db.update(schema.sessionQuestions).set({ votes: sql`${schema.sessionQuestions.votes} + 1` }).where(eq(schema.sessionQuestions.id, question.id)).run();
    return { counted: res.changes > 0 };
  }),

  /** Presenters mark a question answered, or hide it. */
  markQuestion: protectedProcedure.input(z.object({ slug, questionId: id, answered: z.boolean().optional(), hidden: z.boolean().optional() })).mutation(({ ctx, input }) => {
    const { question, presenter } = questionCtx(ctx.user, input.slug, input.questionId);
    requirePresenter(presenter);
    const patch: { answered?: boolean; hidden?: boolean } = {};
    if (input.answered !== undefined) patch.answered = input.answered;
    if (input.hidden !== undefined) patch.hidden = input.hidden;
    if (Object.keys(patch).length) getDb().update(schema.sessionQuestions).set(patch).where(eq(schema.sessionQuestions.id, question.id)).run();
    return { ok: true };
  }),
});
