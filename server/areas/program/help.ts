/** Help center: common questions, the help desk, requests from attendees, and lost and found. */
import { z } from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, notFound, requireArea } from "../../_core/access";
import { notify } from "../../_core/push";
import { fileUrl } from "../../_core/files";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { ENV } from "../../_core/env";
import { attendeeViewer, bad, eventMailStyle, viewer, type AttendeeRow, type EventRow } from "./util";

const LOST_CATEGORIES = ["Phone", "Keys", "Wallet", "Bag", "Clothing", "Other"] as const;

/** Default questions for a new event. Admins edit the placeholders. */
export const DEFAULT_ARTICLES = [
  { category: "At the venue", question: "What is the Wi-Fi?", answer: "Network [WIFI NAME], password [WIFI PASSWORD]." },
  { category: "At the venue", question: "Where do I park?", answer: "[Parking garage or lot, the daily rate, and whether the venue validates parking.]" },
  { category: "CE credits", question: "When do I get my CE certificate?", answer: "Check in at the door with the room's QR code, then take the evaluation after the session. Your certificate shows up in CE credits as soon as the evaluation is in." },
  { category: "At the venue", question: "Where is lost and found?", answer: "Found items are kept at the help desk. Report a lost item in Lost and found in the app and we will let you know when it turns up." },
  { category: "General", question: "How do I contact the organizers?", answer: "Send us a request from this page or stop by the help desk. [Organizer email and phone.]" },
];

export function seedHelp(eventId: number) {
  const db = getDb();
  const has = db.select({ id: schema.helpArticles.id }).from(schema.helpArticles).where(eq(schema.helpArticles.eventId, eventId)).get();
  if (!has) DEFAULT_ARTICLES.forEach((a, i) => db.insert(schema.helpArticles).values({ eventId, ...a, sort: i }).run());
  db.insert(schema.helpDesks)
    .values({ eventId, place: "Registration desk", hours: "", lostFoundNote: "Found items are held at the help desk. Bring your badge to pick one up." })
    .onConflictDoNothing()
    .run();
}

function desk(eventId: number) {
  const row = getDb().select().from(schema.helpDesks).where(eq(schema.helpDesks.eventId, eventId)).get();
  return row ?? { id: 0, eventId, place: "", hours: "", phone: "", lostFoundNote: "", updatedAt: null };
}

const personName = (a: AttendeeRow) => `${a.firstName} ${a.lastName}${a.credentials ? `, ${a.credentials}` : ""}`;

function attendeesById(ids: (number | null)[]) {
  const clean = Array.from(new Set(ids.filter((x): x is number => !!x)));
  const map = new Map<number, AttendeeRow>();
  if (!clean.length) return map;
  for (const a of getDb().select().from(schema.attendees).where(inArray(schema.attendees.id, clean)).all()) map.set(a.id, a);
  return map;
}

/** Tells an attendee something by alert (and push), or by email when they have not opened the app yet. */
async function tellAttendee(ev: EventRow, a: AttendeeRow, notice: { title: string; body: string; path: string; kind: string }) {
  const url = `/e/${ev.slug}${notice.path}`;
  if (a.userId) {
    await notify([a.userId], ev.id, { title: notice.title, body: notice.body, url, kind: notice.kind });
    return;
  }
  const style = eventMailStyle(ev);
  await sendEmail({
    to: a.email,
    subject: notice.title,
    text: `${notice.body}\n\n${ENV.appUrl}${url}`,
    fromName: style.fromName,
    html: emailLayout({ ...style, title: notice.title, blocks: [`<p>${escapeHtml(notice.body).replace(/\n/g, "<br>")}</p>`, emailButton("Open the app", ENV.appUrl + url, style.accent)] }),
  });
}

const articleInput = z.object({
  category: z.string().trim().max(60).default("General"),
  question: z.string().trim().min(3).max(200),
  answer: z.string().trim().min(1).max(4000),
  sort: z.number().int().min(0).max(1000).default(0),
});

