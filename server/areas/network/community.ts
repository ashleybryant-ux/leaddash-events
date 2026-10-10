/** Community: channels (topics), posts and replies, likes, reports, and admin moderation. */
import { z } from "zod";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, forbidden, notFound, requireArea } from "../../_core/access";
import { attendeeCtx, blockedWith, id, personCard, requireFeature, slug } from "./common";

type Channel = typeof schema.channels.$inferSelect;
type Post = typeof schema.posts.$inferSelect;

export const CATEGORIES = ["General", "Practice", "Meetups", "Travel", "Jobs", "Sessions"] as const;

export function communitySettingsFor(eventId: number) {
  const db = getDb();
  let row = db.select().from(schema.communitySettings).where(eq(schema.communitySettings.eventId, eventId)).get();
  if (!row) row = db.insert(schema.communitySettings).values({ eventId }).onConflictDoNothing().returning().get() ?? db.select().from(schema.communitySettings).where(eq(schema.communitySettings.eventId, eventId)).get()!;
  return row;
}

/** Default channels for a new event. */
export function seedCommunity(eventId: number) {
  const db = getDb();
  const has = db.select().from(schema.channels).where(eq(schema.channels.eventId, eventId)).get();
  if (!has) {
    db.insert(schema.channels)
      .values([
        { eventId, name: "General", description: "Talk about anything at the conference.", category: "General", official: true, pinned: true },
        { eventId, name: "Introductions", description: "Say hello and tell people what you do.", category: "General", official: true, pinned: true },
        { eventId, name: "Ask the organizers", description: "Questions for the event team.", category: "General", official: true, pinned: true },
      ])
      .run();
  }
  communitySettingsFor(eventId);
}

function channelIn(eventId: number, channelId: number) {
  const ch = getDb().select().from(schema.channels).where(eq(schema.channels.id, channelId)).get();
  if (!ch || ch.eventId !== eventId) throw notFound("That topic");
  return ch;
}

function postCounts(channelIds: number[]) {
  if (!channelIds.length) return new Map<number, number>();
  const rows = getDb()
    .select({ channelId: schema.posts.channelId, n: sql<number>`count(*)` })
    .from(schema.posts)
    .where(and(inArray(schema.posts.channelId, channelIds), eq(schema.posts.hidden, false)))
    .groupBy(schema.posts.channelId)
    .all();
  return new Map(rows.map((r) => [r.channelId, r.n]));
}

function memberCount(channelId: number) {
  return getDb().select({ n: sql<number>`count(*)` }).from(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId)).get()!.n;
}

function join(channelId: number, attendeeId: number) {
  getDb().insert(schema.channelMembers).values({ channelId, attendeeId, lastReadAt: new Date() }).onConflictDoNothing().run();
}

function attendeeNames(ids: number[]) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return new Map<number, ReturnType<typeof personCard>>();
  return new Map(
    getDb()
      .select()
      .from(schema.attendees)
      .where(inArray(schema.attendees.id, unique))
      .all()
      .map((a) => [a.id, personCard(a)])
  );
}

/** Whether an attendee may post in a channel under the event's community rules. */
function canPost(ch: Channel, me: typeof schema.attendees.$inferSelect) {
  if (ch.archived) return { ok: false, why: "This topic was archived." };
  if (ch.locked) return { ok: false, why: "This topic is closed." };
  if (me.kind === "vendor") {
    const rules = communitySettingsFor(ch.eventId);
    if (rules.exhibitorPosting === "none") return { ok: false, why: "Exhibitors cannot post in Community." };
    if (rules.exhibitorPosting === "own" && ch.createdByAttendeeId !== me.id) return { ok: false, why: "Exhibitors can post only in their own topic." };
  }
  return { ok: true, why: "" };
}

