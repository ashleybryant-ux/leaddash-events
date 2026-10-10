/** People directory, profiles, editing your own profile, and blocking. */
import { z } from "zod";
import { and, eq, inArray, ne } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { forbidden, notFound } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { attendeeCtx, blockedWith, getAttendee, id, personCard, requireFeature, slug } from "./common";

type Vendor = typeof schema.vendors.$inferSelect;

/** Vendor a person works for (their email is the vendor contact or on the booth staff list). */
export function vendorsByEmail(eventId: number) {
  const map = new Map<string, Vendor>();
  for (const v of getDb().select().from(schema.vendors).where(eq(schema.vendors.eventId, eventId)).all()) {
    if (v.status === "cancelled") continue;
    for (const e of [v.email, ...v.boothStaff]) if (e) map.set(e.trim().toLowerCase(), v);
  }
  return map;
}

/** The second line under a person's name: "Group practice owner · Atlanta, GA" or "Booth 14 · Practice software". */
function subLine(a: { jobTitle: string; organization: string; city: string; email: string; kind: string }, vendors: Map<string, Vendor>) {
  const v = a.kind === "vendor" ? vendors.get(a.email.toLowerCase()) : undefined;
  if (v) return [v.booth ? `Booth ${v.booth}` : v.company, v.category].filter(Boolean).join(" · ");
  return [a.jobTitle || a.organization, a.city].filter(Boolean).join(" · ");
}

function mySessionIds(attendeeId: number) {
  return getDb()
    .select({ sessionId: schema.scheduleItems.sessionId })
    .from(schema.scheduleItems)
    .where(eq(schema.scheduleItems.attendeeId, attendeeId))
    .all()
    .map((r) => r.sessionId);
}

const profileInput = z.object({
  slug,
  jobTitle: z.string().trim().max(120),
  organization: z.string().trim().max(160),
  city: z.string().trim().max(120),
  bio: z.string().trim().max(1500),
  credentials: z.string().trim().max(60),
  interests: z.array(z.string().trim().min(1).max(60)).max(20),
  photoFileId: id.nullable(),
  visible: z.boolean(),
});

