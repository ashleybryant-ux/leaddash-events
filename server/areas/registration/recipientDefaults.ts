/**
 * Starting text for the speaker, sponsor and exhibitor welcome emails and
 * their follow-ups. New events get these when they are made; older events get
 * them the first time the Welcome emails page is opened.
 */
import type { MessageKind } from "../../../drizzle/schema";

type EventLike = { name: string; shortName: string | null; startDate: string };
type Insert = { kind: MessageKind; channel: "email"; enabled?: boolean; sendRule: string; fromName: string; subject: string; body: string; includes: Record<string, boolean | string> };

export type RecipientGroup = "speakers" | "sponsors" | "exhibitors";

export const GROUP_WELCOME: Record<RecipientGroup, MessageKind> = {
  speakers: "speaker_welcome",
  sponsors: "sponsor_welcome",
  exhibitors: "exhibitor_welcome",
};

export const GROUP_FOLLOW_UPS: Record<RecipientGroup, MessageKind[]> = {
  speakers: ["speaker_slides_reminder", "speaker_know_before", "speaker_thanks"],
  sponsors: ["sponsor_passes_reminder", "sponsor_logo_reminder", "sponsor_know_before"],
  exhibitors: ["exhibitor_booth_assigned", "exhibitor_know_before"],
};

export const RECIPIENT_KINDS = new Set<MessageKind>([...Object.values(GROUP_WELCOME), ...Object.values(GROUP_FOLLOW_UPS).flat()]);

/** The group a recipient message kind belongs to. */
export function groupOfKind(kind: MessageKind): RecipientGroup | null {
  for (const g of Object.keys(GROUP_WELCOME) as RecipientGroup[]) if (GROUP_WELCOME[g] === kind || GROUP_FOLLOW_UPS[g].includes(kind)) return g;
  return null;
}

/** Base flags every includes object carries (the attendee keys are off). */
const BASE = { receipt: false, getApp: false, qr: false, calendar: false, hotel: false };

/** "Include in the email" options for each welcome email, in board order. */
export const INCLUDE_OPTIONS: Record<RecipientGroup, { key: string; label: string }[]> = {
  speakers: [
    { key: "session", label: "Session details" },
    { key: "uploadSlides", label: "Upload slides button" },
    { key: "bio", label: "Bio and photo button" },
    { key: "qr", label: "Registration QR code" },
    { key: "getApp", label: "Get the app button" },
    { key: "agreementPdf", label: "Signed agreement (PDF)" },
  ],
  sponsors: [
    { key: "schedule", label: "Package and payment schedule" },
    { key: "passNames", label: "Add pass names button" },
    { key: "listing", label: "Edit app listing button" },
    { key: "keyDates", label: "Key dates" },
    { key: "receipt", label: "Receipt" },
    { key: "agreementPdf", label: "Signed agreement (PDF)" },
  ],
  exhibitors: [
    { key: "booth", label: "Booth and add-ons" },
    { key: "times", label: "Setup and teardown times" },
    { key: "staff", label: "Add booth staff button" },
    { key: "listing", label: "Edit app listing button" },
    { key: "leads", label: "Lead scanning how-to" },
    { key: "receipt", label: "Receipt" },
    { key: "agreementPdf", label: "Signed agreement (PDF)" },
  ],
};

/** The welcome email's send choices for each group. */
export const SEND_CHOICES: Record<RecipientGroup, { value: string; label: string; hint: string }[]> = {
  speakers: [
    { value: "after_sign", label: "After they sign the speaker agreement", hint: "Sends when a speaker signs. If the event has no speaker agreement, it waits for Send to new." },
    { value: "after_accept", label: "When their proposal is accepted", hint: "Sends to each presenter as soon as you accept their proposal." },
    { value: "manual", label: "Only when I send it", hint: "Nothing sends on its own. Use Send to new or Send welcome on the Speakers page." },
  ],
  sponsors: [
    { value: "after_payment_signed", label: "After payment and a signed agreement", hint: "Sends once a payment or deposit is in and the agreement is signed (when there is one)." },
    { value: "after_payment", label: "Right after payment", hint: "Sends as soon as a payment or deposit is in, signed or not." },
    { value: "manual", label: "Only when I send it", hint: "Nothing sends on its own. Use Send to new." },
  ],
  exhibitors: [
    { value: "after_payment_signed", label: "After payment and a signed agreement", hint: "Sends once a payment or deposit is in and the agreement is signed (when there is one)." },
    { value: "after_payment", label: "Right after payment", hint: "Sends as soon as a payment or deposit is in, signed or not." },
    { value: "manual", label: "Only when I send it", hint: "Nothing sends on its own. Use Send to new." },
  ],
};

