/**
 * Welcome emails and follow-ups for speakers, sponsors and exhibitors
 * (the attendee messages live in messages.ts). Each sends at most once per
 * person: every send is logged in recipient_log, one row per person and kind.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../../_core/db";
import { ENV } from "../../_core/env";
import { emailLayout, escapeHtml, sendEmail, type EmailAttachment } from "../../_core/email";
import { SHAPE_RADIUS, buttonInk, lookOf, type BrandLike } from "@shared/brand";
import { fmtDate, fmtDates, fmtMoney, fmtTime } from "@shared/format";
import { zonedToDate } from "@shared/time";
import type { Agreement, MessageKind, VendorPayment } from "../../../drizzle/schema";
import { agreementForSpeaker, agreementsForVendor, signedPdfAttachment, templateFor as agreementTemplateFor, templateForVendor } from "../agreements/sign";
import { speakerPageUrl } from "../program/slides";
import { passHolders, passTotal, vendorMoney } from "../network/vendors";
import { ratingAverage } from "../ce/evaluations";
import { appLink, coverFor, qrDataUrl, qrImageLink, seedRecipientTemplates, templateFor } from "./messages";
import { GROUP_FOLLOW_UPS, GROUP_WELCOME, INCLUDE_OPTIONS, SEND_CHOICES, groupOfKind, type RecipientGroup } from "./recipientDefaults";

export { GROUP_FOLLOW_UPS, GROUP_WELCOME, type RecipientGroup } from "./recipientDefaults";

type EventRow = typeof schema.events.$inferSelect;
type Template = typeof schema.messageTemplates.$inferSelect;
type Speaker = typeof schema.speakers.$inferSelect;
type Vendor = typeof schema.vendors.$inferSelect;
type Session = typeof schema.sessions.$inferSelect;
type Includes = Template["includes"];
export type RecipientDraft = Pick<Template, "kind" | "subject" | "body" | "sendRule" | "includes">;

export type SendResult = "sent" | "already" | "skipped" | "waiting" | "failed";

const DAY = 86_400_000;
const NO_SLIDES = new Set(["break", "meal"]);

/* ---------------- Who is in each group ---------------- */

export const isSponsorGroup = (v: Pick<Vendor, "kind">) => v.kind === "sponsor" || v.kind === "both";
export const vendorGroup = (v: Pick<Vendor, "kind">): "sponsors" | "exhibitors" => (isSponsorGroup(v) ? "sponsors" : "exhibitors");

function eventOf(eventId: number) {
  return getDb().select().from(schema.events).where(eq(schema.events.id, eventId)).get();
}

function speakersOf(eventId: number) {
  return getDb().select().from(schema.speakers).where(eq(schema.speakers.eventId, eventId)).all().sort((a, b) => a.sort - b.sort || a.id - b.id);
}

function vendorsOf(eventId: number, group: "sponsors" | "exhibitors") {
  return getDb()
    .select()
    .from(schema.vendors)
    .where(eq(schema.vendors.eventId, eventId))
    .all()
    .filter((v) => v.status !== "cancelled" && vendorGroup(v) === group)
    .sort((a, b) => a.id - b.id);
}

/** Every session a speaker is on, earliest first (presenter sessions before co-presenter ones). */
function sessionsOfSpeaker(speakerId: number): Session[] {
  return getDb()
    .select({ role: schema.sessionSpeakers.role, s: schema.sessions })
    .from(schema.sessionSpeakers)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionSpeakers.sessionId))
    .where(eq(schema.sessionSpeakers.speakerId, speakerId))
    .all()
    .sort((a, b) => Number(a.role !== "presenter") - Number(b.role !== "presenter") || (a.s.date + a.s.startTime).localeCompare(b.s.date + b.s.startTime))
    .map((r) => r.s);
}

function paymentsOf(vendorId: number) {
  return getDb().select().from(schema.vendorPayments).where(eq(schema.vendorPayments.vendorId, vendorId)).all();
}

/** A payment or deposit is in (or a no-cost vendor is confirmed). */
export function vendorPaid(v: Vendor, payments: VendorPayment[]) {
  if (v.status === "cancelled") return false;
  if (v.status === "paid") return true;
  if (v.amountCents <= 0) return v.status === "confirmed";
  return vendorMoney(v, payments).paidCents > 0;
}

function signedOf(list: Agreement[]) {
  return list.find((a) => a.status === "signed") ?? null;
}

/* ---------------- Who is ready for the welcome email ---------------- */

type Readiness = { ready: boolean; waiting: "signature" | "payment" | null };

/** Whether a speaker qualifies for the welcome under the template's rule. `bulk` is Send to new (manual rules qualify). */
function speakerReadiness(sp: Speaker, t: Template, mode: "auto" | "bulk"): Readiness {
  if (!sp.email) return { ready: false, waiting: null };
  if (t.sendRule === "manual") return { ready: mode === "bulk", waiting: null };
  if (t.sendRule === "after_accept") return { ready: sessionsOfSpeaker(sp.id).length > 0, waiting: null };
  // after_sign: needs a signed agreement when the event has a speaker agreement.
  if (!agreementTemplateFor(sp.eventId, "speaker")) return { ready: true, waiting: null };
  return agreementForSpeaker(sp.id)?.status === "signed" ? { ready: true, waiting: null } : { ready: false, waiting: "signature" };
}

function vendorReadiness(v: Vendor, t: Template, mode: "auto" | "bulk", payments = paymentsOf(v.id)): Readiness {
  if (!v.email || v.status === "cancelled") return { ready: false, waiting: null };
  const paid = vendorPaid(v, payments);
  if (t.sendRule === "manual") return { ready: mode === "bulk" && (paid || v.status === "confirmed"), waiting: null };
  if (!paid) return { ready: false, waiting: "payment" };
  if (t.sendRule === "after_payment") return { ready: true, waiting: null };
  const list = agreementsForVendor(v.id).filter((a) => a.status !== "void");
  const needsSignature = list.length > 0 || !!templateForVendor(v);
  if (needsSignature && !signedOf(list)) return { ready: false, waiting: "signature" };
  return { ready: true, waiting: null };
}

