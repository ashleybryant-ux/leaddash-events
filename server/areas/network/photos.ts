/**
 * Event photos: attendees post pictures in the app, the event team reviews
 * them (when review is on), everyone at the event sees posted photos, likes
 * them, and can report one back to review. Photo files are private: only
 * people in the event get the signed links.
 */
import fs from "node:fs";
import { z } from "zod";
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Event, User } from "../../../drizzle/schema";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { attendeeFor, audit, eventAccess, forbidden, getEvent, getEventBySlug, notFound, requireArea } from "../../_core/access";
import { userFromCookie } from "../../_core/context";
import { deleteFile, filePath, fileUrl, saveFile } from "../../_core/files";
import { notify } from "../../_core/push";
import { fullName, initials } from "@shared/format";
import { safePart, writeZip } from "../program/slides";
import { id, slug } from "./common";

type Photo = typeof schema.eventPhotos.$inferSelect;
type Attendee = typeof schema.attendees.$inferSelect;
type Who = "everyone" | "attendees" | "staff";

export const PAGE_SIZE = 60;

export function photoSettingsFor(eventId: number) {
  const db = getDb();
  let row = db.select().from(schema.photoSettings).where(eq(schema.photoSettings.eventId, eventId)).get();
  if (!row) row = db.insert(schema.photoSettings).values({ eventId }).onConflictDoNothing().returning().get() ?? db.select().from(schema.photoSettings).where(eq(schema.photoSettings.eventId, eventId)).get()!;
  return row;
}

/** New events start with photos on, team review first, everyone at the event can post. */
export function seedPhotos(eventId: number) {
  const ev = getEvent(eventId);
  if (ev.features.photos === undefined) getDb().update(schema.events).set({ features: { ...ev.features, photos: true } }).where(eq(schema.events.id, eventId)).run();
  photoSettingsFor(eventId);
}

const photosOn = (ev: Event) => ev.features.photos !== false;

function isStaffOf(user: User, eventId: number) {
  const a = eventAccess(user, eventId);
  return a.admin || a.kinds.size > 0 || Object.values(a.areas).some((v) => v !== "none");
}

/** The person looking at photos in the app: registered attendees and event staff only. */
function photoViewer(user: User, eventSlug: string) {
  const event = getEventBySlug(eventSlug);
  const staff = isStaffOf(user, event.id);
  const attendee = attendeeFor(user, event.id) ?? null;
  if (!attendee && !staff) throw forbidden("You are not registered for this event.");
  if (event.status === "draft" && !staff) throw forbidden("The app opens soon.");
  if (!photosOn(event) && !staff) throw forbidden("Photos are turned off for this event.");
  return { event, attendee, staff };
}

/** Whether this person may post under the event's "who can post" choice. */
export function canPostPhotos(who: Who, v: { attendee: Attendee | null; staff: boolean }) {
  if (who === "staff") return v.staff || v.attendee?.kind === "staff";
  if (who === "attendees") return !!v.attendee;
  return !!v.attendee || v.staff;
}

