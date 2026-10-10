import { sqliteTable, integer, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createdAt, events, files, users } from "./core";
import { ticketTypes } from "./registration";
import { vendors } from "./network";
import { sessions, speakers } from "./program";

/** Where a package's logo shows in the attendee app. */
export type LogoSpots = { welcome: boolean; topOfList: boolean; sessionPages: boolean };

/** A sponsorship package or exhibitor booth that can be sold (by staff or on the checkout page). Prices are in cents. */
export const vendorPackages = sqliteTable(
  "vendor_packages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["sponsor", "exhibitor"] }).notNull().default("sponsor"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    priceCents: integer("price_cents").notNull().default(0),
    /** How many can be sold. Empty means no limit. */
    quantity: integer("quantity"),
    /** Event passes (sponsor) or booth staff passes (exhibitor) included with each one sold. */
    passes: integer("passes").notNull().default(0),
    /** Ticket the passes use. Empty means the first active ticket. */
    passTicketTypeId: integer("pass_ticket_type_id").references(() => ticketTypes.id, { onDelete: "set null" }),
    includesBooth: integer("includes_booth", { mode: "boolean" }).notNull().default(false),
    logoSpots: text("logo_spots", { mode: "json" }).$type<LogoSpots>().notNull().default(sql`'{"welcome":false,"topOfList":false,"sessionPages":false}'`),
    /** Each line becomes a checklist item on the sponsor or exhibitor. */
    benefits: text("benefits", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** Order in the app and on the checkout page (lower first). */
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("vendor_packages_event").on(t.eventId)]
);

/** Extras an exhibitor or sponsor can add (extra staff pass, electricity, table). */
export const vendorAddons = sqliteTable(
  "vendor_addons",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priceCents: integer("price_cents").notNull().default(0),
    quantity: integer("quantity"),
    /** Packages it is offered with. Empty means every exhibitor package. */
    packageIds: text("package_ids", { mode: "json" }).$type<number[]>().notNull().default(sql`'[]'`),
    /** Each one adds a booth staff pass. */
    addsPass: integer("adds_pass", { mode: "boolean" }).notNull().default(false),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("vendor_addons_event").on(t.eventId)]
);

/** Add-ons a vendor bought, priced when bought. */
export type VendorAddonLine = { addonId: number; name: string; qty: number; priceCents: number };

