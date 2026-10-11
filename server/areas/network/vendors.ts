/** Exhibitors and sponsors: the attendee directory and the admin Vendors screen (area "vendors"). */
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, getEventBySlug, notFound, requireArea } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { userForEmail } from "../../core/auth";
import { fmtDate, fmtMoney, fullName } from "@shared/format";
import type { LogoSpots, VendorBenefit } from "../../../drizzle/schema";
import { attendeeCtx, csvCell, id, isBlocked, requireFeature, slug } from "./common";
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

type Pkg = typeof schema.vendorPackages.$inferSelect;
type VendorPayment = typeof schema.vendorPayments.$inferSelect;
type Agreement = typeof schema.agreements.$inferSelect;

const NO_SPOTS: LogoSpots = { welcome: false, topOfList: false, sessionPages: false };

export function eventPackages(eventId: number) {
  return getDb()
    .select()
    .from(schema.vendorPackages)
    .where(eq(schema.vendorPackages.eventId, eventId))
    .all()
    .sort((a, b) => a.sort - b.sort || a.id - b.id);
}

/** Admin list order: by package order (no package last), then the biggest amount, then name. */
function packageOrder(list: Vendor[], packages: Map<number, Pkg>) {
  const rank = (v: Vendor) => (v.packageId && packages.has(v.packageId) ? packages.get(v.packageId)!.sort : Number.MAX_SAFE_INTEGER);
  return list.sort((a, b) => rank(a) - rank(b) || b.amountCents - a.amountCents || a.company.localeCompare(b.company));
}

/** Sponsors first (by package order, then biggest amounts), then exhibitors by name. */
function directoryOrder(list: Vendor[], packages: Map<number, Pkg>) {
  const rank = (v: Vendor) => (v.packageId && packages.has(v.packageId) ? packages.get(v.packageId)!.sort : Number.MAX_SAFE_INTEGER);
  return [...list].sort((a, b) => Number(isSponsor(b)) - Number(isSponsor(a)) || (isSponsor(a) ? rank(a) - rank(b) : 0) || b.amountCents - a.amountCents || a.company.localeCompare(b.company));
}

function publicVendor(v: Vendor, packages: Map<number, Pkg>) {
  const pkg = v.packageId ? packages.get(v.packageId) : undefined;
  return {
    id: v.id,
    company: v.company,
    kind: v.kind,
    sponsor: isSponsor(v),
    level: pkg?.name || v.level,
    /** Where the package puts the logo in the app. */
    logoSpots: pkg?.logoSpots ?? NO_SPOTS,
    booth: v.booth,
    category: v.category,
    description: v.description,
    website: v.website,
    offer: v.offer,
    logoUrl: fileUrl(v.logoFileId),
    canMessage: vendorPeople(v).some((p) => p.visible),
  };
}


/* ---------- Sponsors and exhibitors: money, status, passes ---------- */