const IMAGE_MAGIC: { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", test: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** The image type read from the file's first bytes (never from the name or what the browser said). */
export function photoMime(base64: string) {
  const head = Buffer.from(base64.replace(/^data:[^,]+,/, "").slice(0, 64), "base64");
  return IMAGE_MAGIC.find((m) => m.test(head))?.mime ?? null;
}

function savePhotoFile(orgId: number, userId: number, name: string, base64: string) {
  const mime = photoMime(base64);
  if (!mime) throw new TRPCError({ code: "BAD_REQUEST", message: "Add a JPEG, PNG or WebP photo." });
  return saveFile({ orgId, name: name || "photo.jpg", mime, base64, isPublic: false, userId });
}

function getPhoto(eventId: number, photoId: number) {
  const p = getDb().select().from(schema.eventPhotos).where(eq(schema.eventPhotos.id, photoId)).get();
  if (!p || p.eventId !== eventId) throw notFound("That photo");
  return p;
}

function removePhoto(p: Photo) {
  getDb().delete(schema.eventPhotos).where(eq(schema.eventPhotos.id, p.id)).run();
  deleteFile(p.fileId);
  if (p.thumbFileId) deleteFile(p.thumbFileId);
}

/** People with community edit access by role get a staff notice (no attendee names, like help requests). */
async function noticeStaff(event: Event, title: string) {
  const staff = getDb()
    .select({ userId: schema.staffAssignments.userId, access: schema.staffRoles.access })
    .from(schema.staffAssignments)
    .innerJoin(schema.staffRoles, eq(schema.staffRoles.id, schema.staffAssignments.roleId))
    .where(eq(schema.staffRoles.eventId, event.id))
    .all()
    .filter((s) => s.access.community === "edit")
    .map((s) => s.userId);
  await notify(staff, event.id, { title, url: `/admin/e/${event.id}/photos`, kind: "photo_review" });
}

/** Names, session titles and links for a set of photos. */
function shapePhotos(rows: Photo[], viewerUserId: number, viewerAttendeeId: number | null) {
  const db = getDb();
  const attIds = Array.from(new Set(rows.map((r) => r.attendeeId).filter((x): x is number => !!x)));
  const userIds = Array.from(new Set(rows.filter((r) => !r.attendeeId).map((r) => r.uploadedByUserId).filter((x): x is number => !!x)));
  const sessIds = Array.from(new Set(rows.map((r) => r.sessionId).filter((x): x is number => !!x)));
  const people = new Map(attIds.length ? db.select().from(schema.attendees).where(inArray(schema.attendees.id, attIds)).all().map((a) => [a.id, a]) : []);
  const users = new Map(userIds.length ? db.select().from(schema.users).where(inArray(schema.users.id, userIds)).all().map((u) => [u.id, u]) : []);
  const sessions = new Map(sessIds.length ? db.select({ id: schema.sessions.id, title: schema.sessions.title }).from(schema.sessions).where(inArray(schema.sessions.id, sessIds)).all().map((s) => [s.id, s.title]) : []);
  const liked = rows.length
    ? new Set(
        db
          .select({ photoId: schema.photoLikes.photoId })
          .from(schema.photoLikes)
          .where(and(eq(schema.photoLikes.userId, viewerUserId), inArray(schema.photoLikes.photoId, rows.map((r) => r.id))))
          .all()
          .map((r) => r.photoId)
      )
    : new Set<number>();
  return rows.map((r) => {
    const a = r.attendeeId ? people.get(r.attendeeId) : undefined;
    const u = r.uploadedByUserId ? users.get(r.uploadedByUserId) : undefined;
    const name = a ? fullName(a) : u?.name || "Event team";
    const [first, ...rest] = (a ? `${a.firstName} ${a.lastName}` : name).split(/\s+/);
    return {
      id: r.id,
      url: fileUrl(r.fileId)!,
      thumbUrl: fileUrl(r.thumbFileId ?? r.fileId)!,
      downloadUrl: fileUrl(r.fileId, false, true)!,
      caption: r.caption,
      at: r.createdAt.getTime(),
      sessionTitle: r.sessionId ? sessions.get(r.sessionId) ?? "" : "",
      status: r.status,
      reported: r.reported,
      likes: r.likes,
      liked: liked.has(r.id),
      mine: viewerAttendeeId ? r.attendeeId === viewerAttendeeId : !r.attendeeId && r.uploadedByUserId === viewerUserId,
      by: { name, initials: initials(first ?? "", rest.at(-1) ?? ""), photoUrl: a ? fileUrl(a.photoFileId) : null },
    };
  });
}

/** Photos the person posted: by their attendee row, or (staff without one) by their sign-in. */
function mineWhere(eventId: number, userId: number, attendeeId: number | null) {
  return and(eq(schema.eventPhotos.eventId, eventId), attendeeId ? eq(schema.eventPhotos.attendeeId, attendeeId) : and(sql`${schema.eventPhotos.attendeeId} is null`, eq(schema.eventPhotos.uploadedByUserId, userId)));
}

const countOf = (where: ReturnType<typeof and>) => getDb().select({ n: sql<number>`count(*)` }).from(schema.eventPhotos).where(where).get()!.n;

const uploadInput = {
  name: z.string().max(200).default("photo.jpg"),
  base64: z.string().min(10).max(22_000_000),
  thumbBase64: z.string().max(3_000_000).optional(),
  caption: z.string().trim().max(300).default(""),
  sessionId: id.nullable().default(null),
};

function checkSession(eventId: number, sessionId: number | null) {
  if (!sessionId) return null;
  const s = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!s || s.eventId !== eventId) throw notFound("That session");
  return s.id;
}