/* ---------------- The log ---------------- */

type RecipientType = "speaker" | "vendor";

function logRow(type: RecipientType, id: number, kind: string) {
  return getDb()
    .select()
    .from(schema.recipientLog)
    .where(and(eq(schema.recipientLog.recipientType, type), eq(schema.recipientLog.recipientId, id), eq(schema.recipientLog.kind, kind)))
    .get();
}

/** Reserves the log row first so only one caller sends. A welcome that failed or was skipped may be tried again. */
function reserve(eventId: number, type: RecipientType, id: number, kind: string, retry: boolean) {
  const db = getDb();
  const row = db.insert(schema.recipientLog).values({ eventId, recipientType: type, recipientId: id, kind, status: "sent" }).onConflictDoNothing().returning().get();
  if (row) return row.id;
  if (!retry) return null;
  const existing = logRow(type, id, kind);
  if (!existing || existing.status === "sent") return null;
  const claimed = db
    .update(schema.recipientLog)
    .set({ status: "sent", error: null, createdAt: new Date() })
    .where(and(eq(schema.recipientLog.id, existing.id), eq(schema.recipientLog.status, existing.status)))
    .returning()
    .get();
  return claimed?.id ?? null;
}

function finish(logId: number, status: "failed" | "skipped", error: string) {
  getDb().update(schema.recipientLog).set({ status, error: error.slice(0, 300) }).where(eq(schema.recipientLog.id, logId)).run();
}

async function deliver(opts: { event: EventRow; type: RecipientType; id: number; kind: string; to: string; t: Template; retry: boolean; build: () => Promise<{ subject: string; text: string; html: string; attachments: EmailAttachment[] }> }): Promise<SendResult> {
  const logId = reserve(opts.event.id, opts.type, opts.id, opts.kind, opts.retry);
  if (!logId) return "already";
  try {
    const m = await opts.build();
    await sendEmail({ to: opts.to, subject: m.subject, text: m.text, html: m.html, fromName: opts.t.fromName || undefined, replyTo: opts.t.replyTo || undefined, attachments: m.attachments.length ? m.attachments : undefined });
    return "sent";
  } catch (err) {
    finish(logId, "failed", (err as Error).message || "Send failed");
    console.error(`[welcome] ${opts.kind} to ${opts.type} ${opts.id} failed:`, err);
    return "failed";
  }
}

/* ---------------- What goes in the emails ---------------- */

type SpeakerCtx = {
  type: "speaker";
  event: EventRow;
  speakerId: number | null;
  firstName: string;
  name: string;
  session: Pick<Session, "title" | "date" | "startTime" | "room" | "slidesDueOn"> | null;
  pageUrl: string;
  /** Attendee row token for the registration QR (null when the speaker is not registered). */
  qrToken: string | null;
  qrDataUrl?: string;
  signed: Agreement | null;
  evals: { count: number; average: number | null; scale: number } | null;
};

type VendorCtx = {
  type: "vendor";
  group: "sponsors" | "exhibitors";
  event: EventRow;
  vendor: Pick<Vendor, "company" | "contactName" | "booth" | "kind" | "nextChargeCents" | "nextChargeOn" | "amountCents" | "leadScanning" | "level">;
  packageName: string;
  includesBooth: boolean;
  payments: Pick<VendorPayment, "amountCents" | "status" | "paidOn" | "method" | "reference">[];
  passesTotal: number;
  passesNamed: number;
  addons: string[];
  setupTime: string;
  teardownTime: string;
  logoDueOn: string;
  /** Where "Add pass names" and "Edit app listing" replies go. Empty hides those buttons. */
  replyTo: string;
  signed: Agreement | null;
};

type Ctx = SpeakerCtx | VendorCtx;

const firstWord = (s: string) => s.trim().split(/\s+/)[0] ?? "";
const sessionWhen = (s: { date: string; startTime: string }) => `${fmtDate(s.date)} at ${fmtTime(s.startTime)}`;

function eventFields(ev: EventRow): Record<string, string> {
  return {
    "event name": ev.name,
    "event short name": ev.shortName || ev.name,
    "event dates": fmtDates(ev.startDate, ev.endDate),
    venue: [ev.venueName, ev.city].filter(Boolean).join(", ") || "the venue",
    "app link": appLink(ev.slug),
  };
}

function fieldsFor(c: Ctx): Record<string, string> {
  if (c.type === "speaker") {
    return {
      ...eventFields(c.event),
      "first name": c.firstName || "there",
      "speaker name": c.name,
      "session title": c.session?.title || "your session",
      "session time": c.session ? sessionWhen(c.session) : "a time to be announced",
      room: c.session?.room || "a room to be announced",
      "slides due date": c.session?.slidesDueOn ? fmtDate(c.session.slidesDueOn) : "soon",
    };
  }
  const v = c.vendor;
  return {
    ...eventFields(c.event),
    "first name": firstWord(v.contactName) || "there",
    "company name": v.company,
    "package name": c.packageName || v.level || "proud",
    passes: String(c.passesTotal),
    "next charge date": v.nextChargeOn && v.nextChargeCents > 0 ? fmtDate(v.nextChargeOn) : "none scheduled",
    booth: v.booth || "to be assigned",
    "setup time": c.setupTime || "to be announced",
    "teardown time": c.teardownTime || "to be announced",
    "logo due date": c.logoDueOn ? fmtDate(c.logoDueOn) : "soon",
  };
}

export function fillRecipientFields(text: string, c: Ctx) {
  const fields = fieldsFor(c);
  return text.replace(/\{\{\s*([a-z ]+?)\s*\}\}/gi, (m, k: string) => fields[k.toLowerCase()] ?? m);
}

function brandOf(ev: EventRow) {
  const brand = ev.branding.colorPrimary || "#1F5F4A";
  const accent = ev.branding.colorAccent || "#e88a3a";
  const look: BrandLike = { ...ev.branding, colorPrimary: brand, colorAccent: accent };
  return { brand, accent, look };
}

