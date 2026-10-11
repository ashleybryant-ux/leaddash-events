/**
 * Agreements sent to and signed by one person: creating (the filled text is
 * frozen into the row), emailing the sign link, signing, reminders, and the
 * emails that go out once it is signed.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb, schema } from "../../_core/db";
import { ENV } from "../../_core/env";
import { saveFile } from "../../_core/files";
import { randomToken } from "../../_core/crypto";
import { emailButton, emailLayout, escapeHtml, sendEmail, type EmailAttachment } from "../../_core/email";
import { fmtWhen } from "@shared/format";
import type { Agreement, AgreementTemplate, AgreementValues } from "../../../drizzle/schema";
import { eventMailStyle } from "../program/util";
import { sendSpeakerWelcome, sendVendorWelcome } from "../registration/recipientMessages";
import { fillAgreement, sessionWhen, speakerSession, valuesFor } from "./fill";
import { agreementPdf } from "./pdf";
import type { AgreementKind } from "./templates";

type EventRow = typeof schema.events.$inferSelect;

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const DAY = 86_400_000;

export const signLink = (code: string) => `${ENV.appUrl}/sign/${code}`;
export const copyLink = (code: string) => `${ENV.appUrl}/agreement/${code}`;

function eventOf(eventId: number): EventRow {
  return getDb().select().from(schema.events).where(eq(schema.events.id, eventId)).get()!;
}

function orgName(event: EventRow) {
  return getDb().select().from(schema.organizations).where(eq(schema.organizations.id, event.orgId)).get()?.name ?? "";
}

export function templateById(id: number | null | undefined) {
  return id ? getDb().select().from(schema.agreementTemplates).where(eq(schema.agreementTemplates.id, id)).get() : undefined;
}

/** The template an event uses for a kind (the most recently edited one). */
export function templateFor(eventId: number, kind: AgreementKind): AgreementTemplate | undefined {
  return getDb()
    .select()
    .from(schema.agreementTemplates)
    .where(and(eq(schema.agreementTemplates.eventId, eventId), eq(schema.agreementTemplates.kind, kind)))
    .orderBy(desc(schema.agreementTemplates.updatedAt), desc(schema.agreementTemplates.id))
    .get();
}

/**
 * Creates one agreement and freezes its filled text. Status "draft" until it
 * is emailed (sendAgreement) or signed on the checkout page; pass status "sent"
 * only if you email the link yourself. The returned row's `code` is the secret
 * used in /sign/:code and /agreement/:code.
 */
export function createAgreement(opts: {
  eventId: number;
  templateId: number;
  kind: AgreementKind;
  vendorId?: number | null;
  speakerId?: number | null;
  checkoutId?: number | null;
  signerEmail: string;
  values: AgreementValues;
  status?: "draft" | "sent";
  welcomeAfterSign?: boolean;
}): Agreement {
  const t = templateById(opts.templateId);
  if (!t || t.eventId !== opts.eventId) throw bad("That agreement template was not found.");
  return getDb()
    .insert(schema.agreements)
    .values({
      eventId: opts.eventId,
      templateId: t.id,
      kind: opts.kind,
      vendorId: opts.vendorId ?? null,
      speakerId: opts.speakerId ?? null,
      checkoutId: opts.checkoutId ?? null,
      code: randomToken(24),
      status: opts.status ?? "draft",
      title: t.name,
      html: fillAgreement(t.body, opts.values),
      signerEmail: opts.signerEmail.trim().toLowerCase(),
      sentAt: opts.status === "sent" ? new Date() : null,
      welcomeAfterSign: opts.welcomeAfterSign ?? true,
    })
    .returning()
    .get();
}

/** Every agreement for a sponsor or exhibitor, newest first. */
export function agreementsForVendor(vendorId: number): Agreement[] {
  return getDb().select().from(schema.agreements).where(eq(schema.agreements.vendorId, vendorId)).orderBy(desc(schema.agreements.id)).all();
}

/** The agreement that counts for a speaker: the signed one, else the latest sent or draft one. Void ones are skipped. */
export function agreementForSpeaker(speakerId: number): Agreement | undefined {
  const list = getDb().select().from(schema.agreements).where(eq(schema.agreements.speakerId, speakerId)).orderBy(desc(schema.agreements.id)).all().filter((a) => a.status !== "void");
  return list.find((a) => a.status === "signed") ?? list[0];
}

/** Links an agreement made at checkout to the vendor the checkout created. */
export function attachAgreementToVendor(agreementId: number, vendorId: number) {
  getDb().update(schema.agreements).set({ vendorId }).where(eq(schema.agreements.id, agreementId)).run();
}

