/**
 * Filling an agreement: the {Field name} tokens in a template body become the
 * values for one sponsor, exhibitor, checkout buyer or speaker.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../../_core/db";
import { escapeHtml } from "../../_core/email";
import { fmtDate, fmtDates, fmtMoney, fmtTime } from "@shared/format";
import type { AgreementTemplate, AgreementValues, VendorCheckout } from "../../../drizzle/schema";
import { DATE_VALUES, type AgreementKind } from "./templates";

type EventRow = typeof schema.events.$inferSelect;
type Vendor = typeof schema.vendors.$inferSelect;
type Speaker = typeof schema.speakers.$inferSelect;

/** What an empty or unknown field shows: a blank line to write on, never the raw {token}. */
export const BLANK = "__________";

const TOKEN = /\{([^{}<>\n]{1,60})\}/g;

/**
 * Replaces every {Field name} in a (cleaned) template body with its value.
 * Values are plain text and are escaped. Empty or unknown fields become a blank line.
 */
export function fillAgreement(body: string, values: AgreementValues): string {
  return body.replace(TOKEN, (_m, name: string) => {
    const v = (values[name.trim()] ?? "").trim();
    return v ? escapeHtml(v) : BLANK;
  });
}

/** Field names used in a body, in order, each once. */
export function fieldsIn(body: string) {
  const out: string[] = [];
  for (const m of body.matchAll(TOKEN)) if (!out.includes(m[1].trim())) out.push(m[1].trim());
  return out;
}

const lowerFirst = (s: string) => (s && !/^[A-Z]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/** "a, b and c" */
export function listWords(items: string[]) {
  const list = items.map((s) => s.trim()).filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** Organization-set values as they read in the agreement (dates with the year). */
export function templateValues(t: Pick<AgreementTemplate, "values">): AgreementValues {
  const out: AgreementValues = {};
  for (const [k, v] of Object.entries(t.values ?? {})) out[k] = DATE_VALUES.has(k) && /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : v;
  return out;
}

/** Organization name, Event name, Event dates and Venue. */
export function eventValues(event: EventRow): AgreementValues {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, event.orgId)).get();
  return {
    "Organization name": org?.name ?? "",
    "Event name": event.name,
    "Event dates": fmtDates(event.startDate, event.endDate),
    Venue: event.venueName || event.city,
  };
}

/** The sentence for Payment terms. */
export function paymentTerms(opts: { option: "full" | "deposit" | "invoice"; totalCents: number; dueTodayCents?: number; balanceDueOn?: string | null; dueBy?: string | null }) {
  const total = fmtMoney(opts.totalCents, "$0.00");
  if (opts.option === "deposit") {
    const today = opts.dueTodayCents ?? 0;
    return `A deposit of ${fmtMoney(today, "$0.00")} is paid today and the remaining ${fmtMoney(opts.totalCents - today, "$0.00")} is charged automatically to the same payment method on ${opts.balanceDueOn ? fmtDate(opts.balanceDueOn) : BLANK}`;
  }
  if (opts.option === "invoice") return `The full amount of ${total} is due by ${opts.dueBy ? fmtDate(opts.dueBy) : BLANK}`;
  return `The full amount of ${total} is paid today`;
}

const addonWords = (lines: { name: string; qty: number }[]) =>
  lines.length ? listWords(lines.map((l) => (l.qty > 1 ? `${l.qty} ${lowerFirst(l.name)}` : lowerFirst(l.name)))) : "none";

function packageValues(pkgId: number | null | undefined, fallbackName: string, fallbackCents: number) {
  const pkg = pkgId ? getDb().select().from(schema.vendorPackages).where(eq(schema.vendorPackages.id, pkgId)).get() : undefined;
  return {
    pkg,
    values: {
      "Package name": pkg?.name || fallbackName,
      "Package price": fmtMoney(pkg ? pkg.priceCents : fallbackCents, "$0.00"),
      "Package benefits": pkg ? listWords(pkg.benefits.map(lowerFirst)) : "",
    } as AgreementValues,
  };
}

/** Payment terms for a sponsor or exhibitor added by staff: from what was paid and what is still owed. */
function vendorTerms(v: Vendor) {
  const payments = getDb().select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, v.id)).all();
  const paid = payments.length ? payments.filter((p) => p.status === "paid" || p.status === "pending").reduce((n, p) => n + p.amountCents, 0) : v.paidCents;
  const owed = Math.max(0, v.amountCents - paid);
  if (!v.amountCents) return "";
  if (!owed) return `The full amount of ${fmtMoney(v.amountCents, "$0.00")} has been paid`;
  if (paid > 0 && v.nextChargeCents > 0 && v.nextChargeOn) return `A deposit of ${fmtMoney(paid, "$0.00")} was paid and the remaining ${fmtMoney(owed, "$0.00")} is charged automatically to the same payment method on ${fmtDate(v.nextChargeOn)}`;
  if (paid > 0) return `${fmtMoney(paid, "$0.00")} has been paid and the remaining ${fmtMoney(owed, "$0.00")} is due${v.holdUntil ? ` by ${fmtDate(v.holdUntil)}` : " before the event"}`;
  return `The full amount of ${fmtMoney(v.amountCents, "$0.00")} is due${v.holdUntil ? ` by ${fmtDate(v.holdUntil)}` : " before the event"}`;
}