export const helpRouter = router({
  /** Admin: articles, the help desk, requests and lost and found in one call. */
  adminGet: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "help");
    const db = getDb();
    const requests = db.select().from(schema.helpRequests).where(eq(schema.helpRequests.eventId, input.eventId)).orderBy(desc(schema.helpRequests.id)).all();
    const items = db.select().from(schema.lostFound).where(eq(schema.lostFound.eventId, input.eventId)).orderBy(desc(schema.lostFound.id)).all();
    const people = attendeesById([...requests.map((r) => r.attendeeId), ...items.map((i) => i.attendeeId)]);
    const repliers = new Map(
      (requests.some((r) => r.repliedBy) ? db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, requests.map((r) => r.repliedBy ?? 0))).all() : []).map((u) => [u.id, u.name || u.email])
    );
    const sessionRooms = Array.from(new Set(db.select({ room: schema.sessions.room }).from(schema.sessions).where(eq(schema.sessions.eventId, input.eventId)).all().map((r) => r.room).filter(Boolean))).sort();
    return {
      desk: desk(input.eventId),
      articles: db.select().from(schema.helpArticles).where(eq(schema.helpArticles.eventId, input.eventId)).orderBy(asc(schema.helpArticles.sort), asc(schema.helpArticles.id)).all(),
      requests: requests.map((r) => {
        const a = r.attendeeId ? people.get(r.attendeeId) : undefined;
        return { ...r, attendeeName: a ? personName(a) : "Former attendee", attendeeEmail: a?.email ?? "", repliedByName: r.repliedBy ? repliers.get(r.repliedBy) ?? "" : "" };
      }),
      lostFound: items.map((i) => {
        const a = i.attendeeId ? people.get(i.attendeeId) : undefined;
        return { ...i, ownerName: a ? personName(a) : "", photoUrl: fileUrl(i.photoFileId) };
      }),
      rooms: sessionRooms,
    };
  }),

  saveArticle: protectedProcedure.input(articleInput.extend({ eventId: z.number(), id: z.number().nullable().default(null) })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "help", "edit");
    const { eventId, id, ...rest } = input;
    if (id) {
      const row = getDb().select().from(schema.helpArticles).where(eq(schema.helpArticles.id, id)).get();
      if (!row || row.eventId !== eventId) throw notFound("That question");
      return getDb().update(schema.helpArticles).set(rest).where(eq(schema.helpArticles.id, id)).returning().get();
    }
    return getDb().insert(schema.helpArticles).values({ eventId, ...rest }).returning().get();
  }),

  deleteArticle: protectedProcedure.input(z.object({ eventId: z.number(), id: z.number() })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "help", "edit");
    const row = getDb().select().from(schema.helpArticles).where(eq(schema.helpArticles.id, input.id)).get();
    if (!row || row.eventId !== input.eventId) throw notFound("That question");
    getDb().delete(schema.helpArticles).where(eq(schema.helpArticles.id, row.id)).run();
    return { ok: true };
  }),

  saveDesk: protectedProcedure
    .input(z.object({ eventId: z.number(), place: z.string().trim().max(160), hours: z.string().trim().max(120), phone: z.string().trim().max(40), lostFoundNote: z.string().trim().max(400) }))
    .mutation(({ ctx, input }) => {
      requireArea(ctx.user, input.eventId, "help", "edit");
      const { eventId, ...rest } = input;
      getDb()
        .insert(schema.helpDesks)
        .values({ eventId, ...rest, updatedAt: new Date() })
        .onConflictDoUpdate({ target: schema.helpDesks.eventId, set: { ...rest, updatedAt: new Date() } })
        .run();
      return { ok: true };
    }),

  /** Answers a request. The attendee gets an alert (or an email if they have not opened the app). */
  reply: protectedProcedure.input(z.object({ eventId: z.number(), id: z.number(), reply: z.string().trim().min(1).max(4000) })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "help", "edit");
    const db = getDb();
    const r = db.select().from(schema.helpRequests).where(eq(schema.helpRequests.id, input.id)).get();
    if (!r || r.eventId !== event.id) throw notFound("That request");
    db.update(schema.helpRequests).set({ reply: input.reply, status: "answered", repliedBy: ctx.user.id, repliedAt: new Date() }).where(eq(schema.helpRequests.id, r.id)).run();
    const a = r.attendeeId ? db.select().from(schema.attendees).where(eq(schema.attendees.id, r.attendeeId)).get() : undefined;
    if (a) await tellAttendee(event, a, { title: "The help desk replied", body: input.reply.length > 180 ? `${input.reply.slice(0, 177)}...` : input.reply, path: "/help", kind: "help" });
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "help.reply", detail: `request ${r.id}` });
    return { ok: true };
  }),

  setRequestStatus: protectedProcedure.input(z.object({ eventId: z.number(), id: z.number(), status: z.enum(["open", "closed"]) })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "help", "edit");
    const r = getDb().select().from(schema.helpRequests).where(eq(schema.helpRequests.id, input.id)).get();
    if (!r || r.eventId !== input.eventId) throw notFound("That request");
    getDb().update(schema.helpRequests).set({ status: input.status === "open" ? (r.reply ? "answered" : "open") : "closed" }).where(eq(schema.helpRequests.id, r.id)).run();
    return { ok: true };
  }),

  /** Admin: logs a found item, or edits an item. */
  saveItem: protectedProcedure
    .input(
      z.object({
        eventId: z.number(),
        id: z.number().nullable().default(null),
        category: z.enum(LOST_CATEGORIES).default("Other"),
        item: z.string().trim().min(2).max(160),
        description: z.string().trim().max(1000).default(""),
        place: z.string().trim().max(120).default(""),
        photoFileId: z.number().int().nullable().default(null),
      })
    )
    .mutation(({ ctx, input }) => {
      requireArea(ctx.user, input.eventId, "help", "edit");
      const { eventId, id, ...rest } = input;
      if (id) {
        const row = getDb().select().from(schema.lostFound).where(eq(schema.lostFound.id, id)).get();
        if (!row || row.eventId !== eventId) throw notFound("That item");
        return getDb().update(schema.lostFound).set(rest).where(eq(schema.lostFound.id, id)).returning().get();
      }
      return getDb().insert(schema.lostFound).values({ eventId, kind: "found", ...rest }).returning().get();
    }),

  /**
   * Admin: "claimed" means it is at the help desk for its owner (the owner is told),
   * "returned" means it was picked up, "open" puts it back.
   */
  setItemStatus: protectedProcedure.input(z.object({ eventId: z.number(), id: z.number(), status: z.enum(["open", "claimed", "returned"]) })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "help", "edit");
    const db = getDb();
    const row = db.select().from(schema.lostFound).where(eq(schema.lostFound.id, input.id)).get();
    if (!row || row.eventId !== event.id) throw notFound("That item");
    db.update(schema.lostFound).set({ status: input.status }).where(eq(schema.lostFound.id, row.id)).run();
    if (input.status === "claimed" && row.status !== "claimed" && row.attendeeId) {
      const a = db.select().from(schema.attendees).where(eq(schema.attendees.id, row.attendeeId)).get();
      const d = desk(event.id);
      if (a) await tellAttendee(event, a, { title: "We found your item", body: `${row.item} is at the help desk${d.place ? ` (${d.place})` : ""}. Bring your badge to pick it up.`, path: "/lost-found", kind: "lost_found" });
    }
    return { ok: true };
  }),

  deleteItem: protectedProcedure.input(z.object({ eventId: z.number(), id: z.number() })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "help", "edit");
    const row = getDb().select().from(schema.lostFound).where(eq(schema.lostFound.id, input.id)).get();
    if (!row || row.eventId !== input.eventId) throw notFound("That item");
    getDb().delete(schema.lostFound).where(eq(schema.lostFound.id, row.id)).run();
    return { ok: true };
  }),

  /** Attendee app: the help desk, questions, and the person's own requests. */
  page: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const { event, attendee } = viewer(ctx.user, input.slug);
    const db = getDb();
    const d = desk(event.id);
    return {
      desk: { place: d.place, hours: d.hours, phone: d.phone },
      articles: db.select({ id: schema.helpArticles.id, category: schema.helpArticles.category, question: schema.helpArticles.question, answer: schema.helpArticles.answer }).from(schema.helpArticles).where(eq(schema.helpArticles.eventId, event.id)).orderBy(asc(schema.helpArticles.sort), asc(schema.helpArticles.id)).all(),
      requests: attendee
        ? db
            .select({ id: schema.helpRequests.id, topic: schema.helpRequests.topic, message: schema.helpRequests.message, status: schema.helpRequests.status, reply: schema.helpRequests.reply, repliedAt: schema.helpRequests.repliedAt, createdAt: schema.helpRequests.createdAt })
            .from(schema.helpRequests)
            .where(and(eq(schema.helpRequests.eventId, event.id), eq(schema.helpRequests.attendeeId, attendee.id)))
            .orderBy(desc(schema.helpRequests.id))
            .all()
        : [],
      registered: !!attendee,
    };
  }),

  /** Attendee app: sends a request to the help desk. Help staff get an alert. */
  send: protectedProcedure.input(z.object({ slug: z.string().max(120), topic: z.string().trim().min(2).max(80), message: z.string().trim().min(2).max(2000) })).mutation(async ({ ctx, input }) => {
    const { event, attendee } = attendeeViewer(ctx.user, input.slug);
    const db = getDb();
    const recent = db.select({ id: schema.helpRequests.id, createdAt: schema.helpRequests.createdAt }).from(schema.helpRequests).where(eq(schema.helpRequests.attendeeId, attendee.id)).all();
    if (recent.filter((r) => Date.now() - r.createdAt.getTime() < 3600_000).length >= 10) throw bad("You have sent a lot of requests. Stop by the help desk.");
    const row = db.insert(schema.helpRequests).values({ eventId: event.id, attendeeId: attendee.id, topic: input.topic, message: input.message }).returning().get();
    // Help staff (by role) get an alert with initials only.
    const staff = db
      .select({ userId: schema.staffAssignments.userId, access: schema.staffRoles.access })
      .from(schema.staffAssignments)
      .innerJoin(schema.staffRoles, eq(schema.staffRoles.id, schema.staffAssignments.roleId))
      .where(eq(schema.staffRoles.eventId, event.id))
      .all()
      .filter((s) => s.access.help === "edit")
      .map((s) => s.userId);
    const initials = `${attendee.firstName[0] ?? ""}${attendee.lastName[0] ?? ""}`.toUpperCase();
    await notify(staff, event.id, { title: "New help request", body: `${initials}: ${input.topic}`, url: `/admin/e/${event.id}/help`, kind: "help_request" });
    return { id: row.id };
  }),

  /** Attendee app: lost and found (the person's reports, and found items waiting at the desk). */
  lostFound: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const { event, attendee } = viewer(ctx.user, input.slug);
    const db = getDb();
    const rows = db.select().from(schema.lostFound).where(eq(schema.lostFound.eventId, event.id)).orderBy(desc(schema.lostFound.id)).all();
    const rooms = Array.from(new Set(db.select({ room: schema.sessions.room }).from(schema.sessions).where(eq(schema.sessions.eventId, event.id)).all().map((r) => r.room).filter(Boolean))).sort();
    return {
      note: desk(event.id).lostFoundNote,
      places: rooms,
      mine: attendee ? rows.filter((r) => r.attendeeId === attendee.id && r.kind === "lost").map((r) => ({ id: r.id, item: r.item, category: r.category, place: r.place, status: r.status, createdAt: r.createdAt })) : [],
      found: rows.filter((r) => r.kind === "found" && r.status === "open").map((r) => ({ id: r.id, item: r.item, category: r.category, place: r.place, photoUrl: fileUrl(r.photoFileId), createdAt: r.createdAt })),
      registered: !!attendee,
    };
  }),

  report: protectedProcedure
    .input(z.object({ slug: z.string().max(120), category: z.enum(LOST_CATEGORIES), item: z.string().trim().min(2).max(160), place: z.string().trim().max(120).default("") }))
    .mutation(({ ctx, input }) => {
      const { event, attendee } = attendeeViewer(ctx.user, input.slug);
      const open = getDb().select({ id: schema.lostFound.id }).from(schema.lostFound).where(and(eq(schema.lostFound.attendeeId, attendee.id), eq(schema.lostFound.status, "open"))).all();
      if (open.length >= 10) throw bad("You already have 10 open reports. Stop by the help desk.");
      const row = getDb().insert(schema.lostFound).values({ eventId: event.id, kind: "lost", attendeeId: attendee.id, category: input.category, item: input.item, place: input.place }).returning().get();
      return { id: row.id };
    }),
});