const KIND_WORD: Record<AgreementKind, string> = { sponsor: "sponsor", exhibitor: "exhibitor", speaker: "speaker" };

function greetingName(a: Agreement) {
  const db = getDb();
  if (a.speakerId) {
    const s = db.select().from(schema.speakers).where(eq(schema.speakers.id, a.speakerId)).get();
    return s?.firstName || s?.name || "";
  }
  if (a.vendorId) return (db.select().from(schema.vendors).where(eq(schema.vendors.id, a.vendorId)).get()?.contactName ?? "").split(" ")[0];
  if (a.checkoutId) return db.select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.id, a.checkoutId)).get()?.buyer.firstName ?? "";
  return "";
}

function linkEmail(a: Agreement, reminder: boolean) {
  const event = eventOf(a.eventId);
  const style = eventMailStyle(event);
  const word = KIND_WORD[a.kind];
  const hi = greetingName(a);
  const title = reminder ? `Reminder: please sign your ${word} agreement` : `Please sign your ${word} agreement`;
  const intro = `${reminder ? "Your" : "Here is your"} ${word} agreement for ${event.name}. It takes about a minute to read and sign.`;
  const url = signLink(a.code);
  return {
    to: a.signerEmail,
    fromName: style.fromName,
    subject: `${style.fromName}: ${reminder ? "reminder to sign" : "please sign"} your ${word} agreement`,
    text: [`Hi ${hi || "there"},`, intro, `Sign here: ${url}`, orgName(event)].join("\n\n"),
    html: emailLayout({
      ...style,
      title,
      blocks: [`<p>Hi ${escapeHtml(hi || "there")},</p>`, `<p>${escapeHtml(intro)}</p>`, emailButton("Sign agreement", url, event.branding)],
      footer: escapeHtml(orgName(event)),
    }),
  };
}

/** Emails the sign link and marks the agreement sent (resets reminders). */
export async function sendAgreement(agreementId: number) {
  const a = getDb().select().from(schema.agreements).where(eq(schema.agreements.id, agreementId)).get();
  if (!a) throw bad("That agreement was not found.");
  if (a.status === "signed") throw bad("This agreement is already signed.");
  if (!a.signerEmail) throw bad("Add an email first.");
  await sendEmail(linkEmail(a, false));
  getDb().update(schema.agreements).set({ status: "sent", sentAt: new Date(), remindersSent: 0, lastReminderAt: null }).where(eq(schema.agreements.id, a.id)).run();
}

/**
 * Sends a speaker their agreement: refreshes an unsigned one (session details
 * may have changed) or creates it. Does nothing (returns null) when the event
 * has no speaker template or the speaker has no email; returns the signed one
 * untouched.
 */
export async function sendSpeakerAgreement(speakerId: number, opts: { welcomeAfterSign?: boolean; onlyIfNew?: boolean } = {}) {
  const db = getDb();
  const sp = db.select().from(schema.speakers).where(eq(schema.speakers.id, speakerId)).get();
  if (!sp || !sp.email) return null;
  const t = templateFor(sp.eventId, "speaker");
  if (!t) return null;
  const existing = agreementForSpeaker(sp.id);
  if (existing?.status === "signed") return existing;
  if (existing && opts.onlyIfNew) return existing;
  const event = eventOf(sp.eventId);
  const html = fillAgreement(t.body, valuesFor(event, t, { kind: "speaker", speaker: sp }));
  let row: Agreement;
  if (existing) {
    db.update(schema.agreements)
      .set({ html, templateId: t.id, title: t.name, signerEmail: sp.email.toLowerCase(), ...(opts.welcomeAfterSign === undefined ? {} : { welcomeAfterSign: opts.welcomeAfterSign }) })
      .where(eq(schema.agreements.id, existing.id))
      .run();
    row = db.select().from(schema.agreements).where(eq(schema.agreements.id, existing.id)).get()!;
  } else {
    row = createAgreement({ eventId: sp.eventId, templateId: t.id, kind: "speaker", speakerId: sp.id, signerEmail: sp.email, values: valuesFor(event, t, { kind: "speaker", speaker: sp }), welcomeAfterSign: opts.welcomeAfterSign ?? true });
  }
  await sendAgreement(row.id);
  return db.select().from(schema.agreements).where(eq(schema.agreements.id, row.id)).get()!;
}

