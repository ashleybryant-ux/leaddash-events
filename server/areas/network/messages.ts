/** One-to-one messages between attendees, and the unread count for the bottom nav. */
import { z } from "zod";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { attendeeFor, forbidden, getEventBySlug, notFound } from "../../_core/access";
import { notify } from "../../_core/push";
import { attendeeCtx, blockedWith, getAttendee, id, isBlocked, personCard, requireFeature, slug } from "./common";

/** The thread both people are in (one-to-one), or undefined. */
function findDirectThread(eventId: number, a: number, b: number) {
  const db = getDb();
  const mine = db.select({ threadId: schema.threadMembers.threadId }).from(schema.threadMembers).where(eq(schema.threadMembers.attendeeId, a)).all().map((r) => r.threadId);
  if (!mine.length) return undefined;
  const shared = db
    .select({ threadId: schema.threadMembers.threadId })
    .from(schema.threadMembers)
    .innerJoin(schema.threads, eq(schema.threads.id, schema.threadMembers.threadId))
    .where(and(eq(schema.threadMembers.attendeeId, b), inArray(schema.threadMembers.threadId, mine), eq(schema.threads.eventId, eventId)))
    .all()
    .map((r) => r.threadId);
  for (const t of shared) {
    const count = db.select({ n: sql<number>`count(*)` }).from(schema.threadMembers).where(eq(schema.threadMembers.threadId, t)).get()!.n;
    if (count === 2) return t;
  }
  return undefined;
}

/** Starts (or reuses) a one-to-one thread. Used by Message buttons across the app. */
export function startThread(eventId: number, meId: number, otherId: number) {
  const existing = findDirectThread(eventId, meId, otherId);
  if (existing) return existing;
  const db = getDb();
  const t = db.insert(schema.threads).values({ eventId }).returning().get();
  db.insert(schema.threadMembers).values([{ threadId: t.id, attendeeId: meId }, { threadId: t.id, attendeeId: otherId }]).run();
  return t.id;
}

function membership(threadId: number, attendeeId: number, eventId: number) {
  const db = getDb();
  const thread = db.select().from(schema.threads).where(eq(schema.threads.id, threadId)).get();
  if (!thread || thread.eventId !== eventId) throw notFound("That conversation");
  const member = db
    .select()
    .from(schema.threadMembers)
    .where(and(eq(schema.threadMembers.threadId, threadId), eq(schema.threadMembers.attendeeId, attendeeId)))
    .get();
  if (!member) throw notFound("That conversation");
  const others = db
    .select({ attendee: schema.attendees })
    .from(schema.threadMembers)
    .innerJoin(schema.attendees, eq(schema.attendees.id, schema.threadMembers.attendeeId))
    .where(and(eq(schema.threadMembers.threadId, threadId), ne(schema.threadMembers.attendeeId, attendeeId)))
    .all()
    .map((r) => r.attendee);
  return { thread, member, others };
}

/** Unread messages for an attendee: in threads they did not mute, from people they did not block. */
export function unreadFor(attendeeId: number) {
  const db = getDb();
  const mems = db.select().from(schema.threadMembers).where(eq(schema.threadMembers.attendeeId, attendeeId)).all();
  const blocked = blockedWith(attendeeId);
  let n = 0;
  for (const m of mems) {
    if (m.muted) continue;
    const rows = db
      .select({ attendeeId: schema.messages.attendeeId, n: sql<number>`count(*)` })
      .from(schema.messages)
      .where(and(eq(schema.messages.threadId, m.threadId), ne(schema.messages.attendeeId, attendeeId), gt(schema.messages.id, m.lastReadMessageId)))
      .groupBy(schema.messages.attendeeId)
      .all();
    for (const r of rows) if (!blocked.any(r.attendeeId)) n += r.n;
  }
  return n;
}

function latestMessageId(threadId: number) {
  return getDb().select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.threadId, threadId)).orderBy(desc(schema.messages.id)).limit(1).get()?.id ?? 0;
}

export const unreadMessages = protectedProcedure.input(z.object({ slug: z.string() })).query(({ ctx, input }) => {
  let event;
  try {
    event = getEventBySlug(input.slug);
  } catch {
    return 0;
  }
  if (!event.features.messaging) return 0;
  const me = attendeeFor(ctx.user, event.id);
  if (!me) return 0;
  return unreadFor(me.id);
});

