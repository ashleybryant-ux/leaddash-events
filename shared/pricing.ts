/**
 * Ticket prices by date: an optional early bird price until a date, the
 * regular price, and an optional late price from a date. Each buyer type
 * (Member, Non-member...) can have its own three prices.
 */

export type PriceSet = { early: number | null; regular: number; late: number | null };
export type PriceDates = { earlyEndsOn: string | null; lateStartsOn: string | null };
export type Phase = "early" | "regular" | "late";

/** One buyer choice on the checkout page. */
export type BuyerType = { id: string; name: string; memberId: boolean; school: boolean; code: string };

export const PHASE_LABEL: Record<Phase, string> = { early: "Early bird", regular: "Regular", late: "Late" };

const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / 86_400_000);
const isoOf = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) => isoOf(dayNum(iso) + days);
export const daysBetween = (from: string, to: string) => dayNum(to) - dayNum(from);

/** Which price applies on a calendar date ("2026-10-10"), in the event's time zone. */
export function phaseOn(d: PriceDates, set: PriceSet, today: string): Phase {
  if (set.early != null && d.earlyEndsOn && today <= d.earlyEndsOn) return "early";
  if (set.late != null && d.lateStartsOn && today >= d.lateStartsOn) return "late";
  return "regular";
}

export function centsFor(set: PriceSet, phase: Phase) {
  return phase === "early" ? (set.early ?? set.regular) : phase === "late" ? (set.late ?? set.regular) : set.regular;
}

export type PriceStep = { phase: Phase; cents: number; from: string | null; until: string | null; now: boolean };

/**
 * The price a buyer pays today, what it would be without early bird (to cross
 * out), and every step in order for the price line on the checkout page.
 */
export function priceView(d: PriceDates, set: PriceSet, today: string) {
  const phase = phaseOn(d, set, today);
  const steps: PriceStep[] = [];
  const hasEarly = set.early != null && !!d.earlyEndsOn;
  const hasLate = set.late != null && !!d.lateStartsOn;
  if (hasEarly && today <= d.earlyEndsOn!) steps.push({ phase: "early", cents: set.early!, from: null, until: d.earlyEndsOn, now: phase === "early" });
  const regFrom = hasEarly ? addDays(d.earlyEndsOn!, 1) : null;
  const regUntil = hasLate ? addDays(d.lateStartsOn!, -1) : null;
  if (!(hasLate && today >= d.lateStartsOn!)) steps.push({ phase: "regular", cents: set.regular, from: regFrom, until: regUntil, now: phase === "regular" });
  if (hasLate) steps.push({ phase: "late", cents: set.late!, from: d.lateStartsOn, until: null, now: phase === "late" });
  const cents = centsFor(set, phase);
  return { phase, cents, regularCents: set.regular, saveCents: phase === "early" ? Math.max(0, set.regular - cents) : 0, steps };
}

/** A buyer type's own prices, or the ticket's base prices. */
export function setFor(t: { priceCents: number; earlyPriceCents: number | null; latePriceCents: number | null; buyerPrices: Record<string, PriceSet> }, buyerTypeId: string | null | undefined): PriceSet {
  const own = buyerTypeId ? t.buyerPrices[buyerTypeId] : undefined;
  return own ?? { early: t.earlyPriceCents, regular: t.priceCents, late: t.latePriceCents };
}

/** "member" from "Member", "student-member" from "Student member". */
export const buyerTypeId = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "buyer";