/** Refreshes an unsigned speaker agreement's text (after their session changes) without emailing. */
export function refreshSpeakerAgreement(speakerId: number) {
  const db = getDb();
  const a = agreementForSpeaker(speakerId);
  if (!a || a.status === "signed") return;
  const sp = db.select().from(schema.speakers).where(eq(schema.speakers.id, speakerId)).get();
  const t = templateById(a.templateId);
  if (!sp || !t) return;
  db.update(schema.agreements).set({ html: fillAgreement(t.body, valuesFor(eventOf(sp.eventId), t, { kind: "speaker", speaker: sp })) }).where(eq(schema.agreements.id, a.id)).run();
}

/** The template kind for a vendor: sponsors (and sponsors who also exhibit) use the sponsor one, exhibitors the exhibitor one. */
export function templateForVendor(v: { eventId: number; kind: "exhibitor" | "sponsor" | "both" }) {
  return v.kind === "exhibitor" ? templateFor(v.eventId, "exhibitor") : templateFor(v.eventId, "sponsor") ?? (v.kind === "both" ? templateFor(v.eventId, "exhibitor") : undefined);
}

/** Templates that fit a vendor: sponsor ones for sponsors, exhibitor ones for exhibitors, both for sponsors who also exhibit. */
const fitsVendor = (t: AgreementTemplate, v: { eventId: number; kind: "exhibitor" | "sponsor" | "both" }) =>
  t.eventId === v.eventId && (v.kind === "exhibitor" ? t.kind === "exhibitor" : v.kind === "sponsor" ? t.kind === "sponsor" : t.kind !== "speaker");

/**
 * The template a vendor's agreement uses: the one picked in their details
 * (kept on their latest unsigned agreement, a draft until it is sent), else
 * the event's template for their kind.
 */
export function chosenTemplateForVendor(v: { id: number; eventId: number; kind: "exhibitor" | "sponsor" | "both" }) {
  const open = agreementsForVendor(v.id).find((a) => a.status !== "void");
  const t = open?.templateId ? templateById(open.templateId) : undefined;
  return t && fitsVendor(t, v) ? t : templateForVendor(v);
}

/** Saves the agreement template picked in a vendor's details on their unsigned agreement. Nothing is emailed. */
export function setVendorTemplate(vendorId: number, templateId: number) {
  const db = getDb();
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get();
  if (!v) throw bad("That sponsor was not found.");
  const t = templateById(templateId);
  if (!t || !fitsVendor(t, v)) throw bad("Pick an agreement for this kind.");
  const list = agreementsForVendor(v.id).filter((a) => a.status !== "void");
  if (list.some((a) => a.status === "signed")) throw bad("This agreement is already signed.");
  const open = list[0];
  if (open && open.templateId === t.id) return;
  const values = valuesFor(eventOf(v.eventId), t, { kind: t.kind, vendor: v });
  if (open) db.update(schema.agreements).set({ html: fillAgreement(t.body, values), templateId: t.id, title: t.name, kind: t.kind }).where(eq(schema.agreements.id, open.id)).run();
  else createAgreement({ eventId: v.eventId, templateId: t.id, kind: t.kind, vendorId: v.id, signerEmail: v.email, values });
}

/** Sends a sponsor or exhibitor their agreement (refreshing an unsigned one, or creating it). */
export async function sendVendorAgreement(vendorId: number) {
  const db = getDb();
  const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, vendorId)).get();
  if (!v) throw bad("That sponsor was not found.");
  if (!v.email) throw bad("Add the contact's email first.");
  const t = chosenTemplateForVendor(v);
  if (!t) throw bad("Add an agreement for this kind on the Agreements tab first.");
  const list = agreementsForVendor(v.id).filter((a) => a.status !== "void");
  if (list.some((a) => a.status === "signed")) throw bad("This agreement is already signed.");
  const event = eventOf(v.eventId);
  const values = valuesFor(event, t, { kind: t.kind, vendor: v });
  const open = list[0];
  let id: number;
  if (open) {
    db.update(schema.agreements).set({ html: fillAgreement(t.body, values), templateId: t.id, title: t.name, kind: t.kind, signerEmail: v.email.toLowerCase() }).where(eq(schema.agreements.id, open.id)).run();
    id = open.id;
  } else id = createAgreement({ eventId: v.eventId, templateId: t.id, kind: t.kind, vendorId: v.id, signerEmail: v.email, values }).id;
  await sendAgreement(id);
  return db.select().from(schema.agreements).where(eq(schema.agreements.id, id)).get()!;
}

