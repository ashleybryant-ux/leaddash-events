/** Exhibitors and sponsors: the attendee directory and the admin Vendors screen (area "vendors"). */
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, notFound, requireArea } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { userForEmail } from "../../core/auth";
import { fmtMoney } from "@shared/format";
import { attendeeCtx, id, isBlocked, requireFeature, slug } from "./common";
import { startThread } from "./messages";

type Vendor = typeof schema.vendors.$inferSelect;

export const VENDOR_STATUSES = ["lead", "invited", "contract_sent", "confirmed", "paid", "cancelled"] as const;
/** Vendors attendees see in the app. */
const LISTED = new Set<Vendor["status"]>(["confirmed", "paid"]);

export function vendorIn(eventId: number, vendorId: number) {
  const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get();
  if (!v || v.eventId !== eventId) throw notFound("That vendor");
  return v;
}

/** The attendee rows for a vendor's contact and booth staff (so attendees can message them). */
function vendorPeople(v: Vendor) {
  const emails = Array.from(new Set([v.email, ...v.boothStaff].map((e) => e.trim().toLowerCase()).filter(Boolean)));
  if (!emails.length) return [];
  return getDb()
    .select()
    .from(schema.attendees)
    .where(and(eq(schema.attendees.eventId, v.eventId), inArray(schema.attendees.email, emails)))
    .all()
    .filter((a) => a.status !== "cancelled");
}

/** The built-in booth staff role for an event, created the first time it is needed. */
function boothRole(eventId: number) {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.staffRoles)
    .where(and(eq(schema.staffRoles.eventId, eventId), eq(schema.staffRoles.kind, "booth")))
    .get();
  if (existing) return existing;
  return db
    .insert(schema.staffRoles)
    .values({ eventId, name: "Booth staff", description: "Scan attendee badges for leads at their booth.", kind: "booth", access: {} })
    .returning()
    .get();
}