function shapePosts(rows: Post[], meId: number | null, hideBlocked: (id: number) => boolean) {
  const liked = meId && rows.length
    ? new Set(
        getDb()
          .select({ postId: schema.postLikes.postId })
          .from(schema.postLikes)
          .where(and(eq(schema.postLikes.attendeeId, meId), inArray(schema.postLikes.postId, rows.map((r) => r.id))))
          .all()
          .map((r) => r.postId)
      )
    : new Set<number>();
  const names = attendeeNames(rows.map((r) => r.attendeeId ?? 0));
  const shown = rows.filter((r) => !(r.attendeeId && hideBlocked(r.attendeeId)));
  const one = (r: Post) => ({
    id: r.id,
    body: r.body,
    at: r.createdAt,
    likes: r.likes,
    liked: liked.has(r.id),
    byEvent: r.byEvent,
    author: r.byEvent ? null : r.attendeeId ? names.get(r.attendeeId) ?? null : null,
    mine: !!meId && r.attendeeId === meId && !r.byEvent,
    hidden: r.hidden,
    reported: r.reported,
  });
  const roots = shown.filter((r) => !r.parentId);
  return roots.map((r) => ({ ...one(r), replies: shown.filter((x) => x.parentId === r.id).map(one) }));
}

function insertPost(values: { channelId: number; attendeeId: number | null; body: string; parentId?: number | null; byEvent?: boolean }) {
  const db = getDb();
  const now = new Date();
  const post = db.insert(schema.posts).values({ ...values, parentId: values.parentId ?? null, byEvent: values.byEvent ?? false, createdAt: now }).returning().get();
  db.update(schema.channels).set({ lastPostAt: now }).where(eq(schema.channels.id, values.channelId)).run();
  return post;
}

const channelPatch = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(300).optional(),
  category: z.string().trim().max(40).optional(),
  pinned: z.boolean().optional(),
  locked: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const adminRouter = router({
  /** Every channel with counts (admins, area "community"). */
  channels: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "community", "view");
    const rows = getDb().select().from(schema.channels).where(eq(schema.channels.eventId, input.eventId)).all();
    const counts = postCounts(rows.map((r) => r.id));
    const names = attendeeNames(rows.map((r) => r.createdByAttendeeId ?? 0));
    return rows
      .map((c) => ({ ...c, posts: counts.get(c.id) ?? 0, members: memberCount(c.id), startedBy: c.createdByAttendeeId ? names.get(c.createdByAttendeeId)?.name ?? "" : "" }))
      .sort((a, b) => Number(a.archived) - Number(b.archived) || Number(b.pinned) - Number(a.pinned) || (b.lastPostAt?.getTime() ?? 0) - (a.lastPostAt?.getTime() ?? 0));
  }),

  createChannel: protectedProcedure
    .input(z.object({ eventId: id, name: z.string().trim().min(2).max(100), description: z.string().trim().max(300).default(""), category: z.string().trim().max(40).default("General"), pinned: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => {
      requireArea(ctx.user, input.eventId, "community", "edit");
      const { eventId, ...rest } = input;
      const ch = getDb().insert(schema.channels).values({ eventId, ...rest, official: true }).returning().get();
      audit(ctx.user, { eventId, action: "community.channel.create", detail: ch.name });
      return ch;
    }),

  updateChannel: protectedProcedure.input(z.object({ eventId: id, channelId: id }).merge(channelPatch)).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "community", "edit");
    const ch = channelIn(input.eventId, input.channelId);
    const { eventId: _e, channelId: _c, ...patch } = input;
    if (Object.keys(patch).length) getDb().update(schema.channels).set(patch).where(eq(schema.channels.id, ch.id)).run();
    audit(ctx.user, { eventId: input.eventId, action: "community.channel.update", detail: ch.name });
    return { ok: true };
  }),

  /** Every post in a channel, hidden ones included. */
  posts: protectedProcedure.input(z.object({ eventId: id, channelId: id })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "community", "view");
    channelIn(input.eventId, input.channelId);
    const rows = getDb().select().from(schema.posts).where(eq(schema.posts.channelId, input.channelId)).orderBy(schema.posts.id).all();
    return shapePosts(rows, null, () => false);
  }),

  /** Posts people reported that nobody has reviewed yet. */
  reported: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "community", "view");
    const rows = getDb()
      .select({ post: schema.posts, channel: schema.channels })
      .from(schema.posts)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.posts.channelId))
      .where(and(eq(schema.channels.eventId, input.eventId), gt(schema.posts.reported, 0)))
      .orderBy(desc(schema.posts.reported))
      .all();
    const names = attendeeNames(rows.map((r) => r.post.attendeeId ?? 0));
    return rows.map(({ post, channel }) => ({
      id: post.id,
      body: post.body,
      reports: post.reported,
      hidden: post.hidden,
      channelId: channel.id,
      channelName: channel.name,
      author: post.attendeeId ? names.get(post.attendeeId)?.name ?? "" : "",
    }));
  }),

  /** Hide (remove) or show a post. Clears its reports either way. */
  setHidden: protectedProcedure.input(z.object({ eventId: id, postId: id, hidden: z.boolean() })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "community", "edit");
    const db = getDb();
    const post = db.select().from(schema.posts).where(eq(schema.posts.id, input.postId)).get();
    if (!post) throw notFound("That post");
    channelIn(input.eventId, post.channelId);
    db.update(schema.posts).set({ hidden: input.hidden, reported: 0 }).where(eq(schema.posts.id, post.id)).run();
    audit(ctx.user, { eventId: input.eventId, action: input.hidden ? "community.post.hide" : "community.post.keep", detail: String(post.id) });
    return { ok: true };
  }),

  /** Post in a channel as the event (shows "Event team"). */
  postAsEvent: protectedProcedure.input(z.object({ eventId: id, channelId: id, body: z.string().trim().min(1).max(4000) })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "community", "edit");
    const ch = channelIn(input.eventId, input.channelId);
    const post = insertPost({ channelId: ch.id, attendeeId: null, body: input.body, byEvent: true });
    audit(ctx.user, { eventId: input.eventId, action: "community.post.event", detail: ch.name });
    return { id: post.id };
  }),

  settings: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "community", "view");
    return communitySettingsFor(input.eventId);
  }),

  updateSettings: protectedProcedure
    .input(z.object({ eventId: id, whoCanStart: z.enum(["attendees", "team"]), exhibitorPosting: z.enum(["own", "anywhere", "none"]), hideAfterReports: z.number().int().min(1).max(50).nullable() }))
    .mutation(({ ctx, input }) => {
      requireArea(ctx.user, input.eventId, "community", "edit");
      const row = communitySettingsFor(input.eventId);
      const { eventId: _e, ...rest } = input;
      getDb().update(schema.communitySettings).set(rest).where(eq(schema.communitySettings.id, row.id)).run();
      return { ok: true };
    }),
});

