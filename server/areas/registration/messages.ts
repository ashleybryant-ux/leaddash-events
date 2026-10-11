/**
 * The welcome email and the follow-ups (text with the app link, app reminder,
 * know before you go, morning-of text). Every send is logged in message_log,
 * which allows one row per attendee and kind, so nothing goes twice.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { addressLines } from "@shared/address";
import QRCode from "qrcode";
import { getDb, schema } from "../../_core/db";
import { ENV } from "../../_core/env";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { fileUrl } from "../../_core/files";
import { sendText } from "../../_core/platform";
import { fmtDates, fmtMoney, fmtDate, fmtTime } from "@shared/format";
import { zonedToDate } from "@shared/time";
import type { MessageKind } from "../../../drizzle/schema";
import { RECIPIENT_KINDS, defaultRecipientTemplates } from "./recipientDefaults";

type Event = typeof schema.events.$inferSelect;
type Template = typeof schema.messageTemplates.$inferSelect;
type Attendee = typeof schema.attendees.$inferSelect;
export type TemplateDraft = Pick<Template, "kind" | "channel" | "subject" | "body" | "fromName" | "replyTo" | "includes" | "sendRule" | "onlyIfNoApp" | "enabled">;

export const KIND_LABELS: Record<MessageKind, string> = {
  welcome: "Welcome email",
  text_app: "Text with the app link",
  app_reminder: "App reminder email",
  know_before: "Know before you go",
  morning_text: "Morning-of text",
  speaker_welcome: "Welcome email",
  speaker_slides_reminder: "Slides reminder",
  speaker_know_before: "Speaker know before you go",
  speaker_thanks: "Thank you and evaluation results",
  sponsor_welcome: "Welcome email",
  sponsor_passes_reminder: "Pass names reminder",
  sponsor_logo_reminder: "Logo and ad reminder",
  sponsor_know_before: "Sponsor know before you go",
  exhibitor_welcome: "Welcome email",
  exhibitor_booth_assigned: "Booth number assigned",
  exhibitor_know_before: "Exhibitor know before you go",
};

/** The five messages every new event starts with. */
export function defaultTemplates(ev: Event, orgName: string): Omit<typeof schema.messageTemplates.$inferInsert, "eventId">[] {
  const short = ev.shortName || ev.name;
  const fromName = `${orgName} Conference Team`;
  const none = { receipt: false, getApp: false, qr: false, calendar: false, hotel: false };
  return [
    {
      kind: "welcome",
      channel: "email",
      sendRule: "after_payment",
      fromName,
      subject: `You're registered for ${short}, {{first name}}`,
      body: "Hi {{first name}}, your spot is confirmed. Get the conference app now so your schedule, badge, and CE certificates are ready when you arrive.",
      includes: { receipt: true, getApp: true, qr: true, calendar: true, hotel: false },
    },
    {
      kind: "text_app",
      channel: "text",
      sendRule: "after_payment",
      fromName,
      body: `${short}: you're registered, {{first name}}. Get the conference app here: {{app link}} Reply STOP to opt out.`,
      includes: none,
    },
    {
      kind: "app_reminder",
      channel: "email",
      sendRule: "days_before:7",
      onlyIfNoApp: true,
      fromName,
      subject: `${short} is one week away. Get the app`,
      body: "Hi {{first name}}, the conference starts {{event dates}}. Get the app now so your agenda, badge, and CE certificates are ready when you arrive.",
      includes: { ...none, getApp: true },
    },
    {
      kind: "know_before",
      channel: "email",
      sendRule: "days_before:2",
      fromName,
      subject: `Know before you go: ${short}`,
      body: "Hi {{first name}}, we will see you soon at {{venue}}. Bring this email or open your badge in the app to check in. Your agenda and session rooms are in the app.",
      includes: { ...none, getApp: true, qr: true, calendar: true },
    },
    {
      kind: "morning_text",
      channel: "text",
      sendRule: `at:${ev.startDate}T07:00`,
      enabled: false,
      fromName,
      body: `Good morning, {{first name}}. ${short} starts today. Your agenda and badge are in the app: {{app link}}`,
      includes: none,
    },
  ];
}

