/** Helpers shared by the registration screens (admin and public). */
import { useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import type { RouterOutputs } from "../../lib/trpc";

export type PublicPage = RouterOutputs["registration"]["page"];
export type Offer = PublicPage["tickets"][number];
export type Question = PublicPage["page"]["questions"][number];

export type Buyer = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  credentials: string;
  licenseNumber: string;
  licenseState: string;
  answers: Record<string, string>;
  textConsent: boolean;
};

export const emptyBuyer = (): Buyer => ({ firstName: "", lastName: "", email: "", phone: "", credentials: "", licenseNumber: "", licenseState: "", answers: {}, textConsent: false });

/** What the buyer picked and typed, kept between the Register and Pay steps. */
export type Draft = { ticketId: number; buyer: Buyer; coupon?: string };

const drafts = new Map<string, Draft>();
const draftKey = (slug: string) => `ld-checkout:${slug}`;

export function saveDraft(slug: string, d: Draft) {
  drafts.set(slug, d);
  try {
    sessionStorage.setItem(draftKey(slug), JSON.stringify(d));
  } catch {
    /* private window: the in-memory copy is enough within this tab */
  }
}

export function loadDraft(slug: string): Draft | null {
  const mem = drafts.get(slug);
  if (mem) return mem;
  try {
    const raw = sessionStorage.getItem(draftKey(slug));
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return d && typeof d.ticketId === "number" && d.buyer ? { ...d, buyer: { ...emptyBuyer(), ...d.buyer } } : null;
  } catch {
    return null;
  }
}

export function clearDraft(slug: string) {
  drafts.delete(slug);
  try {
    sessionStorage.removeItem(draftKey(slug));
  } catch {
    /* nothing to clear */
  }
}

/** One Stripe.js instance per connected account (direct charges run on the association's account). */
const stripes = new Map<string, Promise<Stripe | null>>();
export function stripeFor(publishableKey: string, accountId: string) {
  const key = `${publishableKey}:${accountId}`;
  if (!stripes.has(key)) stripes.set(key, loadStripe(publishableKey, { stripeAccount: accountId }));
  return stripes.get(key)!;
}

/** "$249.00", "249", "249.5" to cents. Empty is null; anything else is NaN. */
export function parseMoney(s: string): number | null {
  const clean = s.replace(/[$,\s]/g, "");
  if (!clean) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return NaN;
  return Math.round(parseFloat(clean) * 100);
}

export const centsToInput = (cents: number | null | undefined) => (cents ? (cents / 100).toFixed(2) : "0.00");

/** The value after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Inside the website embed: tells the parent page how tall the form is so the frame fits it. */
export function useEmbedHeight(enabled: boolean) {
  useEffect(() => {
    if (!enabled || window.parent === window) return;
    const post = () => window.parent.postMessage({ type: "leaddash-checkout:height", height: document.documentElement.scrollHeight }, "*");
    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    const t = setInterval(post, 1000);
    return () => {
      ro.disconnect();
      clearInterval(t);
    };
  }, [enabled]);
}

/** Numbered step (the green circle with a number). */
export function StepNumber({ n, size = 24 }: { n: number; size?: number }) {
  return (
    <span style={{ width: size, height: size, flexShrink: 0, borderRadius: size / 2, background: "var(--brand)", color: "#FFFFFF", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {n}
    </span>
  );
}

export function IconShare({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12M7 8l5-5 5 5" />
      <path d="M5 12v8h14v-8" />
    </svg>
  );
}

export function IconStripeCard({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19M6 15h4" />
    </svg>
  );
}