export const communityRouter = router({
  /** Channels attendees can open, pinned first, then most recent. */
  channels: protectedProcedure.input(z.object({ slug })).query(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "community", "Community");
    const db = getDb();
    const rows = db.select().from(schema.channels).where(and(eq(schema.channels.eventId, event.id), eq(schema.channels.archived, false))).all();
    const counts = postCounts(rows.map((r) => r.id));
    const joined = new Set(db.select().from(schema.channelMembers).where(eq(schema.channelMembers.attendeeId, me.id)).all().map((m) => m.channelId));
    const rules = communitySettingsFor(event.id);
    return {
      canStart: rules.whoCanStart === "attendees" && !(me.kind === "vendor" && rules.exhibitorPosting === "none"),
      categories: CATEGORIES,
      channels: rows
        .map((c) => ({ id: c.id, name: c.name, description: c.description, category: c.category, official: c.official, pinned: c.pinned, locked: c.locked, posts: counts.get(c.id) ?? 0, lastPostAt: c.lastPostAt, joined: joined.has(c.id) }))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastPostAt?.getTime() ?? 0) - (a.lastPostAt?.getTime() ?? 0)),
    };
  }),

  /** One channel with its visible posts and replies. */
  channel: protectedProcedure.input(z.object({ slug, channelId: id })).query(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "community", "Community");
    const ch = channelIn(event.id, input.channelId);
    if (ch.archived) throw notFound("That topic");
    const db = getDb();
    const rows = db
      .select()
      .from(schema.posts)
      .where(and(eq(schema.posts.channelId, ch.id), eq(schema.posts.hidden, false)))
      .orderBy(schema.posts.id)
      .all();
    const blocked = blockedWith(me.id);
    const joined = !!db
      .select()
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, ch.id), eq(schema.channelMembers.attendeeId, me.id)))
      .get();
    const posting = canPost(ch, me);
    return {
      id: ch.id,
      name: ch.name,
      description: ch.description,
      official: ch.official,
      locked: ch.locked,
      members: memberCount(ch.id),
      joined,
      canPost: posting.ok,
      cannotPostReason: posting.why,
      /** Topics people started read as one thread: the composer replies to the first post. */
      replyToId: !ch.official ? rows.find((r) => !r.parentId)?.id ?? null : null,
      posts: shapePosts(rows, me.id, blocked.any),
    };
  }),

  /** Start a discussion: a new topic with its first post. */
  start: protectedProcedure
    .input(z.object({ slug, name: z.string().trim().min(3).max(100), body: z.string().trim().min(1).max(4000), category: z.string().trim().max(40).default("General") }))
    .mutation(({ ctx, input }) => {
      const { event, me } = attendeeCtx(ctx.user, input.slug);
      requireFeature(event, "community", "Community");
      const rules = communitySettingsFor(event.id);
      if (rules.whoCanStart !== "attendees") throw forbidden("Only the event team can start topics.");
      if (me.kind === "vendor" && rules.exhibitorPosting === "none") throw forbidden("Exhibitors cannot post in Community.");
      const db = getDb();
      const ch = db.insert(schema.channels).values({ eventId: event.id, name: input.name, category: input.category, createdByAttendeeId: me.id }).returning().get();
      insertPost({ channelId: ch.id, attendeeId: me.id, body: input.body });
      join(ch.id, me.id);
      return { channelId: ch.id };
    }),

  join: protectedProcedure.input(z.object({ slug, channelId: id, joined: z.boolean() })).mutation(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "community", "Community");
    const ch = channelIn(event.id, input.channelId);
    if (input.joined) join(ch.id, me.id);
    else
      getDb()
        .delete(schema.channelMembers)
        .where(and(eq(schema.channelMembers.channelId, ch.id), eq(schema.channelMembers.attendeeId, me.id)))
        .run();
    return { ok: true };
  }),

  post: protectedProcedure.input(z.object({ slug, channelId: id, body: z.string().trim().min(1).max(4000), parentId: id.nullable().default(null) })).mutation(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "community", "Community");
    const ch = channelIn(event.id, input.channelId);
    const posting = canPost(ch, me);
    if (!posting.ok) throw forbidden(posting.why);
    let parentId: number | null = null;
    if (input.parentId) {
      const parent = getDb().select().from(schema.posts).where(eq(schema.posts.id, input.parentId)).get();
      if (!parent || parent.channelId !== ch.id || parent.hidden) throw notFound("That post");
      parentId = parent.parentId ?? parent.id;
    }
    const post = insertPost({ channelId: ch.id, attendeeId: me.id, body: input.body, parentId });
    join(ch.id, me.id);
    return { id: post.id };
  }),

  /** Like or unlike a post. */
  like: protectedProcedure.input(z.object({ slug, postId: id, liked: z.boolean() })).mutation(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    const db = getDb();
    const post = db.select().from(schema.posts).where(eq(schema.posts.id, input.postId)).get();
    if (!post || post.hidden) throw notFound("That post");
    channelIn(event.id, post.channelId);
    if (input.liked) {
      const res = db.insert(schema.postLikes).values({ postId: post.id, attendeeId: me.id }).onConflictDoNothing().run();
      if (res.changes) db.update(schema.posts).set({ likes: sql`${schema.posts.likes} + 1` }).where(eq(schema.posts.id, post.id)).run();
    } else {
      const res = db.delete(schema.postLikes).where(and(eq(schema.postLikes.postId, post.id), eq(schema.postLikes.attendeeId, me.id))).run();
      if (res.changes) db.update(schema.posts).set({ likes: sql`max(${schema.posts.likes} - 1, 0)` }).where(eq(schema.posts.id, post.id)).run();
    }
    return { ok: true };
  }),

  /** Report a post to the event team. Hidden automatically after enough reports. */
  report: protectedProcedure.input(z.object({ slug, postId: id, reason: z.string().trim().max(300).default("") })).mutation(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    const db = getDb();
    const post = db.select().from(schema.posts).where(eq(schema.posts.id, input.postId)).get();
    if (!post || post.hidden) throw notFound("That post");
    channelIn(event.id, post.channelId);
    if (post.attendeeId === me.id) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot report your own post." });
    const res = db.insert(schema.postReports).values({ postId: post.id, attendeeId: me.id, reason: input.reason }).onConflictDoNothing().run();
    if (res.changes) {
      const reported = post.reported + 1;
      const limit = communitySettingsFor(event.id).hideAfterReports;
      db.update(schema.posts)
        .set({ reported, hidden: limit !== null && reported >= limit ? true : post.hidden })
        .where(eq(schema.posts.id, post.id))
        .run();
    }
    return { ok: true };
  }),

  admin: adminRouter,
});
