/**
 * Sponsor and exhibitor payments after checkout: the pay link, the automatic
 * charge for the rest of a deposit (with the reminder 7 days before), Charge
 * now, and what happens when a card or bank payment fails (right away, later
 * through payment_intent.payment_failed, or as a bank return that Stripe
 * reports as a dispute).
 *
 * Every charge is a direct charge on the organization's own Stripe account,
 * like ticket payments, using the payment method saved at checkout.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema } from "../../_core/db";
import { ENV } from "../../_core/env";
import { randomToken } from "../../_core/crypto";
import { emailButton, emailLayout, escapeHtml, sendEmail, type EmailAttachment } from "../../_core/email";
import { fileUrl } from "../../_core/files";
import { SHAPE_RADIUS, buttonInk, lookOf } from "@shared/brand";
import { fmtDate, fmtMoney } from "@shared/format";
import { addDays, vendorMoney } from "../network/vendors";
import { syncPaid } from "../network/packages";
import { accountRow } from "./connect";
import { eventToday } from "./logic";
import { platformFee, stripe, type Stripe, type StripeLike } from "./stripe";

type Vendor = typeof schema.vendors.$inferSelect;
type EventRow = typeof schema.events.$inferSelect;
type VendorPayment = typeof schema.vendorPayments.$inferSelect;

/** The Stripe client with PaymentIntents and Customers (used only here and at vendor checkout). */
export type VendorStripe = Omit<StripeLike, "checkout"> & {
  checkout: { sessions: Pick<Stripe["checkout"]["sessions"], "create" | "retrieve" | "expire"> };
  paymentIntents: Pick<Stripe["paymentIntents"], "create" | "retrieve">;
  setupIntents: Pick<Stripe["setupIntents"], "retrieve">;
};
export const vstripe = () => stripe() as VendorStripe;

const isSponsor = (v: Pick<Vendor, "kind">) => v.kind !== "exhibitor";
const kindWord = (v: Pick<Vendor, "kind">) => (isSponsor(v) ? "sponsor" : "exhibitor");

function eventOf(eventId: number): EventRow {
  return getDb().select().from(schema.events).where(eq(schema.events.id, eventId)).get()!;
}

function orgOf(ev: EventRow) {
  return getDb().select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
}

/** "Gold sponsorship" or "Standard booth": what the vendor bought, for emails. */
export function boughtLabel(v: Vendor) {
  const pkg = v.packageId ? getDb().select().from(schema.vendorPackages).where(eq(schema.vendorPackages.id, v.packageId)).get() : undefined;
  const name = pkg?.name || v.level;
  if (isSponsor(v)) return name ? `${name} sponsorship` : "Sponsorship";
  return name || "Exhibitor booth";
}

/** The vendor's pay link (pay what is owed, or save a new payment method). Creates the secret the first time. */
export function vendorPayLink(v: Vendor) {
  let token = v.payToken;
  if (!token) {
    token = randomToken(18);
    getDb().update(schema.vendors).set({ payToken: token }).where(eq(schema.vendors.id, v.id)).run();
  }
  const ev = eventOf(v.eventId);
  return `${ENV.appUrl}/r/${ev.slug}/${isSponsor(v) ? "sponsor" : "exhibit"}/pay?v=${encodeURIComponent(token)}`;
}

/** "Bank ending 6789" or "Visa ending 4242" from a Stripe payment method. */
export function methodLabel(pm: Stripe.PaymentMethod | string | null | undefined) {
  if (!pm || typeof pm === "string") return { label: "", method: "card" as const };
  if (pm.type === "us_bank_account") return { label: `Bank ending ${pm.us_bank_account?.last4 ?? ""}`.trim(), method: "bank" as const };
  if (pm.type === "card" && pm.card) {
    const brand = pm.card.brand === "amex" ? "Amex" : pm.card.brand ? pm.card.brand[0].toUpperCase() + pm.card.brand.slice(1) : "Card";
    return { label: `${brand} ending ${pm.card.last4}`, method: "card" as const };
  }
  return { label: "", method: "card" as const };
}

