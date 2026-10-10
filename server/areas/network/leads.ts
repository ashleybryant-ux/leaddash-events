/** Lead scanning at booths, and the venue map. */
import { z } from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { User } from "../../../drizzle/schema";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, eventAccess, forbidden, getEventBySlug, notFound, requireArea, requireAttendee } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { fullName } from "@shared/format";
import { csvCell, id, slug } from "./common";


/** Vendors the person may scan leads for: event admins and vendor editors any vendor, booth staff their own (when scanning is on). */
export function scannableVendors(user: User, eventId: number) {
  const access = eventAccess(user, eventId);
  const all = getDb().select().from(schema.vendors).where(eq(schema.vendors.eventId, eventId)).all();
  if (access.admin || access.areas.vendors === "edit") return all.filter((v) => v.status !== "cancelled");
  if (!access.kinds.has("booth")) return [];
  return all.filter((v) => access.vendorIds.includes(v.id) && v.leadScanning && v.status !== "cancelled");
}

function requireScanner(user: User, eventId: number, vendorId: number) {
  const v = scannableVendors(user, eventId).find((x) => x.id === vendorId);
  if (!v) throw forbidden();
  return v;
}

/** A badge QR holds the attendee's token, or a link with ?t=<token>. */
export function tokenFromCode(code: string) {
  const s = code.trim();
  const m = s.match(/[?&]t=([^&#\s]+)/);
  return decodeURIComponent(m ? m[1] : s).trim();
}

function leadPerson(a: typeof schema.attendees.$inferSelect) {
  return { id: a.id, name: fullName(a), firstName: a.firstName, lastName: a.lastName, credentials: a.credentials, jobTitle: a.jobTitle, organization: a.organization, city: a.city, email: a.email, phone: a.phone, photoUrl: fileUrl(a.photoFileId) };
}

function vendorLeads(vendorId: number) {
  return getDb()
    .select({ lead: schema.leads, attendee: schema.attendees })
    .from(schema.leads)
    .innerJoin(schema.attendees, eq(schema.attendees.id, schema.leads.attendeeId))
    .where(eq(schema.leads.vendorId, vendorId))
    .orderBy(desc(schema.leads.id))
    .all();
}

export const leadsRouter = router({
  /** The booths this person can scan for, with lead counts. */
  context: protectedProcedure.input(z.object({ slug })).query(({ ctx, input }) => {
    const event = getEventBySlug(input.slug);
    return scannableVendors(ctx.user, event.id).map((v) => ({ id: v.id, company: v.company, booth: v.booth, leads: vendorLeads(v.id).length }));
  }),

  /** Looks up a scanned badge. */
  lookup: protectedProcedure.input(z.object({ slug, vendorId: id, code: z.string().min(1).max(500) })).mutation(({ ctx, input }) => {
    const event = getEventBySlug(input.slug);
    requireScanner(ctx.user, event.id, input.vendorId);
    const token = tokenFromCode(input.code);
    const a = getDb()
      .select()
      .from(schema.attendees)
      .where(and(eq(schema.attendees.eventId, event.id), eq(schema.attendees.qrToken, token)))
      .get();
    if (!a || a.status === "cancelled") throw new TRPCError({ code: "NOT_FOUND", message: "That badge was not found for this event." });
    const existing = getDb()
      .select()
      .from(schema.leads)
      .where(and(eq(schema.leads.vendorId, input.vendorId), eq(schema.leads.attendeeId, a.id)))
      .get();
    return { person: leadPerson(a), existing: existing ? { rating: existing.rating, note: existing.note } : null };
  }),

  save: protectedProcedure
    .input(z.object({ slug, vendorId: id, attendeeId: id, rating: z.enum(["hot", "warm", "cold"]), note: z.string().trim().max(1000) }))
    .mutation(({ ctx, input }) => {
      const event = getEventBySlug(input.slug);
      requireScanner(ctx.user, event.id, input.vendorId);
      const a = getDb().select().from(schema.attendees).where(and(eq(schema.attendees.id, input.attendeeId), eq(schema.attendees.eventId, event.id))).get();
      if (!a) throw notFound("That attendee");
      getDb()
        .insert(schema.leads)
        .values({ vendorId: input.vendorId, attendeeId: a.id, scannedBy: ctx.user.id, rating: input.rating, note: input.note })
        .onConflictDoUpdate({ target: [schema.leads.vendorId, schema.leads.attendeeId], set: { rating: input.rating, note: input.note } })
        .run();
      return { ok: true };
    }),

  list: protectedProcedure.input(z.object({ slug, vendorId: id })).query(({ ctx, input }) => {
    const event = getEventBySlug(input.slug);
    requireScanner(ctx.user, event.id, input.vendorId);
    return vendorLeads(input.vendorId).map(({ lead, attendee }) => ({ id: lead.id, rating: lead.rating, note: lead.note, at: lead.createdAt, person: leadPerson(attendee) }));
  }),

  /** CSV of the vendor's own leads. */
  exportCsv: protectedProcedure.input(z.object({ slug, vendorId: id })).mutation(({ ctx, input }) => {
    const event = getEventBySlug(input.slug);
    const v = requireScanner(ctx.user, event.id, input.vendorId);
    const head = ["First name", "Last name", "Credentials", "Job title", "Organization", "City", "Email", "Phone", "Interest", "Note", "Scanned"];
    const rows = vendorLeads(v.id).map(({ lead, attendee: a }) =>
      [a.firstName, a.lastName, a.credentials, a.jobTitle, a.organization, a.city, a.email, a.phone, lead.rating, lead.note, lead.createdAt.toISOString()].map(csvCell).join(",")
    );
    return { filename: `${v.company.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-leads.csv`, csv: [head.join(","), ...rows].join("\n") };
  }),
});

const pin = z.object({ label: z.string().trim().min(1).max(80), x: z.number().min(0).max(100), y: z.number().min(0).max(100), kind: z.enum(["room", "booth", "service", "meet"]) });

export const mapsRouter = router({
  /** Venue maps attendees see, with booths matched to exhibitors. */
  list: protectedProcedure.input(z.object({ slug })).query(({ ctx, input }) => {
    const event = getEventBySlug(input.slug);
    const access = eventAccess(ctx.user, event.id);
    if (!access.admin && !access.kinds.size) requireAttendee(ctx.user, event.id);
    const db = getDb();
    const vendors = db
      .select()
      .from(schema.vendors)
      .where(and(eq(schema.vendors.eventId, event.id), eq(schema.vendors.visible, true), inArray(schema.vendors.status, ["confirmed", "paid"])))
      .all();
    const byBooth = new Map(vendors.filter((v) => v.booth).map((v) => [v.booth.toLowerCase(), v]));
    return db
      .select()
      .from(schema.floorMaps)
      .where(eq(schema.floorMaps.eventId, event.id))
      .orderBy(asc(schema.floorMaps.sort), asc(schema.floorMaps.id))
      .all()
      .map((m) => ({
        id: m.id,
        name: m.name,
        imageUrl: fileUrl(m.fileId),
        pins: m.pins.map((p) => {
          const v = p.kind === "booth" ? byBooth.get(p.label.replace(/^booth\s*/i, "").trim().toLowerCase()) : undefined;
          return { ...p, vendorId: v?.id ?? null, vendor: v?.company ?? "" };
        }),
      }));
  }),

  adminList: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "vendors", "view");
    return getDb()
      .select()
      .from(schema.floorMaps)
      .where(eq(schema.floorMaps.eventId, input.eventId))
      .orderBy(asc(schema.floorMaps.sort), asc(schema.floorMaps.id))
      .all()
      .map((m) => ({ ...m, imageUrl: fileUrl(m.fileId) }));
  }),

  create: protectedProcedure.input(z.object({ eventId: id, name: z.string().trim().min(1).max(80), fileId: id })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const f = getDb().select().from(schema.files).where(eq(schema.files.id, input.fileId)).get();
    if (!f || f.orgId !== event.orgId || !f.mime.startsWith("image/")) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload an image of the floor plan." });
    const count = getDb().select().from(schema.floorMaps).where(eq(schema.floorMaps.eventId, input.eventId)).all().length;
    const m = getDb().insert(schema.floorMaps).values({ eventId: input.eventId, name: input.name, fileId: input.fileId, sort: count }).returning().get();
    audit(ctx.user, { eventId: input.eventId, action: "map.create", detail: m.name });
    return m;
  }),

  update: protectedProcedure
    .input(z.object({ eventId: id, mapId: id, name: z.string().trim().min(1).max(80), fileId: id.nullable(), sort: z.number().int().min(0).max(100), pins: z.array(pin).max(300) }))
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
      const db = getDb();
      const m = db.select().from(schema.floorMaps).where(eq(schema.floorMaps.id, input.mapId)).get();
      if (!m || m.eventId !== input.eventId) throw notFound("That map");
      if (input.fileId && input.fileId !== m.fileId) {
        const f = db.select().from(schema.files).where(eq(schema.files.id, input.fileId)).get();
        if (!f || f.orgId !== event.orgId || !f.mime.startsWith("image/")) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload an image of the floor plan." });
      }
      db.update(schema.floorMaps).set({ name: input.name, fileId: input.fileId, sort: input.sort, pins: input.pins }).where(eq(schema.floorMaps.id, m.id)).run();
      return { ok: true };
    }),

  remove: protectedProcedure.input(z.object({ eventId: id, mapId: id })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "vendors", "edit");
    const m = getDb().select().from(schema.floorMaps).where(eq(schema.floorMaps.id, input.mapId)).get();
    if (!m || m.eventId !== input.eventId) throw notFound("That map");
    getDb().delete(schema.floorMaps).where(eq(schema.floorMaps.id, m.id)).run();
    return { ok: true };
  }),
});