export function seedTemplates(eventId: number) {
  const db = getDb();
  const ev = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get();
  if (!ev) return;
  const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
  for (const t of defaultTemplates(ev, org.name)) {
    db.insert(schema.messageTemplates).values({ ...t, eventId }).onConflictDoNothing().run();
  }
  seedRecipientTemplates(eventId);
}

/** Attendee messages (the speaker, sponsor and exhibitor ones live in recipientMessages.ts). */
export const isAttendeeKind = (kind: MessageKind) => !RECIPIENT_KINDS.has(kind);

/** Adds any missing speaker, sponsor and exhibitor messages (new events, and older events the first time they are read). */
export function seedRecipientTemplates(eventId: number) {
  const db = getDb();
  const ev = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get();
  if (!ev) return;
  const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
  for (const t of defaultRecipientTemplates(ev, org.name)) {
    db.insert(schema.messageTemplates)
      .values({ ...t, eventId, includes: { receipt: false, getApp: false, qr: false, calendar: false, hotel: false, ...t.includes } })
      .onConflictDoNothing()
      .run();
  }
}

/** "Right after payment", "7 days before, if no app yet", "Apr 22, 2027, 7:00 AM". */
export function describeRule(rule: string, onlyIfNoApp = false) {
  const tail = onlyIfNoApp ? ", if no app yet" : "";
  if (rule === "after_payment") return `Right after payment${tail}`;
  if (rule === "after_payment_1h") return `1 hour after payment${tail}`;
  const days = rule.match(/^days_before:(\d+)$/);
  if (days) return `${days[1]} day${days[1] === "1" ? "" : "s"} before${tail}`;
  const at = rule.match(/^at:(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  if (at) return `${fmtDate(at[1])}, ${fmtTime(at[2])}${tail}`;
  return rule;
}

export const appLink = (slug: string) => `${ENV.appUrl}/get/${slug}`;
export const calendarLink = (slug: string) => `${ENV.appUrl}/r/${slug}/calendar.ics`;
export const qrImageLink = (slug: string, token: string) => `${ENV.appUrl}/r/${slug}/qr/${encodeURIComponent(token)}.png`;

export function coverFor(ev: Event, absolute = true) {
  const page = getDb().select().from(schema.checkoutPages).where(eq(schema.checkoutPages.eventId, ev.id)).get();
  return fileUrl(page?.coverFileId ?? ev.branding.coverFileId, absolute);
}

type Ctx = {
  event: Event;
  firstName: string;
  lastName: string;
  ticketName: string;
  amountCents: number;
  qrToken: string;
  /** Previews and tests inline the QR code; real emails link the hosted image (Gmail drops inline data images). */
  qrDataUrl?: string;
};

export function fillFields(text: string, c: Ctx) {
  const ev = c.event;
  const fields: Record<string, string> = {
    "first name": c.firstName,
    "last name": c.lastName,
    "ticket name": c.ticketName,
    "amount paid": fmtMoney(c.amountCents),
    "event name": ev.name,
    "event dates": fmtDates(ev.startDate, ev.endDate),
    venue: [ev.venueName, ev.city].filter(Boolean).join(", "),
    "app link": appLink(ev.slug),
  };
  return text.replace(/\{\{\s*([a-z ]+?)\s*\}\}/gi, (m, k: string) => fields[k.toLowerCase()] ?? m);
}

/** Subject, plain text and branded HTML for an email template. */
export function renderEmail(t: TemplateDraft, c: Ctx) {
  const ev = c.event;
  const brand = ev.branding.colorPrimary || "#1F5F4A";
  const accent = ev.branding.colorAccent || "#e88a3a";
  const subject = fillFields(t.subject, c);
  const body = fillFields(t.body, c);
  const where = [fmtDates(ev.startDate, ev.endDate), ev.venueName].filter(Boolean).join(" · ");
  const blocks: string[] = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);
  const text: string[] = [body];
  const inc = t.includes;
  if (inc.receipt) {
    blocks.push(
      `<div style="background:#F4F8F6;border-radius:10px;padding:10px 12px;font-size:13px;margin:0 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-weight:bold">${escapeHtml(c.ticketName)}</td><td align="right" style="font-weight:800">${escapeHtml(fmtMoney(c.amountCents))}</td></tr></table><div style="color:#4B5B57;margin-top:4px">${escapeHtml(where)}</div></div>`
    );
    text.push(`${c.ticketName}: ${fmtMoney(c.amountCents)}\n${where}`);
  }
  if (inc.getApp) {
    blocks.push(emailButton("Get the app", appLink(ev.slug), { ...ev.branding, colorAccent: accent }));
    blocks.push(`<p style="margin:0 0 12px;font-size:13px;color:#4B5B57">iPhone: open the link in Safari, tap Share, then Add to Home Screen. Android: tap Install.</p>`);
    text.push(`Get the app: ${appLink(ev.slug)}\niPhone: open the link in Safari, tap Share, then Add to Home Screen. Android: tap Install.`);
  }
  if (inc.qr) {
    const src = c.qrDataUrl ?? qrImageLink(ev.slug, c.qrToken);
    blocks.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid #EEF2F1;width:100%;margin:0 0 12px"><tr><td width="84" style="padding-top:12px"><img src="${src}" width="72" height="72" alt="Check-in QR code" style="display:block;border:0"></td><td style="padding-top:12px;font-size:13px">Show this code at check-in to print your badge.</td></tr></table>`
    );
    text.push("Show the QR code in this email at check-in to print your badge.");
  }
  if (inc.calendar) {
    blocks.push(`<p style="margin:0 0 12px;font-size:13px"><a href="${calendarLink(ev.slug)}" style="color:${brand};font-weight:bold">Add to calendar</a></p>`);
    text.push(`Add to calendar: ${calendarLink(ev.slug)}`);
  }
  if (inc.hotel && inc.hotelUrl) {
    blocks.push(`<p style="margin:0 0 12px;font-size:13px"><a href="${escapeHtml(inc.hotelUrl)}" style="color:${brand};font-weight:bold">Book the hotel block</a></p>`);
    text.push(`Book the hotel block: ${inc.hotelUrl}`);
  }
  const html = emailLayout({ brand, accent, coverUrl: coverFor(ev), eventName: ev.name, blocks, look: ev.branding });
  return { subject, text: text.join("\n\n"), html };
}

