/** Meeting requests between attendees. */
import { z } from "zod";
import { and, eq, inArray, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { forbidden, notFound } from "../../_core/access";
import { notify } from "../../_core/push";
import { fmtDate, fmtTime } from "@shared/format";
import { attendeeCtx, getAttendee, hhmm, id, isBlocked, isoDate, personCard, requireFeature, slug } from "./common";

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Busy blocks for an attendee on a date: their agenda plus pending or accepted meetings. */
function busy(attendeeId: number, eventId: number, date: string) {
  const db = getDb();
  const sessions = db
    .select({ start: schema.sessions.startTime, end: schema.sessions.endTime })
    .from(schema.scheduleItems)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.scheduleItems.sessionId))
    .where(and(eq(schema.scheduleItems.attendeeId, attendeeId), eq(schema.sessions.date, date)))
    .all()
    .map((s) => [toMin(s.start), toMin(s.end)] as const);
  const meetings = db
    .select()
    .from(schema.meetingRequests)
    .where(
      and(
        eq(schema.meetingRequests.eventId, eventId),
        eq(schema.meetingRequests.date, date),
        inArray(schema.meetingRequests.status, ["pending", "accepted"]),
        or(eq(schema.meetingRequests.fromAttendeeId, attendeeId), eq(schema.meetingRequests.toAttendeeId, attendeeId))
      )
    )
    .all()
    .map((m) => [toMin(m.startTime), toMin(m.startTime) + m.minutes] as const);
  return [...sessions, ...meetings];
}

/** Start times when both people are free for the given length. */
export function freeTimes(eventId: number, a: number, b: number, date: string, minutes: number) {
  const blocks = [...busy(a, eventId, date), ...busy(b, eventId, date)];
  const day = { start: 8 * 60, end: 19 * 60 };
  const candidates = new Set<number>();
  for (let t = day.start; t + minutes <= day.end; t += 30) candidates.add(t);
  for (const [, end] of blocks) if (end >= day.start && end + minutes <= day.end) candidates.add(end);
  return Array.from(candidates)
    .filter((t) => blocks.every(([s, e]) => t + minutes <= s || t >= e))
    .sort((x, y) => x - y)
    .map(toHHMM);
}

function shape(m: typeof schema.meetingRequests.$inferSelect, meId: number, eventId: number) {
  const otherId = m.fromAttendeeId === meId ? m.toAttendeeId : m.fromAttendeeId;
  const other = getAttendee(eventId, otherId);
  return { ...m, incoming: m.toAttendeeId === meId, other: other ? personCard(other) : null };
}

export const meetingsRouter = router({
  /** Times you and the other person are both free on a day. */
  freeTimes: protectedProcedure.input(z.object({ slug, attendeeId: id, date: isoDate, minutes: z.number().int().min(15).max(120).default(30) })).query(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "meetings", "Meetings");
    const other = getAttendee(event.id, input.attendeeId);
    if (!other) throw notFound("That person");
    if (input.date < event.startDate || input.date > event.endDate) return [];
    return freeTimes(event.id, me.id, other.id, input.date, input.minutes);
  }),

  request: protectedProcedure
    .input(z.object({ slug, attendeeId: id, date: isoDate, startTime: hhmm, minutes: z.number().int().min(15).max(120), place: z.string().trim().max(120), note: z.string().trim().max(500) }))
    .mutation(async ({ ctx, input }) => {
      const { event, me } = attendeeCtx(ctx.user, input.slug);
      requireFeature(event, "meetings", "Meetings");
      const other = getAttendee(event.id, input.attendeeId);
      if (!other || other.id === me.id || !other.visible) throw notFound("That person");
      if (isBlocked(me.id, other.id)) throw forbidden("You cannot send this person a request.");
      if (input.date < event.startDate || input.date > event.endDate) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a day during the event." });
      const row = getDb()
        .insert(schema.meetingRequests)
        .values({ eventId: event.id, fromAttendeeId: me.id, toAttendeeId: other.id, date: input.date, startTime: input.startTime, minutes: input.minutes, place: input.place, note: input.note })
        .returning()
        .get();
      if (other.userId) {
        await notify([other.userId], event.id, {
          title: `Meeting request from ${me.firstName}`,
          body: `${fmtDate(input.date)} at ${fmtTime(input.startTime)}`,
          url: `/e/${event.slug}/messages`,
          kind: "meeting",
        });
      }
      return row;
    }),

  /** Your meeting requests (sent and received), soonest first. */
  mine: protectedProcedure.input(z.object({ slug })).query(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "meetings", "Meetings");
    return getDb()
      .select()
      .from(schema.meetingRequests)
      .where(and(eq(schema.meetingRequests.eventId, event.id), or(eq(schema.meetingRequests.fromAttendeeId, me.id), eq(schema.meetingRequests.toAttendeeId, me.id))))
      .all()
      .map((m) => shape(m, me.id, event.id))
      .filter((m) => m.other)
      .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  }),

  /** The person who received a request accepts or declines it. */
  respond: protectedProcedure.input(z.object({ slug, id, accept: z.boolean() })).mutation(async ({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    const db = getDb();
    const m = db.select().from(schema.meetingRequests).where(eq(schema.meetingRequests.id, input.id)).get();
    if (!m || m.eventId !== event.id || m.toAttendeeId !== me.id) throw notFound("That request");
    if (m.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "This request was already answered." });
    const status = input.accept ? "accepted" : "declined";
    db.update(schema.meetingRequests).set({ status }).where(eq(schema.meetingRequests.id, m.id)).run();
    const from = getAttendee(event.id, m.fromAttendeeId);
    if (from?.userId) {
      await notify([from.userId], event.id, {
        title: input.accept ? `${me.firstName} accepted your meeting` : `${me.firstName} declined your meeting`,
        body: `${fmtDate(m.date)} at ${fmtTime(m.startTime)}`,
        url: `/e/${event.slug}/messages`,
        kind: "meeting",
      });
    }
    return { status };
  }),

  /** Either person cancels a pending or accepted meeting. */
  cancel: protectedProcedure.input(z.object({ slug, id })).mutation(async ({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    const db = getDb();
    const m = db.select().from(schema.meetingRequests).where(eq(schema.meetingRequests.id, input.id)).get();
    if (!m || m.eventId !== event.id || (m.fromAttendeeId !== me.id && m.toAttendeeId !== me.id)) throw notFound("That request");
    if (m.status === "declined" || m.status === "cancelled") return { status: m.status };
    db.update(schema.meetingRequests).set({ status: "cancelled" }).where(eq(schema.meetingRequests.id, m.id)).run();
    const other = getAttendee(event.id, m.fromAttendeeId === me.id ? m.toAttendeeId : m.fromAttendeeId);
    if (other?.userId) {
      await notify([other.userId], event.id, {
        title: `${me.firstName} canceled a meeting`,
        body: `${fmtDate(m.date)} at ${fmtTime(m.startTime)}`,
        url: `/e/${event.slug}/messages`,
        kind: "meeting",
      });
    }
    return { status: "cancelled" as const };
  }),
});