export const peopleRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        slug,
        q: z.string().max(100).default(""),
        filter: z.enum(["all", "speakers", "exhibitors", "mine"]).default("all"),
        interest: z.string().max(60).optional(),
        organization: z.string().max(160).optional(),
      })
    )
    .query(({ ctx, input }) => {
      const { event, me } = attendeeCtx(ctx.user, input.slug);
      requireFeature(event, "networking", "People");
      const db = getDb();
      const all = db
        .select()
        .from(schema.attendees)
        .where(and(eq(schema.attendees.eventId, event.id), ne(schema.attendees.status, "cancelled"), eq(schema.attendees.visible, true)))
        .all();
      const { blockedMe, iBlocked } = blockedWith(me.id);
      const pool = all.filter((a) => a.id !== me.id && !blockedMe.has(a.id));
      const interests = Array.from(new Set(pool.flatMap((a) => a.interests))).sort((a, b) => a.localeCompare(b));
      const organizations = Array.from(new Set(pool.map((a) => a.organization).filter(Boolean))).sort((a, b) => a.localeCompare(b));
      let list = pool;
      if (input.filter === "speakers") list = list.filter((a) => a.kind === "speaker");
      if (input.filter === "exhibitors") list = list.filter((a) => a.kind === "vendor");
      if (input.filter === "mine") {
        const mine = mySessionIds(me.id);
        const ids = new Set(
          mine.length
            ? db
                .select({ attendeeId: schema.scheduleItems.attendeeId })
                .from(schema.scheduleItems)
                .where(inArray(schema.scheduleItems.sessionId, mine))
                .all()
                .map((r) => r.attendeeId)
            : []
        );
        list = list.filter((a) => ids.has(a.id));
      }
      if (input.interest) list = list.filter((a) => a.interests.some((i) => i.toLowerCase() === input.interest!.toLowerCase()));
      if (input.organization) list = list.filter((a) => a.organization.toLowerCase() === input.organization!.toLowerCase());
      const q = input.q.trim().toLowerCase();
      if (q) {
        list = list.filter((a) =>
          [a.firstName, a.lastName, `${a.firstName} ${a.lastName}`, a.city, a.organization, a.jobTitle, a.credentials, ...a.interests].some((v) => v.toLowerCase().includes(q))
        );
      }
      list.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
      const vendors = vendorsByEmail(event.id);
      return {
        people: list.slice(0, 300).map((a) => ({ ...personCard(a), line: subLine(a, vendors), blockedByMe: iBlocked.has(a.id) })),
        total: list.length,
        interests,
        organizations,
        meVisible: me.visible,
      };
    }),

  /** Someone's profile (or your own). */
  get: protectedProcedure.input(z.object({ slug, attendeeId: id })).query(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "networking", "People");
    const a = getAttendee(event.id, input.attendeeId);
    const self = a?.id === me.id;
    const { blockedMe, iBlocked } = blockedWith(me.id);
    if (!a || (!self && (!a.visible || blockedMe.has(a.id)))) throw notFound("That person");
    const db = getDb();
    const mine = mySessionIds(me.id);
    const theirs = new Set(mySessionIds(a.id));
    const shared = self ? [] : mine.filter((s) => theirs.has(s));
    const sessions = shared.length
      ? db
          .select({ id: schema.sessions.id, title: schema.sessions.title, date: schema.sessions.date, startTime: schema.sessions.startTime })
          .from(schema.sessions)
          .where(inArray(schema.sessions.id, shared))
          .all()
          .sort((x, y) => `${x.date}${x.startTime}`.localeCompare(`${y.date}${y.startTime}`))
      : [];
    return {
      ...personCard(a),
      line: subLine(a, vendorsByEmail(event.id)),
      bio: a.bio,
      interests: a.interests,
      sharedSessions: sessions,
      self,
      blockedByMe: iBlocked.has(a.id),
      canMessage: !self && event.features.messaging && !iBlocked.has(a.id),
      canMeet: !self && event.features.meetings && !iBlocked.has(a.id),
    };
  }),

  /** Your own profile fields for the edit screen. */
  me: protectedProcedure.input(z.object({ slug })).query(({ ctx, input }) => {
    const { me } = attendeeCtx(ctx.user, input.slug);
    return {
      id: me.id,
      firstName: me.firstName,
      lastName: me.lastName,
      email: me.email,
      jobTitle: me.jobTitle,
      organization: me.organization,
      city: me.city,
      bio: me.bio,
      credentials: me.credentials,
      interests: me.interests,
      photoFileId: me.photoFileId,
      photoUrl: fileUrl(me.photoFileId),
      visible: me.visible,
    };
  }),

  updateMe: protectedProcedure.input(profileInput).mutation(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    const db = getDb();
    if (input.photoFileId && input.photoFileId !== me.photoFileId) {
      const f = db.select().from(schema.files).where(eq(schema.files.id, input.photoFileId)).get();
      if (!f || f.uploadedBy !== ctx.user.id || f.orgId !== event.orgId || !f.mime.startsWith("image/")) throw forbidden("That photo cannot be used.");
    }
    const { slug: _s, interests, ...rest } = input;
    const clean = Array.from(new Set(interests.map((i) => i.trim()).filter(Boolean)));
    db.update(schema.attendees).set({ ...rest, interests: clean }).where(eq(schema.attendees.id, me.id)).run();
    return { ok: true };
  }),

  setVisible: protectedProcedure.input(z.object({ slug, visible: z.boolean() })).mutation(({ ctx, input }) => {
    const { me } = attendeeCtx(ctx.user, input.slug);
    getDb().update(schema.attendees).set({ visible: input.visible }).where(eq(schema.attendees.id, me.id)).run();
    return { ok: true };
  }),

  block: protectedProcedure.input(z.object({ slug, attendeeId: id })).mutation(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    const a = getAttendee(event.id, input.attendeeId);
    if (!a || a.id === me.id) throw notFound("That person");
    getDb().insert(schema.blocks).values({ attendeeId: me.id, blockedAttendeeId: a.id }).onConflictDoNothing().run();
    return { ok: true };
  }),

  unblock: protectedProcedure.input(z.object({ slug, attendeeId: id })).mutation(({ ctx, input }) => {
    const { me } = attendeeCtx(ctx.user, input.slug);
    getDb()
      .delete(schema.blocks)
      .where(and(eq(schema.blocks.attendeeId, me.id), eq(schema.blocks.blockedAttendeeId, input.attendeeId)))
      .run();
    return { ok: true };
  }),

  /** People you blocked (so you can unblock them). */
  blocked: protectedProcedure.input(z.object({ slug })).query(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    const ids = Array.from(blockedWith(me.id).iBlocked);
    if (!ids.length) return [];
    return getDb()
      .select()
      .from(schema.attendees)
      .where(and(eq(schema.attendees.eventId, event.id), inArray(schema.attendees.id, ids)))
      .all()
      .map(personCard);
  }),
});
