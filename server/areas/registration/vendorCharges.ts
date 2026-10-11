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
  return { brand: ev.branding.colorPrimary, accent: ev.branding.colorAccent, look: ev.branding, coverUrl: fileUrl(ev.branding.coverFileId, true), eventName: ev.name, fromName: ev.shortName || ev.name };
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

/**
 * A plain notice to the organization about a sponsor or exhibitor (refund
 * needed, package oversold, hold ended). One failed send never stops the rest.
 */
export async function orgVendorNotice(v: Pick<Vendor, "eventId" | "kind">, subject: string, title: string, text: string) {
  const ev = eventOf(v.eventId);
  const org = orgOf(ev);
  const style = vendorMailStyle(ev);
  const kind = isSponsor(v) ? "sponsor" : "exhibitor";
  const adminUrl = `${ENV.appUrl}/admin/e/${ev.id}/vendors`;
  for (const to of orgNoticeTo(ev, kind)) {
    try {
      await sendEmail({
        to,
        fromName: style.fromName,
        subject: `${style.fromName}: ${subject}`,
        text: [text, `Open ${kind}s: ${adminUrl}`].join("\n\n"),
        html: emailLayout({ ...style, title, blocks: [`<p>${escapeHtml(text)}</p>`, emailButton(`Open ${kind}s`, adminUrl, ev.branding)], footer: escapeHtml(org.name) }),
      });
    } catch (err) {
      console.error("[vendor charges] organization notice:", err);
    }
  }
}

/** Tells the organization a vendor paid more than they owed (nothing is refunded automatically). */
export async function overpaidNotice(v: Vendor, paidCents: number, owedCents: number) {
  const extra = fmtMoney(paidCents - owedCents, "$0.00");
  const text = `${v.company} paid ${fmtMoney(paidCents, "$0.00")} for the ${boughtLabel(v)} when ${fmtMoney(owedCents, "$0.00")} was owed. Refund ${extra} in your Stripe dashboard.`;
  await orgVendorNotice(v, `refund needed for ${v.company}`, "A refund is needed", text);
}

