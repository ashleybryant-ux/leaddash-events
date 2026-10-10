/** Announcements (now or scheduled) and the minute jobs: scheduled announcements and session reminders. */
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, notFound, requireArea } from "../../_core/access";
import { notify } from "../../_core/push";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { ENV } from "../../_core/env";
import { fmtTime } from "@shared/format";
import { bad, eventMailStyle, prefsFor, sessionStart, type EventRow } from "./util";

const AUDIENCES = ["everyone", "checked_in", "not_checked_in", "speakers", "vendors", "ticket", "session"] as const;

type Recipient = { attendeeId: number | null; userId: number | null; email: string };

/** Everyone an announcement goes to, one entry per email. */
export function recipientsFor(a: typeof schema.announcements.$inferSelect): Recipient[] {
  const db = getDb();
  const all = db
    .select()
    .from(schema.attendees)
    .where(and(eq(schema.attendees.eventId, a.eventId), eq(schema.attendees.status, "registered")))
    .all();
  let picked: typeof all = [];
  const extra: Recipient[] = [];
  switch (a.audience) {
    case "everyone":
      picked = all;
      break;
    case "checked_in":
      picked = all.filter((x) => x.checkedInAt);
      break;
    case "not_checked_in":
      picked = all.filter((x) => !x.checkedInAt);
      break;
    case "ticket":
      picked = all.filter((x) => a.ticketTypeId && x.ticketTypeId === a.ticketTypeId);
      break;
    case "speakers": {
      const emails = new Set(db.select({ email: schema.speakers.email }).from(schema.speakers).where(eq(schema.speakers.eventId, a.eventId)).all().map((s) => s.email.toLowerCase()).filter(Boolean));
      picked = all.filter((x) => x.kind === "speaker" || emails.has(x.email));
      for (const e of emails) if (!picked.some((p) => p.email === e)) extra.push({ attendeeId: null, userId: null, email: e });
      break;
    }
    case "vendors": {
      picked = all.filter((x) => x.kind === "vendor");
      const staff = db
        .select({ userId: schema.users.id, email: schema.users.email })
        .from(schema.staffAssignments)
        .innerJoin(schema.staffRoles, eq(schema.staffRoles.id, schema.staffAssignments.roleId))
        .innerJoin(schema.users, eq(schema.users.id, schema.staffAssignments.userId))
        .where(and(eq(schema.staffRoles.eventId, a.eventId), eq(schema.staffRoles.kind, "booth")))
        .all();
      for (const s of staff) extra.push({ attendeeId: null, userId: s.userId, email: s.email });
      break;
    }
    case "session": {
      if (!a.sessionId) break;
      const ids = new Set([
        ...db.select({ id: schema.scheduleItems.attendeeId }).from(schema.scheduleItems).where(eq(schema.scheduleItems.sessionId, a.sessionId)).all().map((r) => r.id),
        ...db.select({ id: schema.sessionCheckins.attendeeId }).from(schema.sessionCheckins).where(eq(schema.sessionCheckins.sessionId, a.sessionId)).all().map((r) => r.id),
      ]);
      picked = all.filter((x) => ids.has(x.id));
      break;
    }
  }
  const out = new Map<string, Recipient>();
  for (const p of picked) out.set(p.email, { attendeeId: p.id, userId: p.userId, email: p.email });
  for (const e of extra) {
    const cur = out.get(e.email);
    if (!cur) out.set(e.email, e);
    else if (!cur.userId && e.userId) cur.userId = e.userId;
  }
  return Array.from(out.values());
}

/** Sends one announcement now: an alert (and push) to everyone signed in, and email when it is on. */
export async function sendAnnouncement(id: number) {
  const db = getDb();
  const a = db.select().from(schema.announcements).where(eq(schema.announcements.id, id)).get();
  if (!a || a.sentAt) return 0;
  // Claim it first so a second run never sends it twice.
  const claimed = db.update(schema.announcements).set({ sentAt: new Date() }).where(and(eq(schema.announcements.id, id), isNull(schema.announcements.sentAt))).run();
  if (!claimed.changes) return 0;
  const ev = db.select().from(schema.events).where(eq(schema.events.id, a.eventId)).get()!;
  const list = recipientsFor(a);
  const prefs = prefsFor(list.map((r) => r.attendeeId).filter((x): x is number => !!x));
  const link = a.url || `/e/${ev.slug}/alerts`;
  const notice = { title: a.title, body: a.body, url: link, kind: `announcement:${a.id}` };
  const withUser = list.filter((r) => r.userId);
  const pushOn = withUser.filter((r) => a.sendPush && (!r.attendeeId || prefs.get(r.attendeeId)?.announcements !== false)).map((r) => r.userId!);
  const pushOff = withUser.filter((r) => !pushOn.includes(r.userId!)).map((r) => r.userId!);
  await notify(pushOn, ev.id, notice);
  await notify(pushOff, ev.id, { ...notice, push: false });
  if (a.sendEmail) {
    const style = eventMailStyle(ev);
    const full = link.startsWith("/") ? ENV.appUrl + link : link;
    for (const r of list) {
      try {
        await sendEmail({
          to: r.email,
          subject: a.title,
          text: `${a.body}\n\n${full}`,
          fromName: style.fromName,
          html: emailLayout({ ...style, title: a.title, blocks: [`<p>${escapeHtml(a.body).replace(/\n/g, "<br>")}</p>`, emailButton("Open the app", full, style.look)] }),
        });
      } catch (err) {
        console.error("[announcement] email failed:", (err as Error).message);
      }
    }
  }
  db.update(schema.announcements).set({ recipients: list.length }).where(eq(schema.announcements.id, a.id)).run();
  return list.length;
}