const adminRouter = router({
  /** Settings, counts and every photo for the admin Photos page. */
  list: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "community", "view");
    const s = photoSettingsFor(event.id);
    const rows = getDb().select().from(schema.eventPhotos).where(eq(schema.eventPhotos.eventId, event.id)).orderBy(desc(schema.eventPhotos.id)).all();
    const photos = shapePhotos(rows, ctx.user.id, null);
    return {
      settings: { on: photosOn(event), review: s.review, who: s.who },
      counts: {
        posted: rows.filter((r) => r.status === "posted").length,
        pending: rows.filter((r) => r.status === "pending").length,
        hidden: rows.filter((r) => r.status === "hidden").length,
        likes: rows.reduce((n, r) => n + r.likes, 0),
      },
      photos,
    };
  }),

  updateSettings: protectedProcedure
    .input(z.object({ eventId: id, on: z.boolean(), review: z.boolean(), who: z.enum(["everyone", "attendees", "staff"]) }))
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "community", "edit");
      const db = getDb();
      photoSettingsFor(event.id);
      db.update(schema.photoSettings).set({ review: input.review, who: input.who }).where(eq(schema.photoSettings.eventId, event.id)).run();
      db.update(schema.events).set({ features: { ...event.features, photos: input.on } }).where(eq(schema.events.id, event.id)).run();
      audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "photos.settings" });
      return { ok: true };
    }),

  /** Post, hide, or send back to review. */
  setStatus: protectedProcedure.input(z.object({ eventId: id, photoId: id, status: z.enum(["pending", "posted", "hidden"]) })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "community", "edit");
    const p = getPhoto(event.id, input.photoId);
    getDb()
      .update(schema.eventPhotos)
      .set({ status: input.status, reported: input.status === "pending" ? p.reported : false, reviewedBy: ctx.user.id, reviewedAt: new Date() })
      .where(eq(schema.eventPhotos.id, p.id))
      .run();
    return { ok: true };
  }),

  remove: protectedProcedure.input(z.object({ eventId: id, photoId: id })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "community", "edit");
    removePhoto(getPhoto(event.id, input.photoId));
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "photos.delete", detail: String(input.photoId) });
    return { ok: true };
  }),

  /** Event staff add photos from the admin. They post right away. */
  upload: protectedProcedure.input(z.object({ eventId: id, ...uploadInput })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "community", "edit");
    const sessionId = checkSession(event.id, input.sessionId);
    const f = savePhotoFile(event.orgId, ctx.user.id, input.name, input.base64);
    const t = input.thumbBase64 ? savePhotoFile(event.orgId, ctx.user.id, `thumb-${input.name}`, input.thumbBase64) : null;
    const row = getDb()
      .insert(schema.eventPhotos)
      .values({ eventId: event.id, attendeeId: null, uploadedByUserId: ctx.user.id, fileId: f.id, thumbFileId: t?.id ?? null, caption: input.caption, sessionId, status: "posted", reviewedBy: ctx.user.id, reviewedAt: new Date() })
      .returning()
      .get();
    return { id: row.id };
  }),
});

