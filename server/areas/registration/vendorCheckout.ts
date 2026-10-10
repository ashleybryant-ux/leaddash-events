/**
 * The sponsor and exhibitor checkout pages (/r/:slug/sponsor, /r/:slug/exhibit):
 * their settings on the admin Checkout page tab, the four public steps
 * (Package or Booth, Company, Agreement, Payment), the confirmation page, the
 * vendor pay link, and the Stripe events that create the sponsor or exhibitor.
 *
 * Money moves exactly like tickets: a Stripe Checkout Session on the
 * organization's own connected account (direct charge). A deposit saves the
 * card or bank account (setup_future_usage off_session) so the rest is charged
 * automatically on the date the organization set (vendorCharges.ts).
 * Everything the buyer picks is checked again here; the page only shows it.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, inArray } from "drizzle-orm";
import { lookOf } from "@shared/brand";
import { fmtDate, fmtMoney } from "@shared/format";
import { protectedProcedure, publicProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, getEventBySlug, notFound, requireArea } from "../../_core/access";
import { ENV } from "../../_core/env";
import { fileUrl, saveFile } from "../../_core/files";
import { randomToken, safeEqual, sign } from "../../_core/crypto";
import { emailButton, emailLayout, escapeHtml, sendEmail, type EmailAttachment } from "../../_core/email";
import type { VendorBuyer, VendorCheckout, VendorCheckoutPage, VendorPackage } from "../../../drizzle/schema";
import { createAgreement, signAgreement, signedPdfAttachment, templateById } from "../agreements/sign";
import { fillAgreement, valuesForCheckout } from "../agreements/fill";
import { addDays, benefitsFor, eventPackages, passHolders, passTotal, syncBoothStaff, vendorIn, vendorMoney } from "../network/vendors";
import { syncPaid } from "../network/packages";
import { accountRow } from "./connect";
import { eventToday, newDoneToken } from "./logic";
import { platformFee, stripeConfigured, type Stripe } from "./stripe";
import { sendVendorWelcome } from "./recipientMessages";
import {
  boughtLabel,
  chargeBalance,
  handleVendorDispute,
  handleVendorPaymentIntent,
  methodLabel,
  orgNoticeTo,
  paymentFailedEmails,
  reasonWords,
  sendVendorPayEmail,
  summaryTable,
  vendorMailStyle,
  vendorPayLink,
  vstripe,
} from "./vendorCharges";

type Kind = "sponsor" | "exhibitor";
type EventRow = typeof schema.events.$inferSelect;
type Vendor = typeof schema.vendors.$inferSelect;
type PayOption = "full" | "deposit" | "invoice";

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const kindIn = z.enum(["sponsor", "exhibitor"]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.number().int().positive();
const slugIn = z.string().min(1).max(120);
const tokenIn = z.string().min(10).max(60);

/** The path segment for each kind: /r/:slug/sponsor and /r/:slug/exhibit. */
export const kindPath = (kind: Kind) => (kind === "sponsor" ? "sponsor" : "exhibit");
export const checkoutLink = (slug: string, kind: Kind) => `${ENV.appUrl}/r/${slug}/${kindPath(kind)}`;

/** Exhibitor categories offered on the page (plus any the event already uses). */
export const DEFAULT_CATEGORIES = ["Practice software", "Office and testing supplies", "Insurance and billing", "Education and training", "Health and wellness", "Recruiting and careers", "Professional organizations", "Other"];

/* ---------- Settings ---------- */

/** The settings row for a kind, created with sensible defaults on first read. */
export function vendorPageFor(eventId: number, kind: Kind): VendorCheckoutPage {
  const db = getDb();
  const find = () => db.select().from(schema.vendorCheckoutPages).where(and(eq(schema.vendorCheckoutPages.eventId, eventId), eq(schema.vendorCheckoutPages.kind, kind))).get();
  const row = find();
  if (row) return row;
  const ev = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get()!;
  db.insert(schema.vendorCheckoutPages)
    .values({ eventId, kind, title: kind === "sponsor" ? `Sponsor ${ev.name}` : `Exhibit at ${ev.name}`, payFull: true, methods: "both", depositPercent: 50, invoiceHoldDays: 14 })
    .onConflictDoNothing()
    .run();
  return find()!;
}

/** Why the page is not taking orders right now ("" when it is). */
function closedReason(ev: EventRow, page: VendorCheckoutPage, today: string) {
  if (ev.status === "ended" || ev.endDate < today) return "This event has ended.";
  if (!page.open) return "This page is not open yet.";
  if (page.closesOn && page.closesOn < today) return "This page is closed.";
  return "";
}

/** The pay choices the settings allow today (a deposit needs a later balance date). */
function payOptions(page: VendorCheckoutPage, today: string): PayOption[] {
  const out: PayOption[] = [];
  if (page.payFull) out.push("full");
  if (page.payDeposit && page.balanceDueOn && page.balanceDueOn > today) out.push("deposit");
  if (page.payInvoice) out.push("invoice");
  return out.length ? out : ["full"];
}

const PENDING_HOLD_MS = 60 * 60_000;

/** Checkouts waiting on Stripe from the last hour (they hold their package and add-ons). */
function heldCheckouts(eventId: number, exceptId?: number) {
  return getDb()
    .select()
    .from(schema.vendorCheckouts)
    .where(and(eq(schema.vendorCheckouts.eventId, eventId), eq(schema.vendorCheckouts.status, "pending"), gt(schema.vendorCheckouts.createdAt, new Date(Date.now() - PENDING_HOLD_MS))))
    .all()
    .filter((c) => c.id !== exceptId && !c.vendorId);
}

function liveVendors(eventId: number) {
  return getDb().select().from(schema.vendors).where(eq(schema.vendors.eventId, eventId)).all().filter((v) => v.status !== "cancelled");
}