/** Keeps booth staff sign-ins in step with the vendor's booth staff emails. */
export function syncBoothStaff(v: Vendor) {
  const db = getDb();
  const role = boothRole(v.eventId);
  const emails = Array.from(new Set(v.boothStaff.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  const userIds: number[] = [];
  for (const email of emails) {
    const u = userForEmail(email);
    userIds.push(u.id);
    db.insert(schema.staffAssignments)
      .values({ roleId: role.id, userId: u.id, vendorId: v.id })
      .onConflictDoUpdate({ target: [schema.staffAssignments.roleId, schema.staffAssignments.userId], set: { vendorId: v.id } })
      .run();
  }
  const current = db
    .select()
    .from(schema.staffAssignments)
    .where(and(eq(schema.staffAssignments.roleId, role.id), eq(schema.staffAssignments.vendorId, v.id)))
    .all();
  for (const a of current) if (!userIds.includes(a.userId)) db.delete(schema.staffAssignments).where(eq(schema.staffAssignments.id, a.id)).run();
}

function leadCounts(vendorIds: number[]) {
  if (!vendorIds.length) return new Map<number, number>();
  const rows = getDb()
    .select({ vendorId: schema.leads.vendorId, n: sql<number>`count(*)` })
    .from(schema.leads)
    .where(inArray(schema.leads.vendorId, vendorIds))
    .groupBy(schema.leads.vendorId)
    .all();
  return new Map(rows.map((r) => [r.vendorId, r.n]));
}

function staffNames(v: Vendor) {
  const people = vendorPeople(v);
  return v.boothStaff.map((email) => {
    const e = email.toLowerCase();
    const a = people.find((p) => p.email === e);
    if (a) return `${a.firstName} ${a.lastName}`;
    const u = getDb().select().from(schema.users).where(eq(schema.users.email, e)).get();
    return u?.name || email;
  });
}

const isSponsor = (v: Vendor) => v.kind === "sponsor" || v.kind === "both";

/** Sponsor levels first (biggest packages first), then exhibitors by name. */
function directoryOrder(list: Vendor[]) {
  return [...list].sort((a, b) => Number(isSponsor(b)) - Number(isSponsor(a)) || b.amountCents - a.amountCents || a.company.localeCompare(b.company));
}

function publicVendor(v: Vendor) {
  return {
    id: v.id,
    company: v.company,
    kind: v.kind,
    sponsor: isSponsor(v),
    level: v.level,
    booth: v.booth,
    category: v.category,
    description: v.description,
    website: v.website,
    offer: v.offer,
    logoUrl: fileUrl(v.logoFileId),
    canMessage: vendorPeople(v).some((p) => p.visible),
  };
}

const benefit = z.object({ label: z.string().trim().min(1).max(160), status: z.enum(["done", "not_started", "waiting"]) });
const vendorFields = z.object({
  company: z.string().trim().min(1).max(160),
  kind: z.enum(["exhibitor", "sponsor", "both"]),
  level: z.string().trim().max(80),
  category: z.string().trim().max(80),
  contactName: z.string().trim().max(120),
  email: z.string().trim().max(200).refine((s) => !s || z.string().email().safeParse(s).success, "Enter a valid email."),
  phone: z.string().trim().max(40),
  booth: z.string().trim().max(20),
  status: z.enum(VENDOR_STATUSES),
  amountCents: z.number().int().min(0).max(100_000_000),
  paidCents: z.number().int().min(0).max(100_000_000),
  description: z.string().trim().max(2000),
  website: z.string().trim().max(300),
  offer: z.string().trim().max(300),
  notes: z.string().trim().max(4000),
  logoFileId: id.nullable(),
  contractFileId: id.nullable(),
  benefits: z.array(benefit).max(40),
  boothStaff: z.array(z.string().trim().email().max(200)).max(30),
  visible: z.boolean(),
  leadScanning: z.boolean(),
});

/** Makes sure an uploaded file belongs to this event's organization. */
function checkFile(fileId: number | null, orgId: number) {
  if (!fileId) return;
  const f = getDb().select().from(schema.files).where(eq(schema.files.id, fileId)).get();
  if (!f || f.orgId !== orgId) throw new TRPCError({ code: "BAD_REQUEST", message: "That file cannot be used." });
}

const adminRouter = router({
  list: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "vendors", "view");
    const db = getDb();
    const rows = db.select().from(schema.vendors).where(eq(schema.vendors.eventId, input.eventId)).all();
    const counts = leadCounts(rows.map((r) => r.id));
    const files = new Map(
      rows.some((r) => r.contractFileId)
        ? db
            .select()
            .from(schema.files)
            .where(inArray(schema.files.id, rows.map((r) => r.contractFileId ?? 0)))
            .all()
            .map((f) => [f.id, f])
        : []
    );
    const maps = db.select().from(schema.floorMaps).where(eq(schema.floorMaps.eventId, input.eventId)).all();
    const booths = new Set(maps.flatMap((m) => m.pins.filter((p) => p.kind === "booth").map((p) => p.label.replace(/^booth\s*/i, "").trim())));
    const taken = new Set(rows.filter((r) => r.status !== "cancelled" && r.booth).map((r) => r.booth));
    const active = rows.filter((r) => r.status !== "cancelled");
    return {
      vendors: rows
        .sort((a, b) => a.company.localeCompare(b.company))
        .map((v) => {
          const contract = v.contractFileId ? files.get(v.contractFileId) : undefined;
          return {
            ...v,
            leads: counts.get(v.id) ?? 0,
            logoUrl: fileUrl(v.logoFileId),
            contractUrl: fileUrl(v.contractFileId),
            contractName: contract?.name ?? "",
            contractAt: contract?.createdAt ?? null,
            staffNames: staffNames(v),
            benefits: v.benefits.map((b) => ({ label: b.label, status: b.status ?? (b.done ? "done" : "not_started") })),
          };
        }),
      stats: {
        vendors: active.length,
        boothsOpen: Array.from(booths).filter((b) => !taken.has(b)).length,
        balanceDue: active.filter((v) => v.amountCents > v.paidCents).length,
        leads: Array.from(counts.values()).reduce((a, b) => a + b, 0),
      },
      openBooths: Array.from(booths).filter((b) => !taken.has(b)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    };
  }),

  create: protectedProcedure
    .input(z.object({ eventId: id, company: z.string().trim().min(1).max(160), kind: z.enum(["exhibitor", "sponsor", "both"]).default("exhibitor"), contactName: z.string().trim().max(120).default(""), email: z.string().trim().max(200).default("") }))
    .mutation(({ ctx, input }) => {
      requireArea(ctx.user, input.eventId, "vendors", "edit");
      const v = getDb().insert(schema.vendors).values(input).returning().get();
      audit(ctx.user, { eventId: input.eventId, action: "vendor.create", detail: v.company });
      return v;
    }),

  update: protectedProcedure.input(vendorFields.extend({ eventId: id, vendorId: id })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = vendorIn(input.eventId, input.vendorId);
    checkFile(input.logoFileId, event.orgId);
    checkFile(input.contractFileId, event.orgId);
    const { eventId: _e, vendorId: _v, benefits, boothStaff, email, ...rest } = input;
    const db = getDb();
    db.update(schema.vendors)
      .set({
        ...rest,
        email: email.toLowerCase(),
        benefits: benefits.map((b) => ({ label: b.label, status: b.status, done: b.status === "done" })),
        boothStaff: Array.from(new Set(boothStaff.map((e) => e.toLowerCase()))),
      })
      .where(eq(schema.vendors.id, v.id))
      .run();
    syncBoothStaff(db.select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!);
    audit(ctx.user, { eventId: input.eventId, action: "vendor.update", detail: input.company });
    return { ok: true };
  }),

  remove: protectedProcedure.input(z.object({ eventId: id, vendorId: id })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = vendorIn(input.eventId, input.vendorId);
    const db = getDb();
    db.delete(schema.staffAssignments).where(eq(schema.staffAssignments.vendorId, v.id)).run();
    db.delete(schema.vendors).where(eq(schema.vendors.id, v.id)).run();
    audit(ctx.user, { eventId: input.eventId, action: "vendor.delete", detail: v.company });
    return { ok: true };
  }),

  /** Emails the vendor contact what they owe. */
  sendInvoice: protectedProcedure.input(z.object({ eventId: id, vendorId: id })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = vendorIn(input.eventId, input.vendorId);
    if (!v.email) throw new TRPCError({ code: "BAD_REQUEST", message: "Add the vendor's email first." });
    const due = v.amountCents - v.paidCents;
    if (due <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing is due." });
    const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, event.orgId)).get()!;
    const lines = [
      `Package: ${v.level || (isSponsor(v) ? "Sponsorship" : "Exhibitor booth")}`,
      `Price: ${fmtMoney(v.amountCents, "$0.00")}`,
      `Paid so far: ${fmtMoney(v.paidCents, "$0.00")}`,
      `Balance due: ${fmtMoney(due)}`,
    ];
    await sendEmail({
      to: v.email,
      fromName: `${event.shortName || event.name} Team`,
      subject: `${event.shortName || event.name}: balance due for ${v.company}`,
      text: `Hello${v.contactName ? ` ${v.contactName}` : ""},\n\nHere is the balance for ${v.company} at ${event.name}.\n\n${lines.join("\n")}\n\nReply to this email with any questions.\n\n${org.name}`,
      html: emailLayout({
        brand: event.branding.colorPrimary,
        accent: event.branding.colorAccent,
        title: "Balance due",
        blocks: [`<p>Hello${v.contactName ? ` ${escapeHtml(v.contactName)}` : ""},</p>`, `<p>Here is the balance for ${escapeHtml(v.company)} at ${escapeHtml(event.name)}.</p>`, `<p>${lines.map(escapeHtml).join("<br>")}</p>`, `<p>Reply to this email with any questions.</p>`],
        footer: escapeHtml(org.name),
      }),
    });
    audit(ctx.user, { eventId: input.eventId, action: "vendor.invoice", detail: v.company });
    return { ok: true };
  }),
});