/** Every minute: scheduled announcements that are due. */
export async function runScheduledAnnouncements() {
  const due = getDb()
    .select({ id: schema.announcements.id })
    .from(schema.announcements)
    .where(and(isNull(schema.announcements.sentAt), eq(schema.announcements.draft, false), isNotNull(schema.announcements.sendAt), lte(schema.announcements.sendAt, new Date())))
    .all();
  for (const d of due) {
    try {
      await sendAnnouncement(d.id);
    } catch (err) {
      console.error(`[announcement ${d.id}]`, err);
    }
  }
}

const REMIND_MINUTES = 15;

/** Every minute: "Starting in 15 minutes" for sessions on My agenda with the reminder on. */
export async function runSessionReminders(now = new Date()) {
  const db = getDb();
  const day = (offset: number) => new Date(now.getTime() + offset * 86400_000).toISOString().slice(0, 10);
  const rows = db
    .select({ item: schema.scheduleItems, s: schema.sessions, ev: schema.events, userId: schema.attendees.userId })
    .from(schema.scheduleItems)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.scheduleItems.sessionId))
    .innerJoin(schema.events, eq(schema.events.id, schema.sessions.eventId))
    .innerJoin(schema.attendees, eq(schema.attendees.id, schema.scheduleItems.attendeeId))
    .where(and(eq(schema.scheduleItems.remind, true), isNull(schema.scheduleItems.remindedAt), inArray(schema.sessions.date, [day(-1), day(0), day(1)]), eq(schema.attendees.status, "registered")))
    .all();
  const prefs = prefsFor(rows.map((r) => r.item.attendeeId));
  for (const r of rows) {
    const startsAt = sessionStart(r.s, r.ev.timezone).getTime();
    const lead = startsAt - now.getTime();
    if (lead > REMIND_MINUTES * 60_000) continue;
    db.update(schema.scheduleItems).set({ remindedAt: now }).where(eq(schema.scheduleItems.id, r.item.id)).run();
    // Too late to be useful (it already started): mark it and move on.
    if (lead < -60_000 || !r.userId || !r.s.published || r.ev.status !== "live") continue;
    const mins = Math.max(1, Math.round(lead / 60_000));
    try {
      await notify([r.userId], r.ev.id, {
        title: mins >= REMIND_MINUTES - 1 ? `Starting in ${REMIND_MINUTES} minutes` : `Starting in ${mins} minute${mins === 1 ? "" : "s"}`,
        body: `${r.s.title}${r.s.room ? `, ${r.s.room}` : ""}. ${fmtTime(r.s.startTime)}.`,
        url: `/e/${r.ev.slug}/session/${r.s.id}`,
        kind: "reminder",
        push: prefs.get(r.item.attendeeId)?.reminders !== false,
      });
    } catch (err) {
      console.error("[reminder]", (err as Error).message);
    }
  }
}

const announcementInput = z.object({
  eventId: z.number(),
  title: z.string().trim().min(2).max(140),
  body: z.string().trim().max(2000).default(""),
  audience: z.enum(AUDIENCES).default("everyone"),
  ticketTypeId: z.number().int().nullable().default(null),
  sessionId: z.number().int().nullable().default(null),
  url: z.string().trim().max(500).default(""),
  sendPush: z.boolean().default(true),
  sendEmail: z.boolean().default(false),
  /** Empty sends now. */
  sendAt: z.number().int().nullable().default(null),
  draft: z.boolean().default(false),
});

function checkAudience(ev: EventRow, input: { audience: string; ticketTypeId: number | null; sessionId: number | null; sendPush: boolean; sendEmail: boolean; url: string }) {
  const db = getDb();
  if (input.audience === "ticket") {
    const t = input.ticketTypeId ? db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, input.ticketTypeId)).get() : undefined;
    if (!t || t.eventId !== ev.id) throw bad("Pick a ticket type.");
  }
  if (input.audience === "session") {
    const s = input.sessionId ? db.select().from(schema.sessions).where(eq(schema.sessions.id, input.sessionId)).get() : undefined;
    if (!s || s.eventId !== ev.id) throw bad("Pick a session.");
  }
  if (input.url && !/^(https:\/\/|\/e\/)/.test(input.url)) throw bad("Links start with https:// or /e/.");
}

