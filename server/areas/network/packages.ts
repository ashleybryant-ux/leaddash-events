/**
 * Sponsorship packages, exhibitor add-ons, payments recorded by staff, the
 * next scheduled charge, and sponsor passes (area "vendors").
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, notFound, requireArea } from "../../_core/access";
import { fmtMoney } from "@shared/format";
import { id, isoDate } from "./common";
import { eventPackages, vendorIn, vendorMoney } from "./vendors";

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const cents = z.number().int().min(0).max(100_000_000);

function packageIn(eventId: number, packageId: number) {
  const p = getDb().select().from(schema.vendorPackages).where(eq(schema.vendorPackages.id, packageId)).get();
  if (!p || p.eventId !== eventId) throw notFound("That package");
  return p;
}

function addonIn(eventId: number, addonId: number) {
  const a = getDb().select().from(schema.vendorAddons).where(eq(schema.vendorAddons.id, addonId)).get();
  if (!a || a.eventId !== eventId) throw notFound("That add-on");
  return a;
}

function eventAddons(eventId: number) {
  return getDb()
    .select()
    .from(schema.vendorAddons)
    .where(eq(schema.vendorAddons.eventId, eventId))
    .all()
    .sort((a, b) => a.sort - b.sort || a.id - b.id);
}

/**
 * Keeps vendors.paidCents equal to the payments that went through, so reports
 * keep working. A vendor paid before payments were tracked gets one line for
 * that amount the first time a payment is recorded.
 */
export function syncPaid(vendorId: number) {
  const db = getDb();
  const rows = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, vendorId)).all();
  const paid = rows.filter((p) => p.status === "paid").reduce((n, p) => n + p.amountCents, 0);
  db.update(schema.vendors).set({ paidCents: paid }).where(eq(schema.vendors.id, vendorId)).run();
  return paid;
}

function keepEarlierPaid(v: typeof schema.vendors.$inferSelect) {
  const db = getDb();
  const any = db.select({ id: schema.vendorPayments.id }).from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).get();
  if (any || v.paidCents <= 0) return;
  db.insert(schema.vendorPayments)
    .values({ eventId: v.eventId, vendorId: v.id, amountCents: v.paidCents, method: "other", status: "paid", purpose: "manual", paidOn: new Date(v.createdAt).toISOString().slice(0, 10), note: "Paid before payments were tracked" })
    .run();
}

/**
 * After a payment is recorded: the scheduled charge only collects what is
 * still owed, and stops when nothing is.
 */
function trimNextCharge(vendorId: number) {
  const db = getDb();
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get()!;
  if (v.nextChargeCents <= 0) return;
  const rows = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, vendorId)).all();
  const owed = vendorMoney(v, rows).owedCents;
  if (owed <= 0) db.update(schema.vendors).set({ nextChargeCents: 0, nextChargeOn: null, nextChargeReminderAt: null }).where(eq(schema.vendors.id, v.id)).run();
  else if (owed < v.nextChargeCents) db.update(schema.vendors).set({ nextChargeCents: owed }).where(eq(schema.vendors.id, v.id)).run();
}

const packageFields = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["sponsor", "exhibitor"]),
  priceCents: cents,
  quantity: z.number().int().positive().max(100_000).nullable(),
  passes: z.number().int().min(0).max(500),
  passTicketTypeId: id.nullable(),
  includesBooth: z.boolean(),
  logoSpots: z.object({ welcome: z.boolean(), topOfList: z.boolean(), sessionPages: z.boolean() }),
  benefits: z.array(z.string().trim().min(1).max(160)).max(40),
});

const addonFields = z.object({
  name: z.string().trim().min(1).max(80),
  priceCents: cents,
  quantity: z.number().int().positive().max(100_000).nullable(),
  packageIds: z.array(id).max(100),
  addsPass: z.boolean(),
});