/** Resends an unsigned agreement: refreshes the text when its party still exists, then emails the link again. */
export async function resendAgreement(agreementId: number) {
  const a = getDb().select().from(schema.agreements).where(eq(schema.agreements.id, agreementId)).get();
  if (!a) throw bad("That agreement was not found.");
  if (a.status === "signed") throw bad("This agreement is already signed.");
  if (a.speakerId) return sendSpeakerAgreement(a.speakerId);
  if (a.vendorId) return sendVendorAgreement(a.vendorId);
  await sendAgreement(a.id);
  return getDb().select().from(schema.agreements).where(eq(schema.agreements.id, a.id)).get()!;
}

/** The PDF of a signed agreement as an email attachment (for receipts). */
export async function signedPdfAttachment(a: Agreement): Promise<EmailAttachment> {
  const bytes = await agreementPdf(a);
  const name = `${(a.title || "Agreement").replace(/[^A-Za-z0-9 ._-]/g, "").trim() || "Agreement"} (signed).pdf`;
  return { filename: name, contentType: "application/pdf", content: Buffer.from(bytes) };
}

/** Where a copy of a signed sponsor or exhibitor agreement goes (the checkout page's notify address). */
function notifyAddress(a: Agreement) {
  if (a.kind === "speaker") return "";
  const page = getDb()
    .select()
    .from(schema.vendorCheckoutPages)
    .where(and(eq(schema.vendorCheckoutPages.eventId, a.eventId), eq(schema.vendorCheckoutPages.kind, a.kind)))
    .get();
  return page?.notifyEmail ?? "";
}

/** Emails the signer their signed copy again (Resend on a signed agreement). */
export async function resendSignedCopy(agreementId: number) {
  const a = getDb().select().from(schema.agreements).where(eq(schema.agreements.id, agreementId)).get();
  if (!a || a.status !== "signed") throw bad("This agreement is not signed yet.");
  if (!a.signerEmail) throw bad("There is no email for the signer.");
  await signedEmails(a, { notify: false });
}

async function signedEmails(a: Agreement, opts: { notify?: boolean } = {}) {
  const event = eventOf(a.eventId);
  const style = eventMailStyle(event);
  const word = KIND_WORD[a.kind];
  const attachment = await signedPdfAttachment(a);
  const intro = `Thank you for signing your ${word} agreement for ${event.name}. Your signed copy is attached.`;
  const footer = escapeHtml(orgName(event));
  await sendEmail({
    to: a.signerEmail,
    fromName: style.fromName,
    subject: `${style.fromName}: your signed ${word} agreement`,
    text: [`Hi ${a.signerName || "there"},`, intro, `View it online: ${copyLink(a.code)}`, orgName(event)].join("\n\n"),
    html: emailLayout({ ...style, title: "Your signed agreement", blocks: [`<p>Hi ${escapeHtml(a.signerName || "there")},</p>`, `<p>${escapeHtml(intro)}</p>`, emailButton("View signed copy", copyLink(a.code), event.branding)], footer }),
    attachments: [attachment],
  });
  const notify = opts.notify === false ? "" : notifyAddress(a);
  if (notify) {
    const who = `${a.signerName}${a.signerTitle ? `, ${a.signerTitle}` : ""}`;
    await sendEmail({
      to: notify,
      fromName: style.fromName,
      subject: `${style.fromName}: ${a.title || "agreement"} signed by ${a.signerName}`,
      text: `${who} signed the ${a.title || "agreement"} on ${fmtWhen(a.signedAt)}. The signed copy is attached.`,
      html: emailLayout({ ...style, title: "Agreement signed", blocks: [`<p>${escapeHtml(who)} signed the ${escapeHtml(a.title || "agreement")} on ${escapeHtml(fmtWhen(a.signedAt))}. The signed copy is attached.</p>`], footer }),
      attachments: [attachment],
    });
  }
}

/**
 * Signs an agreement from its code. Stores the signature PNG (drawn in the
 * browser in the signature font) as a private file, adds the organization's
 * countersignature when the template says so, and marks it signed. Then
 * (unless sendCopy is false) emails the signer the signed PDF, with a copy to
 * the checkout page's notify address, and sends the speaker welcome email when
 * that was chosen. Returns the signed row.
 */