/** "insufficient_funds" -> "Insufficient funds" */
export const reasonWords = (s: string | null | undefined) => {
  const t = String(s || "").replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

function clearNextCharge(vendorId: number) {
  getDb().update(schema.vendors).set({ nextChargeCents: 0, nextChargeOn: null, nextChargeReminderAt: null, nextChargeError: "" }).where(eq(schema.vendors.id, vendorId)).run();
}

/** waiting: a pay link payment is open, so nothing was charged. */
export type ChargeResult = { status: "paid" | "pending" | "failed" | "nothing" | "waiting"; error?: string };

/** Shown on a scheduled charge Stripe did not answer for (a timeout): the webhook or the next try settles it. */
export const UNCONFIRMED_NOTE = "Waiting for Stripe to confirm";

/** Whether a Stripe error means the charge was turned down (not a timeout or outage, where it may have gone through). */
function definiteFailure(err: unknown) {
  const e = err as { type?: string; raw?: { type?: string; payment_intent?: unknown }; payment_intent?: unknown };
  if (e.raw?.payment_intent || e.payment_intent) return true;
  if (["StripeCardError", "StripeInvalidRequestError", "StripePermissionError", "StripeAuthenticationError"].includes(e.type ?? "")) return true;
  return ["card_error", "invalid_request_error"].includes(e.raw?.type ?? "");
}

/**
 * Before the scheduled charge: a pay link session that is still open means
 * the vendor may be paying right now, so the charge waits. Once it is past its
 * expiry it is checked (a finished one is recorded first) and expired at
 * Stripe to be sure, then forgotten. Returns true when the charge must wait.
 */
async function payLinkOpen(v: Vendor, account: string, now: Date) {
  if (!v.paySessionId) return false;
  if (v.paySessionExpiresAt && new Date(v.paySessionExpiresAt).getTime() > now.getTime()) return true;
  try {
    const s = await vstripe().checkout.sessions.retrieve(v.paySessionId, {}, { stripeAccount: account });
    if (s.status === "complete") {
      const { completeBalance } = await import("./vendorCheckout");
      await completeBalance(v.id, s, account);
    } else if (s.status === "open") {
      await vstripe().checkout.sessions.expire(v.paySessionId, {}, { stripeAccount: account });
    }
  } catch (err) {
    console.error("[vendor charges] pay link check:", err);
    return true;
  }
  getDb().update(schema.vendors).set({ paySessionId: null, paySessionExpiresAt: null }).where(and(eq(schema.vendors.id, v.id), eq(schema.vendors.paySessionId, v.paySessionId))).run();
  return false;
}

/**
 * Charges what is scheduled (or what is owed, for Charge now) to the saved
 * payment method, off session. A pending row is written first, so two runs
 * can never charge twice. The idempotency key is the same for every try of
 * one attempt (vendor, due date, attempt number); a try Stripe did not answer
 * keeps its pending row and key, so the next try (or Charge now) gets the same
 * PaymentIntent back instead of a second charge. Bank payments stay pending
 * until payment_intent.succeeded.
 */
export async function chargeBalance(vendorId: number, now = new Date()): Promise<ChargeResult> {
  const db = getDb();
  let v = db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get();
  if (!v || v.status === "cancelled") return { status: "nothing" };
  const ev = eventOf(v.eventId);
  const acct = accountRow(ev.orgId);
  if (acct && (await payLinkOpen(v, acct.accountId, now))) return { status: "waiting", error: "A payment from the pay link is open. Try again in an hour." };
  v = db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get()!;
  const payments = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
  const balanceRows = payments.filter((p) => p.purpose === "balance");
  const unconfirmed = balanceRows.find((p) => p.status === "pending" && !p.stripePaymentIntentId && !!p.stripeIdempotencyKey);
  if (!unconfirmed && balanceRows.some((p) => p.status === "pending")) return { status: "pending" };
  const owed = vendorMoney(v, payments).owedCents;
  if (!unconfirmed && owed <= 0) {
    if (v.nextChargeCents > 0) clearNextCharge(v.id);
    return { status: "nothing" };
  }
  const today = eventToday(ev, now);
  const amount = unconfirmed ? unconfirmed.amountCents : v.nextChargeCents > 0 ? Math.min(v.nextChargeCents, owed) : owed;
  const isBank = unconfirmed ? unconfirmed.method === "bank" : /^bank/i.test(v.payMethodLabel);
  const key = unconfirmed?.stripeIdempotencyKey ?? `vendor-balance-${v.id}-${v.nextChargeOn ?? today}-${balanceRows.length + 1}`;
  const vendor = v;

  const fail = async (rowId: number | null, reason: string, piId?: string | null) => {
    const clean = reason.slice(0, 300) || "The payment was declined";
    if (rowId) db.update(schema.vendorPayments).set({ status: "failed", failureReason: clean, note: "", ...(piId ? { stripePaymentIntentId: piId } : {}) }).where(eq(schema.vendorPayments.id, rowId)).run();
    db.update(schema.vendors).set({ nextChargeError: clean }).where(eq(schema.vendors.id, vendor.id)).run();
    syncPaid(vendor.id);
    try {
      await paymentFailedEmails(vendor, amount, clean);
    } catch (err) {
      console.error("[vendor charges] failure emails:", err);
    }
    return { status: "failed" as const, error: clean };
  };

  // A try Stripe did not answer may still have charged: it is never marked failed here, only settled by Stripe.
  const notNow = (reason: string) => (unconfirmed ? { status: "pending" as const, error: `${reason}. The last charge is still waiting for Stripe to confirm.` } : fail(null, reason));
  if (!vendor.stripeCustomerId || !vendor.stripePaymentMethodId) return notNow("No saved payment method");
  if (!acct || !acct.chargesEnabled) return notNow("Stripe is not connected");
  const row =
    unconfirmed ??
    db
      .insert(schema.vendorPayments)
      .values({ eventId: vendor.eventId, vendorId: vendor.id, amountCents: amount, method: isBank ? "bank" : "card", status: "pending", purpose: "balance", paidOn: today, reference: vendor.payMethodLabel, stripeAccountId: acct.accountId, stripeIdempotencyKey: key })
      .returning()
      .get();
  let pi: Stripe.PaymentIntent;
  try {
    const fee = platformFee(amount);
    pi = await vstripe().paymentIntents.create(
      {
        amount,
        currency: "usd",
        customer: vendor.stripeCustomerId,
        payment_method: vendor.stripePaymentMethodId,
        allowed_payment_method_types: [isBank ? "us_bank_account" : "card"],
        confirm: true,
        off_session: true,
        ...(fee > 0 ? { application_fee_amount: fee } : {}),
        description: `${ev.name}: ${boughtLabel(vendor)} for ${vendor.company}`,
        ...(vendor.email ? { receipt_email: vendor.email } : {}),
        metadata: { leaddash_vendor_id: String(vendor.id), leaddash_event_id: String(ev.id), leaddash_charge_key: key },
      },
      { stripeAccount: acct.accountId, idempotencyKey: key }
    );
  } catch (err) {
    const e = err as { message?: string; raw?: { payment_intent?: { id?: string } }; payment_intent?: { id?: string } };
    if (definiteFailure(err)) return fail(row.id, e.message || "The payment was declined", e.raw?.payment_intent?.id ?? e.payment_intent?.id ?? null);
    // A timeout or outage: Stripe may have charged. The row stays pending with its key; the webhook or the next try settles it.
    console.error("[vendor charges] charge not confirmed:", err);
    db.update(schema.vendorPayments).set({ note: UNCONFIRMED_NOTE }).where(eq(schema.vendorPayments.id, row.id)).run();
    return { status: "pending", error: "Stripe has not confirmed this charge yet. It updates on its own, so do not charge again." };
  }
  db.update(schema.vendorPayments).set({ stripePaymentIntentId: pi.id, note: "" }).where(eq(schema.vendorPayments.id, row.id)).run();
  if (pi.status === "succeeded" || pi.status === "processing") {
    db.update(schema.vendorPayments).set({ status: pi.status === "succeeded" ? "paid" : "pending" }).where(eq(schema.vendorPayments.id, row.id)).run();
    clearNextCharge(vendor.id);
    syncPaid(vendor.id);
    return { status: pi.status === "succeeded" ? "paid" : "pending" };
  }
  const reason = pi.last_payment_error?.message || (pi.status === "requires_action" ? "The bank or card asked the payer to confirm this payment" : "The payment was declined");
  return fail(row.id, reason, pi.id);
}

/**
 * Minute job: the reminder 7 days before nextChargeOn (once), then the charge
 * on or after the date (once; a failed charge waits for staff to Charge now or
 * change the date). Also tells the organization once when an invoice hold
 * ended with nothing paid. Dates are the event's calendar dates.
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
  await runHoldNotices(now);
  return n;
}

/** Whether an invoice hold has ended (after its date, in the event's time zone) with nothing paid or clearing. */
export function holdLapsed(v: Pick<Vendor, "holdUntil" | "status">, payments: Pick<VendorPayment, "status" | "amountCents">[], today: string) {
  if (!v.holdUntil || v.status === "cancelled" || today <= v.holdUntil) return false;
  return !payments.some((p) => (p.status === "paid" || p.status === "pending") && p.amountCents > 0);
}

/** Tells the organization, once, that an invoice hold ended with nothing paid. The sponsor or exhibitor stays on the list. */
async function runHoldNotices(now: Date) {
  const db = getDb();
  const held = db.select().from(schema.vendors).where(isNull(schema.vendors.holdNoticeAt)).all().filter((v) => v.holdUntil && v.status !== "cancelled");
  for (const v of held) {
    try {
      const ev = eventOf(v.eventId);
      const payments = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
      if (!holdLapsed(v, payments, eventToday(ev, now))) continue;
      const claimed = db.update(schema.vendors).set({ holdNoticeAt: now }).where(and(eq(schema.vendors.id, v.id), isNull(schema.vendors.holdNoticeAt))).run().changes === 1;
      if (!claimed) continue;
      const kind = isSponsor(v) ? "sponsor" : "exhibitor";
      const text = `The invoice hold for ${v.company} (${boughtLabel(v)}) ended ${fmtDate(v.holdUntil)} and nothing has been paid. The ${isSponsor(v) ? "package" : "booth"} is open for others to buy again. The ${kind} is still on your list: send the invoice again, record a payment, or set Status to Cancelled.`;
      await orgVendorNotice(v, `invoice hold ended for ${v.company}`, "An invoice hold ended", text);
    } catch (err) {
      console.error(`[vendor charges] hold notice ${v.id}:`, err);
    }
  }
}

/**
 * payment_intent.succeeded / payment_failed for a vendor payment (bank
 * payments clearing or failing, and scheduled charges Stripe did not answer
 * for, found by the charge key in the metadata). Null when it is not a vendor payment.
 */
export async function handleVendorPaymentIntent(type: "payment_intent.succeeded" | "payment_intent.payment_failed", pi: Stripe.PaymentIntent, account: string | null) {
  const db = getDb();
  let row = db
    .select()
    .from(schema.vendorPayments)
    .where(and(eq(schema.vendorPayments.stripePaymentIntentId, pi.id), eq(schema.vendorPayments.stripeAccountId, account ?? "")))
    .get();
  const key = pi.metadata?.leaddash_charge_key;
  if (!row && key) {
    const byKey = db
      .select()
      .from(schema.vendorPayments)
      .where(and(eq(schema.vendorPayments.stripeIdempotencyKey, key), eq(schema.vendorPayments.stripeAccountId, account ?? "")))
      .get();
    if (byKey && String(byKey.vendorId) === pi.metadata?.leaddash_vendor_id && !byKey.stripePaymentIntentId) {
      db.update(schema.vendorPayments).set({ stripePaymentIntentId: pi.id, note: "" }).where(eq(schema.vendorPayments.id, byKey.id)).run();
      row = { ...byKey, stripePaymentIntentId: pi.id, note: "" };
    }
  }
  if (!row) return null;
  if (type === "payment_intent.succeeded") {
    if (row.status !== "pending") return "ignored";
    db.update(schema.vendorPayments).set({ status: "paid", note: "" }).where(and(eq(schema.vendorPayments.id, row.id), eq(schema.vendorPayments.status, "pending"))).run();
    if (row.purpose === "balance") clearNextCharge(row.vendorId);
    syncPaid(row.vendorId);
    return "vendor_paid";
  }
  if (row.status !== "pending") return "ignored";
  const reason = pi.last_payment_error?.message || reasonWords(pi.last_payment_error?.code) || "The payment was declined";
  const won = db.update(schema.vendorPayments).set({ status: "failed", failureReason: reason.slice(0, 300), note: "" }).where(and(eq(schema.vendorPayments.id, row.id), eq(schema.vendorPayments.status, "pending"))).run().changes === 1;
  if (!won) return "ignored";
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, row.vendorId)).get();
  if (!v) return "ignored";
  if (row.purpose === "balance") db.update(schema.vendors).set({ nextChargeError: reason.slice(0, 300) }).where(eq(schema.vendors.id, v.id)).run();
  syncPaid(v.id);
  await paymentFailedEmails(v, row.amountCents, reason);
  return "vendor_failed";
}