/** Every value for a sponsor or exhibitor (the event's, the organization's from the template, and the vendor's). */
export function valuesForVendor(event: EventRow, template: Pick<AgreementTemplate, "values">, v: Vendor): AgreementValues {
  const { values } = packageValues(v.packageId, v.level, v.amountCents);
  return {
    ...eventValues(event),
    ...templateValues(template),
    "Company name": v.company,
    ...values,
    "Add-ons": addonWords(v.addons),
    "Payment terms": vendorTerms(v),
  };
}

/** Every value for a buyer on the sponsor or exhibitor checkout page, before the vendor exists. */
export function valuesForCheckout(event: EventRow, template: Pick<AgreementTemplate, "values">, c: VendorCheckout): AgreementValues {
  const db = getDb();
  const { values } = packageValues(c.packageId, "", c.totalCents);
  const ids = c.buyer.addons.map((a) => a.addonId);
  const addons = ids.length ? db.select().from(schema.vendorAddons).where(inArray(schema.vendorAddons.id, ids)).all() : [];
  const lines = c.buyer.addons.filter((a) => a.qty > 0).map((a) => ({ name: addons.find((x) => x.id === a.addonId)?.name ?? "", qty: a.qty })).filter((l) => l.name);
  const page = db
    .select()
    .from(schema.vendorCheckoutPages)
    .where(and(eq(schema.vendorCheckoutPages.eventId, c.eventId), eq(schema.vendorCheckoutPages.kind, c.kind)))
    .get();
  const created = new Date(c.createdAt ?? Date.now());
  const dueBy = new Date(created.getTime() + (page?.invoiceHoldDays ?? 14) * 86_400_000).toISOString().slice(0, 10);
  return {
    ...eventValues(event),
    ...templateValues(template),
    "Company name": c.buyer.company,
    ...values,
    "Add-ons": addonWords(lines),
    "Payment terms": paymentTerms({ option: c.payOption, totalCents: c.totalCents, dueTodayCents: c.dueTodayCents, balanceDueOn: page?.balanceDueOn ?? null, dueBy }),
  };
}

/** The speaker's first session (presenting before other roles), for Session title, Session time and Room. */
export function speakerSession(speakerId: number) {
  const rows = getDb()
    .select({ role: schema.sessionSpeakers.role, s: schema.sessions })
    .from(schema.sessionSpeakers)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionSpeakers.sessionId))
    .where(eq(schema.sessionSpeakers.speakerId, speakerId))
    .all()
    .sort((a, b) => Number(a.role !== "presenter") - Number(b.role !== "presenter") || (a.s.date + a.s.startTime).localeCompare(b.s.date + b.s.startTime));
  return rows[0]?.s ?? null;
}

/** "Apr 23, 2027 at 10:30 AM" */
export const sessionWhen = (s: { date: string; startTime: string }) => `${fmtDate(s.date)} at ${fmtTime(s.startTime)}`;

/** Every value for a speaker. Materials due date falls back to the session's slides due date. */
export function valuesForSpeaker(event: EventRow, template: Pick<AgreementTemplate, "values">, sp: Speaker): AgreementValues {
  const s = speakerSession(sp.id);
  const t = templateValues(template);
  return {
    ...eventValues(event),
    ...t,
    "Speaker name": sp.name,
    "Session title": s?.title ?? "",
    "Session time": s ? sessionWhen(s) : "",
    Room: s?.room ?? "",
    "Materials due date": t["Materials due date"] || (s?.slidesDueOn ? fmtDate(s.slidesDueOn) : ""),
  };
}

/** Builds the values for whichever party the agreement is for. */
export function valuesFor(event: EventRow, template: AgreementTemplate, party: { kind: AgreementKind; vendor?: Vendor; checkout?: VendorCheckout; speaker?: Speaker }): AgreementValues {
  if (party.speaker) return valuesForSpeaker(event, template, party.speaker);
  if (party.vendor) return valuesForVendor(event, template, party.vendor);
  if (party.checkout) return valuesForCheckout(event, template, party.checkout);
  return { ...eventValues(event), ...templateValues(template) };
}
