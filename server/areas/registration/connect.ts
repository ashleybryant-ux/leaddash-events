/**
 * Stripe Connect for an organization, set up the same way as LeadDash EHR
 * (stripeConnect.js, decision 2026-09-18):
 *
 * - LeadDash's platform account and its Connect app (STRIPE_SECRET_KEY,
 *   STRIPE_CONNECT_CLIENT_ID) are shared with LeadDash EHR.
 * - The organization connects its OWN Stripe account (Standard) once, through
 *   Stripe's "Connect with Stripe" screen (OAuth, read_write). No keys are
 *   copied by hand. It can sign in to an existing account or create one there.
 * - Every ticket is a direct charge on the organization's account: it is the
 *   merchant of record, the money pays out to its bank, and disputes are its
 *   own, answered from its Stripe dashboard.
 * - LeadDash's optional fee rides on the charge as an application fee.
 *
 * Ways to pay: Checkout uses dynamic payment methods, so card, Apple Pay,
 * Google Pay, Klarna and Afterpay appear automatically when they are turned
 * on in the organization's own Stripe dashboard (Settings, Payment methods)
 * and the buyer is eligible. We read the account's capabilities to show
 * which are on.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../_core/db";
import { ENV } from "../../_core/env";
import { safeEqual, sign } from "../../_core/crypto";
import { stripe, stripeConfigured, type Stripe } from "./stripe";

export function accountRow(orgId: number) {
  return getDb().select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.orgId, orgId)).get();
}

export const connectReady = () => stripeConfigured() && !!ENV.stripeConnectClientId;
export const connectRedirectUri = () => ENV.stripeConnectRedirect || `${ENV.appUrl}/api/stripe/connect/callback`;

const STATE_MINUTES = 30;

/** A signed state that says which organization started the connection and when. */
export function signState(orgId: number, userId: number, at = Date.now()) {
  const body = `${orgId}.${userId}.${at}`;
  return `${body}.${sign(`stripe-connect:${body}`)}`;
}

export function verifyState(state: string) {
  const [orgId, userId, at, sig] = String(state || "").split(".");
  if (!orgId || !userId || !at || !sig) return null;
  if (!safeEqual(sig, sign(`stripe-connect:${orgId}.${userId}.${at}`))) return null;
  if (Date.now() - Number(at) > STATE_MINUTES * 60_000) return null;
  return { orgId: Number(orgId), userId: Number(userId) };
}

/** Stripe's "Connect with Stripe" page for this organization. */
export function connectUrl(orgId: number, userId: number) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).get();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: ENV.stripeConnectClientId,
    scope: "read_write",
    state: signState(orgId, userId),
    redirect_uri: connectRedirectUri(),
    stripe_landing: "login",
  });
  if (org?.name) q.set("stripe_user[business_name]", org.name);
  return `https://connect.stripe.com/oauth/authorize?${q}`;
}

/** Stripe sent the organization back with a code: exchange it and keep the account id. */
export async function finishConnect(code: string, state: string) {
  const who = verifyState(state);
  if (!who) throw new Error("This connection did not start from LeadDash Events, or it took longer than 30 minutes. Start again.");
  const t = await stripe().oauth.token({ grant_type: "authorization_code", code });
  const accountId = t.stripe_user_id;
  if (!accountId) throw new Error("Stripe did not return an account.");
  const db = getDb();
  const values = { orgId: who.orgId, accountId, connectedVia: "oauth", livemode: t.livemode !== false, connectedAt: new Date(), updatedAt: new Date() };
  db.insert(schema.stripeAccounts)
    .values(values)
    .onConflictDoUpdate({ target: schema.stripeAccounts.orgId, set: values })
    .run();
  try {
    await refreshAccount(who.orgId);
  } catch (err) {
    console.error("[stripe] status after connect failed:", (err as Error).message);
  }
  return { orgId: who.orgId, accountId, userId: who.userId };
}