export const packagesRouter = router({
  /** Packages and add-ons with how many are sold, and the event's tickets for "Passes use ticket". */
  list: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "vendors", "view");
    const db = getDb();
    const vendors = db.select().from(schema.vendors).where(eq(schema.vendors.eventId, input.eventId)).all().filter((v) => v.status !== "cancelled");
    const packages = eventPackages(input.eventId).map((p) => ({ ...p, sold: vendors.filter((v) => v.packageId === p.id).length }));
    const addons = eventAddons(input.eventId).map((a) => ({ ...a, sold: vendors.reduce((n, v) => n + v.addons.filter((l) => l.addonId === a.id).reduce((m, l) => m + l.qty, 0), 0) }));
    const tickets = db
      .select({ id: schema.ticketTypes.id, name: schema.ticketTypes.name, priceCents: schema.ticketTypes.priceCents })
      .from(schema.ticketTypes)
      .where(eq(schema.ticketTypes.eventId, input.eventId))
      .orderBy(schema.ticketTypes.sort, schema.ticketTypes.id)
      .all();
    return {
      packages,
      addons,
      tickets,
      strip: { packages: packages.length, sold: packages.reduce((n, p) => n + p.sold, 0), forSale: packages.reduce((n, p) => n + (p.quantity ?? 0), 0), unlimited: packages.some((p) => p.quantity == null), valueSoldCents: vendors.filter((v) => v.packageId).reduce((n, v) => n + v.amountCents, 0) },
    };
  }),

  save: protectedProcedure.input(packageFields.extend({ eventId: id, packageId: id.optional() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const db = getDb();
    const { eventId, packageId, ...rest } = input;
    if (rest.passTicketTypeId) {
      const t = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, rest.passTicketTypeId)).get();
      if (!t || t.eventId !== eventId) throw bad("Pick a ticket for this event.");
    }
    if (packageId) {
      const p = packageIn(eventId, packageId);
      db.update(schema.vendorPackages).set(rest).where(eq(schema.vendorPackages.id, p.id)).run();
      audit(ctx.user, { orgId: event.orgId, eventId, action: "package.update", detail: rest.name });
      return { id: p.id };
    }
    const sort = eventPackages(eventId).reduce((n, p) => Math.max(n, p.sort), 0) + 1;
    const row = db.insert(schema.vendorPackages).values({ ...rest, eventId, sort }).returning().get();
    audit(ctx.user, { orgId: event.orgId, eventId, action: "package.create", detail: rest.name });
    return { id: row.id };
  }),

  remove: protectedProcedure.input(z.object({ eventId: id, packageId: id })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const db = getDb();
    const p = packageIn(input.eventId, input.packageId);
    const users = db.select().from(schema.vendors).where(and(eq(schema.vendors.eventId, input.eventId), eq(schema.vendors.packageId, p.id))).all();
    if (users.length) throw bad(`${users.length === 1 ? users[0].company : `${users.length} sponsors and exhibitors`} ${users.length === 1 ? "has" : "have"} this package. Move them to another package first.`);
    db.delete(schema.vendorPackages).where(eq(schema.vendorPackages.id, p.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: input.eventId, action: "package.delete", detail: p.name });
    return { ok: true };
  }),

  /** Moves a package one place up (the order sponsors show in the app). */
  moveUp: protectedProcedure.input(z.object({ eventId: id, packageId: id })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "vendors", "edit");
    packageIn(input.eventId, input.packageId);
    const list = eventPackages(input.eventId);
    const i = list.findIndex((p) => p.id === input.packageId);
    if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    const db = getDb();
    list.forEach((p, n) => db.update(schema.vendorPackages).set({ sort: n + 1 }).where(eq(schema.vendorPackages.id, p.id)).run());
    return { ok: true };
  }),

  saveAddon: protectedProcedure.input(addonFields.extend({ eventId: id, addonId: id.optional() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const db = getDb();
    const { eventId, addonId, ...rest } = input;
    const ids = new Set(eventPackages(eventId).map((p) => p.id));
    const values = { ...rest, packageIds: Array.from(new Set(rest.packageIds.filter((x) => ids.has(x)))) };
    if (addonId) {
      const a = addonIn(eventId, addonId);
      db.update(schema.vendorAddons).set(values).where(eq(schema.vendorAddons.id, a.id)).run();
      audit(ctx.user, { orgId: event.orgId, eventId, action: "addon.update", detail: rest.name });
      return { id: a.id };
    }
    const sort = eventAddons(eventId).reduce((n, a) => Math.max(n, a.sort), 0) + 1;
    const row = db.insert(schema.vendorAddons).values({ ...values, eventId, sort }).returning().get();
    audit(ctx.user, { orgId: event.orgId, eventId, action: "addon.create", detail: rest.name });
    return { id: row.id };
  }),

  removeAddon: protectedProcedure.input(z.object({ eventId: id, addonId: id })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const db = getDb();
    const a = addonIn(input.eventId, input.addonId);
    const users = db.select().from(schema.vendors).where(eq(schema.vendors.eventId, input.eventId)).all().filter((v) => v.addons.some((l) => l.addonId === a.id));
    if (users.length) throw bad(`${users.length === 1 ? users[0].company : `${users.length} exhibitors`} bought this add-on. It cannot be deleted.`);
    db.delete(schema.vendorAddons).where(eq(schema.vendorAddons.id, a.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: input.eventId, action: "addon.delete", detail: a.name });
    return { ok: true };
  }),

  /** A payment staff record by hand (check, cash, a card run elsewhere). */
  recordPayment: protectedProcedure
    .input(
      z.object({
        eventId: id,
        vendorId: id,
        amountCents: z.number().int().min(1).max(100_000_000),
        method: z.enum(["card", "bank", "check", "cash", "invoice", "other"]),
        paidOn: isoDate,
        note: z.string().trim().max(200).default(""),
      })
    )
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
      const v = vendorIn(input.eventId, input.vendorId);
      keepEarlierPaid(v);
      const isNumber = input.method === "check" || input.method === "invoice";
      getDb()
        .insert(schema.vendorPayments)
        .values({ eventId: v.eventId, vendorId: v.id, amountCents: input.amountCents, method: input.method, status: "paid", purpose: "manual", paidOn: input.paidOn, reference: isNumber ? input.note : "", note: isNumber ? "" : input.note, recordedBy: ctx.user.id })
        .run();
      syncPaid(v.id);
      trimNextCharge(v.id);
      audit(ctx.user, { orgId: event.orgId, eventId: input.eventId, action: "vendor.payment", detail: `${v.company}: ${fmtMoney(input.amountCents)} ${input.method}` });
      return { ok: true };
    }),

  /** Removes a payment staff recorded. Stripe payments stay (refund them in Stripe). */
  removePayment: protectedProcedure.input(z.object({ eventId: id, paymentId: id })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const db = getDb();
    const p = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.id, input.paymentId)).get();
    if (!p || p.eventId !== input.eventId) throw notFound("That payment");
    if (p.stripePaymentIntentId || p.stripeSessionId) throw bad("Payments made online cannot be removed here. Refund them in Stripe.");
    const v = vendorIn(input.eventId, p.vendorId);
    db.delete(schema.vendorPayments).where(eq(schema.vendorPayments.id, p.id)).run();
    syncPaid(v.id);
    audit(ctx.user, { orgId: event.orgId, eventId: input.eventId, action: "vendor.payment.remove", detail: `${v.company}: ${fmtMoney(p.amountCents)}` });
    return { ok: true };
  }),

  /** Moves the date the rest of a deposit is charged. */
  setNextChargeOn: protectedProcedure.input(z.object({ eventId: id, vendorId: id, date: isoDate })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = vendorIn(input.eventId, input.vendorId);
    if (v.nextChargeCents <= 0) throw bad("Nothing is scheduled to charge.");
    if (input.date < new Date().toISOString().slice(0, 10)) throw bad("Pick today or a later date.");
    getDb().update(schema.vendors).set({ nextChargeOn: input.date, nextChargeReminderAt: null, nextChargeError: "" }).where(eq(schema.vendors.id, v.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: input.eventId, action: "vendor.next_charge", detail: `${v.company}: ${input.date}` });
    return { ok: true };
  }),

  /** Takes a pass back: the person's registration is cancelled and no longer tied to the sponsor. */
  removePass: protectedProcedure.input(z.object({ eventId: id, attendeeId: id })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const db = getDb();
    const a = db.select().from(schema.attendees).where(eq(schema.attendees.id, input.attendeeId)).get();
    if (!a || a.eventId !== input.eventId || !a.vendorId) throw notFound("That pass");
    const v = vendorIn(input.eventId, a.vendorId);
    db.update(schema.attendees).set({ status: "cancelled", vendorId: null }).where(eq(schema.attendees.id, a.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: input.eventId, action: "vendor.pass.remove", detail: `${v.company}: ${a.firstName} ${a.lastName}` });
    return { ok: true };
  }),
});