/** "the bank account ending in 6789" for sentences. */
function methodPhrase(label: string) {
  const bank = /^bank ending (\d+)/i.exec(label);
  if (bank) return `the bank account ending in ${bank[1]}`;
  const card = /^(\w+) ending (\d+)/i.exec(label);
  if (card) return `the ${card[1]} card ending in ${card[2]}`;
  return "your saved payment method";
}

/** Where organization notices go: the checkout page's notify address, else the organization's owners. */
export function orgNoticeTo(ev: EventRow, kind: "sponsor" | "exhibitor") {
  const db = getDb();
  const page = db
    .select()
    .from(schema.vendorCheckoutPages)
    .where(and(eq(schema.vendorCheckoutPages.eventId, ev.id), eq(schema.vendorCheckoutPages.kind, kind)))
    .get();
  if (page?.notifyEmail) return [page.notifyEmail];
  return db
    .select({ email: schema.users.email })
    .from(schema.orgMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
    .where(and(eq(schema.orgMembers.orgId, ev.orgId), eq(schema.orgMembers.role, "owner")))
    .all()
    .map((r) => r.email);
}

/** The event's email look (colors, font, cover) and the from name. */
export function vendorMailStyle(ev: EventRow) {
  return { brand: ev.branding.colorPrimary, accent: ev.branding.colorAccent, look: ev.branding, coverUrl: fileUrl(ev.branding.coverFileId, true), fromName: ev.shortName || ev.name };
}

/** A small two-column summary table for emails. Rows are [label, value, bold]. */
export function summaryTable(rows: [string, string, boolean?][]) {
  const tr = rows
    .map(([l, val, bold], i) => `<tr><td style="padding:10px 14px;${i ? "border-top:1px solid #E1E8E5;" : ""}">${escapeHtml(l)}</td><td align="right" style="padding:10px 14px;${i ? "border-top:1px solid #E1E8E5;" : ""}${bold ? "font-weight:800;" : ""}">${escapeHtml(val)}</td></tr>`)
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E1E8E5;border-radius:10px;border-collapse:separate;font-size:14px;margin:0 0 14px">${tr}</table>`;
}

/** Two buttons side by side: the event's button and an outlined one. */
function twoButtons(ev: EventRow, a: [string, string], b: [string, string]) {
  const look = lookOf(ev.branding);
  const radius = SHAPE_RADIUS[look.buttonShape];
  const ink = buttonInk(ev.branding);
  return `<p style="margin:16px 0"><a href="${a[1]}" style="display:inline-block;background:${ev.branding.colorAccent};color:${ink};font-weight:bold;text-decoration:none;padding:12px 20px;border-radius:${radius};margin:0 8px 8px 0">${escapeHtml(a[0])}</a><a href="${b[1]}" style="display:inline-block;background:#FFFFFF;color:${ev.branding.colorPrimary};border:1.5px solid ${ev.branding.colorPrimary};font-weight:bold;text-decoration:none;padding:11px 18px;border-radius:${radius};margin:0 0 8px">${escapeHtml(b[0])}</a></p>`;
}

const firstName = (v: Vendor) => v.contactName.trim().split(/\s+/)[0] || "there";

function paidLines(payments: VendorPayment[]) {
  return payments
    .filter((p) => p.status === "paid" || p.status === "pending")
    .sort((a, b) => (a.paidOn || "").localeCompare(b.paidOn || "") || a.id - b.id)
    .map((p) => [`${p.status === "pending" ? "Paying" : "Paid"} ${fmtDate(p.paidOn)}`, fmtMoney(p.amountCents, "$0.00")] as [string, string]);
}

/** Emails the vendor what they owe with the pay link (Send invoice, the invoice choice, and failed payments). */
export async function sendVendorPayEmail(v: Vendor, opts: { title?: string; intro?: string; subject?: string; attachments?: EmailAttachment[] } = {}) {
  if (!v.email) return false;
  const db = getDb();
  const ev = eventOf(v.eventId);
  const org = orgOf(ev);
  const style = vendorMailStyle(ev);
  const payments = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
  const owed = vendorMoney(v, payments).owedCents;
  const link = vendorPayLink(v);
  const what = boughtLabel(v);
  const intro = opts.intro ?? `Here is the invoice for ${v.company} at ${ev.name}. Pay online with the link below.`;
  const rows: [string, string, boolean?][] = [[what, fmtMoney(v.amountCents, "$0.00"), true], ...v.addons.filter((l) => l.qty > 0).map((l) => [`${l.name} x ${l.qty}`, fmtMoney(l.priceCents * l.qty, "$0.00")] as [string, string]), ...paidLines(payments), ["Due", fmtMoney(owed, "$0.00"), true]];
  if (v.holdUntil) rows.push(["Due by", fmtDate(v.holdUntil)]);
  const notify = orgNoticeTo(ev, isSponsor(v) ? "sponsor" : "exhibitor")[0];
  await sendEmail({
    to: v.email,
    fromName: style.fromName,
    replyTo: notify || undefined,
    subject: opts.subject ?? `${style.fromName}: invoice for ${v.company}`,
    text: [`Hi ${firstName(v)},`, intro, ...rows.map(([l, val]) => `${l}: ${val}`), `Pay here: ${link}`, org.name].join("\n\n"),
    html: emailLayout({
      ...style,
      title: opts.title ?? "Your invoice",
      blocks: [`<p>Hi ${escapeHtml(firstName(v))},</p>`, `<p>${escapeHtml(intro)}</p>`, summaryTable(rows), emailButton(owed > 0 ? `Pay ${fmtMoney(owed)}` : "View payment", link, ev.branding), notify ? `<p style="font-size:13px;color:#4B5B57">Questions? Reply to this email or write to ${escapeHtml(notify)}.</p>` : ""],
      footer: escapeHtml(org.name),
    }),
    attachments: opts.attachments,
  });
  return true;
}

/** The reminder 7 days before the automatic charge (board PayReminder). */
export async function sendChargeReminder(v: Vendor) {
  if (!v.email || !v.nextChargeOn) return false;
  const db = getDb();
  const ev = eventOf(v.eventId);
  const org = orgOf(ev);
  const style = vendorMailStyle(ev);
  const payments = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
  const paid = payments.filter((p) => p.status === "paid" || p.status === "pending").reduce((n, p) => n + p.amountCents, 0);
  const what = boughtLabel(v);
  const amount = fmtMoney(v.nextChargeCents, "$0.00");
  const part = paid === v.nextChargeCents ? "the second half" : "the rest";
  const title = isSponsor(v) ? "Your next sponsorship payment" : "Your next booth payment";
  const link = vendorPayLink(v);
  const notify = orgNoticeTo(ev, isSponsor(v) ? "sponsor" : "exhibitor")[0];
  const sentence = `On ${fmtDate(v.nextChargeOn)}, we will charge ${amount} to ${methodPhrase(v.payMethodLabel)}. This is ${part} of the ${what} for ${v.company}. You do not need to do anything.`;
  const html = `On <b>${escapeHtml(fmtDate(v.nextChargeOn))}</b>, we will charge <b>${escapeHtml(amount)}</b> to ${escapeHtml(methodPhrase(v.payMethodLabel)).replace(/ending in (\d+)/, "ending in <b>$1</b>")}. This is ${part} of the ${escapeHtml(what)} for ${escapeHtml(v.company)}. You do not need to do anything.`;
  const rows: [string, string, boolean?][] = [[what, fmtMoney(v.amountCents, "$0.00"), true], ...paidLines(payments), [`Charged ${fmtDate(v.nextChargeOn)}`, amount, true]];
  await sendEmail({
    to: v.email,
    fromName: style.fromName,
    replyTo: notify || undefined,
    subject: `${style.fromName}: ${title.toLowerCase()} on ${fmtDate(v.nextChargeOn)}`,
    text: [`Hi ${firstName(v)},`, sentence, ...rows.map(([l, val]) => `${l}: ${val}`), `Pay now instead or change the payment method: ${link}`, org.name].join("\n\n"),
    html: emailLayout({
      ...style,
      title,
      blocks: [`<p>Hi ${escapeHtml(firstName(v))},</p>`, `<p>${html}</p>`, summaryTable(rows), twoButtons(ev, ["Pay now instead", link], ["Change payment method", `${link}&change=1`]), notify ? `<p style="font-size:13px;color:#4B5B57">Questions? Reply to this email or write to ${escapeHtml(notify)}.</p>` : ""],
      footer: escapeHtml(org.name),
    }),
  });
  return true;
}

/** Tells the organization a sponsor or exhibitor payment failed, and sends the vendor a pay link. */
export async function paymentFailedEmails(v: Vendor, amountCents: number, reason: string, opts: { late?: boolean; emailVendor?: boolean } = {}) {
  const ev = eventOf(v.eventId);
  const org = orgOf(ev);
  const style = vendorMailStyle(ev);
  const kind = isSponsor(v) ? "sponsor" : "exhibitor";
  const fresh = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, v.id)).get() ?? v;
  const payments = getDb().select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
  const owed = vendorMoney(fresh, payments).owedCents;
  const amount = fmtMoney(amountCents, "$0.00");
  const why = reason ? ` (${reason.replace(/\.$/, "")})` : "";
  const emailVendor = opts.emailVendor !== false && !!fresh.email;
  const orgText = `${opts.late ? "A payment that showed as paid was returned" : "A payment did not go through"}: ${amount} from ${fresh.company} (${boughtLabel(fresh)})${why}. They now owe ${fmtMoney(owed, "$0.00")}.${emailVendor ? " We emailed them a link to pay." : ""}`;
  const adminUrl = `${ENV.appUrl}/admin/e/${ev.id}/vendors`;
  for (const to of orgNoticeTo(ev, kind)) {
    await sendEmail({
      to,
      fromName: style.fromName,
      subject: `${style.fromName}: payment failed for ${fresh.company}`,
      text: [orgText, `Open ${kind}s: ${adminUrl}`].join("\n\n"),
      html: emailLayout({ ...style, title: "A payment failed", blocks: [`<p>${escapeHtml(orgText)}</p>`, emailButton(`Open ${kind}s`, adminUrl, ev.branding)], footer: escapeHtml(org.name) }),
    });
  }
  if (emailVendor) {
    await sendVendorPayEmail(fresh, {
      title: "Your payment did not go through",
      subject: `${style.fromName}: your payment did not go through`,
      intro: `We could not collect ${amount} from ${methodPhrase(fresh.payMethodLabel)} for the ${boughtLabel(fresh)} of ${fresh.company}${why}. Pay with the link below to keep your ${kind === "sponsor" ? "sponsorship" : "booth"}.`,
    });
  }
}