export const messagesRouter = router({
  /** Start or reuse a conversation with someone. */
  start: protectedProcedure.input(z.object({ slug, attendeeId: id })).mutation(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "messaging", "Messaging");
    const other = getAttendee(event.id, input.attendeeId);
    if (!other || other.id === me.id) throw notFound("That person");
    if (isBlocked(me.id, other.id)) throw forbidden("You cannot message this person.");
    const existing = findDirectThread(event.id, me.id, other.id);
    if (!existing && !other.visible) throw forbidden("This person is not taking messages.");
    return { threadId: existing ?? startThread(event.id, me.id, other.id) };
  }),

  /** Your conversations, newest first. */
  list: protectedProcedure.input(z.object({ slug })).query(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "messaging", "Messaging");
    const db = getDb();
    const blocked = blockedWith(me.id);
    const mems = db
      .select({ member: schema.threadMembers, thread: schema.threads })
      .from(schema.threadMembers)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.threadMembers.threadId))
      .where(and(eq(schema.threadMembers.attendeeId, me.id), eq(schema.threads.eventId, event.id)))
      .all();
    const out = [];
    for (const { member, thread } of mems) {
      const last = db.select().from(schema.messages).where(eq(schema.messages.threadId, thread.id)).orderBy(desc(schema.messages.id)).limit(1).get();
      if (!last) continue;
      const others = membership(thread.id, me.id, event.id).others;
      const unread = db
        .select({ n: sql<number>`count(*)` })
        .from(schema.messages)
        .where(and(eq(schema.messages.threadId, thread.id), ne(schema.messages.attendeeId, me.id), gt(schema.messages.id, member.lastReadMessageId)))
        .get()!.n;
      const isBlocked = others.some((o) => blocked.any(o.id));
      out.push({
        threadId: thread.id,
        people: others.map(personCard),
        last: { body: isBlocked ? "" : last.body, at: last.createdAt, mine: last.attendeeId === me.id },
        unread: member.muted || isBlocked ? 0 : unread,
        muted: member.muted,
        blocked: isBlocked,
      });
    }
    return out.sort((a, b) => b.last.at.getTime() - a.last.at.getTime());
  }),

  /** One conversation with its messages (oldest first). */
  get: protectedProcedure.input(z.object({ slug, threadId: id })).query(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "messaging", "Messaging");
    const { member, others } = membership(input.threadId, me.id, event.id);
    const blocked = blockedWith(me.id);
    const rows = getDb()
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, input.threadId))
      .orderBy(desc(schema.messages.id))
      .limit(300)
      .all()
      .reverse();
    return {
      threadId: input.threadId,
      people: others.map((o) => ({ ...personCard(o), blockedByMe: blocked.iBlocked.has(o.id) })),
      muted: member.muted,
      blocked: others.some((o) => blocked.any(o.id)),
      messages: rows.filter((m) => m.attendeeId === me.id || !blocked.any(m.attendeeId)).map((m) => ({ id: m.id, body: m.body, at: m.createdAt, mine: m.attendeeId === me.id })),
    };
  }),

  markRead: protectedProcedure.input(z.object({ slug, threadId: id })).mutation(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    const { member } = membership(input.threadId, me.id, event.id);
    getDb()
      .update(schema.threadMembers)
      .set({ lastReadAt: new Date(), lastReadMessageId: Math.max(member.lastReadMessageId, latestMessageId(input.threadId)) })
      .where(eq(schema.threadMembers.id, member.id))
      .run();
    return { ok: true };
  }),

  send: protectedProcedure.input(z.object({ slug, threadId: id, body: z.string().trim().min(1).max(2000) })).mutation(async ({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "messaging", "Messaging");
    const { member, others } = membership(input.threadId, me.id, event.id);
    if (others.some((o) => isBlocked(me.id, o.id))) throw forbidden("You cannot message this person.");
    if (others.some((o) => o.status === "cancelled")) throw new TRPCError({ code: "BAD_REQUEST", message: "This person is no longer registered." });
    const db = getDb();
    const now = new Date();
    const msg = db.insert(schema.messages).values({ threadId: input.threadId, attendeeId: me.id, body: input.body, createdAt: now }).returning().get();
    db.update(schema.threads).set({ lastMessageAt: now }).where(eq(schema.threads.id, input.threadId)).run();
    db.update(schema.threadMembers).set({ lastReadAt: now, lastReadMessageId: msg.id }).where(eq(schema.threadMembers.id, member.id)).run();
    const mutedIds = new Set(
      db
        .select()
        .from(schema.threadMembers)
        .where(and(eq(schema.threadMembers.threadId, input.threadId), eq(schema.threadMembers.muted, true)))
        .all()
        .map((m) => m.attendeeId)
    );
    const userIds = others.filter((o) => !mutedIds.has(o.id) && o.userId).map((o) => o.userId!);
    // No message text in the notice: lock screens are not private.
    await notify(userIds, event.id, { title: `New message from ${me.firstName}`, url: `/e/${event.slug}/messages/${input.threadId}`, kind: "message" });
    return { id: msg.id };
  }),

  mute: protectedProcedure.input(z.object({ slug, threadId: id, muted: z.boolean() })).mutation(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    const { member } = membership(input.threadId, me.id, event.id);
    getDb().update(schema.threadMembers).set({ muted: input.muted }).where(eq(schema.threadMembers.id, member.id)).run();
    return { ok: true };
  }),
});