export const exhibitorsRouter = router({
  /** Sponsors (by level) and exhibitors attendees can browse. */
  list: protectedProcedure.input(z.object({ slug })).query(({ ctx, input }) => {
    const { event } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "exhibitors", "Exhibitors");
    const rows = getDb()
      .select()
      .from(schema.vendors)
      .where(and(eq(schema.vendors.eventId, event.id), eq(schema.vendors.visible, true)))
      .all()
      .filter((v) => LISTED.has(v.status));
    return directoryOrder(rows).map(publicVendor);
  }),

  get: protectedProcedure.input(z.object({ slug, vendorId: id })).query(({ ctx, input }) => {
    const { event } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "exhibitors", "Exhibitors");
    const v = vendorIn(event.id, input.vendorId);
    if (!v.visible || !LISTED.has(v.status)) throw notFound("That exhibitor");
    return publicVendor(v);
  }),

  /** Message an exhibitor: opens a conversation with their contact (or first booth staff member). */
  message: protectedProcedure.input(z.object({ slug, vendorId: id })).mutation(({ ctx, input }) => {
    const { event, me } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "messaging", "Messaging");
    const v = vendorIn(event.id, input.vendorId);
    if (!v.visible || !LISTED.has(v.status)) throw notFound("That exhibitor");
    const people = vendorPeople(v).filter((p) => p.visible && p.id !== me.id && !isBlocked(me.id, p.id));
    const contact = people.find((p) => p.email === v.email.toLowerCase()) ?? people[0];
    if (!contact) throw new TRPCError({ code: "BAD_REQUEST", message: "This exhibitor is not taking messages yet." });
    return { threadId: startThread(event.id, me.id, contact.id) };
  }),
});

export const vendorsRouter = adminRouter;