/** Stops LeadDash's access to the account in Stripe, then forgets it. Nothing else changes in the organization's Stripe account. */
export async function disconnectAccount(orgId: number) {
  const row = accountRow(orgId);
  if (!row) return;
  if (row.connectedVia === "oauth" && ENV.stripeConnectClientId) {
    try {
      await stripe().oauth.deauthorize({ client_id: ENV.stripeConnectClientId, stripe_user_id: row.accountId });
    } catch (err) {
      console.warn("[stripe] deauthorize answered:", (err as Error).message);
    }
  }
  getDb().delete(schema.stripeAccounts).where(eq(schema.stripeAccounts.orgId, orgId)).run();
}

const cap = (v: unknown) => (typeof v === "string" ? v : "");

/** Copies what Stripe says about the account onto our row. */
export function saveAccountStatus(a: Stripe.Account, bankLast4?: string) {
  const db = getDb();
  const row = db.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.accountId, a.id)).get();
  if (!row) return null;
  const banks = a.external_accounts?.data ?? [];
  const bank = banks.find((b) => b.object === "bank_account") ?? banks[0];
  const last4 = bankLast4 ?? (bank && "last4" in bank ? bank.last4 : "") ?? "";
  const caps = (a.capabilities ?? {}) as Record<string, unknown>;
  db.update(schema.stripeAccounts)
    .set({
      chargesEnabled: !!a.charges_enabled,
      payoutsEnabled: !!a.payouts_enabled,
      detailsSubmitted: !!a.details_submitted,
      businessName: a.business_profile?.name || a.settings?.dashboard?.display_name || row.businessName,
      bankLast4: last4 || row.bankLast4,
      payoutInterval: a.settings?.payouts?.schedule?.interval ?? row.payoutInterval,
      statementDescriptor: a.settings?.payments?.statement_descriptor || row.statementDescriptor,
      // "ach" (bank account payments for sponsors and exhibitors) rides in the same json column.
      payMethods: { card: cap(caps.card_payments), klarna: cap(caps.klarna_payments), afterpay: cap(caps.afterpay_clearpay_payments), ach: cap(caps.us_bank_account_ach_payments) } as typeof row.payMethods,
      connectedAt: row.connectedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.stripeAccounts.id, row.id))
    .run();
  return db.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.id, row.id)).get();
}

/** Asks Stripe for the account's current state. */
export async function refreshAccount(orgId: number) {
  const row = accountRow(orgId);
  if (!row) return null;
  const a = await stripe().accounts.retrieve(row.accountId);
  let last4: string | undefined;
  try {
    // Platforms cannot always read bank details of Standard accounts.
    const list = await stripe().accounts.listExternalAccounts(row.accountId, { limit: 3 });
    const bank = list.data.find((b) => b.object === "bank_account") ?? list.data[0];
    if (bank && "last4" in bank) last4 = bank.last4 ?? undefined;
  } catch {
    last4 = undefined;
  }
  return saveAccountStatus(a, last4);
}

/** Public view of the account for admin screens. */
export function accountView(orgId: number) {
  const row = accountRow(orgId);
  if (!row) return { connected: false as const, stripeReady: connectReady() };
  return {
    connected: true as const,
    stripeReady: connectReady(),
    accountId: row.accountId,
    businessName: row.businessName,
    chargesEnabled: row.chargesEnabled,
    payoutsEnabled: row.payoutsEnabled,
    detailsSubmitted: row.detailsSubmitted,
    bankLast4: row.bankLast4,
    payoutInterval: row.payoutInterval,
    statementDescriptor: row.statementDescriptor,
    refundPolicy: row.refundPolicy,
    payMethods: row.payMethods,
    livemode: row.livemode,
    connectedAt: row.connectedAt,
    fee: { cents: ENV.platformFeeCents, percent: ENV.platformFeePercent },
  };
}