export function renderText(t: Pick<Template, "body">, c: Ctx) {
  return fillFields(t.body, c);
}

export async function qrDataUrl(value: string) {
  return QRCode.toDataURL(value, { margin: 1, width: 216, errorCorrectionLevel: "M", color: { dark: "#0F2A23", light: "#FFFFFF" } });
}

export async function qrPng(value: string) {
  return QRCode.toBuffer(value, { type: "png", margin: 1, width: 216, errorCorrectionLevel: "M", color: { dark: "#0F2A23", light: "#FFFFFF" } });
}

/** The person's latest paid or free order (ticket, amount, when they registered). */
function latestOrder(attendee: Attendee) {
  return getDb()
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.attendeeId, attendee.id), inArray(schema.orders.status, ["paid", "free"])))
    .orderBy(desc(schema.orders.id))
    .get();
}

function ctxFor(attendee: Attendee, ev: Event): Ctx {
  const order = latestOrder(attendee);
  const ticketId = order?.ticketTypeId ?? attendee.ticketTypeId;
  const ticket = ticketId ? getDb().select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, ticketId)).get() : undefined;
  return { event: ev, firstName: attendee.firstName, lastName: attendee.lastName, ticketName: ticket?.name ?? "Registration", amountCents: order?.amountCents ?? 0, qrToken: attendee.qrToken };
}

/** Reserves the log row first; only the caller that reserved it sends. Returns the row id, or null if already sent. */
function reserve(eventId: number, attendeeId: number, kind: string, channel: string) {
  const row = getDb().insert(schema.messageLog).values({ eventId, attendeeId, kind, channel, status: "sent" }).onConflictDoNothing().returning().get();
  return row?.id ?? null;
}