export const photosRouter = router({
  /** One page of photos: "all" is posted photos, "mine" is the person's own (posted and waiting). */
  list: protectedProcedure
    .input(z.object({ slug, mine: z.boolean().default(false), cursor: id.nullish() }))
    .query(({ ctx, input }) => {
      const { event, attendee, staff } = photoViewer(ctx.user, input.slug);
      const s = photoSettingsFor(event.id);
      const allWhere = and(eq(schema.eventPhotos.eventId, event.id), eq(schema.eventPhotos.status, "posted"));
      const myWhere = and(mineWhere(event.id, ctx.user.id, attendee?.id ?? null), or(eq(schema.eventPhotos.status, "posted"), eq(schema.eventPhotos.status, "pending")));
      const where = input.mine ? myWhere : allWhere;
      const rows = getDb()
        .select()
        .from(schema.eventPhotos)
        .where(input.cursor ? and(where, lt(schema.eventPhotos.id, input.cursor)) : where)
        .orderBy(desc(schema.eventPhotos.id))
        .limit(PAGE_SIZE + 1)
        .all();
      const page = rows.slice(0, PAGE_SIZE);
      return {
        items: shapePhotos(page, ctx.user.id, attendee?.id ?? null),
        next: rows.length > PAGE_SIZE ? page[page.length - 1].id : null,
        counts: { all: countOf(allWhere), mine: countOf(myWhere) },
        canPost: photosOn(event) && canPostPhotos(s.who, { attendee, staff }),
        review: s.review,
        on: photosOn(event),
      };
    }),

  /** When the newest posted photo went up (for the dot on the Home tile). 0 when there are none or photos are off. */
  latest: protectedProcedure.input(z.object({ slug })).query(({ ctx, input }) => {
    let v;
    try {
      v = photoViewer(ctx.user, input.slug);
    } catch {
      return 0;
    }
    const row = getDb()
      .select({ at: schema.eventPhotos.createdAt })
      .from(schema.eventPhotos)
      .where(and(eq(schema.eventPhotos.eventId, v.event.id), eq(schema.eventPhotos.status, "posted")))
      .orderBy(desc(schema.eventPhotos.id))
      .limit(1)
      .get();
    return row ? row.at.getTime() : 0;
  }),

  /** Posts one photo (the app sends each picked photo in turn). Waits for review when the event reviews first. */
  upload: protectedProcedure.input(z.object({ slug, ...uploadInput })).mutation(async ({ ctx, input }) => {
    const { event, attendee, staff } = photoViewer(ctx.user, input.slug);
    if (!photosOn(event)) throw forbidden("Photos are turned off for this event.");
    const s = photoSettingsFor(event.id);
    if (!canPostPhotos(s.who, { attendee, staff })) throw forbidden(s.who === "staff" ? "Only the event team can post photos." : "Only attendees can post photos.");
    const db = getDb();
    const recent = countOf(and(mineWhere(event.id, ctx.user.id, attendee?.id ?? null), sql`${schema.eventPhotos.createdAt} > ${Date.now() - 3600_000}`));
    if (recent >= 100) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "You have posted a lot of photos in the last hour. Try again later." });
    const sessionId = checkSession(event.id, input.sessionId);
    const f = savePhotoFile(event.orgId, ctx.user.id, input.name, input.base64);
    const t = input.thumbBase64 ? savePhotoFile(event.orgId, ctx.user.id, `thumb-${input.name}`, input.thumbBase64) : null;
    // Photos posted in the app follow the review choice for everyone; staff post right away from the admin.
    const status = s.review ? ("pending" as const) : ("posted" as const);
    const row = db
      .insert(schema.eventPhotos)
      .values({ eventId: event.id, attendeeId: attendee?.id ?? null, uploadedByUserId: ctx.user.id, fileId: f.id, thumbFileId: t?.id ?? null, caption: input.caption, sessionId, status })
      .returning()
      .get();
    if (status === "pending") await noticeStaff(event, "A new photo is waiting for review");
    return { id: row.id, status };
  }),

  /** Like or unlike a posted photo. Once per person. */
  like: protectedProcedure.input(z.object({ slug, photoId: id })).mutation(({ ctx, input }) => {
    const { event } = photoViewer(ctx.user, input.slug);
    const p = getPhoto(event.id, input.photoId);
    if (p.status !== "posted") throw notFound("That photo");
    const db = getDb();
    const had = db.select().from(schema.photoLikes).where(and(eq(schema.photoLikes.photoId, p.id), eq(schema.photoLikes.userId, ctx.user.id))).get();
    if (had) db.delete(schema.photoLikes).where(eq(schema.photoLikes.id, had.id)).run();
    else db.insert(schema.photoLikes).values({ photoId: p.id, userId: ctx.user.id }).onConflictDoNothing().run();
    const likes = db.select({ n: sql<number>`count(*)` }).from(schema.photoLikes).where(eq(schema.photoLikes.photoId, p.id)).get()!.n;
    db.update(schema.eventPhotos).set({ likes }).where(eq(schema.eventPhotos.id, p.id)).run();
    return { liked: !had, likes };
  }),

  /** Deletes one of the person's own photos. */
  remove: protectedProcedure.input(z.object({ slug, photoId: id })).mutation(({ ctx, input }) => {
    const { event, attendee } = photoViewer(ctx.user, input.slug);
    const p = getPhoto(event.id, input.photoId);
    const mine = attendee ? p.attendeeId === attendee.id : !p.attendeeId && p.uploadedByUserId === ctx.user.id;
    if (!mine) throw forbidden("You can delete only your own photos.");
    removePhoto(p);
    return { ok: true };
  }),

  /** Sends a posted photo back to review and lets the event team know. */
  report: protectedProcedure.input(z.object({ slug, photoId: id })).mutation(async ({ ctx, input }) => {
    const { event } = photoViewer(ctx.user, input.slug);
    const p = getPhoto(event.id, input.photoId);
    if (p.status !== "posted") return { ok: true };
    getDb().update(schema.eventPhotos).set({ status: "pending", reported: true }).where(eq(schema.eventPhotos.id, p.id)).run();
    await noticeStaff(event, "A photo was reported and is waiting for review");
    return { ok: true };
  }),

  admin: adminRouter,
});

