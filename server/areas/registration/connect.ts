/**
 * Stripe Connect for an association: its own Stripe account (full Stripe
 * Dashboard) is the merchant of record, so ticket money goes straight to it.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../_core/db";
import { ENV } from "../../_core/env";
import { stripe, stripeConfigured, type Stripe } from "./stripe";

export function accountRow(orgId: number) {
  return getDb().select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.orgId, orgId)).get();
}

/** Starts (or continues) Stripe onboarding and returns the one-time Stripe link. */
export async function onboardingLink(orgId: number) {
  const db = getDb();
  let row = accountRow(orgId);
  if (!row) {
    const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).get()!;
    const acct = await stripe().accounts.create({
      controller: {
        stripe_dashboard: { type: "full" },
        fees: { payer: "account" },
        losses: { payments: "stripe" },
        requirement_collection: "stripe",
      },
      business_profile: { name: org.name },
      metadata: { leaddash_org_id: String(orgId) },
    });
    row = db
      .insert(schema.stripeAccounts)
      .values({ orgId, accountId: acct.id, businessName: org.name, updatedAt: new Date() })
      .returning()
      .get();
  }
  const link = await stripe().accountLinks.create({
    account: row.accountId,
    type: "account_onboarding",
    refresh_url: `${ENV.appUrl}/admin/payments?stripe=refresh`,
    return_url: `${ENV.appUrl}/admin/payments?stripe=return`,
    collection_options: { fields: "eventually_due" },
  });
  return link.url;
}

/** Copies what Stripe says about the account onto our row. */
export function saveAccountStatus(a: Stripe.Account, bankLast4?: string) {
  const db = getDb();
  const row = db.select().from(schema.stripeAccounts).where(eq(schema.stripeAccounts.accountId, a.id)).get();
  if (!row) return null;
  const banks = a.external_accounts?.data ?? [];
  const bank = banks.find((b) => b.object === "bank_account") ?? banks[0];
  const last4 = bankLast4 ?? (bank && "last4" in bank ? bank.last4 : "") ?? "";
  db.update(schema.stripeAccounts)
    .set({
      chargesEnabled: !!a.charges_enabled,
      payoutsEnabled: !!a.payouts_enabled,
      detailsSubmitted: !!a.details_submitted,
      businessName: a.business_profile?.name || a.settings?.dashboard?.display_name || row.businessName,
      bankLast4: last4 || row.bankLast4,
      payoutInterval: a.settings?.payouts?.schedule?.interval ?? row.payoutInterval,
      statementDescriptor: a.settings?.payments?.statement_descriptor || row.statementDescriptor,
      connectedAt: row.connectedAt ?? (a.charges_enabled ? new Date() : null),
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
    // Platforms cannot always read bank details of accounts with their own Stripe Dashboard.
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
  if (!row) return { connected: false as const, stripeReady: stripeConfigured() };
  return {
    connected: true as const,
    stripeReady: stripeConfigured(),
    accountId: row.accountId,
    businessName: row.businessName,
    chargesEnabled: row.chargesEnabled,
    payoutsEnabled: row.payoutsEnabled,
    detailsSubmitted: row.detailsSubmitted,
    bankLast4: row.bankLast4,
    payoutInterval: row.payoutInterval,
    statementDescriptor: row.statementDescriptor,
    refundPolicy: row.refundPolicy,
    connectedAt: row.connectedAt,
    fee: { cents: ENV.platformFeeCents, percent: ENV.platformFeePercent },
  };
}