function finish(logId: number, status: "sent" | "failed" | "skipped", error?: string) {
  getDb().update(schema.messageLog).set({ status, error: error ?? null }).where(eq(schema.messageLog.id, logId)).run();
}

/** Sends one template to one attendee (once). */
export async function deliver(t: Template, attendee: Attendee, ev: Event) {
  const logId = reserve(ev.id, attendee.id, t.kind, t.channel);
  if (!logId) return "already";
  try {
    if (t.onlyIfNoApp && attendee.appOpenedAt) {
      finish(logId, "skipped", "Already opened the app");
      return "skipped";
    }
    const c = ctxFor(attendee, ev);
    if (t.channel === "text") {
      if (!attendee.textConsent || !attendee.phone) {
        finish(logId, "skipped", "Did not agree to texts");
        return "skipped";
      }
      const ok = await sendText(ev.orgId, { email: attendee.email, firstName: attendee.firstName, lastName: attendee.lastName, phone: attendee.phone }, renderText(t, c));
      if (!ok) {
        finish(logId, "skipped", "Texting is not set up for this organization");
        return "skipped";
      }
      return "sent";
    }
    const m = renderEmail(t, c);
    await sendEmail({ to: attendee.email, subject: m.subject, text: m.text, html: m.html, fromName: t.fromName || undefined, replyTo: t.replyTo || undefined });
    return "sent";
  } catch (err) {
    finish(logId, "failed", (err as Error).message.slice(0, 300));
    return "failed";
  }
}

export function templateFor(eventId: number, kind: MessageKind) {
  return getDb()
    .select()
    .from(schema.messageTemplates)
    .where(and(eq(schema.messageTemplates.eventId, eventId), eq(schema.messageTemplates.kind, kind)))
    .get();
}

/** The welcome email. With onlyIfDueNow, waits for the minute job when the template is set to 1 hour after payment. */
export async function sendWelcome(attendeeId: number, opts: { onlyIfDueNow?: boolean } = {}) {
  const db = getDb();
  const attendee = db.select().from(schema.attendees).where(eq(schema.attendees.id, attendeeId)).get();
  if (!attendee || attendee.status !== "registered") return "skipped";
  const ev = db.select().from(schema.events).where(eq(schema.events.id, attendee.eventId)).get()!;
  const t = templateFor(ev.id, "welcome");
  if (!t || !t.enabled) return "skipped";
  if (opts.onlyIfDueNow && t.sendRule !== "after_payment") return "later";
  return deliver(t, attendee, ev);
}