/** What a package includes, as the lines on its card. */
export function packageIncludes(p: VendorPackage) {
  const lines: string[] = [];
  if (p.kind === "exhibitor" && p.description.trim()) lines.push(p.description.trim());
  if (p.passes > 0) lines.push(p.kind === "sponsor" ? `${p.passes} event pass${p.passes === 1 ? "" : "es"}` : `${p.passes} booth staff pass${p.passes === 1 ? "" : "es"}`);
  if (p.kind === "sponsor" && p.includesBooth) lines.push("Booth in the exhibit hall");
  if (p.logoSpots.welcome) lines.push("Logo on the app welcome screen");
  if (p.logoSpots.topOfList) lines.push("Logo at the top of the sponsors list");
  if (p.logoSpots.sessionPages) lines.push("Logo on the session page you sponsor");
  lines.push(...p.benefits);
  const seen = new Set<string>();
  return lines.filter((l) => {
    const k = l.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Packages on the page with how many are left (vendors plus checkouts waiting on Stripe). */
function packageOffers(eventId: number, kind: Kind, page: VendorCheckoutPage, exceptCheckoutId?: number) {
  const vendors = liveVendors(eventId);
  const held = heldCheckouts(eventId, exceptCheckoutId);
  return eventPackages(eventId)
    .filter((p) => p.kind === kind && p.active && (!page.packageIds.length || page.packageIds.includes(p.id)))
    .map((p) => {
      const sold = vendors.filter((v) => v.packageId === p.id).length + held.filter((c) => c.packageId === p.id).length;
      const left = p.quantity == null ? null : Math.max(0, p.quantity - sold);
      return { pkg: p, left, soldOut: left === 0 };
    });
}

/** Add-ons offered with a package and how many are left. */
function addonOffers(eventId: number, pkg: VendorPackage, exceptCheckoutId?: number) {
  const db = getDb();
  const vendors = liveVendors(eventId);
  const held = heldCheckouts(eventId, exceptCheckoutId);
  return db
    .select()
    .from(schema.vendorAddons)
    .where(eq(schema.vendorAddons.eventId, eventId))
    .all()
    .filter((a) => a.active && (a.packageIds.length ? a.packageIds.includes(pkg.id) : pkg.kind === "exhibitor"))
    .sort((a, b) => a.sort - b.sort || a.id - b.id)
    .map((a) => {
      const sold = vendors.reduce((n, v) => n + v.addons.filter((l) => l.addonId === a.id).reduce((m, l) => m + l.qty, 0), 0) + held.reduce((n, c) => n + c.buyer.addons.filter((l) => l.addonId === a.id).reduce((m, l) => m + l.qty, 0), 0);
      const left = a.quantity == null ? null : Math.max(0, a.quantity - sold);
      return { addon: a, left };
    });
}

/* ---------- Validation ---------- */

const personIn = z.object({ name: z.string().trim().max(120), email: z.string().trim().max(200) });
const buyerIn = z.object({
  company: z.string().trim().max(160),
  website: z.string().trim().max(300).default(""),
  firstName: z.string().trim().max(80),
  lastName: z.string().trim().max(80),
  email: z.string().trim().max(200),
  phone: z.string().trim().max(40).default(""),
  category: z.string().trim().max(80).default(""),
  about: z.string().trim().max(2000).default(""),
  offer: z.string().trim().max(300).default(""),
  boothRequest: z.string().trim().max(300).default(""),
  logoFileId: id.nullable().default(null),
  logoToken: z.string().max(80).default(""),
  people: z.array(personIn).max(60).default([]),
  addons: z.array(z.object({ addonId: id, qty: z.number().int().min(0).max(100) })).max(40).default([]),
});
type BuyerInput = z.infer<typeof buyerIn>;

const logoToken = (fileId: number) => sign(`vendor-logo:${fileId}`);
const emailOk = (s: string) => z.string().email().safeParse(s).success;

/** Checks the Company step and returns the buyer as stored on the checkout. */
function cleanBuyer(kind: Kind, b: BuyerInput, maxPeople: number): VendorBuyer {
  if (!b.company) throw bad("Enter the company name.");
  if (!b.firstName || !b.lastName) throw bad("Enter your first and last name.");
  if (!emailOk(b.email)) throw bad("Enter a valid email.");
  if (kind === "sponsor" && !b.phone) throw bad("Enter a mobile number.");
  if (kind === "exhibitor" && !b.category) throw bad("Choose a category.");
  if (b.logoFileId && !safeEqual(b.logoToken, logoToken(b.logoFileId))) throw bad("Upload the logo again.");
  const people = b.people.filter((p) => p.name || p.email);
  for (const p of people) {
    if (!p.name) throw bad(`Add a name for ${p.email}.`);
    if (!emailOk(p.email)) throw bad(`Enter a valid email for ${p.name}.`);
  }
  const emails = people.map((p) => p.email.toLowerCase());
  if (new Set(emails).size !== emails.length) throw bad("Each pass needs a different email.");
  if (people.length > maxPeople) throw bad(`This package includes ${maxPeople} pass${maxPeople === 1 ? "" : "es"}.`);
  return {
    company: b.company,
    website: b.website,
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email.toLowerCase(),
    phone: b.phone,
    category: kind === "exhibitor" ? b.category : "",
    about: b.about,
    offer: kind === "exhibitor" ? b.offer : "",
    boothRequest: kind === "exhibitor" ? b.boothRequest : "",
    logoFileId: b.logoFileId,
    people: people.map((p) => ({ name: p.name, email: p.email.toLowerCase() })),
    addons: b.addons.filter((a) => a.qty > 0),
  };
}

type Order = {
  page: VendorCheckoutPage;
  pkg: VendorPackage;
  buyer: VendorBuyer;
  lines: { label: string; cents: number }[];
  totalCents: number;
  dueTodayCents: number;
  payOption: PayOption;
  options: PayOption[];
};

/** Everything the server checks before a checkout is saved or paid. */
function validateOrder(ev: EventRow, kind: Kind, input: { packageId: number; buyer: BuyerInput | VendorBuyer; payOption: PayOption; strictOption?: boolean }, exceptCheckoutId?: number): Order {
  const page = vendorPageFor(ev.id, kind);
  const today = eventToday(ev);
  const closed = closedReason(ev, page, today);
  if (closed) throw bad(closed);
  const offer = packageOffers(ev.id, kind, page, exceptCheckoutId).find((o) => o.pkg.id === input.packageId);
  if (!offer) throw bad(kind === "sponsor" ? "That package is not on this page. Pick another one." : "That booth is not on this page. Pick another one.");
  if (offer.soldOut) throw bad(`${offer.pkg.name} is sold out.`);
  const pkg = offer.pkg;
  const offered = addonOffers(ev.id, pkg, exceptCheckoutId);
  const lines = [{ label: kind === "sponsor" ? `${pkg.name} sponsor` : pkg.name, cents: pkg.priceCents }];
  let extraPasses = 0;
  const wanted = new Map<number, number>();
  for (const a of input.buyer.addons) wanted.set(a.addonId, (wanted.get(a.addonId) ?? 0) + a.qty);
  for (const [addonId, qty] of wanted) {
    if (qty <= 0) continue;
    const o = offered.find((x) => x.addon.id === addonId);
    if (!o) throw bad("That add-on is not offered with this package.");
    if (o.left != null && qty > o.left) throw bad(o.left === 0 ? `${o.addon.name} is sold out.` : `Only ${o.left} ${o.addon.name.toLowerCase()} left.`);
    lines.push({ label: `${o.addon.name} x ${qty}`, cents: o.addon.priceCents * qty });
    if (o.addon.addsPass) extraPasses += qty;
  }
  const buyer = "logoToken" in input.buyer ? cleanBuyer(kind, input.buyer as BuyerInput, pkg.passes + extraPasses) : (input.buyer as VendorBuyer);
  const totalCents = lines.reduce((n, l) => n + l.cents, 0);
  const options = payOptions(page, today);
  let payOption = input.payOption;
  if (!options.includes(payOption)) {
    if (input.strictOption) throw bad("Choose how to pay.");
    payOption = options[0];
  }
  const dueTodayCents = totalCents === 0 || payOption === "invoice" ? 0 : payOption === "deposit" ? Math.round((totalCents * page.depositPercent) / 100) : totalCents;
  return { page, pkg, buyer, lines, totalCents, dueTodayCents, payOption, options };
}

/** The pending checkout behind a token, for this event and kind. */
function checkoutFor(ev: EventRow, kind: Kind, token: string) {
  const c = getDb().select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.doneToken, token)).get();
  if (!c || c.eventId !== ev.id || c.kind !== kind) throw notFound("That checkout");
  return c;
}

/**
 * Makes sure the checkout's agreement matches what is being bought now. A
 * change to the package, add-ons or how they pay voids the old one and makes
 * a new one to sign. Returns null when the page has no agreement.
 */
function syncAgreement(ev: EventRow, c: VendorCheckout) {
  const db = getDb();
  const page = vendorPageFor(ev.id, c.kind);
  const t = templateById(page.agreementTemplateId);
  if (!t || t.eventId !== ev.id || t.kind !== c.kind) return null;
  const values = valuesForCheckout(ev, t, c);
  const html = fillAgreement(t.body, values);
  const current = c.agreementId ? db.select().from(schema.agreements).where(eq(schema.agreements.id, c.agreementId)).get() : undefined;
  if (current && current.status !== "void" && current.html === html && current.signerEmail === c.buyer.email) return current;
  if (current && current.status !== "void") db.update(schema.agreements).set({ status: "void" }).where(eq(schema.agreements.id, current.id)).run();
  const a = createAgreement({ eventId: ev.id, templateId: t.id, kind: c.kind, checkoutId: c.id, signerEmail: c.buyer.email, values, welcomeAfterSign: false });
  db.update(schema.vendorCheckouts).set({ agreementId: a.id }).where(eq(schema.vendorCheckouts.id, c.id)).run();
  return a;
}

/* ---------- Public page data ---------- */

function publicInfo(ev: EventRow) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
  const cp = getDb().select().from(schema.checkoutPages).where(eq(schema.checkoutPages.eventId, ev.id)).get();
  return {
    id: ev.id,
    slug: ev.slug,
    name: ev.name,
    shortName: ev.shortName || ev.name,
    startDate: ev.startDate,
    endDate: ev.endDate,
    venueName: ev.venueName,
    city: ev.city,
    orgName: org.name,
    branding: { colorPrimary: ev.branding.colorPrimary, colorAccent: ev.branding.colorAccent, ...lookOf(ev.branding) },
    logoUrl: fileUrl(ev.branding.logoFileId ?? org.logoFileId),
    coverUrl: fileUrl(cp?.coverFileId ?? ev.branding.coverFileId),
  };
}

function paymentsFor(orgId: number) {
  const row = accountRow(orgId);
  const ready = !!row && row.chargesEnabled && stripeConfigured() && (!!ENV.stripePublishable || ENV.isTest);
  return { ready, publishableKey: ready ? ENV.stripePublishable : null, accountId: ready ? row!.accountId : null, businessName: row?.businessName ?? "" };
}