/** "2026-10-10" plus n business days (bank payments clear in about five). */
export function businessDaysAfter(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const t = new Date(Date.UTC(y, m - 1, d));
  let left = n;
  while (left > 0) {
    t.setUTCDate(t.getUTCDate() + 1);
    const dow = t.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return t.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Paid, still clearing, and owed. Vendors from before payments were tracked use paidCents. */
export function vendorMoney(v: Vendor, payments: VendorPayment[]) {
  const paidCents = payments.length ? payments.filter((p) => p.status === "paid").reduce((n, p) => n + p.amountCents, 0) : v.paidCents;
  const pendingCents = payments.filter((p) => p.status === "pending").reduce((n, p) => n + p.amountCents, 0);
  return { paidCents, pendingCents, owedCents: Math.max(0, v.amountCents - paidCents - pendingCents) };
}

/** The agreement that counts for a vendor: the signed one, else the latest sent. */
export function currentAgreement(list: Agreement[]) {
  const live = list.filter((a) => a.status !== "void" && a.status !== "draft").sort((a, b) => b.id - a.id);
  return live.find((a) => a.status === "signed") ?? live[0];
}

export type VendorStatus = { label: string; tone: "green" | "orange" | "gray" | "red"; note: string };

/** The status shown on the list, worked out from payments, the agreement and the invoice hold. */
export function vendorStatus(v: Vendor, payments: VendorPayment[], agreements: Agreement[]): VendorStatus {
  const m = vendorMoney(v, payments);
  const owed = m.paidCents < v.amountCents;
  if (v.status === "cancelled") return { label: "Cancelled", tone: "red", note: "" };
  const agr = currentAgreement(agreements);
  if (agr && agr.status === "sent") return { label: "Not signed", tone: "orange", note: "Agreement sent, not signed yet" };
  const pending = payments.filter((p) => p.status === "pending");
  if (pending.length) {
    const clears = pending.map((p) => businessDaysAfter(p.paidOn || new Date().toISOString().slice(0, 10), 5)).sort().at(-1)!;
    return { label: "Payment pending", tone: "orange", note: `bank deposit clears about ${fmtDate(clears)}` };
  }
  if (!owed) return { label: "Paid", tone: "green", note: "" };
  if (v.holdUntil) return { label: "Invoice sent", tone: "orange", note: `held until ${fmtDate(v.holdUntil)}` };
  if (m.paidCents > 0 && v.nextChargeCents > 0 && v.nextChargeOn) return { label: "Deposit paid", tone: "green", note: `rest charged ${fmtDate(v.nextChargeOn)}` };
  return { label: "Owed", tone: "orange", note: "" };
}

/** Passes a vendor has: the package's plus add-ons that add a pass. */
export function passTotal(v: Vendor, pkg: Pkg | undefined, addons: Map<number, { addsPass: boolean }>) {
  return (pkg?.passes ?? 0) + v.addons.reduce((n, l) => n + (addons.get(l.addonId)?.addsPass ? l.qty : 0), 0);
}

/** Pass holders: attendees linked to the vendor whose registration is not cancelled. */
export function passHolders(eventId: number) {
  return getDb()
    .select()
    .from(schema.attendees)
    .where(eq(schema.attendees.eventId, eventId))
    .all()
    .filter((a) => a.vendorId && a.status !== "cancelled");
}

/** Every vendor with its package and pass counts (the Add attendee sheet uses it too). */
export function vendorPassSummary(eventId: number) {
  const db = getDb();
  const vendors = db.select().from(schema.vendors).where(eq(schema.vendors.eventId, eventId)).all().filter((v) => v.status !== "cancelled");
  const packages = new Map(eventPackages(eventId).map((p) => [p.id, p]));
  const addons = new Map(db.select().from(schema.vendorAddons).where(eq(schema.vendorAddons.eventId, eventId)).all().map((a) => [a.id, a]));
  const holders = passHolders(eventId);
  return vendors
    .sort((a, b) => a.company.localeCompare(b.company))
    .map((v) => {
      const pkg = v.packageId ? packages.get(v.packageId) : undefined;
      return { id: v.id, company: v.company, kind: v.kind, packageName: pkg?.name || v.level, passTicketTypeId: pkg?.passTicketTypeId ?? null, passesTotal: passTotal(v, pkg, addons), passesUsed: holders.filter((a) => a.vendorId === v.id).length };
    });
}

/** Benefits for a package, keeping the done state of ones the vendor already had. */
export function benefitsFor(pkg: Pkg, current: VendorBenefit[]): VendorBenefit[] {
  return pkg.benefits.map((label) => {
    const had = current.find((b) => b.label.toLowerCase() === label.toLowerCase());
    const status = had?.status ?? (had?.done ? "done" : "not_started");
    return { label, status, done: status === "done" };
  });
}

/** What the listing in the app shows ("Logo, about, website, booth offer"). */
function appSummary(v: Vendor) {
  if (!v.visible) return "Hidden from the app";
  const parts = [v.logoFileId ? "logo" : "", v.description ? "about" : "", v.website ? "website" : "", v.offer ? "booth offer" : ""].filter(Boolean);
  if (!parts.length) return "Name only";
  const s = parts.join(", ");
  return s[0].toUpperCase() + s.slice(1);
}

const METHOD_LABEL: Record<VendorPayment["method"], string> = { card: "Card", bank: "Bank account", check: "Check", cash: "Cash", invoice: "Invoice", other: "Other" };
const PURPOSE_LABEL: Record<VendorPayment["purpose"], string> = { deposit: "deposit", balance: "balance", full: "payment", manual: "payment" };

/** One payment line as the Payments section shows it. */
function paymentLine(p: VendorPayment, names: Map<number, string>, label: string) {
  const how =
    p.method === "card" || p.method === "bank" ? p.reference || label || METHOD_LABEL[p.method]
    : p.reference ? `${METHOD_LABEL[p.method]} ${p.reference}`
    : METHOD_LABEL[p.method];
  const by = p.recordedBy ? names.get(p.recordedBy) : "";
  const state =
    p.status === "pending" ? `Pending, clears about ${fmtDate(businessDaysAfter(p.paidOn || new Date().toISOString().slice(0, 10), 5))}`
    : p.status === "failed" ? `Failed${p.failureReason ? `: ${p.failureReason}` : ""}`
    : p.status === "refunded" ? "Refunded"
    : by ? `Recorded by ${by}` : "";
  return {
    id: p.id,
    amountCents: p.amountCents,
    status: p.status,
    method: p.method,
    title: `${fmtMoney(p.amountCents, "$0.00")} ${PURPOSE_LABEL[p.purpose]}`,
    detail: [how, fmtDate(p.paidOn), state, p.note].filter(Boolean).join(" · "),
    /** Payments made through Stripe stay; staff can remove the ones they recorded. */
    removable: !p.stripePaymentIntentId && !p.stripeSessionId,
  };
}

/** Everything the Sponsors and exhibitors page shows for each vendor. */
function adminVendorRows(eventId: number, rows: Vendor[]) {
  const db = getDb();
  const ids = rows.map((r) => r.id);
  const packages = new Map(eventPackages(eventId).map((p) => [p.id, p]));
  const addons = new Map(db.select().from(schema.vendorAddons).where(eq(schema.vendorAddons.eventId, eventId)).all().map((a) => [a.id, a]));
  const payments = ids.length ? db.select().from(schema.vendorPayments).where(inArray(schema.vendorPayments.vendorId, ids)).all() : [];
  const agreements = ids.length ? db.select().from(schema.agreements).where(inArray(schema.agreements.vendorId, ids)).all() : [];
  const templates = new Map(db.select().from(schema.agreementTemplates).where(eq(schema.agreementTemplates.eventId, eventId)).all().map((t) => [t.id, t.name]));
  const holders = passHolders(eventId);
  const userIds = Array.from(new Set(payments.map((p) => p.recordedBy).filter((x): x is number => !!x)));
  const names = new Map(userIds.length ? db.select().from(schema.users).where(inArray(schema.users.id, userIds)).all().map((u) => [u.id, u.name || u.email]) : []);
  return rows.map((v) => {
    const mine = payments.filter((p) => p.vendorId === v.id).sort((a, b) => (a.paidOn || "").localeCompare(b.paidOn || "") || a.id - b.id);
    const agrs = agreements.filter((a) => a.vendorId === v.id);
    const agr = currentAgreement(agrs);
    const pkg = v.packageId ? packages.get(v.packageId) : undefined;
    const people = holders.filter((a) => a.vendorId === v.id);
    const money = vendorMoney(v, mine);
    const status = vendorStatus(v, mine, agrs);
    const remindOn = v.nextChargeReminderAt ? new Date(v.nextChargeReminderAt).toISOString().slice(0, 10) : v.nextChargeOn ? addDays(v.nextChargeOn, -7) : null;
    return {
      packageName: pkg?.name ?? "",
      packageKind: pkg?.kind ?? null,
      ...money,
      statusLabel: status.label,
      statusTone: status.tone,
      statusNote: status.note,
      agreement: agr
        ? { code: agr.code, status: agr.status, signerName: agr.signerName, signedAt: agr.signedAt, templateName: (agr.templateId ? templates.get(agr.templateId) : "") || agr.title || "Agreement" }
        : null,
      payments: mine.map((p) => paymentLine(p, names, v.payMethodLabel)),
      nextChargeRemindOn: remindOn,
      passesTotal: passTotal(v, pkg, addons),
      passesUsed: people.length,
      passPeople: people.sort((a, b) => a.id - b.id).map((a) => ({ id: a.id, name: fullName(a), email: a.email, checkedIn: !!a.checkedInAt })),
      appSummary: appSummary(v),
    };
  });
}

/** The thin number strip for a set of vendors. */
function stripFor(list: { status: Vendor["status"]; amountCents: number; paidCents: number; pendingCents: number; owedCents: number; passesTotal: number; passesUsed: number }[]) {
  const live = list.filter((v) => v.status !== "cancelled");
  const sum = (f: (v: (typeof live)[number]) => number) => live.reduce((n, v) => n + f(v), 0);
  return { soldCents: sum((v) => v.amountCents), paidCents: sum((v) => v.paidCents + v.pendingCents), owedCents: sum((v) => v.owedCents), passesUsed: sum((v) => v.passesUsed), passesTotal: sum((v) => v.passesTotal) };
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
    packageOrder(rows, new Map(eventPackages(input.eventId).map((p) => [p.id, p])));
    const extra = adminVendorRows(input.eventId, rows);
    const vendors = rows.map((v, i) => {
          const contract = v.contractFileId ? files.get(v.contractFileId) : undefined;
          return {
            ...v,
            ...extra[i],
            leads: counts.get(v.id) ?? 0,
            logoUrl: fileUrl(v.logoFileId),
            contractUrl: fileUrl(v.contractFileId),
            contractName: contract?.name ?? "",
            contractAt: contract?.createdAt ?? null,
            staffNames: staffNames(v),
            benefits: v.benefits.map((b) => ({ label: b.label, status: b.status ?? (b.done ? "done" : "not_started") })),
          };
        });
    const packages = eventPackages(input.eventId);
    const sold = (pid: number) => rows.filter((r) => r.packageId === pid && r.status !== "cancelled").length;
    return {
      vendors,
      packages: packages.map((p) => ({ ...p, sold: sold(p.id) })),
      counts: {
        addons: db.select({ id: schema.vendorAddons.id }).from(schema.vendorAddons).where(eq(schema.vendorAddons.eventId, input.eventId)).all().length,
        agreements: db.select({ id: schema.agreementTemplates.id }).from(schema.agreementTemplates).where(eq(schema.agreementTemplates.eventId, input.eventId)).all().length,
      },
      strips: {
        sponsors: stripFor(vendors.filter((v) => v.kind !== "exhibitor")),
        exhibitors: stripFor(vendors.filter((v) => v.kind !== "sponsor")),
      },
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
    .input(
      z.object({
        eventId: id,
        company: z.string().trim().min(1).max(160),
        kind: z.enum(["exhibitor", "sponsor", "both"]).default("exhibitor"),
        contactName: z.string().trim().max(120).default(""),
        email: z.string().trim().max(200).default(""),
        status: z.enum(VENDOR_STATUSES).default("lead"),
        packageId: id.nullable().default(null),
      })
    )
    .mutation(({ ctx, input }) => {
      requireArea(ctx.user, input.eventId, "vendors", "edit");
      const { packageId, ...rest } = input;
      const pkg = packageId ? eventPackages(input.eventId).find((p) => p.id === packageId) : undefined;
      if (packageId && !pkg) throw notFound("That package");
      const fromPackage = pkg ? { packageId: pkg.id, level: pkg.name, amountCents: pkg.priceCents, benefits: benefitsFor(pkg, []) } : {};
      const v = getDb().insert(schema.vendors).values({ ...rest, email: rest.email.toLowerCase(), ...fromPackage }).returning().get();
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

  /** Sponsor details on the Sponsors and exhibitors page. Choosing a package fills the price, level and benefits. */
  saveDetails: protectedProcedure
    .input(
      z.object({
        eventId: id,
        vendorId: id,
        company: z.string().trim().min(1).max(160),
        kind: z.enum(["exhibitor", "sponsor", "both"]),
        packageId: id.nullable(),
        amountCents: z.number().int().min(0).max(100_000_000),
        booth: z.string().trim().max(20),
        contactName: z.string().trim().max(120),
        email: z.string().trim().max(200).refine((s) => !s || z.string().email().safeParse(s).success, "Enter a valid email."),
        phone: z.string().trim().max(40),
        active: z.boolean(),
        logoFileId: id.nullable(),
        description: z.string().trim().max(2000),
        website: z.string().trim().max(300),
        category: z.string().trim().max(80),
        offer: z.string().trim().max(300),
        notes: z.string().trim().max(4000),
        boothStaff: z.array(z.string().trim().email().max(200)).max(30),
        visible: z.boolean(),
        leadScanning: z.boolean(),
      })
    )
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
      const v = vendorIn(input.eventId, input.vendorId);
      checkFile(input.logoFileId, event.orgId);
      const db = getDb();
      const pkg = input.packageId ? eventPackages(input.eventId).find((p) => p.id === input.packageId) : undefined;
      if (input.packageId && !pkg) throw notFound("That package");
      const { eventId: _e, vendorId: _v, active, email, boothStaff, packageId, ...rest } = input;
      const changedPackage = packageId !== v.packageId;
      const status: Vendor["status"] = !active ? "cancelled" : v.status === "confirmed" || v.status === "paid" ? v.status : "confirmed";
      db.update(schema.vendors)
        .set({
          ...rest,
          email: email.toLowerCase(),
          status,
          packageId,
          boothStaff: Array.from(new Set(boothStaff.map((e) => e.toLowerCase()))),
          ...(pkg ? { level: pkg.name } : {}),
          ...(changedPackage && pkg ? { benefits: benefitsFor(pkg, v.benefits) } : {}),
        })
        .where(eq(schema.vendors.id, v.id))
        .run();
      syncBoothStaff(db.select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!);
      audit(ctx.user, { orgId: event.orgId, eventId: input.eventId, action: "vendor.update", detail: input.company });
      return { ok: true };
    }),

  /** The checkbox on a benefit: done or to do. */
  setBenefit: protectedProcedure.input(z.object({ eventId: id, vendorId: id, index: z.number().int().min(0).max(100), done: z.boolean() })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = vendorIn(input.eventId, input.vendorId);
    if (!v.benefits[input.index]) throw notFound("That benefit");
    const benefits = v.benefits.map((b, i) => (i === input.index ? { ...b, done: input.done, status: input.done ? ("done" as const) : ("not_started" as const) } : b));
    getDb().update(schema.vendors).set({ benefits }).where(eq(schema.vendors.id, v.id)).run();
    audit(ctx.user, { eventId: input.eventId, action: "vendor.benefit", detail: `${v.company}: ${v.benefits[input.index].label} ${input.done ? "done" : "to do"}` });
    return { ok: true };
  }),

  /** The Sponsors or Exhibitors tab as a CSV file. */
  exportCsv: protectedProcedure.input(z.object({ eventId: id, tab: z.enum(["sponsors", "exhibitors"]) })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "view");
    const rows = getDb()
      .select()
      .from(schema.vendors)
      .where(eq(schema.vendors.eventId, input.eventId))
      .all()
      .filter((v) => (input.tab === "sponsors" ? isSponsor(v) : v.kind !== "sponsor"))
      .sort((a, b) => a.company.localeCompare(b.company));
    const extra = adminVendorRows(input.eventId, rows);
    const head = ["Company", "Contact", "Email", "Phone", "Package", "Booth", "Price", "Paid", "Owed", "Passes used", "Passes", "Status"];
    const lines = rows.map((v, i) => {
      const x = extra[i];
      return [v.company, v.contactName, v.email, v.phone, x.packageName || v.level, v.booth, (v.amountCents / 100).toFixed(2), ((x.paidCents + x.pendingCents) / 100).toFixed(2), (x.owedCents / 100).toFixed(2), x.passesUsed, x.passesTotal, x.statusLabel];
    });
    return { filename: `${event.slug}-${input.tab}.csv`, csv: [head, ...lines].map((r) => r.map(csvCell).join(",")).join("\n") };
  }),

  remove: protectedProcedure.input(z.object({ eventId: id, vendorId: id })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = vendorIn(input.eventId, input.vendorId);
    const db = getDb();
    // Online payments and signed agreements are records the organization keeps: those are cancelled, not deleted.
    const paidOnline = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all().some((p) => p.stripePaymentIntentId || p.stripeSessionId);
    const signed = db.select().from(schema.agreements).where(eq(schema.agreements.vendorId, v.id)).all().some((a) => a.status === "signed");
    if (paidOnline || signed) {
      const word = v.kind === "exhibitor" ? "exhibitor" : "sponsor";
      throw new TRPCError({ code: "BAD_REQUEST", message: `This ${word} has ${paidOnline ? "online payments" : "a signed agreement"}, so it cannot be deleted. Set Status to Cancelled instead.` });
    }
    db.delete(schema.staffAssignments).where(eq(schema.staffAssignments.vendorId, v.id)).run();
    db.update(schema.attendees).set({ vendorId: null }).where(eq(schema.attendees.vendorId, v.id)).run();
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
        look: event.branding,
        eventName: event.name,
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
  /** Sign-in page (no sign-in needed): up to four sponsor names and logos, the ones picked for the welcome screen first. */
  welcomeSponsors: publicProcedure.input(z.object({ slug })).query(({ input }) => {
    const event = getEventBySlug(input.slug);
    if (event.status === "draft" || !event.features.exhibitors) return [];
    const packages = new Map(eventPackages(event.id).map((p) => [p.id, p]));
    const sponsors = directoryOrder(
      getDb().select().from(schema.vendors).where(and(eq(schema.vendors.eventId, event.id), eq(schema.vendors.visible, true))).all().filter((v) => LISTED.has(v.status) && isSponsor(v)),
      packages
    );
    const welcome = sponsors.filter((v) => (v.packageId ? packages.get(v.packageId)?.logoSpots : null)?.welcome);
    return (welcome.length ? welcome : sponsors).slice(0, 4).map((v) => ({ id: v.id, company: v.company, logoUrl: fileUrl(v.logoFileId) }));
  }),

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
    const packages = new Map(eventPackages(event.id).map((p) => [p.id, p]));
    return directoryOrder(rows, packages).map((v) => publicVendor(v, packages));
  }),

  get: protectedProcedure.input(z.object({ slug, vendorId: id })).query(({ ctx, input }) => {
    const { event } = attendeeCtx(ctx.user, input.slug);
    requireFeature(event, "exhibitors", "Exhibitors");
    const v = vendorIn(event.id, input.vendorId);
    if (!v.visible || !LISTED.has(v.status)) throw notFound("That exhibitor");
    return publicVendor(v, new Map(eventPackages(event.id).map((p) => [p.id, p])));
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