export const announcementsRouter = router({
  list: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "announcements");
    const db = getDb();
    const rows = db.select().from(schema.announcements).where(eq(schema.announcements.eventId, input.eventId)).orderBy(desc(schema.announcements.id)).all();
    const kinds = rows.map((r) => `announcement:${r.id}`);
    const reads = new Map<string, { total: number; read: number }>();
    if (kinds.length) {
      for (const n of db
        .select({ kind: schema.notifications.kind, readAt: schema.notifications.readAt })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.eventId, input.eventId), inArray(schema.notifications.kind, kinds)))
        .all()) {
        const cur = reads.get(n.kind) ?? { total: 0, read: 0 };
        cur.total++;
        if (n.readAt) cur.read++;
        reads.set(n.kind, cur);
      }
    }
    const creators = new Map(
      (rows.some((r) => r.createdBy) ? db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, rows.map((r) => r.createdBy ?? 0))).all() : []).map((u) => [u.id, u.name || u.email])
    );
    const sessions = new Map(db.select({ id: schema.sessions.id, title: schema.sessions.title }).from(schema.sessions).where(eq(schema.sessions.eventId, input.eventId)).all().map((s) => [s.id, s.title]));
    const tickets = new Map(db.select({ id: schema.ticketTypes.id, name: schema.ticketTypes.name }).from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, input.eventId)).all().map((t) => [t.id, t.name]));
    return rows.map((r) => {
      const rd = reads.get(`announcement:${r.id}`);
      return {
        ...r,
        createdByName: r.createdBy ? creators.get(r.createdBy) ?? "" : "",
        sessionTitle: r.sessionId ? sessions.get(r.sessionId) ?? "" : "",
        ticketName: r.ticketTypeId ? tickets.get(r.ticketTypeId) ?? "" : "",
        openedPercent: rd && rd.total ? Math.round((rd.read / rd.total) * 100) : null,
      };
    });
  }),

  /** Choices for the Send to and Session fields, with how many people each reaches. */
  options: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "announcements");
    const db = getDb();
    const sessions = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, input.eventId)).all().sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    const count = (audience: (typeof AUDIENCES)[number], extra: { ticketTypeId?: number; sessionId?: number } = {}) =>
      recipientsFor({ eventId: input.eventId, audience, ticketTypeId: extra.ticketTypeId ?? null, sessionId: extra.sessionId ?? null } as typeof schema.announcements.$inferSelect).length;
    return {
      counts: { everyone: count("everyone"), checked_in: count("checked_in"), not_checked_in: count("not_checked_in"), speakers: count("speakers"), vendors: count("vendors") },
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, date: s.date, startTime: s.startTime, people: count("session", { sessionId: s.id }) })),
      tickets: db.select({ id: schema.ticketTypes.id, name: schema.ticketTypes.name }).from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, input.eventId)).all().map((t) => ({ ...t, people: count("ticket", { ticketTypeId: t.id }) })),
    };
  }),

  create: protectedProcedure.input(announcementInput).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "announcements", "edit");
    checkAudience(event, input);
    if (input.sendAt && input.sendAt < Date.now() - 60_000 && !input.draft) throw bad("Pick a time in the future.");
    const row = getDb()
      .insert(schema.announcements)
      .values({ ...input, sendAt: input.sendAt ? new Date(input.sendAt) : null, createdBy: ctx.user.id })
      .returning()
      .get();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: input.draft ? "announcement.draft" : "announcement.create", detail: row.title });
    const recipients = !input.draft && !input.sendAt ? await sendAnnouncement(row.id) : 0;
    return { id: row.id, recipients };
  }),

  /** Edits a draft or a scheduled announcement that has not gone out. */
  update: protectedProcedure.input(announcementInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "announcements", "edit");
    const a = getDb().select().from(schema.announcements).where(eq(schema.announcements.id, input.id)).get();
    if (!a || a.eventId !== event.id) throw notFound("That announcement");
    if (a.sentAt) throw bad("This announcement was already sent.");
    checkAudience(event, input);
    const { id, eventId, ...rest } = input;
    void eventId;
    getDb().update(schema.announcements).set({ ...rest, sendAt: rest.sendAt ? new Date(rest.sendAt) : null }).where(eq(schema.announcements.id, id)).run();
    const recipients = !rest.draft && !rest.sendAt ? await sendAnnouncement(id) : 0;
    return { id, recipients };
  }),

  delete: protectedProcedure.input(z.object({ eventId: z.number(), id: z.number() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "announcements", "edit");
    const a = getDb().select().from(schema.announcements).where(eq(schema.announcements.id, input.id)).get();
    if (!a || a.eventId !== event.id) throw notFound("That announcement");
    if (a.sentAt) throw bad("Sent announcements stay on the record.");
    getDb().delete(schema.announcements).where(eq(schema.announcements.id, a.id)).run();
    return { ok: true };
  }),
});