/** Whether the organization's Stripe account reports bank (ACH) payments as active. */
export function achActive(orgId: number) {
  const row = accountRow(orgId);
  return (row?.payMethods as Record<string, string> | undefined)?.ach === "active";
}

function eventCategories(eventId: number) {
  const used = liveVendors(eventId).map((v) => v.category.trim()).filter(Boolean);
  return Array.from(new Set([...DEFAULT_CATEGORIES.filter((c) => c !== "Other"), ...used, "Other"]));
}

/* ---------- Creating the sponsor or exhibitor ---------- */

const splitName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
};

/** Pass holders (sponsor) or booth staff (exhibitor) named at checkout, registered on the package's pass ticket. */
function addPassPeople(v: Vendor, people: { name: string; email: string }[]) {
  const db = getDb();
  const pkg = v.packageId ? db.select().from(schema.vendorPackages).where(eq(schema.vendorPackages.id, v.packageId)).get() : undefined;
  const addons = new Map(db.select().from(schema.vendorAddons).where(eq(schema.vendorAddons.eventId, v.eventId)).all().map((a) => [a.id, a]));
  const used = passHolders(v.eventId).filter((a) => a.vendorId === v.id).length;
  const open = Math.max(0, passTotal(v, pkg, addons) - used);
  const tickets = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, v.eventId)).orderBy(schema.ticketTypes.sort, schema.ticketTypes.id).all();
  const ticket = tickets.find((t) => t.id === pkg?.passTicketTypeId) ?? tickets.find((t) => t.active) ?? tickets[0];
  const kind = v.kind === "exhibitor" ? ("vendor" as const) : ("sponsor" as const);
  let added = 0;
  const emails: string[] = [];
  for (const p of people.slice(0, open)) {
    const email = p.email.trim().toLowerCase();
    if (!email) continue;
    const { firstName, lastName } = splitName(p.name);
    const existing = db.select().from(schema.attendees).where(and(eq(schema.attendees.eventId, v.eventId), eq(schema.attendees.email, email))).get();
    if (existing && existing.status === "registered") {
      if (!existing.vendorId) {
        db.update(schema.attendees).set({ vendorId: v.id, organization: existing.organization || v.company }).where(eq(schema.attendees.id, existing.id)).run();
        added++;
        emails.push(email);
      }
      continue;
    }
    const u = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
    const values = { firstName, lastName, organization: v.company, kind, vendorId: v.id, ticketTypeId: ticket?.id ?? null, status: "registered" as const };
    const row = existing
      ? db.update(schema.attendees).set(values).where(eq(schema.attendees.id, existing.id)).returning().get()
      : db.insert(schema.attendees).values({ ...values, eventId: v.eventId, email, qrToken: randomToken(12), userId: u?.id ?? null }).returning().get();
    if (ticket) {
      db.insert(schema.orders)
        .values({ eventId: v.eventId, attendeeId: row.id, email, ticketTypeId: ticket.id, subtotalCents: 0, amountCents: 0, status: "free", method: "sponsor_pass", paidAt: new Date(), buyer: { firstName, lastName, email } })
        .run();
    }
    added++;
    emails.push(email);
  }
  if (v.kind === "exhibitor" && emails.length) {
    const fresh = db.select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
    const staff = Array.from(new Set([...fresh.boothStaff, ...emails]));
    db.update(schema.vendors).set({ boothStaff: staff }).where(eq(schema.vendors.id, v.id)).run();
    syncBoothStaff({ ...fresh, boothStaff: staff });
  }
  return added;
}

/** Creates the sponsor or exhibitor from a checkout. */
function createVendor(c: VendorCheckout, extra: Partial<typeof schema.vendors.$inferInsert>) {
  const db = getDb();
  const pkg = db.select().from(schema.vendorPackages).where(eq(schema.vendorPackages.id, c.packageId)).get()!;
  const b = c.buyer;
  const ids = b.addons.map((a) => a.addonId);
  const addons = ids.length ? db.select().from(schema.vendorAddons).where(inArray(schema.vendorAddons.id, ids)).all() : [];
  const lines = b.addons.filter((a) => a.qty > 0).map((a) => {
    const x = addons.find((y) => y.id === a.addonId);
    return { addonId: a.addonId, name: x?.name ?? "Add-on", qty: a.qty, priceCents: x?.priceCents ?? 0 };
  });
  const v = db
    .insert(schema.vendors)
    .values({
      eventId: c.eventId,
      company: b.company,
      kind: c.kind,
      level: pkg.name,
      contactName: `${b.firstName} ${b.lastName}`.trim(),
      email: b.email,
      phone: b.phone,
      amountCents: c.totalCents,
      paidCents: 0,
      status: "confirmed",
      description: b.about,
      website: b.website,
      logoFileId: b.logoFileId,
      benefits: benefitsFor(pkg, []),
      offer: b.offer,
      category: b.category,
      notes: b.boothRequest ? `Booth request: ${b.boothRequest}` : "",
      packageId: pkg.id,
      addons: lines,
      source: "checkout",
      payToken: randomToken(18),
      ...extra,
    })
    .returning()
    .get();
  if (c.agreementId) db.update(schema.agreements).set({ vendorId: v.id }).where(eq(schema.agreements.id, c.agreementId)).run();
  addPassPeople(v, b.people);
  return db.select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
}

function signedAgreementOf(c: VendorCheckout) {
  if (!c.agreementId) return undefined;
  const a = getDb().select().from(schema.agreements).where(eq(schema.agreements.id, c.agreementId)).get();
  return a?.status === "signed" ? a : undefined;
}

async function pdfFor(c: VendorCheckout): Promise<EmailAttachment[]> {
  const a = signedAgreementOf(c);
  if (!a) return [];
  try {
    return [await signedPdfAttachment(a)];
  } catch (err) {
    console.error("[vendor checkout] agreement pdf:", err);
    return [];
  }
}

/** Whether the sponsor or exhibitor welcome email (recipientMessages.ts) already went to this vendor. */
function welcomeSent(vendorId: number) {
  return getDb()
    .select()
    .from(schema.recipientLog)
    .where(and(eq(schema.recipientLog.recipientType, "vendor"), eq(schema.recipientLog.recipientId, vendorId)))
    .all()
    .some((r) => r.status === "sent" && /welcome/.test(r.kind));
}