/** "insufficient_funds" -> "Insufficient funds" */
export const reasonWords = (s: string | null | undefined) => {
  const t = String(s || "").replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

function clearNextCharge(vendorId: number) {
  getDb().update(schema.vendors).set({ nextChargeCents: 0, nextChargeOn: null, nextChargeReminderAt: null, nextChargeError: "" }).where(eq(schema.vendors.id, vendorId)).run();
}

export type ChargeResult = { status: "paid" | "pending" | "failed" | "nothing"; error?: string };

/**
 * Charges what is scheduled (or what is owed, for Charge now) to the saved
 * payment method, off session. A pending row is written first, so two runs
 * can never charge twice; the idempotency key also covers retries of the same
 * attempt. Bank payments stay pending until payment_intent.succeeded.
 */
export async function chargeBalance(vendorId: number, now = new Date()): Promise<ChargeResult> {
  const db = getDb();
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get();
  if (!v || v.status === "cancelled") return { status: "nothing" };
  const payments = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
  const owed = vendorMoney(v, payments).owedCents;
  if (owed <= 0) {
    if (v.nextChargeCents > 0) clearNextCharge(v.id);
    return { status: "nothing" };
  }
  if (payments.some((p) => p.status === "pending" && p.purpose === "balance")) return { status: "pending" };
  const ev = eventOf(v.eventId);
  const today = eventToday(ev, now);
  const amount = v.nextChargeCents > 0 ? Math.min(v.nextChargeCents, owed) : owed;
  const acct = accountRow(ev.orgId);
  const isBank = /^bank/i.test(v.payMethodLabel);
  const attempt = payments.filter((p) => p.purpose === "balance").length + 1;

  const fail = async (rowId: number | null, reason: string, piId?: string | null) => {
    const clean = reason.slice(0, 300) || "The payment was declined";
    if (rowId) db.update(schema.vendorPayments).set({ status: "failed", failureReason: clean, ...(piId ? { stripePaymentIntentId: piId } : {}) }).where(eq(schema.vendorPayments.id, rowId)).run();
    db.update(schema.vendors).set({ nextChargeError: clean }).where(eq(schema.vendors.id, v.id)).run();
    syncPaid(v.id);
    try {
      await paymentFailedEmails(v, amount, clean);
    } catch (err) {
      console.error("[vendor charges] failure emails:", err);
    }
    return { status: "failed" as const, error: clean };
  };

  if (!v.stripeCustomerId || !v.stripePaymentMethodId) return fail(null, "No saved payment method");
  if (!acct || !acct.chargesEnabled) return fail(null, "Stripe is not connected");
  const row = db
    .insert(schema.vendorPayments)
    .values({ eventId: v.eventId, vendorId: v.id, amountCents: amount, method: isBank ? "bank" : "card", status: "pending", purpose: "balance", paidOn: today, reference: v.payMethodLabel, stripeAccountId: acct.accountId })
    .returning()
    .get();
  let pi: Stripe.PaymentIntent;
  try {
    const fee = platformFee(amount);
    pi = await vstripe().paymentIntents.create(
      {
        amount,
        currency: "usd",
        customer: v.stripeCustomerId,
        payment_method: v.stripePaymentMethodId,
        allowed_payment_method_types: [isBank ? "us_bank_account" : "card"],
        confirm: true,
        off_session: true,
        ...(fee > 0 ? { application_fee_amount: fee } : {}),
        description: `${ev.name}: ${boughtLabel(v)} for ${v.company}`,
        ...(v.email ? { receipt_email: v.email } : {}),
        metadata: { leaddash_vendor_id: String(v.id), leaddash_event_id: String(ev.id) },
      },
      { stripeAccount: acct.accountId, idempotencyKey: `vendor-balance-${v.id}-${v.nextChargeOn ?? today}-${attempt}` }
    );
  } catch (err) {
    const e = err as { message?: string; raw?: { payment_intent?: { id?: string } }; payment_intent?: { id?: string } };
    return fail(row.id, e.message || "The payment was declined", e.raw?.payment_intent?.id ?? e.payment_intent?.id ?? null);
  }
  db.update(schema.vendorPayments).set({ stripePaymentIntentId: pi.id }).where(eq(schema.vendorPayments.id, row.id)).run();
  if (pi.status === "succeeded" || pi.status === "processing") {
    db.update(schema.vendorPayments).set({ status: pi.status === "succeeded" ? "paid" : "pending" }).where(eq(schema.vendorPayments.id, row.id)).run();
    clearNextCharge(v.id);
    syncPaid(v.id);
    return { status: pi.status === "succeeded" ? "paid" : "pending" };
  }
  const reason = pi.last_payment_error?.message || (pi.status === "requires_action" ? "The bank or card asked the payer to confirm this payment" : "The payment was declined");
  return fail(row.id, reason, pi.id);
}

/**
 * Minute job: the reminder 7 days before nextChargeOn (once), then the charge
 * on or after the date (once; a failed charge waits for staff to Charge now or
 * change the date). Dates are the event's calendar dates.
 */
export async function runVendorCharges(now = new Date()) {
  const db = getDb();
  const due = db.select().from(schema.vendors).where(gt(schema.vendors.nextChargeCents, 0)).all().filter((v) => v.nextChargeOn && v.status !== "cancelled");
  let n = 0;
  for (const v of due) {
    try {
      const ev = eventOf(v.eventId);
      const today = eventToday(ev, now);
      const on = v.nextChargeOn!;
      if (!v.nextChargeReminderAt && today >= addDays(on, -7) && today < on) {
        const claimed = db.update(schema.vendors).set({ nextChargeReminderAt: now }).where(and(eq(schema.vendors.id, v.id), isNull(schema.vendors.nextChargeReminderAt))).run().changes === 1;
        if (claimed) await sendChargeReminder(v);
      }
      if (today >= on && !v.nextChargeError) {
        await chargeBalance(v.id, now);
        n++;
      }
    } catch (err) {
      console.error(`[vendor charges] vendor ${v.id}:`, err);
    }
  }
  return n;
}

/** payment_intent.succeeded / payment_failed for a vendor payment (bank payments clearing, or failing). Null when it is not a vendor payment. */
export async function handleVendorPaymentIntent(type: "payment_intent.succeeded" | "payment_intent.payment_failed", pi: Stripe.PaymentIntent, account: string | null) {
  const db = getDb();
  const row = db
    .select()
    .from(schema.vendorPayments)
    .where(and(eq(schema.vendorPayments.stripePaymentIntentId, pi.id), eq(schema.vendorPayments.stripeAccountId, account ?? "")))
    .get();
  if (!row) return null;
  if (type === "payment_intent.succeeded") {
    if (row.status !== "pending") return "ignored";
    db.update(schema.vendorPayments).set({ status: "paid" }).where(and(eq(schema.vendorPayments.id, row.id), eq(schema.vendorPayments.status, "pending"))).run();
    syncPaid(row.vendorId);
    return "vendor_paid";
  }
  if (row.status !== "pending") return "ignored";
  const reason = pi.last_payment_error?.message || reasonWords(pi.last_payment_error?.code) || "The payment was declined";
  const won = db.update(schema.vendorPayments).set({ status: "failed", failureReason: reason.slice(0, 300) }).where(and(eq(schema.vendorPayments.id, row.id), eq(schema.vendorPayments.status, "pending"))).run().changes === 1;
  if (!won) return "ignored";
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, row.vendorId)).get();
  if (!v) return "ignored";
  if (row.purpose === "balance") db.update(schema.vendors).set({ nextChargeError: reason.slice(0, 300) }).where(eq(schema.vendors.id, v.id)).run();
  syncPaid(v.id);
  await paymentFailedEmails(v, row.amountCents, reason);
  return "vendor_failed";
}