/** GET /api/photos/:eventId/photos.zip: event staff download every posted photo as one zip. */
async function handleZip(req: Request, res: Response) {
  const eventId = Number(req.params.eventId);
  let user: User | null = null;
  try {
    user = userFromCookie(req.headers.cookie);
  } catch {
    user = null;
  }
  let event: Event;
  try {
    if (!user || !eventId) throw forbidden();
    event = requireArea(user, eventId, "community", "view").event;
  } catch {
    return res.status(user ? 403 : 401).send("Sign in as event staff to download photos.");
  }
  const db = getDb();
  const rows = db
    .select({ p: schema.eventPhotos, file: schema.files })
    .from(schema.eventPhotos)
    .innerJoin(schema.files, eq(schema.files.id, schema.eventPhotos.fileId))
    .where(and(eq(schema.eventPhotos.eventId, event.id), eq(schema.eventPhotos.status, "posted")))
    .orderBy(schema.eventPhotos.id)
    .all();
  const entries: { name: string; path: string; at: Date }[] = [];
  let total = 0;
  for (const r of rows) {
    const p = filePath(r.file.key);
    if (!fs.existsSync(p)) continue;
    const ext = r.file.mime === "image/png" ? "png" : r.file.mime === "image/webp" ? "webp" : "jpg";
    entries.push({ name: `photo-${String(r.p.id).padStart(5, "0")}.${ext}`, path: p, at: r.p.createdAt });
    total += r.file.size;
  }
  if (!entries.length) return res.status(404).send("No photos have been posted yet.");
  if (total > 3.5 * 1024 ** 3) return res.status(413).send("Too many photos for one download.");
  const zipName = `${safePart(`${event.shortName || event.name} photos`)}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  res.setHeader("Cache-Control", "private, no-store");
  try {
    await writeZip(res, entries);
  } catch (err) {
    console.error("[photos] zip failed:", err);
    res.destroy();
  }
}

export function registerPhotosHttp(app: Express) {
  app.get("/api/photos/:eventId/photos.zip", (req, res) => void handleZip(req, res));
}