/** The buyer's receipt, and the notice to the organization. */
async function checkoutEmails(c: VendorCheckout, v: Vendor, paid: { cents: number; pending: boolean } | null) {
  const db = getDb();
  const ev = db.select().from(schema.events).where(eq(schema.events.id, c.eventId)).get()!;
  const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
  const style = vendorMailStyle(ev);
  const pdf = await pdfFor(c);
  const word = c.kind === "sponsor" ? "sponsor" : "exhibitor";
  const what = boughtLabel(v);
  if (paid) {
    const rest = c.totalCents - paid.cents;
    const rows: [string, string, boolean?][] = [[what, fmtMoney(v.amountCents - v.addons.reduce((n, l) => n + l.priceCents * l.qty, 0), "$0.00")], ...v.addons.map((l) => [`${l.name} x ${l.qty}`, fmtMoney(l.priceCents * l.qty, "$0.00")] as [string, string]), ["Total", fmtMoney(c.totalCents, "$0.00"), true], [paid.pending ? "Bank payment, clearing" : `Paid ${fmtDate(eventToday(ev))}`, fmtMoney(paid.cents, "$0.00")]];
    if (rest > 0 && v.nextChargeOn) rows.push([`Charged ${fmtDate(v.nextChargeOn)}`, fmtMoney(rest, "$0.00")]);
    const intro = paid.pending
      ? `Thank you for your ${word === "sponsor" ? "sponsorship" : "booth"} at ${ev.name}. Your bank payment of ${fmtMoney(paid.cents, "$0.00")} is on its way and takes up to 4 business days to clear.`
      : `Thank you for your ${word === "sponsor" ? "sponsorship" : "booth"} at ${ev.name}. Here is your receipt.`;
    const attach = welcomeSent(v.id) ? [] : pdf;
    const pkgRow = v.packageId ? db.select().from(schema.vendorPackages).where(eq(schema.vendorPackages.id, v.packageId)).get() : undefined;
    const addonRows = new Map(db.select().from(schema.vendorAddons).where(eq(schema.vendorAddons.eventId, v.eventId)).all().map((a) => [a.id, a]));
    const open = passTotal(v, pkgRow, addonRows) - passHolders(v.eventId).filter((a) => a.vendorId === v.id).length;
    const doneUrl = `${ENV.appUrl}/r/${ev.slug}/${kindPath(c.kind)}/done?c=${c.doneToken}`;
    const passLabel = c.kind === "sponsor" ? "Add pass names" : "Add booth staff";
    try {
      await sendEmail({
        to: c.buyer.email,
        fromName: style.fromName,
        replyTo: orgNoticeTo(ev, c.kind)[0] || undefined,
        subject: `${style.fromName}: receipt for ${v.company}`,
        text: [`Hi ${c.buyer.firstName},`, intro, ...rows.map(([l, val]) => `${l}: ${val}`), open > 0 ? `${passLabel}: ${doneUrl}` : "", org.name].filter(Boolean).join("\n\n"),
        html: emailLayout({ ...style, title: "Your receipt", blocks: [`<p>Hi ${escapeHtml(c.buyer.firstName)},</p>`, `<p>${escapeHtml(intro)}</p>`, summaryTable(rows), open > 0 ? emailButton(passLabel, doneUrl, ev.branding) : "", attach.length ? `<p style="font-size:13px;color:#4B5B57">Your signed ${word} agreement is attached.</p>` : ""], footer: escapeHtml(org.name) }),
        attachments: attach.length ? attach : undefined,
      });
    } catch (err) {
      console.error("[vendor checkout] receipt:", err);
    }
  }
  const how = !paid ? `chose to pay by invoice (held until ${fmtDate(v.holdUntil)})` : paid.pending ? `paid ${fmtMoney(paid.cents, "$0.00")} by bank account (clearing)` : `paid ${fmtMoney(paid.cents, "$0.00")}`;
  const restLine = paid && c.totalCents > paid.cents && v.nextChargeOn ? ` The other ${fmtMoney(c.totalCents - paid.cents, "$0.00")} is charged ${fmtDate(v.nextChargeOn)}.` : "";
  const text = `${v.company} (${v.contactName}, ${v.email}) bought ${what} for ${fmtMoney(c.totalCents, "$0.00")} on the ${word} checkout page and ${how}.${restLine}`;
  const adminUrl = `${ENV.appUrl}/admin/e/${ev.id}/vendors`;
  for (const to of orgNoticeTo(ev, c.kind)) {
    try {
      await sendEmail({
        to,
        fromName: style.fromName,
        subject: `${style.fromName}: new ${word}, ${v.company}`,
        text: [text, `Open ${word}s: ${adminUrl}`].join("\n\n"),
        html: emailLayout({ ...style, title: `New ${word}`, blocks: [`<p>${escapeHtml(text)}</p>`, emailButton(`Open ${word}s`, adminUrl, ev.branding)], footer: escapeHtml(org.name) }),
        attachments: pdf.length ? pdf : undefined,
      });
    } catch (err) {
      console.error("[vendor checkout] notice:", err);
    }
  }
}

/**
 * A finished Stripe Checkout Session: creates the vendor, the passes and the
 * payment (paid, or pending while a bank payment clears), saves the payment
 * method for the rest of a deposit, and sends the emails. Safe to call more
 * than once (Stripe retries; the confirmation page also calls it).
 */
export async function completeCheckout(checkoutId: number, s: Pick<Stripe.Checkout.Session, "id" | "payment_status" | "payment_intent" | "customer"> & { amount_total?: number | null }) {
  const db = getDb();
  const c = db.select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.id, checkoutId)).get();
  if (!c) return null;
  const won = db.update(schema.vendorCheckouts).set({ status: "paid" }).where(and(eq(schema.vendorCheckouts.id, c.id), inArray(schema.vendorCheckouts.status, ["started", "pending", "expired"]))).run().changes === 1;
  if (!won) return db.select().from(schema.vendors).where(eq(schema.vendors.id, c.vendorId ?? 0)).get() ?? null;
  const piId = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null;
  const customer = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
  let pm: Stripe.PaymentMethod | null = null;
  if (piId && c.stripeAccountId) {
    try {
      const pi = await vstripe().paymentIntents.retrieve(piId, { expand: ["payment_method"] }, { stripeAccount: c.stripeAccountId });
      pm = typeof pi.payment_method === "object" ? pi.payment_method : null;
    } catch (err) {
      console.error("[vendor checkout] payment method lookup:", err);
    }
  }
  const m = methodLabel(pm);
  const paidNow = s.payment_status === "paid";
  const ev = db.select().from(schema.events).where(eq(schema.events.id, c.eventId)).get()!;
  const page = vendorPageFor(c.eventId, c.kind);
  // What Stripe actually charged is what counts (the session is the record of the amount).
  const charged = typeof s.amount_total === "number" ? s.amount_total : c.dueTodayCents;
  const deposit = c.payOption === "deposit" && c.totalCents > charged;
  const v = createVendor(c, {
    stripeCustomerId: customer,
    stripePaymentMethodId: pm?.id ?? null,
    payMethodLabel: m.label,
    ...(deposit ? { nextChargeCents: c.totalCents - charged, nextChargeOn: page.balanceDueOn ?? addDays(eventToday(ev), 30) } : {}),
  });
  db.insert(schema.vendorPayments)
    .values({ eventId: c.eventId, vendorId: v.id, amountCents: charged, method: m.method, status: paidNow ? "paid" : "pending", purpose: deposit ? "deposit" : "full", paidOn: eventToday(ev), reference: m.label, stripeAccountId: c.stripeAccountId, stripeSessionId: s.id, stripePaymentIntentId: piId })
    .run();
  syncPaid(v.id);
  db.update(schema.vendorCheckouts).set({ vendorId: v.id }).where(eq(schema.vendorCheckouts.id, c.id)).run();
  try {
    await sendVendorWelcome(v.id);
  } catch (err) {
    console.error("[vendor checkout] welcome:", err);
  }
  await checkoutEmails(c, db.select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!, { cents: charged, pending: !paidNow });
  return db.select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
}

/** The invoice choice (and free packages): the vendor is created now and the package is held. */
async function completeWithoutPayment(c: VendorCheckout) {
  const db = getDb();
  const won = db.update(schema.vendorCheckouts).set({ status: "invoice" }).where(and(eq(schema.vendorCheckouts.id, c.id), eq(schema.vendorCheckouts.status, "started"))).run().changes === 1;
  if (!won) return null;
  const ev = db.select().from(schema.events).where(eq(schema.events.id, c.eventId)).get()!;
  const page = vendorPageFor(c.eventId, c.kind);
  const free = c.totalCents === 0;
  const v = createVendor(c, free ? {} : { holdUntil: addDays(eventToday(ev), page.invoiceHoldDays) });
  db.update(schema.vendorCheckouts).set({ vendorId: v.id }).where(eq(schema.vendorCheckouts.id, c.id)).run();
  if (free) {
    try {
      await sendVendorWelcome(v.id);
    } catch (err) {
      console.error("[vendor checkout] welcome:", err);
    }
  } else {
    try {
      await sendVendorPayEmail(v, { attachments: await pdfFor(c) });
    } catch (err) {
      console.error("[vendor checkout] invoice email:", err);
    }
  }
  await checkoutEmails(c, v, free ? { cents: 0, pending: false } : null);
  return v;
}

/* ---------- Stripe sessions ---------- */

function methodTypes(methods: VendorCheckoutPage["methods"]): Stripe.Checkout.SessionCreateParams.AllowedPaymentMethodType[] {
  return methods === "ach" ? ["us_bank_account"] : methods === "card" ? ["card"] : ["card", "us_bank_account"];
}

async function createSession(ev: EventRow, c: VendorCheckout, page: VendorCheckoutPage, pkg: VendorPackage, opts: { accountId: string; key: string }) {
  const deposit = c.payOption === "deposit";
  const fee = platformFee(c.dueTodayCents);
  const name = `${ev.shortName || ev.name}: ${c.kind === "sponsor" ? `${pkg.name} sponsorship` : pkg.name}${deposit ? " (deposit)" : ""}`;
  const session = await vstripe().checkout.sessions.create(
    {
      ui_mode: "embedded_page",
      mode: "payment",
      allowed_payment_method_types: methodTypes(page.methods),
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: c.dueTodayCents, product_data: { name } } }],
      customer_creation: "always",
      customer_email: c.buyer.email,
      client_reference_id: `vendor-checkout-${c.id}`,
      metadata: { leaddash_vendor_checkout_id: String(c.id), leaddash_event_id: String(ev.id) },
      payment_intent_data: {
        ...(fee > 0 ? { application_fee_amount: fee } : {}),
        ...(deposit ? { setup_future_usage: "off_session" as const } : {}),
        receipt_email: c.buyer.email,
        description: `${ev.name}: ${pkg.name} for ${c.buyer.company}`,
        metadata: { leaddash_vendor_checkout_id: String(c.id) },
      },
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      return_url: `${ENV.appUrl}/r/${ev.slug}/${kindPath(c.kind)}/done?c=${c.doneToken}`,
    },
    { stripeAccount: opts.accountId, idempotencyKey: opts.key }
  );
  getDb().update(schema.vendorCheckouts).set({ status: "pending", stripeSessionId: session.id, stripeAccountId: opts.accountId }).where(eq(schema.vendorCheckouts.id, c.id)).run();
  if (!session.client_secret) throw new Error("Stripe returned no client secret");
  return session.client_secret;
}