/** Label and value rows in a bordered box (Session, When, Room...). */
function detailsBox(rows: [string, string][]) {
  if (!rows.length) return "";
  const cells = rows
    .map(([label, value], i) => {
      const line = i ? "border-top:1px solid #EEF2F1;" : "";
      return `<tr><td style="${line}padding:10px 12px;color:#4B5B57;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td align="right" style="${line}padding:10px 12px;font-weight:bold;vertical-align:top">${escapeHtml(value)}</td></tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E1E8E5;border-radius:10px;border-collapse:separate;margin:0 0 12px;font-size:14px">${cells}</table>`;
}

/** Buttons side by side: the first filled with the event's button color, the rest outlined. */
function buttonRow(buttons: { label: string; url: string; primary?: boolean }[], c: Ctx) {
  if (!buttons.length) return "";
  const { brand, look } = brandOf(c.event);
  const radius = SHAPE_RADIUS[lookOf(look).buttonShape];
  const links = buttons.map((b) =>
    b.primary
      ? `<a href="${escapeHtml(b.url)}" style="display:inline-block;background:${look.colorAccent};color:${buttonInk(look)};border:1.5px solid ${look.colorAccent};font-weight:bold;text-decoration:none;padding:11px 18px;border-radius:${radius};margin:0 8px 8px 0">${escapeHtml(b.label)}</a>`
      : `<a href="${escapeHtml(b.url)}" style="display:inline-block;background:#FFFFFF;color:${brand};border:1.5px solid ${brand};font-weight:bold;text-decoration:none;padding:11px 18px;border-radius:${radius};margin:0 8px 8px 0">${escapeHtml(b.label)}</a>`
  );
  return `<p style="margin:4px 0 8px">${links.join("")}</p>`;
}

const section = (heading: string, text: string) => `<p style="margin:0 0 2px;font-weight:bold">${escapeHtml(heading)}</p><p style="margin:0 0 12px">${escapeHtml(text)}</p>`;
const note = (text: string) => `<p style="margin:0 0 8px;font-size:13px;color:#4B5B57">${escapeHtml(text)}</p>`;
const paragraphs = (body: string) =>
  body
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);

function mailto(address: string, subject: string) {
  return `mailto:${address}?subject=${encodeURIComponent(subject)}`;
}

const METHOD_LABEL: Record<VendorPayment["method"], string> = { card: "Card", bank: "Bank account", check: "Check", cash: "Cash", invoice: "Invoice", other: "Payment" };

/** Package, payments and passes (the sponsor details box). */
function scheduleRows(c: VendorCtx): [string, string][] {
  const rows: [string, string][] = [["Package", c.packageName || c.vendor.level || "Sponsor"]];
  for (const p of c.payments.filter((x) => x.status === "paid" || x.status === "pending").sort((a, b) => a.paidOn.localeCompare(b.paidOn))) {
    rows.push([`${p.status === "pending" ? "Pending" : "Paid"} ${fmtDate(p.paidOn) || ""}`.trim(), fmtMoney(p.amountCents, "$0.00")]);
  }
  if (c.vendor.nextChargeCents > 0 && c.vendor.nextChargeOn) rows.push([`Charged ${fmtDate(c.vendor.nextChargeOn)}`, fmtMoney(c.vendor.nextChargeCents, "$0.00")]);
  if (c.passesTotal > 0) rows.push(["Event passes", `${c.passesNamed} of ${c.passesTotal} named`]);
  return rows;
}

function boothValue(c: VendorCtx) {
  if (c.vendor.booth) return c.packageName ? `${c.packageName}, booth ${c.vendor.booth}` : `Booth ${c.vendor.booth}`;
  return c.packageName ? `${c.packageName}, number to come` : "Number to come";
}

function receiptBlock(c: VendorCtx) {
  const paid = c.payments.filter((p) => p.status === "paid");
  const paidCents = paid.reduce((n, p) => n + p.amountCents, 0);
  const lines = paid
    .map((p) => `<tr><td style="padding:2px 0">${escapeHtml([fmtDate(p.paidOn), METHOD_LABEL[p.method], p.reference].filter(Boolean).join(" · "))}</td><td align="right" style="padding:2px 0;font-weight:bold">${escapeHtml(fmtMoney(p.amountCents, "$0.00"))}</td></tr>`)
    .join("");
  const balance = Math.max(0, c.vendor.amountCents - paidCents);
  const text = [`Receipt for ${c.vendor.company}`, ...paid.map((p) => `${[fmtDate(p.paidOn), METHOD_LABEL[p.method], p.reference].filter(Boolean).join(" · ")}: ${fmtMoney(p.amountCents, "$0.00")}`), `Total ${fmtMoney(c.vendor.amountCents, "$0.00")}, paid ${fmtMoney(paidCents, "$0.00")}, balance ${fmtMoney(balance, "$0.00")}`];
  const html = `<div style="background:#F4F8F6;border-radius:10px;padding:10px 12px;font-size:13px;margin:0 0 12px"><div style="font-weight:bold;margin-bottom:4px">Receipt</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${lines}<tr><td style="padding:6px 0 0;border-top:1px solid #E1E8E5">Total ${escapeHtml(fmtMoney(c.vendor.amountCents, "$0.00"))} · Balance ${escapeHtml(fmtMoney(balance, "$0.00"))}</td><td align="right" style="padding:6px 0 0;border-top:1px solid #E1E8E5;font-weight:bold">Paid ${escapeHtml(fmtMoney(paidCents, "$0.00"))}</td></tr></table></div>`;
  return { html, text: text.join("\n") };
}

function keyDatesText(c: VendorCtx) {
  const parts: string[] = [];
  if (c.logoDueOn) parts.push(`Logo and ad due ${fmtDate(c.logoDueOn)}.`);
  if (c.setupTime && (c.includesBooth || c.vendor.kind === "both")) parts.push(`Booth setup ${c.setupTime}.`);
  if (!parts.length) parts.push(`The conference runs ${fmtDates(c.event.startDate, c.event.endDate)}.`);
  return parts.join(" ");
}

const LEADS_HOW_TO = "Booth staff scan attendee badges in the app to collect leads. You can download them after the event.";

/** Subject, plain text and branded HTML for one message. `preview` shows the attachment line as if the agreement were signed. */
export async function renderRecipientEmail(t: RecipientDraft, c: Ctx, opts: { preview?: boolean } = {}) {
  const ev = c.event;
  const inc = t.includes as Includes;
  const subject = fillRecipientFields(t.subject, c);
  const body = fillRecipientFields(t.body, c);
  const blocks: string[] = paragraphs(body);
  const text: string[] = [body];
  let title: string | undefined;
  let attachNote = "";
  const add = (html: string, plain?: string) => {
    if (!html) return;
    blocks.push(html);
    if (plain) text.push(plain);
  };
  const rowsText = (rows: [string, string][]) => rows.map(([l, v]) => `${l}: ${v}`).join("\n");
  const getApp = () => add(buttonRow([{ label: "Get the app", url: appLink(ev.slug) }], c), `Get the app: ${appLink(ev.slug)}`);
  const qrBlock = (sc: SpeakerCtx) => {
    if (!sc.qrToken) return;
    const src = sc.qrDataUrl ?? qrImageLink(ev.slug, sc.qrToken);
    add(section("Your registration", "Your full conference registration is included. Show this QR code, or your badge in the app, at check-in."), "Your registration: your full conference registration is included. Show the QR code in this email, or your badge in the app, at check-in.");
    add(`<p style="margin:0 0 12px"><img src="${src}" width="96" height="96" alt="Check-in QR code" style="display:block;border:0"></p>`);
  };

  if (c.type === "speaker") {
    const s = c.session;
    const sessionRows: [string, string][] = s ? [["Session", s.title], ["When", sessionWhen(s)], ["Room", s.room || "To be announced"], ...(s.slidesDueOn ? ([["Slides due", fmtDate(s.slidesDueOn)]] as [string, string][]) : [])] : [["Session", "To be scheduled"]];
    if (t.kind === "speaker_welcome") {
      title = `You are speaking at ${ev.name}`;
      if (inc.session) add(detailsBox(sessionRows), rowsText(sessionRows));
      const buttons = [...(inc.uploadSlides ? [{ label: "Upload slides", url: c.pageUrl, primary: true }] : []), ...(inc.bio ? [{ label: "Update bio and photo", url: c.pageUrl, primary: !inc.uploadSlides }] : [])];
      add(buttonRow(buttons, c), buttons.map((b) => `${b.label}: ${b.url}`).join("\n"));
      if (inc.qr) qrBlock(c);
      if (inc.getApp) getApp();
      if (inc.agreementPdf && (c.signed || opts.preview)) attachNote = "Attached: your signed speaker agreement (PDF)";
    } else if (t.kind === "speaker_slides_reminder") {
      const rows = sessionRows.filter(([l]) => l === "Session" || l === "Slides due");
      add(detailsBox(rows), rowsText(rows));
      add(buttonRow([{ label: "Upload slides", url: c.pageUrl, primary: true }], c), `Upload slides: ${c.pageUrl}`);
    } else if (t.kind === "speaker_know_before") {
      const rows = sessionRows.filter(([l]) => l !== "Slides due");
      add(detailsBox(rows), rowsText(rows));
      qrBlock(c);
      if (inc.getApp) getApp();
    } else if (t.kind === "speaker_thanks") {
      if (c.evals && c.evals.count > 0) {
        const rows: [string, string][] = [["Session", s?.title ?? ""], ["Evaluations", String(c.evals.count)], ...(c.evals.average !== null ? ([["Average rating", `${c.evals.average} of ${c.evals.scale}`]] as [string, string][]) : [])];
        add(detailsBox(rows), rowsText(rows));
      } else {
        add(note("No evaluations came in for your session."), "No evaluations came in for your session.");
      }
    }
  } else {
    const v = c.vendor;
    const reply = c.replyTo;
    const listing = reply ? { label: "Edit app listing", url: mailto(reply, `App listing for ${v.company}`) } : null;
    const timesRows: [string, string][] = [...(c.setupTime ? ([["Setup", c.setupTime]] as [string, string][]) : []), ...(c.teardownTime ? ([["Teardown", c.teardownTime]] as [string, string][]) : [])];
    if (t.kind === "sponsor_welcome") {
      title = `Welcome, ${v.company}`;
      if (inc.schedule) add(detailsBox(scheduleRows(c)), rowsText(scheduleRows(c)));
      const buttons = [...(inc.passNames && reply && c.passesTotal > 0 ? [{ label: "Add pass names", url: mailto(reply, `Pass names for ${v.company}`), primary: true }] : []), ...(inc.listing && listing ? [listing] : [])];
      if (buttons.length === 1) buttons[0] = { ...buttons[0], primary: true };
      add(buttonRow(buttons, c), buttons.map((b) => `${b.label}: email ${reply}`).join("\n"));
      if (inc.keyDates) add(section("Key dates", keyDatesText(c)), `Key dates: ${keyDatesText(c)}`);
      if (inc.receipt) {
        const r = receiptBlock(c);
        add(r.html, r.text);
      }
      if (inc.agreementPdf && (c.signed || opts.preview)) attachNote = "Attached: your signed sponsor agreement (PDF)";
    } else if (t.kind === "exhibitor_welcome") {
      title = `Welcome, ${v.company}`;
      const rows: [string, string][] = [...(inc.booth ? ([["Booth", boothValue(c)], ...(c.addons.length ? [["Add-ons", c.addons.join(", ")]] : [])] as [string, string][]) : []), ...(inc.times ? timesRows : [])];
      add(detailsBox(rows), rowsText(rows));
      const buttons = [...(inc.staff && reply ? [{ label: "Add booth staff", url: mailto(reply, `Booth staff for ${v.company}`), primary: true }] : []), ...(inc.listing && listing ? [listing] : [])];
      if (buttons.length === 1) buttons[0] = { ...buttons[0], primary: true };
      add(buttonRow(buttons, c), buttons.map((b) => `${b.label}: email ${reply}`).join("\n"));
      if (inc.leads && v.leadScanning) add(section("Leads", LEADS_HOW_TO), `Leads: ${LEADS_HOW_TO}`);
      if (inc.receipt) {
        const r = receiptBlock(c);
        add(r.html, r.text);
      }
      if (inc.agreementPdf && (c.signed || opts.preview)) attachNote = "Attached: your signed exhibitor agreement (PDF)";
    } else if (t.kind === "sponsor_passes_reminder") {
      const rows: [string, string][] = [["Event passes", `${c.passesNamed} of ${c.passesTotal} named`]];
      add(detailsBox(rows), rowsText(rows));
      if (reply) add(buttonRow([{ label: "Add pass names", url: mailto(reply, `Pass names for ${v.company}`), primary: true }], c), `Add pass names: email ${reply}`);
    } else if (t.kind === "sponsor_logo_reminder") {
      if (listing) add(buttonRow([{ ...listing, primary: true }], c), `Edit app listing: email ${reply}`);
    } else if (t.kind === "exhibitor_booth_assigned") {
      const rows: [string, string][] = [["Booth", boothValue(c)], ...timesRows];
      add(detailsBox(rows), rowsText(rows));
    } else if (t.kind === "sponsor_know_before" || t.kind === "exhibitor_know_before") {
      const rows: [string, string][] = [...(v.booth ? ([["Booth", v.booth]] as [string, string][]) : []), ...timesRows];
      add(detailsBox(rows), rowsText(rows));
      if (t.kind === "exhibitor_know_before" && v.leadScanning) add(section("Leads", LEADS_HOW_TO), `Leads: ${LEADS_HOW_TO}`);
      if (inc.getApp) getApp();
    }
  }
  if (attachNote) add(note(attachNote), attachNote);
  const { brand, accent } = brandOf(ev);
  const html = emailLayout({ brand, accent, coverUrl: coverFor(ev), eventName: ev.name, title, blocks, look: ev.branding });
  return { subject, text: (title ? [title, ...text] : text).join("\n\n"), html };
}

/* ---------------- Contexts ---------------- */

function attendeeQrToken(eventId: number, email: string) {
  if (!email) return null;
  const a = getDb()
    .select()
    .from(schema.attendees)
    .where(and(eq(schema.attendees.eventId, eventId), eq(schema.attendees.email, email.trim().toLowerCase())))
    .get();
  return a && a.status !== "cancelled" ? a.qrToken : null;
}

function evalSummary(sessionIds: number[]) {
  if (!sessionIds.length) return null;
  const db = getDb();
  const responses = db.select().from(schema.evaluationResponses).where(inArray(schema.evaluationResponses.sessionId, sessionIds)).all();
  if (!responses.length) return { count: 0, average: null, scale: 5 };
  const forms = db.select().from(schema.evaluations).where(inArray(schema.evaluations.id, Array.from(new Set(responses.map((r) => r.evaluationId))))).all();
  const questions = forms.flatMap((f) => f.questions);
  const scale = questions.find((q) => q.kind === "rating")?.scale ?? 5;
  return { count: responses.length, average: ratingAverage(questions, responses), scale };
}

export function speakerCtx(sp: Speaker, ev: EventRow): SpeakerCtx {
  const sessions = sessionsOfSpeaker(sp.id);
  const a = agreementForSpeaker(sp.id);
  return {
    type: "speaker",
    event: ev,
    speakerId: sp.id,
    firstName: sp.firstName || firstWord(sp.name),
    name: sp.name,
    session: sessions[0] ?? null,
    pageUrl: speakerPageUrl(sp.id),
    qrToken: attendeeQrToken(ev.id, sp.email),
    signed: a?.status === "signed" ? a : null,
    evals: evalSummary(sessions.map((s) => s.id)),
  };
}

/** Free text from the exhibitor agreement ("Apr 21, 2027, 2:00 PM to 6:00 PM"). */
function boothTimes(eventId: number) {
  const values = agreementTemplateFor(eventId, "exhibitor")?.values ?? {};
  return { setupTime: values["Setup time"] ?? "", teardownTime: values["Teardown time"] ?? "" };
}

/**
 * Where vendors reply: the welcome's reply-to, then the attendee welcome's,
 * then the vendor checkout page's notify address, then an email link on the
 * event's host page, then the organization owner's email. The welcome buttons
 * reply to this address, so it is only empty when none of those exist.
 */
function replyAddress(ev: EventRow, t: Pick<Template, "replyTo"> | undefined, group: "sponsors" | "exhibitors") {
  if (t?.replyTo) return t.replyTo;
  const welcome = templateFor(ev.id, "welcome");
  if (welcome?.replyTo) return welcome.replyTo;
  const db = getDb();
  const page = db
    .select()
    .from(schema.vendorCheckoutPages)
    .where(and(eq(schema.vendorCheckoutPages.eventId, ev.id), eq(schema.vendorCheckoutPages.kind, group === "sponsors" ? "sponsor" : "exhibitor")))
    .get();
  if (page?.notifyEmail) return page.notifyEmail;
  const hostMail = (ev.hostLinks ?? []).map((l) => /^mailto:([^?]+)/i.exec(l.url.trim())?.[1] ?? "").find((m) => m.includes("@"));
  if (hostMail) return decodeURIComponent(hostMail);
  const owner = db
    .select({ email: schema.users.email })
    .from(schema.orgMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
    .where(and(eq(schema.orgMembers.orgId, ev.orgId), eq(schema.orgMembers.role, "owner")))
    .get();
  return owner?.email ?? "";
}

export function vendorCtx(v: Vendor, ev: EventRow, replyTo?: string): VendorCtx {
  const db = getDb();
  const group = vendorGroup(v);
  const pkg = v.packageId ? db.select().from(schema.vendorPackages).where(eq(schema.vendorPackages.id, v.packageId)).get() : undefined;
  const addons = new Map(db.select().from(schema.vendorAddons).where(eq(schema.vendorAddons.eventId, ev.id)).all().map((a) => [a.id, a]));
  const named = passHolders(ev.id).filter((a) => a.vendorId === v.id).length;
  const list = agreementsForVendor(v.id);
  const logo = templateFor(ev.id, "sponsor_logo_reminder");
  const welcome = templateFor(ev.id, GROUP_WELCOME[group]);
  return {
    type: "vendor",
    group,
    event: ev,
    vendor: v,
    packageName: pkg?.name || v.level,
    includesBooth: !!pkg?.includesBooth,
    payments: paymentsOf(v.id),
    passesTotal: passTotal(v, pkg, addons),
    passesNamed: named,
    addons: v.addons.map((l) => (l.qty > 1 ? `${l.name} (${l.qty})` : l.name)),
    ...boothTimes(ev.id),
    logoDueOn: typeof logo?.includes.logoDueOn === "string" ? logo.includes.logoDueOn : "",
    replyTo: replyTo || replyAddress(ev, welcome, group),
    signed: signedOf(list),
  };
}

/** A sample person for the preview when the group is empty. Generic text only. */
async function sampleCtx(ev: EventRow, group: RecipientGroup, replyTo: string): Promise<Ctx> {
  const back = (n: number) => {
    const [y, m, d] = ev.startDate.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
  };
  if (group === "speakers") {
    return {
      type: "speaker",
      event: ev,
      speakerId: null,
      firstName: "Jordan",
      name: "Jordan Lee",
      session: { title: "Sample session title", date: ev.startDate, startTime: "10:30", room: "Room A", slidesDueOn: back(14) },
      pageUrl: `${ENV.appUrl}/speak/sample`,
      qrToken: "sample",
      qrDataUrl: await qrDataUrl(`${ev.slug}-sample`),
      signed: null,
      evals: { count: 24, average: 4.6, scale: 5 },
    };
  }
  const kind = group === "sponsors" ? "sponsor" : "exhibitor";
  const pkg = getDb()
    .select()
    .from(schema.vendorPackages)
    .where(and(eq(schema.vendorPackages.eventId, ev.id), eq(schema.vendorPackages.kind, kind)))
    .all()
    .sort((a, b) => a.sort - b.sort || a.id - b.id)[0];
  const price = pkg?.priceCents ?? 500000;
  const today = new Date().toISOString().slice(0, 10);
  const logo = templateFor(ev.id, "sponsor_logo_reminder");
  return {
    type: "vendor",
    group,
    event: ev,
    vendor: { company: "Sample Company", contactName: "Alex Morgan", booth: "", kind, nextChargeCents: 0, nextChargeOn: null, amountCents: price, leadScanning: true, level: "" },
    packageName: pkg?.name || (group === "sponsors" ? "Gold" : "Standard booth"),
    includesBooth: !!pkg?.includesBooth,
    payments: [{ amountCents: price, status: "paid", paidOn: today, method: "card", reference: "" }],
    passesTotal: pkg?.passes ?? 2,
    passesNamed: 0,
    addons: [],
    ...boothTimes(ev.id),
    logoDueOn: typeof logo?.includes.logoDueOn === "string" ? logo.includes.logoDueOn : "",
    replyTo: replyTo || replyAddress(ev, undefined, group),
    signed: null,
  };
}

/** The first real person in the group (speakers with a session first, vendors who paid first), else a sample. */
export async function previewCtx(ev: EventRow, group: RecipientGroup, replyTo: string): Promise<Ctx> {
  if (group === "speakers") {
    const list = speakersOf(ev.id);
    const sp = list.find((s) => sessionsOfSpeaker(s.id).length > 0) ?? list[0];
    if (sp) {
      const c = speakerCtx(sp, ev);
      return c.qrToken ? { ...c, qrDataUrl: await qrDataUrl(c.qrToken) } : c;
    }
    return sampleCtx(ev, group, replyTo);
  }
  const list = vendorsOf(ev.id, group);
  const v = list.find((x) => vendorPaid(x, paymentsOf(x.id))) ?? list[0];
  return v ? vendorCtx(v, ev, replyTo) : sampleCtx(ev, group, replyTo);
}

/* ---------------- Welcome emails ---------------- */

/** The speaker's, sponsor's or exhibitor's template, creating the defaults the first time for older events. */
export function recipientTemplate(eventId: number, kind: MessageKind) {
  let t = templateFor(eventId, kind);
  if (!t) {
    seedRecipientTemplates(eventId);
    t = templateFor(eventId, kind);
  }
  return t;
}

async function attachmentsFor(t: Template, signed: Agreement | null) {
  if (!t.includes.agreementPdf || !signed) return [];
  try {
    return [await signedPdfAttachment(signed)];
  } catch (err) {
    console.error("[welcome] signed agreement PDF failed:", err);
    return [];
  }
}

/** Marks the booth number email as not needed when the welcome already showed the booth. */
function skipBoothEmail(v: Vendor, t: Template) {
  if (vendorGroup(v) !== "exhibitors" || !v.booth || !t.includes.booth) return;
  getDb().insert(schema.recipientLog).values({ eventId: v.eventId, recipientType: "vendor", recipientId: v.id, kind: "exhibitor_booth_assigned", status: "skipped", error: "The welcome email had the booth number" }).onConflictDoNothing().run();
}

/**
 * Sends the speaker welcome email now if it is on, the send rule allows it,
 * and it has not gone out. `force` is the staff Send welcome button (sends
 * even when the rule is "Only when I send it"); `bulk` is Send to new.
 */
export async function sendSpeakerWelcome(speakerId: number, opts: { force?: boolean; bulk?: boolean } = {}): Promise<SendResult> {
  const sp = getDb().select().from(schema.speakers).where(eq(schema.speakers.id, speakerId)).get();
  if (!sp || !sp.email) return "skipped";
  const ev = eventOf(sp.eventId);
  if (!ev) return "skipped";
  const t = recipientTemplate(ev.id, "speaker_welcome");
  if (!t) return "skipped";
  if (!opts.force) {
    if (!t.enabled) return "skipped";
    const r = speakerReadiness(sp, t, opts.bulk ? "bulk" : "auto");
    if (!r.ready) return r.waiting ? "waiting" : "skipped";
  }
  return deliver({
    event: ev,
    type: "speaker",
    id: sp.id,
    kind: "speaker_welcome",
    to: sp.email,
    t,
    retry: true,
    build: async () => {
      const c = speakerCtx(sp, ev);
      return { ...(await renderRecipientEmail(t, c)), attachments: await attachmentsFor(t, c.signed) };
    },
  });
}

/** Sends the sponsor or exhibitor welcome email now if it is on, the send rule allows it, and it has not gone out. */
export async function sendVendorWelcome(vendorId: number, opts: { force?: boolean; bulk?: boolean } = {}): Promise<SendResult> {
  const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get();
  if (!v || !v.email || v.status === "cancelled") return "skipped";
  const ev = eventOf(v.eventId);
  if (!ev) return "skipped";
  const kind = GROUP_WELCOME[vendorGroup(v)];
  const t = recipientTemplate(ev.id, kind);
  if (!t) return "skipped";
  if (!opts.force) {
    if (!t.enabled) return "skipped";
    const r = vendorReadiness(v, t, opts.bulk ? "bulk" : "auto");
    if (!r.ready) return r.waiting ? "waiting" : "skipped";
  }
  const result = await deliver({
    event: ev,
    type: "vendor",
    id: v.id,
    kind,
    to: v.email,
    t,
    retry: true,
    build: async () => {
      const c = vendorCtx(v, ev);
      return { ...(await renderRecipientEmail(t, c)), attachments: await attachmentsFor(t, c.signed) };
    },
  });
  if (result === "sent") skipBoothEmail(v, t);
  return result;
}

/** Counts for the tab: how many got it, how many are waiting and why, and how many Send to new would reach. */
export function welcomeSummary(eventId: number, group: RecipientGroup) {
  const kind = GROUP_WELCOME[group];
  const t = recipientTemplate(eventId, kind);
  const sentIds = new Set(
    getDb()
      .select({ id: schema.recipientLog.recipientId })
      .from(schema.recipientLog)
      .where(and(eq(schema.recipientLog.eventId, eventId), eq(schema.recipientLog.kind, kind), eq(schema.recipientLog.status, "sent")))
      .all()
      .map((r) => r.id)
  );
  let total = 0;
  let sent = 0;
  let waitingSignature = 0;
  let waitingPayment = 0;
  const ready: number[] = [];
  const people = group === "speakers" ? speakersOf(eventId) : vendorsOf(eventId, group);
  for (const p of people) {
    total++;
    if (sentIds.has(p.id)) {
      sent++;
      continue;
    }
    if (!t) continue;
    const r = group === "speakers" ? speakerReadiness(p as Speaker, t, "bulk") : vendorReadiness(p as Vendor, t, "bulk");
    if (r.ready) ready.push(p.id);
    else if (r.waiting === "signature") waitingSignature++;
    else if (r.waiting === "payment") waitingPayment++;
  }
  const parts = [`${sent} sent`];
  if (waitingSignature) parts.push(`${waitingSignature} waiting on a signature`);
  if (waitingPayment) parts.push(`${waitingPayment} waiting on payment`);
  return { total, sent, waitingSignature, waitingPayment, readyIds: ready, ready: ready.length, sentLabel: parts.join(" · ") };
}

/** Send to new: everyone in the group who qualifies and has not gotten the welcome. Returns how many went out. */
export async function sendWelcomeToNew(eventId: number, group: RecipientGroup) {
  const { readyIds } = welcomeSummary(eventId, group);
  let sent = 0;
  for (const id of readyIds) {
    try {
      const r = group === "speakers" ? await sendSpeakerWelcome(id, { bulk: true }) : await sendVendorWelcome(id, { bulk: true });
      if (r === "sent") sent++;
    } catch (err) {
      console.error(`[welcome] send to new ${group} ${id} failed:`, err);
    }
  }
  return sent;
}

/* ---------------- Labels ---------------- */

export function welcomeRuleLabel(group: RecipientGroup, rule: string) {
  return SEND_CHOICES[group].find((c) => c.value === rule)?.label ?? rule;
}

export function followUpRuleLabel(t: Pick<Template, "kind" | "sendRule" | "includes">) {
  if (t.sendRule === "on_booth") return "When a booth number is set";
  const m = t.sendRule.match(/^days_(before|after):(\d+)$/);
  if (!m) return t.sendRule;
  const n = `${m[2]} day${m[2] === "1" ? "" : "s"}`;
  if (m[1] === "after") return `${n} after`;
  if (t.kind === "speaker_slides_reminder") return `${n} before slides are due`;
  if (t.kind === "sponsor_passes_reminder") return `${n} before, if passes are open`;
  if (t.kind === "sponsor_logo_reminder") return typeof t.includes.logoDueOn === "string" && t.includes.logoDueOn ? `${n} before ${fmtDate(t.includes.logoDueOn)}` : `${n} before the due date (not set)`;
  return `${n} before`;
}

export function includesLabel(group: RecipientGroup, inc: Includes) {
  return INCLUDE_OPTIONS[group].filter((o) => inc[o.key] === true).map((o) => o.label).join(", ") || "Nothing extra";
}

/* ---------------- Follow-ups (minute job) ---------------- */

function shiftDate(iso: string, days: number) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const daysOf = (rule: string) => Number(rule.match(/^days_(?:before|after):(\d+)$/)?.[1] ?? NaN);

/** Due at 9:00 AM event time N days before `anchor`, and only until the anchor day is over (or the event starts). */
function dueBefore(rule: string, anchor: string, until: Date, tz: string, now: Date) {
  const n = daysOf(rule);
  if (!rule.startsWith("days_before:") || Number.isNaN(n) || !anchor) return false;
  return now >= zonedToDate(shiftDate(anchor, -n), "09:00", tz) && now < until;
}

/** Due at 9:00 AM event time N days after the event ends, for three days. */
function dueAfter(rule: string, end: string, tz: string, now: Date) {
  const n = daysOf(rule);
  if (!rule.startsWith("days_after:") || Number.isNaN(n)) return false;
  const due = zonedToDate(shiftDate(end, n), "09:00", tz);
  return now >= due && now.getTime() < due.getTime() + 3 * DAY;
}

/** Minute job: each enabled follow-up goes once to each person when it is due. Never throws for one bad row. */
export async function runRecipientFollowUps(now = new Date()) {
  const db = getDb();
  const kinds = Object.values(GROUP_FOLLOW_UPS).flat();
  const templates = db.select().from(schema.messageTemplates).where(and(inArray(schema.messageTemplates.kind, kinds), eq(schema.messageTemplates.enabled, true))).all();
  const byEvent = new Map<number, Template[]>();
  for (const t of templates) byEvent.set(t.eventId, [...(byEvent.get(t.eventId) ?? []), t]);
  let sent = 0;
  for (const [eventId, list] of byEvent) {
    try {
      sent += await followUpsForEvent(eventId, list, now);
    } catch (err) {
      console.error(`[welcome] follow-ups for event ${eventId} failed:`, err);
    }
  }
  return sent;
}

async function followUpsForEvent(eventId: number, templates: Template[], now: Date) {
  const db = getDb();
  const ev = eventOf(eventId);
  if (!ev) return 0;
  const tz = ev.timezone;
  // Nothing goes out more than a few weeks after the event.
  if (now.getTime() > zonedToDate(shiftDate(ev.endDate, 30), "23:59", tz).getTime()) return 0;
  const startNoon = zonedToDate(ev.startDate, "12:00", tz);
  const endOfEvent = zonedToDate(ev.endDate, "23:59", tz);
  const log = db.select().from(schema.recipientLog).where(eq(schema.recipientLog.eventId, eventId)).all();
  const logged = new Set(log.map((r) => `${r.recipientType}:${r.recipientId}:${r.kind}`));
  const welcomed = new Set(log.filter((r) => r.status === "sent" && (r.kind === "sponsor_welcome" || r.kind === "exhibitor_welcome")).map((r) => r.recipientId));
  let sent = 0;

  const run = async (type: RecipientType, id: number, t: Template, to: string, ctx: () => Ctx) => {
    if (logged.has(`${type}:${id}:${t.kind}`)) return;
    logged.add(`${type}:${id}:${t.kind}`);
    try {
      const r = await deliver({ event: ev, type, id, kind: t.kind, to, t, retry: false, build: async () => ({ ...(await renderRecipientEmail(t, ctx())), attachments: [] }) });
      if (r === "sent") sent++;
    } catch (err) {
      console.error(`[welcome] ${t.kind} to ${type} ${id} failed:`, err);
    }
  };

  const speakerTemplates = templates.filter((t) => groupOfKind(t.kind) === "speakers");
  if (speakerTemplates.length) {
    for (const sp of speakersOf(eventId)) {
      if (!sp.email) continue;
      try {
        const sessions = sessionsOfSpeaker(sp.id).filter((s) => !NO_SLIDES.has(s.kind));
        if (!sessions.length) continue;
        for (const t of speakerTemplates) {
          if (logged.has(`speaker:${sp.id}:${t.kind}`)) continue;
          if (t.kind === "speaker_slides_reminder") {
            const ids = sessions.map((s) => s.id);
            const withFiles = new Set(db.select({ id: schema.sessionFiles.sessionId }).from(schema.sessionFiles).where(inArray(schema.sessionFiles.sessionId, ids)).all().map((r) => r.id));
            const due = sessions.filter((s) => s.slidesDueOn && !withFiles.has(s.id)).map((s) => s.slidesDueOn!).sort()[0];
            if (!due || !dueBefore(t.sendRule, due, zonedToDate(due, "23:59", tz), tz, now)) continue;
          } else if (t.kind === "speaker_know_before") {
            if (!dueBefore(t.sendRule, ev.startDate, startNoon, tz, now)) continue;
          } else if (t.kind === "speaker_thanks") {
            if (!dueAfter(t.sendRule, ev.endDate, tz, now)) continue;
          } else continue;
          await run("speaker", sp.id, t, sp.email, () => speakerCtx(sp, ev));
        }
      } catch (err) {
        console.error(`[welcome] follow-ups for speaker ${sp.id} failed:`, err);
      }
    }
  }

  const vendorTemplates = templates.filter((t) => groupOfKind(t.kind) === "sponsors" || groupOfKind(t.kind) === "exhibitors");
  if (vendorTemplates.length) {
    const vendors = db.select().from(schema.vendors).where(eq(schema.vendors.eventId, eventId)).all().filter((v) => v.status !== "cancelled" && v.email);
    const payments = vendors.length ? db.select().from(schema.vendorPayments).where(eq(schema.vendorPayments.eventId, eventId)).all() : [];
    for (const v of vendors) {
      try {
        const group = vendorGroup(v);
        const paid = vendorPaid(v, payments.filter((p) => p.vendorId === v.id));
        for (const t of vendorTemplates) {
          if (logged.has(`vendor:${v.id}:${t.kind}`)) continue;
          if (t.kind === "exhibitor_booth_assigned") {
            // Exhibitors (and sponsors who also exhibit) once a booth number is set after their welcome went out.
            if (v.kind === "sponsor" || !v.booth || !welcomed.has(v.id) || now >= endOfEvent) continue;
          } else {
            if (groupOfKind(t.kind) !== group || !paid) continue;
            if (t.kind === "sponsor_passes_reminder") {
              const c = vendorCtx(v, ev);
              if (c.passesTotal <= 0 || c.passesNamed >= c.passesTotal || !dueBefore(t.sendRule, ev.startDate, startNoon, tz, now)) continue;
            } else if (t.kind === "sponsor_logo_reminder") {
              const dueOn = typeof t.includes.logoDueOn === "string" ? t.includes.logoDueOn : "";
              if (v.logoFileId || !dueOn || !dueBefore(t.sendRule, dueOn, zonedToDate(dueOn, "23:59", tz), tz, now)) continue;
            } else if (t.kind === "sponsor_know_before" || t.kind === "exhibitor_know_before") {
              if (!dueBefore(t.sendRule, ev.startDate, startNoon, tz, now)) continue;
            } else continue;
          }
          await run("vendor", v.id, t, v.email, () => vendorCtx(v, ev));
        }
      } catch (err) {
        console.error(`[welcome] follow-ups for vendor ${v.id} failed:`, err);
      }
    }
  }
  return sent;
}