/** Every payment toward a sponsor or exhibitor (online, recorded by staff, or scheduled). */
export const vendorPayments = sqliteTable(
  "vendor_payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    vendorId: integer("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    /** card | bank (ACH) | check | cash | invoice | other */
    method: text("method", { enum: ["card", "bank", "check", "cash", "invoice", "other"] }).notNull().default("other"),
    /** pending: bank payment still clearing. failed: the bank or card turned it down. */
    status: text("status", { enum: ["pending", "paid", "failed", "refunded"] }).notNull().default("paid"),
    /** deposit | balance | full | manual */
    purpose: text("purpose", { enum: ["deposit", "balance", "full", "manual"] }).notNull().default("manual"),
    /** Calendar date it was paid, "2026-10-10". */
    paidOn: text("paid_on").notNull().default(""),
    /** Check number, invoice number, or "Bank ending 6789". */
    reference: text("reference").notNull().default(""),
    note: text("note").notNull().default(""),
    stripeAccountId: text("stripe_account_id"),
    stripeSessionId: text("stripe_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    failureReason: text("failure_reason").notNull().default(""),
    recordedBy: integer("recorded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("vendor_payments_vendor").on(t.vendorId), index("vendor_payments_pi").on(t.stripePaymentIntentId)]
);

/** Settings for the public sponsor and exhibitor checkout pages (/r/:slug/sponsor, /r/:slug/exhibit). */
export const vendorCheckoutPages = sqliteTable(
  "vendor_checkout_pages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["sponsor", "exhibitor"] }).notNull(),
    open: integer("open", { mode: "boolean" }).notNull().default(false),
    /** Calendar date the page closes. Empty means it stays open until the event. */
    closesOn: text("closes_on"),
    title: text("title").notNull().default(""),
    intro: text("intro").notNull().default(""),
    /** Empty means every active package of this kind. */
    packageIds: text("package_ids", { mode: "json" }).$type<number[]>().notNull().default(sql`'[]'`),
    payFull: integer("pay_full", { mode: "boolean" }).notNull().default(true),
    payDeposit: integer("pay_deposit", { mode: "boolean" }).notNull().default(false),
    payInvoice: integer("pay_invoice", { mode: "boolean" }).notNull().default(false),
    /** both: card and bank account. ach: bank account only. card: card only. */
    methods: text("methods", { enum: ["both", "ach", "card"] }).notNull().default("both"),
    depositPercent: integer("deposit_percent").notNull().default(50),
    /** Calendar date the rest of a deposit is charged automatically. */
    balanceDueOn: text("balance_due_on"),
    invoiceHoldDays: integer("invoice_hold_days").notNull().default(14),
    /** Agreement signed on the page before paying. Empty means no agreement step. */
    agreementTemplateId: integer("agreement_template_id"),
    notifyEmail: text("notify_email").notNull().default(""),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("vendor_checkout_pages_kind").on(t.eventId, t.kind)]
);

/** What a sponsor or exhibitor typed on the checkout page, held until payment (or the invoice choice) creates the vendor. */
export type VendorBuyer = {
  company: string;
  website: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  category: string;
  about: string;
  offer: string;
  boothRequest: string;
  logoFileId: number | null;
  /** Pass holders or booth staff named now. */
  people: { name: string; email: string }[];
  addons: { addonId: number; qty: number }[];
};

export const vendorCheckouts = sqliteTable(
  "vendor_checkouts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["sponsor", "exhibitor"] }).notNull(),
    packageId: integer("package_id").notNull(),
    buyer: text("buyer", { mode: "json" }).$type<VendorBuyer>().notNull(),
    payOption: text("pay_option", { enum: ["full", "deposit", "invoice"] }).notNull().default("full"),
    totalCents: integer("total_cents").notNull(),
    /** Charged today (the deposit, the full amount, or 0 for an invoice). */
    dueTodayCents: integer("due_today_cents").notNull(),
    agreementId: integer("agreement_id"),
    status: text("status", { enum: ["started", "pending", "paid", "failed", "expired", "invoice"] }).notNull().default("started"),
    stripeAccountId: text("stripe_account_id"),
    stripeSessionId: text("stripe_session_id").unique(),
    vendorId: integer("vendor_id"),
    /** Random token in the confirmation link (/r/:slug/sponsor/done?c=). */
    doneToken: text("done_token").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [index("vendor_checkouts_event").on(t.eventId)]
);

/** Agreement templates: sponsor, exhibitor and speaker agreements the organization edits. */
export type AgreementValues = Record<string, string>;

export const agreementTemplates = sqliteTable(
  "agreement_templates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["sponsor", "exhibitor", "speaker"] }).notNull(),
    name: text("name").notNull(),
    /** Rich text (cleaned HTML) with fields written as {Field name}. */
    body: text("body").notNull().default(""),
    /** checkout: signed on the checkout page before paying. email: a link to sign is emailed. */
    signWhen: text("sign_when", { enum: ["checkout", "email"] }).notNull().default("checkout"),
    /** Speaker agreements: send when a proposal is accepted, and when a speaker is added by hand. */
    sendOnAccept: integer("send_on_accept", { mode: "boolean" }).notNull().default(true),
    sendOnAdd: integer("send_on_add", { mode: "boolean" }).notNull().default(true),
    /** Reminder every N days until signed, up to reminderMax times. 0 turns reminders off. */
    reminderDays: integer("reminder_days").notNull().default(3),
    reminderMax: integer("reminder_max").notNull().default(3),
    askRecording: integer("ask_recording", { mode: "boolean" }).notNull().default(false),
    signerName: text("signer_name").notNull().default(""),
    signerTitle: text("signer_title").notNull().default(""),
    countersign: integer("countersign", { mode: "boolean" }).notNull().default(true),
    /** Organization-set field values (Cancel by date, Cancel fee, Speaker benefits, Materials due date...). */
    values: text("values", { mode: "json" }).$type<AgreementValues>().notNull().default(sql`'{}'`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("agreement_templates_event").on(t.eventId)]
);

/** One agreement sent to or signed by one person. The text is frozen when it is sent or signed. */
export const agreements = sqliteTable(
  "agreements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    templateId: integer("template_id").references(() => agreementTemplates.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["sponsor", "exhibitor", "speaker"] }).notNull(),
    vendorId: integer("vendor_id").references(() => vendors.id, { onDelete: "cascade" }),
    speakerId: integer("speaker_id").references(() => speakers.id, { onDelete: "cascade" }),
    checkoutId: integer("checkout_id"),
    /** Secret in the sign link and the signed copy link (/sign/:code, /agreement/:code). */
    code: text("code").notNull().unique(),
    status: text("status", { enum: ["draft", "sent", "signed", "void"] }).notNull().default("draft"),
    title: text("title").notNull().default(""),
    /** Filled-in agreement text (cleaned HTML). */
    html: text("html").notNull().default(""),
    signerEmail: text("signer_email").notNull().default(""),
    signerName: text("signer_name").notNull().default(""),
    signerTitle: text("signer_title").notNull().default(""),
    /** PNG of the typed signature drawn in the signature font. */
    signatureFileId: integer("signature_file_id").references(() => files.id, { onDelete: "set null" }),
    /** Speaker's answer to "May we record your session?" (empty when not asked). */
    recordingAllowed: integer("recording_allowed", { mode: "boolean" }),
    countersignName: text("countersign_name").notNull().default(""),
    countersignTitle: text("countersign_title").notNull().default(""),
    ip: text("ip").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    remindersSent: integer("reminders_sent").notNull().default(0),
    lastReminderAt: integer("last_reminder_at", { mode: "timestamp_ms" }),
    signedAt: integer("signed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("agreements_event").on(t.eventId), index("agreements_vendor").on(t.vendorId), index("agreements_speaker").on(t.speakerId)]
);

/** Slides and handouts for a session. */
export const sessionFiles = sqliteTable(
  "session_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    fileId: integer("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    /** Name attendees see ("Session slides"). */
    label: text("label").notNull().default(""),
    uploadedBySpeakerId: integer("uploaded_by_speaker_id").references(() => speakers.id, { onDelete: "set null" }),
    uploadedByUserId: integer("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    downloads: integer("downloads").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("session_files_session").on(t.sessionId)]
);

/** Welcome emails and follow-ups sent to speakers, sponsors and exhibitors, so nothing goes twice. */
export const recipientLog = sqliteTable(
  "recipient_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    recipientType: text("recipient_type", { enum: ["speaker", "vendor"] }).notNull(),
    recipientId: integer("recipient_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status", { enum: ["sent", "failed", "skipped"] }).notNull().default("sent"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("recipient_log_once").on(t.recipientType, t.recipientId, t.kind)]
);

export type VendorPackage = typeof vendorPackages.$inferSelect;
export type VendorAddon = typeof vendorAddons.$inferSelect;
export type VendorPayment = typeof vendorPayments.$inferSelect;
export type VendorCheckoutPage = typeof vendorCheckoutPages.$inferSelect;
export type VendorCheckout = typeof vendorCheckouts.$inferSelect;
export type AgreementTemplate = typeof agreementTemplates.$inferSelect;
export type Agreement = typeof agreements.$inferSelect;
export type SessionFile = typeof sessionFiles.$inferSelect;