/** The pay link: a session for what is owed that also saves the method used (so it becomes the saved method). */
async function createBalanceSession(ev: EventRow, v: Vendor, owed: number, accountId: string) {
  const fee = platformFee(owed);
  const session = await vstripe().checkout.sessions.create(
    {
      ui_mode: "embedded_page",
      mode: "payment",
      allowed_payment_method_types: methodTypes(vendorPageFor(ev.id, v.kind === "exhibitor" ? "exhibitor" : "sponsor").methods),
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: owed, product_data: { name: `${ev.shortName || ev.name}: ${boughtLabel(v)}` } } }],
      ...(v.stripeCustomerId ? { customer: v.stripeCustomerId } : { customer_creation: "always" as const, customer_email: v.email || undefined }),
      client_reference_id: `vendor-${v.id}`,
      metadata: { leaddash_vendor_pay: String(v.id), leaddash_event_id: String(ev.id) },
      payment_intent_data: {
        ...(fee > 0 ? { application_fee_amount: fee } : {}),
        setup_future_usage: "off_session",
        ...(v.email ? { receipt_email: v.email } : {}),
        description: `${ev.name}: ${boughtLabel(v)} for ${v.company}`,
        metadata: { leaddash_vendor_id: String(v.id) },
      },
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      return_url: `${ENV.appUrl}/r/${ev.slug}/${v.kind === "exhibitor" ? "exhibit" : "sponsor"}/pay?v=${encodeURIComponent(v.payToken ?? "")}&session_id={CHECKOUT_SESSION_ID}`,
    },
    { stripeAccount: accountId, idempotencyKey: `leaddash-vendor-pay-${v.id}-${owed}-${Date.now()}` }
  );
  if (!session.client_secret) throw new Error("Stripe returned no client secret");
  return session.client_secret;
}

/** Change payment method from the pay link: a setup session that saves a new card or bank account for the scheduled charge. */
async function createSetupSession(ev: EventRow, v: Vendor, accountId: string) {
  const session = await vstripe().checkout.sessions.create(
    {
      ui_mode: "embedded_page",
      mode: "setup",
      currency: "usd",
      allowed_payment_method_types: methodTypes(vendorPageFor(ev.id, v.kind === "exhibitor" ? "exhibitor" : "sponsor").methods),
      customer: v.stripeCustomerId!,
      client_reference_id: `vendor-${v.id}`,
      metadata: { leaddash_vendor_setup: String(v.id), leaddash_event_id: String(ev.id) },
      return_url: `${ENV.appUrl}/r/${ev.slug}/${v.kind === "exhibitor" ? "exhibit" : "sponsor"}/pay?v=${encodeURIComponent(v.payToken ?? "")}&session_id={CHECKOUT_SESSION_ID}`,
    },
    { stripeAccount: accountId, idempotencyKey: `leaddash-vendor-setup-${v.id}-${Date.now()}` }
  );
  if (!session.client_secret) throw new Error("Stripe returned no client secret");
  return session.client_secret;
}

/** A finished setup session: the new method is used for the scheduled charge. Safe to call twice. */
export async function completeSetup(vendorId: number, s: Pick<Stripe.Checkout.Session, "id" | "setup_intent">, account: string) {
  const db = getDb();
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get();
  if (!v) return null;
  const ev = db.select().from(schema.events).where(eq(schema.events.id, v.eventId)).get()!;
  if (accountRow(ev.orgId)?.accountId !== account) return null;
  const siId = typeof s.setup_intent === "string" ? s.setup_intent : s.setup_intent?.id;
  if (!siId) return "ignored";
  const si = await vstripe().setupIntents.retrieve(siId, { expand: ["payment_method"] }, { stripeAccount: account });
  const pm = typeof si.payment_method === "object" ? si.payment_method : null;
  if (!pm || pm.id === v.stripePaymentMethodId) return "ignored";
  db.update(schema.vendors).set({ stripePaymentMethodId: pm.id, payMethodLabel: methodLabel(pm).label, nextChargeError: "" }).where(eq(schema.vendors.id, v.id)).run();
  return "vendor_method";
}

/** A paid pay-link session: records the payment, saves the new method, and clears the scheduled charge. Safe to call twice. */
export async function completeBalance(vendorId: number, s: Pick<Stripe.Checkout.Session, "id" | "payment_status" | "payment_intent" | "customer" | "amount_total">, account: string) {
  const db = getDb();
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get();
  if (!v) return null;
  const ev = db.select().from(schema.events).where(eq(schema.events.id, v.eventId)).get()!;
  if (accountRow(ev.orgId)?.accountId !== account) return null;
  if (db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.stripeSessionId, s.id)).get()) return "ignored";
  const piId = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null;
  const customer = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
  let pm: Stripe.PaymentMethod | null = null;
  if (piId) {
    try {
      const pi = await vstripe().paymentIntents.retrieve(piId, { expand: ["payment_method"] }, { stripeAccount: account });
      pm = typeof pi.payment_method === "object" ? pi.payment_method : null;
    } catch (err) {
      console.error("[vendor pay] payment method lookup:", err);
    }
  }
  const m = methodLabel(pm);
  const inserted = db
    .insert(schema.vendorPayments)
    .values({ eventId: v.eventId, vendorId: v.id, amountCents: s.amount_total ?? 0, method: m.method, status: s.payment_status === "paid" ? "paid" : "pending", purpose: "balance", paidOn: eventToday(ev), reference: m.label, stripeAccountId: account, stripeSessionId: s.id, stripePaymentIntentId: piId })
    .onConflictDoNothing()
    .run().changes;
  if (!inserted) return "ignored";
  db.update(schema.vendors)
    .set({ holdUntil: null, nextChargeCents: 0, nextChargeOn: null, nextChargeReminderAt: null, nextChargeError: "", ...(customer ? { stripeCustomerId: customer } : {}), ...(pm ? { stripePaymentMethodId: pm.id, payMethodLabel: m.label } : {}) })
    .where(eq(schema.vendors.id, v.id))
    .run();
  syncPaid(v.id);
  try {
    await sendVendorWelcome(v.id);
  } catch (err) {
    console.error("[vendor pay] welcome:", err);
  }
  return "vendor_balance";
}

/* ---------- Stripe events ---------- */

/**
 * Stripe events for sponsor and exhibitor payments. Returns null when the event
 * is not about a vendor payment (the ticket handler takes it from there). Only
 * events from the account the checkout was created on are trusted.
 */