/**
 * A bank payment returned after it showed as paid (Stripe reports it as a
 * dispute, reason insufficient_funds and so on), or a card dispute: the
 * payment is marked failed, so the vendor owes it again, and the organization
 * is told. Null when it is not a vendor payment.
 */
export async function handleVendorDispute(d: Stripe.Dispute, account: string | null) {
  const db = getDb();
  const piId = typeof d.payment_intent === "string" ? d.payment_intent : d.payment_intent?.id;
  if (!piId) return null;
  const row = db
    .select()
    .from(schema.vendorPayments)
    .where(and(eq(schema.vendorPayments.stripePaymentIntentId, piId), eq(schema.vendorPayments.stripeAccountId, account ?? "")))
    .get();
  if (!row) return null;
  if (row.status === "failed" || row.status === "refunded") return "ignored";
  const reason = reasonWords(d.reason) || "Returned by the bank";
  db.update(schema.vendorPayments).set({ status: "failed", failureReason: reason }).where(eq(schema.vendorPayments.id, row.id)).run();
  syncPaid(row.vendorId);
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, row.vendorId)).get();
  if (v) await paymentFailedEmails(v, row.amountCents, reason, { late: true, emailVendor: false });
  return "vendor_dispute";
}

/** For tests and the admin: the label staff see for a vendor's kind. */
export { kindWord };
