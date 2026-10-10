import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb, schema } from "../_core/db";
import { attendeeFor, eventAccess, forbidden, getEvent, getEventBySlug, isLeadDashStaff, orgRole, requireEventAdmin, requireOrgAdmin, audit } from "../_core/access";
import { fileUrl, saveFile } from "../_core/files";
import { ENV } from "../_core/env";
import { markRead, unreadCount } from "../_core/push";
import { agencyStatus, authorizeUrl, platformConfigured } from "../_core/platform";
import { sign } from "../_core/crypto";
import { slugify } from "@shared/format";
import { userForEmail } from "./auth";
import { seedEvent } from "../areas";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** What attendees and public pages may see about an event. */
export function publicEvent(ev: typeof schema.events.$inferSelect) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
  return {
    id: ev.id,
    orgId: ev.orgId,
    orgName: org.name,
    orgSlug: org.slug,
    slug: ev.slug,
    name: ev.name,
    shortName: ev.shortName || ev.name,
    startDate: ev.startDate,
    endDate: ev.endDate,
    timezone: ev.timezone,
    venueName: ev.venueName,
    venueAddress: ev.venueAddress,
    city: ev.city,
    status: ev.status,
    branding: ev.branding,
    logoUrl: fileUrl(ev.branding.logoFileId ?? org.logoFileId),
    coverUrl: fileUrl(ev.branding.coverFileId),
    features: ev.features,
  };
}