export async function handleVendorStripeEvent(event: Stripe.Event): Promise<string | null> {
  const db = getDb();
  const account = event.account ?? null;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const s = event.data.object as Stripe.Checkout.Session;
      const c = db.select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.stripeSessionId, s.id)).get();
      if (c) {
        if (c.stripeAccountId !== account) return "ignored";
        if (event.type === "checkout.session.expired") {
          db.update(schema.vendorCheckouts).set({ status: "expired" }).where(and(eq(schema.vendorCheckouts.id, c.id), eq(schema.vendorCheckouts.status, "pending"))).run();
          return "vendor_expired";
        }
        if (event.type === "checkout.session.completed") {
          await completeCheckout(c.id, s);
          return "vendor_created";
        }
        const pay = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.stripeSessionId, s.id)).get();
        if (!pay) {
          // The completed event has not arrived yet: finish it first, then apply this one.
          if (event.type === "checkout.session.async_payment_succeeded") await completeCheckout(c.id, { ...s, payment_status: "paid" });
          else {
            await completeCheckout(c.id, { ...s, payment_status: "unpaid" });
            return handleVendorStripeEvent(event);
          }
          return "vendor_paid";
        }
        return settleSessionPayment(event.type, pay, s);
      }
      const setupFor = Number(s.metadata?.leaddash_vendor_setup ?? 0);
      if (setupFor) return event.type === "checkout.session.completed" ? ((await completeSetup(setupFor, s, account ?? "")) ?? "ignored") : "ignored";
      const vendorId = Number(s.metadata?.leaddash_vendor_pay ?? 0);
      if (!vendorId) return null;
      if (event.type === "checkout.session.expired") return "ignored";
      if (event.type === "checkout.session.completed") return (await completeBalance(vendorId, s, account ?? "")) ?? "ignored";
      const pay = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.stripeSessionId, s.id)).get();
      if (!pay) {
        await completeBalance(vendorId, { ...s, payment_status: event.type === "checkout.session.async_payment_succeeded" ? "paid" : "unpaid" }, account ?? "");
        const again = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.stripeSessionId, s.id)).get();
        return again ? settleSessionPayment(event.type, again, s) : "ignored";
      }
      return settleSessionPayment(event.type, pay, s);
    }
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
      return handleVendorPaymentIntent(event.type, event.data.object as Stripe.PaymentIntent, account);
    case "charge.dispute.created": {
      const d = event.data.object as Stripe.Dispute;
      return (await handleVendorDispute(d, account)) ?? (await handleOrderDispute(d, account));
    }
    default:
      return null;
  }
}

/** A ticket payment returned or disputed: the order is marked failed and the organization is told. */
async function handleOrderDispute(d: Stripe.Dispute, account: string | null) {
  const db = getDb();
  const piId = typeof d.payment_intent === "string" ? d.payment_intent : d.payment_intent?.id;
  if (!piId) return null;
  const order = db.select().from(schema.orders).where(and(eq(schema.orders.stripePaymentIntentId, piId), eq(schema.orders.stripeAccountId, account ?? ""))).get();
  if (!order) return null;
  if (order.status !== "paid") return "ignored";
  db.update(schema.orders).set({ status: "failed" }).where(eq(schema.orders.id, order.id)).run();
  const ev = db.select().from(schema.events).where(eq(schema.events.id, order.eventId)).get()!;
  const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
  const style = vendorMailStyle(ev);
  const b = order.buyer as { firstName?: string; lastName?: string };
  const who = `${b.firstName ?? ""} ${b.lastName ?? ""}`.trim() || order.email;
  const text = `The ${fmtMoney(order.amountCents, "$0.00")} ticket payment from ${who} (${order.email}) was returned or disputed (${reasonWords(d.reason).toLowerCase() || "general"}). It now shows as failed in Sales and payments. Answer the dispute in your Stripe dashboard.`;
  const url = `${ENV.appUrl}/admin/e/${ev.id}/registration?tab=payments`;
  const owners = db
    .select({ email: schema.users.email })
    .from(schema.orgMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
    .where(and(eq(schema.orgMembers.orgId, ev.orgId), eq(schema.orgMembers.role, "owner")))
    .all();
  for (const o of owners) {
    await sendEmail({ to: o.email, fromName: style.fromName, subject: `${style.fromName}: ticket payment failed for ${who}`, text: `${text}\n\n${url}`, html: emailLayout({ ...style, title: "A ticket payment failed", blocks: [`<p>${escapeHtml(text)}</p>`, emailButton("Open payments", url, ev.branding)], footer: escapeHtml(org.name) }) });
  }
  return "order_dispute";
}

async function settleSessionPayment(type: string, pay: typeof schema.vendorPayments.$inferSelect, s: Stripe.Checkout.Session) {
  const db = getDb();
  if (type === "checkout.session.async_payment_succeeded") {
    const won = db.update(schema.vendorPayments).set({ status: "paid" }).where(and(eq(schema.vendorPayments.id, pay.id), eq(schema.vendorPayments.status, "pending"))).run().changes === 1;
    if (won) syncPaid(pay.vendorId);
    return won ? "vendor_paid" : "ignored";
  }
  const reason = "The bank did not complete the payment";
  const won = db.update(schema.vendorPayments).set({ status: "failed", failureReason: reason }).where(and(eq(schema.vendorPayments.id, pay.id), eq(schema.vendorPayments.status, "pending"))).run().changes === 1;
  if (!won) return "ignored";
  syncPaid(pay.vendorId);
  db.update(schema.vendorCheckouts).set({ status: "failed" }).where(eq(schema.vendorCheckouts.stripeSessionId, s.id)).run();
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, pay.vendorId)).get();
  if (v) await paymentFailedEmails(v, pay.amountCents, reason);
  return "vendor_failed";
}

/* ---------- Routes ---------- */

const settingsIn = z.object({
  eventId: id,
  kind: kindIn,
  open: z.boolean(),
  closesOn: isoDate.nullable(),
  title: z.string().trim().min(1).max(160),
  intro: z.string().trim().max(2000),
  packageIds: z.array(id).max(100),
  payFull: z.boolean(),
  payDeposit: z.boolean(),
  payInvoice: z.boolean(),
  methods: z.enum(["both", "ach", "card"]),
  depositPercent: z.number().int().min(10).max(90).multipleOf(10),
  balanceDueOn: isoDate.nullable(),
  invoiceHoldDays: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  agreementTemplateId: id.nullable(),
  notifyEmail: z.string().trim().max(200).refine((s) => !s || emailOk(s), "Enter a valid email."),
});

const adminRouter = router({
  /** The Sponsors or Exhibitors tab on the admin Checkout page. */
  settings: protectedProcedure.input(z.object({ eventId: id, kind: kindIn })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "registration", "view");
    const page = vendorPageFor(event.id, input.kind);
    const db = getDb();
    const packages = eventPackages(event.id).filter((p) => p.kind === input.kind);
    const templates = db
      .select({ id: schema.agreementTemplates.id, name: schema.agreementTemplates.name })
      .from(schema.agreementTemplates)
      .where(and(eq(schema.agreementTemplates.eventId, event.id), eq(schema.agreementTemplates.kind, input.kind)))
      .all();
    const today = eventToday(event);
    return {
      ...page,
      link: checkoutLink(event.slug, input.kind),
      embedCode: `<iframe src="${checkoutLink(event.slug, input.kind)}" title="${input.kind === "sponsor" ? "Sponsor" : "Exhibit"}" style="width:100%;max-width:480px;height:900px;border:0" allow="payment *"></iframe>`,
      live: !closedReason(event, page, today),
      packages: packages.map((p) => ({ id: p.id, name: p.name, active: p.active })),
      templates,
      achActive: achActive(event.orgId),
      stripeConnected: !!accountRow(event.orgId),
      today,
    };
  }),

  saveSettings: protectedProcedure.input(settingsIn).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "registration", "edit");
    const db = getDb();
    const { eventId, kind, ...rest } = input;
    const page = vendorPageFor(eventId, kind);
    if (!rest.payFull && !rest.payDeposit && !rest.payInvoice) throw bad("Choose at least one way to pay.");
    if (rest.payDeposit) {
      if (!rest.balanceDueOn) throw bad("Set the date the rest is charged.");
      if (rest.balanceDueOn <= eventToday(event)) throw bad("The rest is charged on a later date. Pick a date after today.");
    }
    const ids = new Set(eventPackages(eventId).filter((p) => p.kind === kind).map((p) => p.id));
    const packageIds = Array.from(new Set(rest.packageIds.filter((x) => ids.has(x))));
    if (rest.agreementTemplateId) {
      const t = templateById(rest.agreementTemplateId);
      if (!t || t.eventId !== eventId || t.kind !== kind) throw bad("Pick an agreement for this kind.");
    }
    db.update(schema.vendorCheckoutPages)
      .set({ ...rest, packageIds, notifyEmail: rest.notifyEmail.toLowerCase(), updatedAt: new Date() })
      .where(eq(schema.vendorCheckoutPages.id, page.id))
      .run();
    audit(ctx.user, { orgId: event.orgId, eventId, action: "vendor_checkout.update", detail: kind });
    return { ok: true };
  }),

  /** Charge now on the next charge row: the scheduled charge, right away. */
  chargeNow: protectedProcedure.input(z.object({ eventId: id, vendorId: id })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = vendorIn(input.eventId, input.vendorId);
    if (v.nextChargeCents <= 0) throw bad("Nothing is scheduled to charge.");
    const r = await chargeBalance(v.id);
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "vendor.charge_now", detail: `${v.company}: ${r.status}` });
    if (r.status === "failed") throw bad(`The charge did not go through: ${r.error}`);
    return r;
  }),

  /** Send invoice: emails the pay link for what is owed. */
  sendPayLink: protectedProcedure.input(z.object({ eventId: id, vendorId: id })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = vendorIn(input.eventId, input.vendorId);
    if (!v.email) throw bad("Add the contact's email first.");
    const payments = getDb().select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
    if (vendorMoney(v, payments).owedCents <= 0) throw bad("Nothing is owed.");
    await sendVendorPayEmail(v);
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "vendor.invoice", detail: v.company });
    return { to: v.email };
  }),

  /** Copy pay link. */
  payLink: protectedProcedure.input(z.object({ eventId: id, vendorId: id })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "vendors", "edit");
    return { url: vendorPayLink(vendorIn(input.eventId, input.vendorId)) };
  }),
});