export async function signAgreement(
  code: string,
  input: { name: string; title: string; signaturePng: string; recordingAllowed?: boolean | null; ip?: string; userAgent?: string },
  opts: { sendCopy?: boolean } = {}
): Promise<Agreement> {
  const db = getDb();
  const a = db.select().from(schema.agreements).where(eq(schema.agreements.code, code)).get();
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "That agreement was not found." });
  if (a.status === "signed") throw bad("This agreement is already signed.");
  if (a.status === "void") throw bad("This agreement is no longer in use. Ask the organization for a new link.");
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2) throw bad("Type your full name.");
  if (name.length > 120) throw bad("That name is too long.");
  const title = input.title.trim().slice(0, 120);
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.signaturePng.trim());
  if (!m) throw bad("Your signature did not come through. Try again.");
  const png = Buffer.from(m[1], "base64");
  if (png.length < 60 || png.length > 400_000 || png.subarray(1, 4).toString("ascii") !== "PNG") throw bad("Your signature did not come through. Try again.");
  const t = templateById(a.templateId);
  if (t?.kind === "speaker" && t.askRecording && (input.recordingAllowed === undefined || input.recordingAllowed === null)) throw bad("Choose whether we may record your session.");
  const event = eventOf(a.eventId);
  const file = saveFile({ orgId: event.orgId, name: "signature.png", mime: "image/png", base64: m[1], isPublic: false, userId: null });
  const counter = t && t.countersign && t.signerName.trim() ? { countersignName: t.signerName.trim(), countersignTitle: t.signerTitle.trim() } : { countersignName: "", countersignTitle: "" };
  db.update(schema.agreements)
    .set({
      status: "signed",
      signerName: name,
      signerTitle: title,
      signatureFileId: file.id,
      recordingAllowed: t?.kind === "speaker" && t.askRecording ? !!input.recordingAllowed : null,
      ...counter,
      ip: (input.ip ?? "").slice(0, 64),
      userAgent: (input.userAgent ?? "").slice(0, 300),
      signedAt: new Date(),
    })
    .where(eq(schema.agreements.id, a.id))
    .run();
  const signed = db.select().from(schema.agreements).where(eq(schema.agreements.id, a.id)).get()!;
  if (opts.sendCopy !== false && signed.signerEmail) {
    try {
      await signedEmails(signed);
    } catch (err) {
      console.error("[agreements] signed copy email failed:", err);
    }
  }
  if (signed.kind === "speaker" && signed.speakerId && signed.welcomeAfterSign) {
    try {
      await sendSpeakerWelcome(signed.speakerId);
    } catch (err) {
      console.error("[agreements] speaker welcome failed:", err);
    }
  }
  // Sponsors and exhibitors who sign from an emailed link: the welcome goes out once they have also paid (the welcome checks).
  if (signed.kind !== "speaker" && signed.vendorId) {
    try {
      await sendVendorWelcome(signed.vendorId);
    } catch (err) {
      console.error("[agreements] vendor welcome failed:", err);
    }
  }
  return signed;
}

/** When the next reminder goes out for a sent agreement (null when reminders are off or used up). */
export function nextReminderAt(a: Pick<Agreement, "status" | "sentAt" | "lastReminderAt" | "remindersSent">, t: Pick<AgreementTemplate, "reminderDays" | "reminderMax"> | undefined) {
  if (a.status !== "sent" || !t || t.reminderDays <= 0 || a.remindersSent >= t.reminderMax) return null;
  const from = a.lastReminderAt ?? a.sentAt;
  return from ? new Date(new Date(from).getTime() + t.reminderDays * DAY) : null;
}

/** Minute job: one reminder per due agreement, every reminderDays days, up to reminderMax. One bad row never stops the rest. */
export async function runAgreementReminders(now = new Date()) {
  const db = getDb();
  const sent = db.select().from(schema.agreements).where(eq(schema.agreements.status, "sent")).all();
  if (!sent.length) return 0;
  const ids = Array.from(new Set(sent.map((a) => a.templateId).filter((x): x is number => !!x)));
  const templates = new Map(ids.length ? db.select().from(schema.agreementTemplates).where(inArray(schema.agreementTemplates.id, ids)).all().map((t) => [t.id, t]) : []);
  let n = 0;
  for (const a of sent) {
    try {
      const due = nextReminderAt(a, a.templateId ? templates.get(a.templateId) : undefined);
      if (!due || due > now || !a.signerEmail) continue;
      // Mark first so a slow or failing send never repeats in the same minute.
      db.update(schema.agreements).set({ remindersSent: a.remindersSent + 1, lastReminderAt: now }).where(eq(schema.agreements.id, a.id)).run();
      await sendEmail(linkEmail(a, true));
      n++;
    } catch (err) {
      console.error(`[agreements] reminder for agreement ${a.id} failed:`, err);
    }
  }
  return n;
}

/** The session line a speaker sign page shows. */
export function speakerSessionCard(speakerId: number) {
  const s = speakerSession(speakerId);
  return s ? { title: s.title, when: sessionWhen(s), room: s.room } : null;
}