/**
 * charge.refunded for a vendor payment: a full refund marks the payment
 * refunded, a partial one lowers it to what was kept. The vendor owes the
 * refunded amount again and the organization is told. Null when it is not a vendor payment.
 */
export async function handleVendorRefund(c: Stripe.Charge, account: string | null) {
  const db = getDb();
  const piId = typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id;
  if (!piId) return null;
  const row = db
    .select()
    .from(schema.vendorPayments)
    .where(and(eq(schema.vendorPayments.stripePaymentIntentId, piId), eq(schema.vendorPayments.stripeAccountId, account ?? "")))
    .get();
  if (!row) return null;
  if (row.status === "refunded" || row.status === "failed") return "ignored";
  const full = c.refunded || c.amount_refunded >= c.amount;
  const kept = Math.max(0, c.amount - c.amount_refunded);
  const note = full ? "" : `Partly refunded: ${fmtMoney(c.amount_refunded, "$0.00")}`;
  if (full) db.update(schema.vendorPayments).set({ status: "refunded" }).where(eq(schema.vendorPayments.id, row.id)).run();
  else if (row.amountCents !== kept) db.update(schema.vendorPayments).set({ amountCents: kept, note }).where(eq(schema.vendorPayments.id, row.id)).run();
  else return "ignored";
  syncPaid(row.vendorId);
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, row.vendorId)).get();
  if (v) {
    const payments = db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
    const owed = vendorMoney(v, payments).owedCents;
    const text = `${fmtMoney(c.amount_refunded, "$0.00")} of the ${fmtMoney(c.amount, "$0.00")} payment from ${v.company} (${boughtLabel(v)}) was refunded in Stripe. They now owe ${fmtMoney(owed, "$0.00")}.`;
    await orgVendorNotice(v, `refund for ${v.company}`, "A payment was refunded", text);
  }
  return "vendor_refunded";
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