const startIn = z.object({ slug: slugIn, kind: kindIn, token: tokenIn, payOption: z.enum(["full", "deposit", "invoice"]) });

export const vendorCheckoutRouter = router({
  admin: adminRouter,

  /** Everything the public page needs. */
  page: publicProcedure.input(z.object({ slug: slugIn, kind: kindIn })).query(({ input }) => {
    const ev = getEventBySlug(input.slug);
    const page = vendorPageFor(ev.id, input.kind);
    const today = eventToday(ev);
    const t = templateById(page.agreementTemplateId);
    // Sold out packages go last.
    const offers = packageOffers(ev.id, input.kind, page).sort((a, b) => Number(a.soldOut) - Number(b.soldOut));
    return {
      event: publicInfo(ev),
      page: { title: page.title || (input.kind === "sponsor" ? `Sponsor ${ev.name}` : `Exhibit at ${ev.name}`), intro: page.intro, methods: page.methods, depositPercent: page.depositPercent, balanceDueOn: page.balanceDueOn, invoiceHoldDays: page.invoiceHoldDays, options: payOptions(page, today) },
      closed: closedReason(ev, page, today),
      hasAgreement: !!t && t.eventId === ev.id && t.kind === input.kind,
      packages: offers.map((o) => ({
        id: o.pkg.id,
        name: o.pkg.name,
        priceCents: o.pkg.priceCents,
        quantity: o.pkg.quantity,
        left: o.left,
        soldOut: o.soldOut,
        passes: o.pkg.passes,
        includes: packageIncludes(o.pkg),
        addons: addonOffers(ev.id, o.pkg).map((a) => ({ id: a.addon.id, name: a.addon.name, priceCents: a.addon.priceCents, left: a.left, addsPass: a.addon.addsPass })),
      })),
      categories: input.kind === "exhibitor" ? eventCategories(ev.id) : [],
      payments: paymentsFor(ev.orgId),
    };
  }),

  /** The logo on the Company step (images only, public, tied to this upload by a signed token). */
  uploadLogo: publicProcedure
    .input(z.object({ slug: slugIn, kind: kindIn, name: z.string().max(200), mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]), base64: z.string().max(7_000_000) }))
    .mutation(({ input }) => {
      const ev = getEventBySlug(input.slug);
      const page = vendorPageFor(ev.id, input.kind);
      const closed = closedReason(ev, page, eventToday(ev));
      if (closed) throw bad(closed);
      if (Buffer.byteLength(input.base64.replace(/^data:[^,]+,/, ""), "base64") > 5 * 1024 * 1024) throw bad("Logos can be up to 5 MB.");
      const f = saveFile({ orgId: ev.orgId, name: input.name || "logo", mime: input.mime, base64: input.base64, isPublic: true, userId: null });
      return { fileId: f.id, url: fileUrl(f.id)!, token: logoToken(f.id) };
    }),

  /**
   * Saves the Package and Company steps as a checkout (creating it the first
   * time) and returns the totals and the agreement to sign. Called again when
   * the buyer goes back and changes something, or changes how they pay.
   */
  prepare: publicProcedure
    .input(z.object({ slug: slugIn, kind: kindIn, token: tokenIn.optional(), packageId: id, buyer: buyerIn, payOption: z.enum(["full", "deposit", "invoice"]).default("full") }))
    .mutation(({ input }) => {
      const ev = getEventBySlug(input.slug);
      const db = getDb();
      let c = input.token ? db.select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.doneToken, input.token)).get() : undefined;
      if (c && (c.eventId !== ev.id || c.kind !== input.kind || !["started", "expired"].includes(c.status))) c = undefined;
      const o = validateOrder(ev, input.kind, { packageId: input.packageId, buyer: input.buyer, payOption: input.payOption }, c?.id);
      const values = { packageId: o.pkg.id, buyer: o.buyer, payOption: o.payOption, totalCents: o.totalCents, dueTodayCents: o.dueTodayCents };
      c = c
        ? db.update(schema.vendorCheckouts).set({ ...values, status: "started" }).where(eq(schema.vendorCheckouts.id, c.id)).returning().get()
        : db.insert(schema.vendorCheckouts).values({ ...values, eventId: ev.id, kind: input.kind, status: "started", doneToken: newDoneToken() }).returning().get();
      const a = syncAgreement(ev, c);
      return {
        token: c.doneToken,
        payOption: o.payOption,
        totalCents: o.totalCents,
        dueTodayCents: o.dueTodayCents,
        lines: o.lines,
        agreement: a ? { code: a.code, html: a.html, signed: a.status === "signed", signedAt: a.signedAt } : null,
      };
    }),

  /** Signs the checkout's agreement (no email yet: the signed copy goes out with the receipt or welcome email after payment). */
  sign: publicProcedure
    .input(z.object({ slug: slugIn, kind: kindIn, token: tokenIn, name: z.string().max(200), title: z.string().max(200).default(""), signaturePng: z.string().max(600_000) }))
    .mutation(async ({ ctx, input }) => {
      const ev = getEventBySlug(input.slug);
      const c = checkoutFor(ev, input.kind, input.token);
      if (!["started", "expired"].includes(c.status)) throw bad("This checkout is already finished.");
      const a = syncAgreement(ev, c);
      if (!a) throw bad("There is no agreement to sign.");
      if (a.status !== "signed") await signAgreement(a.code, { name: input.name, title: input.title, signaturePng: input.signaturePng, ip: ctx.req.ip ?? "", userAgent: String(ctx.req.headers?.["user-agent"] ?? "") }, { sendCopy: false });
      return { ok: true };
    }),

  /** Pay (Stripe Checkout on the organization's account) or Request invoice. */
  start: publicProcedure.input(startIn).mutation(async ({ input }) => {
    const ev = getEventBySlug(input.slug);
    const db = getDb();
    let c = checkoutFor(ev, input.kind, input.token);
    const doneUrl = `/r/${ev.slug}/${kindPath(input.kind)}/done?c=${c.doneToken}`;
    if (["paid", "invoice"].includes(c.status)) return { kind: "done" as const, doneUrl };
    // A Stripe session already started: reuse it while open, finish it if it was paid.
    if (c.status === "pending" && c.stripeSessionId && c.stripeAccountId) {
      try {
        const s = await vstripe().checkout.sessions.retrieve(c.stripeSessionId, {}, { stripeAccount: c.stripeAccountId });
        if (s.status === "complete") {
          await completeCheckout(c.id, s);
          return { kind: "done" as const, doneUrl };
        }
        if (s.status === "open" && s.client_secret && c.payOption === input.payOption) return { kind: "pay" as const, clientSecret: s.client_secret };
        // They changed how to pay: close the old session so only the new one can be paid.
        if (s.status === "open") await vstripe().checkout.sessions.expire(c.stripeSessionId, {}, { stripeAccount: c.stripeAccountId });
      } catch (err) {
        console.error("[vendor checkout] earlier session:", err);
      }
    }
    if (c.status === "failed") throw bad("This checkout did not go through. Start again.");
    const restart = c.status !== "started";
    const o = validateOrder(ev, input.kind, { packageId: c.packageId, buyer: c.buyer, payOption: input.payOption, strictOption: true }, c.id);
    c = db.update(schema.vendorCheckouts).set({ payOption: o.payOption, totalCents: o.totalCents, dueTodayCents: o.dueTodayCents, status: "started" }).where(eq(schema.vendorCheckouts.id, c.id)).returning().get();
    const a = syncAgreement(ev, c);
    if (a && a.status !== "signed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Sign the agreement before paying." });
    if (o.payOption === "invoice" || o.dueTodayCents === 0) {
      await completeWithoutPayment(c);
      return { kind: "done" as const, doneUrl };
    }
    const pay = paymentsFor(ev.orgId);
    if (!pay.ready || !pay.accountId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This event is not taking payments yet. Please try again later." });
    try {
      const key = `leaddash-vendor-checkout-${c.id}-${o.payOption}-${o.dueTodayCents}${restart ? `-${Date.now()}` : ""}`;
      const clientSecret = await createSession(ev, c, o.page, o.pkg, { accountId: pay.accountId, key });
      return { kind: "pay" as const, clientSecret };
    } catch (err) {
      console.error("[stripe] vendor checkout session failed:", err);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "We could not start the payment. Please try again." });
    }
  }),

  /** The confirmation page: checks the Stripe session (finishing it if the webhook has not yet). */
  done: publicProcedure.input(z.object({ slug: slugIn, kind: kindIn, c: tokenIn })).query(async ({ input }) => {
    const ev = getEventBySlug(input.slug);
    const db = getDb();
    let c = checkoutFor(ev, input.kind, input.c);
    if (c.status === "pending" && c.stripeSessionId && c.stripeAccountId) {
      try {
        const s = await vstripe().checkout.sessions.retrieve(c.stripeSessionId, {}, { stripeAccount: c.stripeAccountId });
        if (s.status === "complete") await completeCheckout(c.id, s);
        else if (s.status === "expired") db.update(schema.vendorCheckouts).set({ status: "expired" }).where(and(eq(schema.vendorCheckouts.id, c.id), eq(schema.vendorCheckouts.status, "pending"))).run();
      } catch (err) {
        console.error("[vendor checkout] done check:", err);
      }
      c = db.select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.id, c.id)).get()!;
    }
    const v = c.vendorId ? db.select().from(schema.vendors).where(eq(schema.vendors.id, c.vendorId)).get() : undefined;
    const pkg = db.select().from(schema.vendorPackages).where(eq(schema.vendorPackages.id, c.packageId)).get();
    const base = { firstName: c.buyer.firstName, email: c.buyer.email, packageName: pkg?.name ?? "", totalCents: c.totalCents, dueTodayCents: c.dueTodayCents };
    if (!v) return { ...base, status: c.status === "pending" || c.status === "started" ? ("processing" as const) : c.status === "failed" ? ("failed" as const) : ("expired" as const) };
    const payments = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
    const failed = payments.some((p) => p.stripeSessionId === c.stripeSessionId && p.status === "failed");
    const pending = payments.some((p) => p.status === "pending");
    const addons = new Map(db.select().from(schema.vendorAddons).where(eq(schema.vendorAddons.eventId, ev.id)).all().map((a) => [a.id, a]));
    const total = passTotal(v, pkg, addons);
    const named = passHolders(ev.id).filter((a) => a.vendorId === v.id).length;
    const a = c.agreementId ? db.select().from(schema.agreements).where(eq(schema.agreements.id, c.agreementId)).get() : undefined;
    return {
      ...base,
      status: failed ? ("failed" as const) : c.status === "invoice" ? ("invoice" as const) : pending ? ("clearing" as const) : ("paid" as const),
      restCents: v.nextChargeCents,
      restOn: v.nextChargeOn,
      holdUntil: v.holdUntil,
      payLink: c.status === "invoice" || failed ? vendorPayLink(v) : null,
      passes: { total, named },
      listing: { company: v.company, logoUrl: fileUrl(v.logoFileId), about: v.description, website: v.website, offer: v.offer, category: v.category },
      agreement: a && a.status === "signed" ? { code: a.code, signedAt: a.signedAt } : null,
    };
  }),

  /** Add your pass names (from the confirmation page; the token is the buyer's secret). */
  addPasses: publicProcedure.input(z.object({ slug: slugIn, kind: kindIn, c: tokenIn, people: z.array(personIn).min(1).max(60) })).mutation(({ input }) => {
    const ev = getEventBySlug(input.slug);
    const c = checkoutFor(ev, input.kind, input.c);
    const v = c.vendorId ? getDb().select().from(schema.vendors).where(eq(schema.vendors.id, c.vendorId)).get() : undefined;
    if (!v || v.status === "cancelled") throw bad("This checkout has no passes yet.");
    const people = input.people.filter((p) => p.name || p.email);
    for (const p of people) {
      if (!p.name) throw bad(`Add a name for ${p.email}.`);
      if (!emailOk(p.email)) throw bad(`Enter a valid email for ${p.name}.`);
    }
    return { added: addPassPeople(v, people) };
  }),

  /** The vendor pay link page (/r/:slug/sponsor/pay?v=). */
  payInfo: publicProcedure.input(z.object({ slug: slugIn, v: tokenIn, sessionId: z.string().max(200).optional() })).query(async ({ input }) => {
    const ev = getEventBySlug(input.slug);
    const db = getDb();
    let v = db.select().from(schema.vendors).where(eq(schema.vendors.payToken, input.v)).get();
    if (!v || v.eventId !== ev.id || v.status === "cancelled") throw notFound("That payment link");
    // Back from Stripe: finish it now if the webhook has not yet.
    if (input.sessionId) {
      const acct = accountRow(ev.orgId);
      if (acct && !db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.stripeSessionId, input.sessionId)).get()) {
        try {
          const s = await vstripe().checkout.sessions.retrieve(input.sessionId, {}, { stripeAccount: acct.accountId });
          if (s.status === "complete" && Number(s.metadata?.leaddash_vendor_pay ?? 0) === v.id) await completeBalance(v.id, s, acct.accountId);
          if (s.status === "complete" && Number(s.metadata?.leaddash_vendor_setup ?? 0) === v.id) await completeSetup(v.id, s, acct.accountId);
        } catch (err) {
          console.error("[vendor pay] session check:", err);
        }
      }
      v = db.select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get()!;
    }
    const payments = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
    const money = vendorMoney(v, payments);
    return {
      company: v.company,
      what: boughtLabel(v),
      kind: v.kind === "exhibitor" ? ("exhibitor" as const) : ("sponsor" as const),
      amountCents: v.amountCents,
      paidCents: money.paidCents,
      pendingCents: money.pendingCents,
      owedCents: money.owedCents,
      nextChargeCents: v.nextChargeCents,
      nextChargeOn: v.nextChargeOn,
      payMethodLabel: v.payMethodLabel,
      payments: payments.filter((p) => p.status === "paid" || p.status === "pending").map((p) => ({ id: p.id, amountCents: p.amountCents, paidOn: p.paidOn, pending: p.status === "pending" })),
      justPaid: !!input.sessionId && payments.some((p) => p.stripeSessionId === input.sessionId),
      canChange: !!v.stripeCustomerId && v.nextChargeCents > 0,
    };
  }),

  /** Pay now (what is owed) from the pay link, or change the saved method for the scheduled charge. */
  changeMethod: publicProcedure.input(z.object({ slug: slugIn, v: tokenIn })).mutation(async ({ input }) => {
    const ev = getEventBySlug(input.slug);
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.payToken, input.v)).get();
    if (!v || v.eventId !== ev.id || v.status === "cancelled") throw notFound("That payment link");
    if (!v.stripeCustomerId || v.nextChargeCents <= 0) throw bad("Nothing is scheduled to charge.");
    const pay = paymentsFor(ev.orgId);
    if (!pay.ready || !pay.accountId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This event is not taking payments yet. Please try again later." });
    try {
      return { clientSecret: await createSetupSession(ev, v, pay.accountId) };
    } catch (err) {
      console.error("[stripe] vendor setup session failed:", err);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "We could not open the payment form. Please try again." });
    }
  }),

  payBalance: publicProcedure.input(z.object({ slug: slugIn, v: tokenIn })).mutation(async ({ input }) => {
    const ev = getEventBySlug(input.slug);
    const db = getDb();
    const v = db.select().from(schema.vendors).where(eq(schema.vendors.payToken, input.v)).get();
    if (!v || v.eventId !== ev.id || v.status === "cancelled") throw notFound("That payment link");
    const payments = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
    const owed = vendorMoney(v, payments).owedCents;
    if (owed <= 0) throw bad("Nothing is owed.");
    const pay = paymentsFor(ev.orgId);
    if (!pay.ready || !pay.accountId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This event is not taking payments yet. Please try again later." });
    try {
      return { clientSecret: await createBalanceSession(ev, v, owed, pay.accountId) };
    } catch (err) {
      console.error("[stripe] vendor pay session failed:", err);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "We could not start the payment. Please try again." });
    }
  }),
});