/** When a template is due for someone who registered at `registeredAt`. */
export function dueAt(rule: string, ev: Pick<Event, "startDate" | "timezone">, registeredAt: Date): Date | null {
  if (rule === "after_payment") return registeredAt;
  if (rule === "after_payment_1h") return new Date(registeredAt.getTime() + 3600_000);
  const days = rule.match(/^days_before:(\d+)$/);
  if (days) {
    const d = new Date(`${ev.startDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - Number(days[1]));
    return zonedToDate(d.toISOString().slice(0, 10), "09:00", ev.timezone);
  }
  const at = rule.match(/^at:(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  if (at) return zonedToDate(at[1], at[2], ev.timezone);
  return null;
}

const HOUR = 3600_000;

/**
 * Whether a template should go to this person now. Payment-based messages go
 * within two days of registering; "days before" messages stop when the event
 * starts; a timed message (morning-of) is dropped six hours late. Reminders
 * are not sent to people who registered within a day of the reminder.
 */
export function shouldSend(t: Pick<Template, "sendRule" | "onlyIfNoApp">, ev: Pick<Event, "startDate" | "timezone">, registeredAt: Date, now: Date) {
  const due = dueAt(t.sendRule, ev, registeredAt);
  if (!due || now < due) return false;
  if (t.sendRule.startsWith("after_payment")) return now.getTime() - due.getTime() < 48 * HOUR;
  if (t.sendRule.startsWith("days_before:")) {
    if (now >= zonedToDate(ev.startDate, "12:00", ev.timezone)) return false;
    if (t.onlyIfNoApp && registeredAt.getTime() > due.getTime() - 24 * HOUR) return false;
    return true;
  }
  if (t.sendRule.startsWith("at:")) return now.getTime() - due.getTime() < 6 * HOUR && registeredAt <= due;
  return false;
}

/** Minute job: sends what is due. Never throws for one bad row. */
export async function runFollowUps(now = new Date()) {
  const db = getDb();
  const events = db.select().from(schema.events).where(ne(schema.events.status, "ended")).all();
  for (const ev of events) {
    const templates = db
      .select()
      .from(schema.messageTemplates)
      .where(and(eq(schema.messageTemplates.eventId, ev.id), eq(schema.messageTemplates.enabled, true)))
      .all()
      .filter((t) => isAttendeeKind(t.kind));
    if (!templates.length) continue;
    const page = db.select().from(schema.checkoutPages).where(eq(schema.checkoutPages.eventId, ev.id)).get();
    const attendees = db
      .select()
      .from(schema.attendees)
      .where(and(eq(schema.attendees.eventId, ev.id), eq(schema.attendees.status, "registered"), ne(schema.attendees.kind, "staff")))
      .all();
    if (!attendees.length) continue;
    const sent = new Set(
      db.select({ a: schema.messageLog.attendeeId, k: schema.messageLog.kind }).from(schema.messageLog).where(eq(schema.messageLog.eventId, ev.id)).all().map((r) => `${r.a}:${r.k}`)
    );
    const orders = db
      .select({ attendeeId: schema.orders.attendeeId, paidAt: schema.orders.paidAt })
      .from(schema.orders)
      .where(and(eq(schema.orders.eventId, ev.id), inArray(schema.orders.status, ["paid", "free"])))
      .all();
    const paidAt = new Map<number, Date>();
    for (const o of orders) if (o.attendeeId && o.paidAt && (!paidAt.has(o.attendeeId) || paidAt.get(o.attendeeId)! < o.paidAt)) paidAt.set(o.attendeeId, o.paidAt);
    for (const t of templates) {
      if (t.kind === "welcome" && page && !page.sendWelcome) continue;
      for (const a of attendees) {
        if (sent.has(`${a.id}:${t.kind}`)) continue;
        // The welcome email and payment follow-ups are for people who registered on the checkout page.
        const registeredAt = paidAt.get(a.id);
        if ((t.kind === "welcome" || t.sendRule.startsWith("after_payment")) && !registeredAt) continue;
        if (!shouldSend(t, ev, registeredAt ?? a.createdAt, now)) continue;
        try {
          await deliver(t, a, ev);
        } catch (err) {
          console.error(`[registration] follow-up ${t.kind} for attendee ${a.id} failed:`, err);
        }
      }
    }
  }
}

/** Sample data for previews and tests: the admin's first name and the first ticket. */
export async function sampleCtx(ev: Event, firstName: string): Promise<Ctx> {
  const ticket = getDb().select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, ev.id)).orderBy(schema.ticketTypes.sort, schema.ticketTypes.id).get();
  return { event: ev, firstName: firstName || "Jordan", lastName: "", ticketName: ticket?.name ?? "Member", amountCents: ticket?.priceCents ?? 0, qrToken: "sample", qrDataUrl: await qrDataUrl(`${ev.slug}-sample`) };
}

/** An all-day calendar entry for the event. */
export function calendarFile(ev: Event) {
  const next = new Date(`${ev.endDate}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const ymd = (s: string) => s.replace(/-/g, "");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const location = [ev.venueName, ...addressLines(ev)].filter(Boolean).join(", ");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LeadDash Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:event-${ev.id}@events.leaddash.io`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${ymd(ev.startDate)}`,
    `DTEND;VALUE=DATE:${ymd(next.toISOString().slice(0, 10))}`,
    `SUMMARY:${esc(ev.name)}`,
    location ? `LOCATION:${esc(location)}` : "",
    `DESCRIPTION:${esc(`Your agenda and badge are in the app: ${appLink(ev.slug)}`)}`,
    `URL:${appLink(ev.slug)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}