export const coreRouter = router({
  org: router({
    /** Name, colors and logo for member-facing pages. */
    publicBySlug: publicProcedure.input(z.object({ slug: z.string().max(120) })).query(({ input }) => {
      const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.slug, input.slug)).get();
      if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "That organization was not found." });
      return { id: org.id, name: org.name, slug: org.slug, colorPrimary: org.colorPrimary, colorAccent: org.colorAccent, logoUrl: fileUrl(org.logoFileId) };
    }),

    get: protectedProcedure.input(z.object({ orgId: z.number() })).query(({ ctx, input }) => {
      const role = requireOrgAdmin(ctx.user, input.orgId);
      const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, input.orgId)).get()!;
      return { ...org, logoUrl: fileUrl(org.logoFileId), role };
    }),

    /** LeadDash staff set up a new organization and its owner. */
    create: protectedProcedure
      .input(z.object({ name: z.string().min(2).max(120), ownerEmail: z.string().email(), ownerName: z.string().max(120).default("") }))
      .mutation(({ ctx, input }) => {
        if (!isLeadDashStaff(ctx.user)) throw forbidden();
        const db = getDb();
        let slug = slugify(input.name) || "organization";
        if (db.select().from(schema.organizations).where(eq(schema.organizations.slug, slug)).get()) slug = `${slug}-${Date.now().toString(36)}`;
        const org = db.insert(schema.organizations).values({ name: input.name, slug }).returning().get();
        const owner = userForEmail(input.ownerEmail, input.ownerName);
        db.insert(schema.orgMembers).values({ orgId: org.id, userId: owner.id, role: "owner" }).run();
        audit(ctx.user, { orgId: org.id, action: "org.create", detail: input.name });
        return org;
      }),

    update: protectedProcedure
      .input(z.object({ orgId: z.number(), name: z.string().min(2).max(120), colorPrimary: hex, colorAccent: hex, logoFileId: z.number().nullable(), allEvents: z.boolean().default(false) }))
      .mutation(({ ctx, input }) => {
        requireOrgAdmin(ctx.user, input.orgId);
        const db = getDb();
        const before = db.select().from(schema.organizations).where(eq(schema.organizations.id, input.orgId)).get();
        db.update(schema.organizations)
          .set({ name: input.name, colorPrimary: input.colorPrimary, colorAccent: input.colorAccent, logoFileId: input.logoFileId })
          .where(eq(schema.organizations.id, input.orgId))
          .run();
        // Events that still use the organization's colors or logo follow the change.
        // An event whose Branding was set to its own colors or logo keeps them, unless allEvents is chosen.
        let eventsUpdated = 0;
        if (before) {
          const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
          for (const ev of db.select().from(schema.events).where(eq(schema.events.orgId, input.orgId)).all()) {
            const br = ev.branding;
            const colorsFollow = input.allEvents || (same(br.colorPrimary, before.colorPrimary) && same(br.colorAccent, before.colorAccent));
            const logoFollows = input.allEvents || (br.logoFileId ?? null) === (before.logoFileId ?? null);
            if (!colorsFollow && !logoFollows) continue;
            const next = { ...br, ...(colorsFollow ? { colorPrimary: input.colorPrimary, colorAccent: input.colorAccent } : {}), ...(logoFollows ? { logoFileId: input.logoFileId } : {}) };
            db.update(schema.events).set({ branding: next }).where(eq(schema.events.id, ev.id)).run();
            eventsUpdated += 1;
          }
        }
        return { ok: true, eventsUpdated };
      }),

    team: protectedProcedure.input(z.object({ orgId: z.number() })).query(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      return getDb()
        .select({ id: schema.orgMembers.id, role: schema.orgMembers.role, userId: schema.users.id, email: schema.users.email, name: schema.users.name })
        .from(schema.orgMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
        .where(eq(schema.orgMembers.orgId, input.orgId))
        .all();
    }),

    addAdmin: protectedProcedure
      .input(z.object({ orgId: z.number(), email: z.string().email(), name: z.string().max(120).default("") }))
      .mutation(({ ctx, input }) => {
        const role = requireOrgAdmin(ctx.user, input.orgId);
        if (role === "admin") throw forbidden("Only the owner can add admins.");
        const user = userForEmail(input.email, input.name);
        getDb().insert(schema.orgMembers).values({ orgId: input.orgId, userId: user.id, role: "admin" }).onConflictDoNothing().run();
        return { ok: true };
      }),

    removeAdmin: protectedProcedure.input(z.object({ orgId: z.number(), memberRowId: z.number() })).mutation(({ ctx, input }) => {
      const role = requireOrgAdmin(ctx.user, input.orgId);
      if (role === "admin") throw forbidden("Only the owner can remove admins.");
      const row = getDb().select().from(schema.orgMembers).where(eq(schema.orgMembers.id, input.memberRowId)).get();
      if (!row || row.orgId !== input.orgId) throw forbidden();
      if (row.role === "owner") throw new TRPCError({ code: "BAD_REQUEST", message: "The owner cannot be removed." });
      getDb().delete(schema.orgMembers).where(eq(schema.orgMembers.id, row.id)).run();
      return { ok: true };
    }),

    /** Every organization (LeadDash staff only). */
    all: protectedProcedure.query(({ ctx }) => {
      if (!isLeadDashStaff(ctx.user)) throw forbidden();
      return getDb().select().from(schema.organizations).all();
    }),

    /** LeadDash staff: which LeadDash platform sub-account the organization mirrors contacts into. */
    setPlatformLocation: protectedProcedure
      .input(z.object({ orgId: z.number(), locationId: z.string().max(80).nullable() }))
      .mutation(({ ctx, input }) => {
        if (!isLeadDashStaff(ctx.user)) throw forbidden();
        getDb().update(schema.organizations).set({ platformLocationId: input.locationId || null }).where(eq(schema.organizations.id, input.orgId)).run();
        return { ok: true };
      }),
  }),

  platform: router({
    status: protectedProcedure.query(({ ctx }) => {
      if (!isLeadDashStaff(ctx.user)) throw forbidden();
      return { configured: platformConfigured(), ...agencyStatus() };
    }),
    authorizeUrl: protectedProcedure.mutation(({ ctx }) => {
      if (!isLeadDashStaff(ctx.user)) throw forbidden();
      if (!platformConfigured()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "GHL_CLIENT_ID and GHL_CLIENT_SECRET are not set on the server." });
      const state = `${ctx.user.id}.${Date.now()}`;
      return { url: authorizeUrl(`${state}.${sign(state)}`) };
    }),
  }),

  events: router({
    /** Events of an organization (admins). */
    list: protectedProcedure.input(z.object({ orgId: z.number() })).query(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      return getDb().select().from(schema.events).where(eq(schema.events.orgId, input.orgId)).orderBy(desc(schema.events.startDate)).all();
    }),

    create: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          name: z.string().min(2).max(160),
          shortName: z.string().max(60).default(""),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          timezone: z.string().max(60).default("America/Chicago"),
          venueName: z.string().max(160).default(""),
          venueAddress: z.string().max(240).default(""),
          city: z.string().max(120).default(""),
        })
      )
      .mutation(async ({ ctx, input }) => {
        requireOrgAdmin(ctx.user, input.orgId);
        if (input.endDate < input.startDate) throw new TRPCError({ code: "BAD_REQUEST", message: "The end date is before the start date." });
        const db = getDb();
        const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, input.orgId)).get()!;
        let slug = slugify(`${org.slug}-${input.shortName || input.name}`);
        if (db.select().from(schema.events).where(eq(schema.events.slug, slug)).get()) slug = `${slug}-${Date.now().toString(36)}`;
        const ev = db
          .insert(schema.events)
          .values({ ...input, slug, branding: { colorPrimary: org.colorPrimary, colorAccent: org.colorAccent, logoFileId: org.logoFileId } })
          .returning()
          .get();
        await seedEvent(ev.id);
        audit(ctx.user, { orgId: input.orgId, eventId: ev.id, action: "event.create", detail: ev.name });
        return ev;
      }),

    /** Event home: what is left to set up, and a count for each part of the event the person may open. */
    home: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => {
      const access = eventAccess(ctx.user, input.eventId);
      const ev = getEvent(input.eventId);
      const can = (a: keyof typeof access.areas) => access.areas[a] !== "none";
      if (!access.admin && !Object.values(access.areas).some((v) => v !== "none") && !access.kinds.size) throw forbidden();
      const db = getDb();
      const n = (table: { eventId: unknown } & object, ...where: unknown[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db.select({ c: count() }).from(table as any).where(and(eq((table as any).eventId, ev.id), ...(where as any[]))).get()?.c ?? 0;
      const s = schema;
      const sessions = n(s.sessions);
      const speakers = n(s.speakers);
      const toReview = n(s.proposals, inArray(s.proposals.status, ["submitted", "in_review"]));
      const registered = n(s.attendees, eq(s.attendees.status, "registered"));
      const tickets = n(s.ticketTypes, eq(s.ticketTypes.active, true));
      const sales = db.select({ c: sql<number>`coalesce(sum(${s.orders.amountCents}), 0)` }).from(s.orders).where(and(eq(s.orders.eventId, ev.id), eq(s.orders.status, "paid"))).get()?.c ?? 0;
      const staff = db.select({ c: count() }).from(s.staffAssignments).innerJoin(s.staffRoles, eq(s.staffRoles.id, s.staffAssignments.roleId)).where(eq(s.staffRoles.eventId, ev.id)).get()?.c ?? 0;
      const evaluations = n(s.evaluations);
      const templates = n(s.certificateTemplates);
      const issued = n(s.certificates, isNull(s.certificates.revokedAt));
      const sent = n(s.announcements, isNotNull(s.announcements.sentAt));
      const stripe = db.select().from(s.stripeAccounts).where(eq(s.stripeAccounts.orgId, ev.orgId)).get();
      const b = ev.branding;
      const steps = [
        { key: "stripe", label: "Connect Stripe", done: !!stripe?.chargesEnabled, href: "/admin/payments", show: access.admin },
        { key: "tickets", label: "Add tickets", done: tickets > 0, href: `/admin/e/${ev.id}/registration?tab=tickets`, show: can("registration") },
        { key: "look", label: "Set the app's look", done: !!(b.logoFileId || b.coverFileId), href: `/admin/e/${ev.id}/branding`, show: access.admin },
        { key: "sessions", label: "Add sessions", done: sessions > 0, href: `/admin/e/${ev.id}/sessions`, show: can("sessions") },
        { key: "speakers", label: "Add speakers", done: speakers > 0, href: `/admin/e/${ev.id}/speakers`, show: can("speakers") },
        { key: "certificates", label: "Set up CE certificates", done: templates > 0, href: `/admin/e/${ev.id}/certificates`, show: can("certificates") },
        { key: "live", label: "Open the app to attendees", done: ev.status !== "draft", href: `/admin/e/${ev.id}/settings`, show: access.admin },
      ]
        .filter((x) => x.show)
        .map(({ show: _s, ...x }) => x);
      return {
        steps,
        counts: {
          sessions,
          speakers,
          toReview,
          registered,
          sales: can("registration") ? Number(sales) : null,
          staff,
          evaluations,
          issued,
          sent,
        },
      };
    }),

    /** One event for the admin screens, with what the signed-in person may open. */
    get: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => {
      const access = eventAccess(ctx.user, input.eventId);
      const visible = Object.entries(access.areas).filter(([, v]) => v !== "none").map(([k]) => k);
      if (!access.admin && !visible.length && !access.kinds.size) throw forbidden();
      const ev = getEvent(input.eventId);
      return {
        ...ev,
        coverUrl: fileUrl(ev.branding.coverFileId),
        logoUrl: fileUrl(ev.branding.logoFileId),
        hostImageUrl: fileUrl(ev.hostImageFileId),
        access: { admin: access.admin, areas: access.areas, kinds: Array.from(access.kinds), vendorIds: access.vendorIds },
        orgRole: orgRole(ctx.user, ev.orgId),
      };
    }),

    update: protectedProcedure
      .input(
        z.object({
          eventId: z.number(),
          name: z.string().min(2).max(160),
          shortName: z.string().max(60),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          timezone: z.string().max(60),
          venueName: z.string().max(160),
          venueAddress: z.string().max(240),
          city: z.string().max(120),
          capacity: z.number().int().positive().nullable(),
          status: z.enum(["draft", "live", "ended"]),
        })
      )
      .mutation(({ ctx, input }) => {
        requireEventAdmin(ctx.user, input.eventId);
        const { eventId, ...rest } = input;
        getDb().update(schema.events).set(rest).where(eq(schema.events.id, eventId)).run();
        return { ok: true };
      }),

    /** Public details for the attendee app and the public pages. */
    publicBySlug: publicProcedure.input(z.object({ slug: z.string().max(120) })).query(({ input }) => publicEvent(getEventBySlug(input.slug))),

    /** What the signed-in person is for this event (attendee, staff, admin). */
    me: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
      const ev = getEventBySlug(input.slug);
      const attendee = attendeeFor(ctx.user, ev.id);
      const access = eventAccess(ctx.user, ev.id);
      return {
        eventId: ev.id,
        attendee: attendee ? { ...attendee, photoUrl: fileUrl(attendee.photoFileId) } : null,
        staff: { admin: access.admin, areas: access.areas, kinds: Array.from(access.kinds), vendorIds: access.vendorIds },
        unread: unreadCount(ctx.user.id, ev.id),
      };
    }),

    /** Events the signed-in person can open (attendee, staff or admin). */
    mine: protectedProcedure.query(({ ctx }) => {
      const db = getDb();
      const asAttendee = db
        .select({ eventId: schema.attendees.eventId })
        .from(schema.attendees)
        .where(and(eq(schema.attendees.email, ctx.user.email.toLowerCase())))
        .all()
        .map((r) => r.eventId);
      const orgIds = db.select().from(schema.orgMembers).where(eq(schema.orgMembers.userId, ctx.user.id)).all().map((r) => r.orgId);
      const asStaff = db
        .select({ eventId: schema.staffRoles.eventId })
        .from(schema.staffAssignments)
        .innerJoin(schema.staffRoles, eq(schema.staffRoles.id, schema.staffAssignments.roleId))
        .where(eq(schema.staffAssignments.userId, ctx.user.id))
        .all()
        .map((r) => r.eventId);
      const ids = Array.from(new Set([...asAttendee, ...asStaff]));
      const rows = [
        ...(ids.length ? db.select().from(schema.events).where(inArray(schema.events.id, ids)).all() : []),
        ...(orgIds.length ? db.select().from(schema.events).where(inArray(schema.events.orgId, orgIds)).all() : []),
      ];
      const seen = new Set<number>();
      return rows
        .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
        .map((e) => ({ ...publicEvent(e), isAttendee: asAttendee.includes(e.id), isAdmin: orgIds.includes(e.orgId) || asStaff.includes(e.id) }));
    }),
  }),

  files: router({
    /** Upload a file (base64). Admins upload for their organization; attendees can upload their own photo. */
    upload: protectedProcedure
      .input(
        z.object({
          orgId: z.number().optional(),
          eventId: z.number().optional(),
          name: z.string().min(1).max(200),
          mime: z.string().max(120),
          base64: z.string().max(22_000_000),
          isPublic: z.boolean().default(true),
        })
      )
      .mutation(({ ctx, input }) => {
        let orgId: number | null = input.orgId ?? null;
        if (input.eventId) {
          const ev = getEvent(input.eventId);
          orgId = ev.orgId;
          const access = eventAccess(ctx.user, ev.id);
          const isStaff = access.admin || Object.values(access.areas).some((v) => v === "edit");
          if (!isStaff && !attendeeFor(ctx.user, ev.id)) throw forbidden();
        } else if (orgId) {
          if (!orgRole(ctx.user, orgId)) throw forbidden();
        }
        const f = saveFile({ orgId, name: input.name, mime: input.mime, base64: input.base64, isPublic: input.isPublic, userId: ctx.user.id });
        return { id: f.id, url: fileUrl(f.id)!, name: f.name, mime: f.mime, size: f.size };
      }),
  }),

  push: router({
    publicKey: publicProcedure.query(() => ({ key: ENV.vapidPublic || null })),
    subscribe: protectedProcedure
      .input(z.object({ endpoint: z.string().url().max(1000), p256dh: z.string().max(200), auth: z.string().max(100) }))
      .mutation(({ ctx, input }) => {
        getDb()
          .insert(schema.pushSubscriptions)
          .values({ userId: ctx.user.id, ...input })
          .onConflictDoUpdate({ target: schema.pushSubscriptions.endpoint, set: { userId: ctx.user.id, p256dh: input.p256dh, auth: input.auth } })
          .run();
        return { ok: true };
      }),
    unsubscribe: protectedProcedure.input(z.object({ endpoint: z.string().max(1000) })).mutation(({ ctx, input }) => {
      getDb()
        .delete(schema.pushSubscriptions)
        .where(and(eq(schema.pushSubscriptions.userId, ctx.user.id), eq(schema.pushSubscriptions.endpoint, input.endpoint)))
        .run();
      return { ok: true };
    }),
  }),

  notifications: router({
    list: protectedProcedure.input(z.object({ eventId: z.number().optional() })).query(({ ctx, input }) => {
      const rows = getDb()
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.userId, ctx.user.id))
        .orderBy(desc(schema.notifications.id))
        .limit(100)
        .all();
      return rows.filter((r) => input.eventId === undefined || r.eventId === input.eventId);
    }),
    markRead: protectedProcedure.input(z.object({ ids: z.array(z.number()).max(200) })).mutation(({ ctx, input }) => {
      markRead(ctx.user.id, input.ids);
      return { ok: true };
    }),
  }),
});
