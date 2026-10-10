/**
 * The Stripe client for LeadDash's platform account. Every payment call runs
 * on the association's connected account (direct charges) by passing
 * `{ stripeAccount }` as the request option.
 *
 * Tests swap the client with setStripeClient() so nothing calls the real API.
 */
import Stripe from "stripe";
import { TRPCError } from "@trpc/server";
import { ENV } from "../../_core/env";

/** The parts of the Stripe client this area uses (so tests can hand in a small fake). */
export type StripeLike = {
  accounts: Pick<Stripe["accounts"], "retrieve" | "update" | "listExternalAccounts">;
  oauth: Pick<Stripe["oauth"], "token" | "deauthorize">;
  checkout: { sessions: Pick<Stripe["checkout"]["sessions"], "create" | "retrieve"> };
  refunds: Pick<Stripe["refunds"], "create">;
  webhooks: Pick<Stripe["webhooks"], "constructEvent">;
};

let override: StripeLike | null = null;
let real: Stripe | null = null;

export function setStripeClient(client: StripeLike | null) {
  override = client;
}

export const stripeConfigured = () => !!override || !!ENV.stripeSecret;

/** The client, or a clear error when STRIPE_SECRET_KEY is not set on the server. */
export function stripe(): StripeLike {
  if (override) return override;
  if (!ENV.stripeSecret) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Stripe is not set up on the server yet (STRIPE_SECRET_KEY)." });
  real ||= new Stripe(ENV.stripeSecret, { appInfo: { name: "LeadDash Events", url: "https://events.leaddash.io" } });
  return real;
}

/** Webhook signature checks need no API key, so they work even before the key is set. */
export function webhookVerifier(): Pick<Stripe["webhooks"], "constructEvent"> {
  if (override) return override.webhooks;
  return (real ?? new Stripe(ENV.stripeSecret || "sk_unset")).webhooks;
}

/** LeadDash's fee on a paid ticket: PLATFORM_FEE_CENTS plus PLATFORM_FEE_PERCENT, never more than the payment. */
export function platformFee(amountCents: number) {
  if (amountCents <= 0) return 0;
  const fee = Math.max(0, ENV.platformFeeCents) + Math.round((amountCents * Math.max(0, ENV.platformFeePercent)) / 100);
  return Math.min(fee, amountCents);
}

export type { Stripe };