/** {{field}} chips shown under the message, per group. */
export const GROUP_FIELDS: Record<RecipientGroup, string[]> = {
  speakers: ["first name", "speaker name", "session title", "session time", "room", "slides due date"],
  sponsors: ["first name", "company name", "package name", "passes", "next charge date"],
  exhibitors: ["first name", "company name", "booth", "setup time", "teardown time"],
};

/** Calendar date n days before an ISO date. */
function daysBefore(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

export function defaultRecipientTemplates(ev: EventLike, orgName: string): Insert[] {
  const short = ev.shortName || ev.name;
  const fromName = `${orgName} Conference Team`;
  const on = (keys: string[]) => ({ ...BASE, ...Object.fromEntries(keys.map((k) => [k, true])) });
  return [
    {
      kind: "speaker_welcome",
      channel: "email",
      sendRule: "after_sign",
      fromName,
      subject: `You're speaking at ${short}, {{first name}}`,
      body: "Hi {{first name}}, thank you for signing your speaker agreement. Here is everything you need before the conference.",
      includes: on(INCLUDE_OPTIONS.speakers.map((o) => o.key)),
    },
    {
      kind: "speaker_slides_reminder",
      channel: "email",
      sendRule: "days_before:14",
      fromName,
      subject: "Your slides are due {{slides due date}}",
      body: "Hi {{first name}}, slides for {{session title}} are due {{slides due date}}. Upload them on your speaker page so they are ready for attendees.",
      includes: { ...BASE },
    },
    {
      kind: "speaker_know_before",
      channel: "email",
      sendRule: "days_before:3",
      fromName,
      subject: `Know before you go: ${short}`,
      body: "Hi {{first name}}, we will see you soon. You are presenting {{session title}} on {{session time}} in {{room}}. Check in at registration when you arrive and your badge will be ready.",
      includes: { ...BASE, getApp: true },
    },
    {
      kind: "speaker_thanks",
      channel: "email",
      enabled: false,
      sendRule: "days_after:7",
      fromName,
      subject: `Thank you for speaking at ${short}`,
      body: "Hi {{first name}}, thank you for presenting {{session title}}. Here is what attendees said in their evaluations.",
      includes: { ...BASE },
    },
    {
      kind: "sponsor_welcome",
      channel: "email",
      sendRule: "after_payment_signed",
      fromName,
      subject: "Welcome, {{company name}}",
      body: `Hi {{first name}}, thank you for being a {{package name}} sponsor of ${ev.name}. Here is what comes next.`,
      includes: on(INCLUDE_OPTIONS.sponsors.map((o) => o.key)),
    },
    {
      kind: "sponsor_passes_reminder",
      channel: "email",
      sendRule: "days_before:30",
      fromName,
      subject: "Add names for your event passes",
      body: "Hi {{first name}}, {{company name}} has {{passes}} event passes. Send us the name and email for each pass holder so their badges are ready.",
      includes: { ...BASE },
    },
    {
      kind: "sponsor_logo_reminder",
      channel: "email",
      sendRule: "days_before:7",
      fromName,
      subject: "Your logo and ad are due {{logo due date}}",
      body: "Hi {{first name}}, please send the {{company name}} logo and ad by {{logo due date}} so they appear in the app and the program.",
      includes: { ...BASE, logoDueOn: daysBefore(ev.startDate, 80) },
    },
    {
      kind: "sponsor_know_before",
      channel: "email",
      sendRule: "days_before:3",
      fromName,
      subject: `Know before you go: ${short}`,
      body: "Hi {{first name}}, the conference starts {{event dates}} at {{venue}}. Your pass holders can check in with the QR code in the app.",
      includes: { ...BASE, getApp: true },
    },
    {
      kind: "exhibitor_welcome",
      channel: "email",
      sendRule: "after_payment_signed",
      fromName,
      subject: "Your booth is confirmed, {{company name}}",
      body: `Hi {{first name}}, your booth is confirmed for ${ev.name}. Here is what you need to plan.`,
      includes: on(INCLUDE_OPTIONS.exhibitors.map((o) => o.key)),
    },
    {
      kind: "exhibitor_booth_assigned",
      channel: "email",
      sendRule: "on_booth",
      fromName,
      subject: "You are in booth {{booth}}",
      body: "Hi {{first name}}, {{company name}} is in booth {{booth}}. Setup is {{setup time}}.",
      includes: { ...BASE },
    },
    {
      kind: "exhibitor_know_before",
      channel: "email",
      sendRule: "days_before:3",
      fromName,
      subject: `Know before you go: ${short}`,
      body: "Hi {{first name}}, setup is {{setup time}} and teardown is {{teardown time}}. Booth staff can scan attendee badges in the app to collect leads.",
      includes: { ...BASE, getApp: true },
    },
  ];
}
