import { sqliteTable, integer, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createdAt, events, organizations, users } from "./core";
import type { BuyerType, PriceSet } from "../../shared/pricing";

export type { BuyerType, PriceSet };

/** A ticket someone can buy. Prices are in cents. */
export const ticketTypes = sqliteTable(
  "ticket_types",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    priceCents: integer("price_cents").notNull().default(0),
    quantity: integer("quantity"),
    /** Calendar date the sale ends, "2027-02-01". Empty means it sells until the event. */
    saleEndsOn: text("sale_ends_on"),
    /** What happens after the sale ends: close it, or point buyers to another ticket. */
    afterSale: text("after_sale", { enum: ["close", "switch"] }).notNull().default("close"),
    switchToTicketId: integer("switch_to_ticket_id"),
    /** Early bird: this price through this date (event time zone). */
    earlyEndsOn: text("early_ends_on"),
    earlyPriceCents: integer("early_price_cents"),
    /** Late: this price from this date. */
    lateStartsOn: text("late_starts_on"),
    latePriceCents: integer("late_price_cents"),
    /** Buyer types (checkout page) who can buy it. Empty means everyone. */
    buyerTypes: text("buyer_types", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    /** Each buyer type's own early, regular and late prices. A buyer type left out pays the prices above. */
    buyerPrices: text("buyer_prices", { mode: "json" }).$type<Record<string, PriceSet>>().notNull().default(sql`'{}'`),
    includes: text("includes").notNull().default("All days"),
    audience: text("audience", { enum: ["anyone", "members"] }).notNull().default("anyone"),
    /** Badge ribbon text (Speaker, Student...). */
    ribbon: text("ribbon").notNull().default(""),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("ticket_types_event").on(t.eventId)]
);

export const coupons = sqliteTable(
  "coupons",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    percentOff: integer("percent_off"),
    amountOffCents: integer("amount_off_cents"),
    maxUses: integer("max_uses"),
    used: integer("used").notNull().default(0),
    endsOn: text("ends_on"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("coupons_code").on(t.eventId, t.code)]
);

export type CheckoutQuestion = {
  key: string;
  label: string;
  kind: "text" | "phone" | "license" | "select" | "textarea";
  required: boolean;
  /** Name and email are always asked and cannot be removed. */
  locked?: boolean;
  options?: string[];
};

/** The public checkout page for an event (direct link and embed). */
export const checkoutPages = sqliteTable("checkout_pages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").notNull().unique().references(() => events.id, { onDelete: "cascade" }),
  coverFileId: integer("cover_file_id"),
  headline: text("headline").notNull().default(""),
  description: text("description").notNull().default(""),
  buttonLabel: text("button_label").notNull().default("Register"),
  /** Empty list means every active ticket shows. */
  ticketIds: text("ticket_ids", { mode: "json" }).$type<number[]>().notNull().default(sql`'[]'`),
  questions: text("questions", { mode: "json" }).$type<CheckoutQuestion[]>().notNull().default(sql`'[]'`),
  showConfirmation: integer("show_confirmation", { mode: "boolean" }).notNull().default(true),
  sendWelcome: integer("send_welcome", { mode: "boolean" }).notNull().default(true),
  platformTag: text("platform_tag").notNull().default(""),
  embedStyle: text("embed_style", { enum: ["inline", "popup"] }).notNull().default("inline"),
  /** Offer Klarna and Afterpay at checkout when the association's Stripe account has them on. */
  payOverTime: integer("pay_over_time", { mode: "boolean" }).notNull().default(true),
  /** "Who is registering?" choices. Empty means the page does not ask. */
  buyerTypes: text("buyer_types", { mode: "json" }).$type<BuyerType[]>().notNull().default(sql`'[]'`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

/** Everyone registered for an event. Signing in with the same email links the person to this row. */
export const attendees = sqliteTable(
  "attendees",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    credentials: text("credentials").notNull().default(""),
    phone: text("phone").notNull().default(""),
    jobTitle: text("job_title").notNull().default(""),
    organization: text("organization").notNull().default(""),
    city: text("city").notNull().default(""),
    bio: text("bio").notNull().default(""),
    photoFileId: integer("photo_file_id"),
    interests: text("interests", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    /** Shows in the People directory and can receive messages. */
    visible: integer("visible", { mode: "boolean" }).notNull().default(true),
    licenseNumber: text("license_number").notNull().default(""),
    licenseState: text("license_state").notNull().default(""),
    answers: text("answers", { mode: "json" }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
    textConsent: integer("text_consent", { mode: "boolean" }).notNull().default(false),
    ticketTypeId: integer("ticket_type_id").references(() => ticketTypes.id, { onDelete: "set null" }),
    status: text("status", { enum: ["pending", "registered", "cancelled"] }).notNull().default("registered"),
    kind: text("kind", { enum: ["attendee", "speaker", "vendor", "staff", "guest", "volunteer", "sponsor"] }).notNull().default("attendee"),
    /** Sponsor or exhibitor whose pass this person uses. */
    vendorId: integer("vendor_id"),
    /** Secret printed in the attendee's check-in QR code. */
    qrToken: text("qr_token").notNull().unique(),
    checkedInAt: integer("checked_in_at", { mode: "timestamp_ms" }),
    checkedInBy: integer("checked_in_by"),
    badgePrintedAt: integer("badge_printed_at", { mode: "timestamp_ms" }),
    badgePrints: integer("badge_prints").notNull().default(0),
    appOpenedAt: integer("app_opened_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("attendees_event_email").on(t.eventId, t.email), index("attendees_user").on(t.userId)]
);

export const orders = sqliteTable(
  "orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").references(() => attendees.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    ticketTypeId: integer("ticket_type_id").notNull(),
    couponId: integer("coupon_id"),
    subtotalCents: integer("subtotal_cents").notNull(),
    discountCents: integer("discount_cents").notNull().default(0),
    amountCents: integer("amount_cents").notNull(),
    feeCents: integer("fee_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    status: text("status", { enum: ["pending", "paid", "refunded", "failed", "expired", "free"] }).notNull().default("pending"),
    stripeAccountId: text("stripe_account_id"),
    stripeSessionId: text("stripe_session_id").unique(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    /** Random token in the confirmation link for free registrations (/r/:slug/done?order=). */
    doneToken: text("done_token").unique(),
    /** What the buyer typed, held until payment completes. */
    buyer: text("buyer", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    /** stripe: paid on the checkout page. check, cash, invoice, other: recorded by staff. comp: no charge. sponsor_pass: included in a package. link: payment link emailed. */
    method: text("method", { enum: ["stripe", "check", "cash", "invoice", "other", "comp", "sponsor_pass", "link"] }).notNull().default("stripe"),
    /** Check or invoice number recorded by staff. */
    reference: text("reference").notNull().default(""),
    /** Calendar date staff recorded the payment, "2026-10-09". */
    paidOn: text("paid_on").notNull().default(""),
    recordedBy: integer("recorded_by"),
    paidAt: integer("paid_at", { mode: "timestamp_ms" }),
    refundedAt: integer("refunded_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("orders_event").on(t.eventId)]
);

/** The association's connected Stripe account. Payments are direct charges on it. */
export const stripeAccounts = sqliteTable("stripe_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  businessName: text("business_name").notNull().default(""),
  chargesEnabled: integer("charges_enabled", { mode: "boolean" }).notNull().default(false),
  payoutsEnabled: integer("payouts_enabled", { mode: "boolean" }).notNull().default(false),
  bankLast4: text("bank_last4").notNull().default(""),
  /** Payout schedule from Stripe ("daily", "weekly", "monthly", "manual"). */
  payoutInterval: text("payout_interval").notNull().default(""),
  /** Onboarding sent in everything Stripe asked for. */
  detailsSubmitted: integer("details_submitted", { mode: "boolean" }).notNull().default(false),
  statementDescriptor: text("statement_descriptor").notNull().default(""),
  refundPolicy: text("refund_policy").notNull().default(""),
  /** Capability status per way to pay, from Stripe ("active", "inactive", "pending", or "" when not requested). */
  payMethods: text("pay_methods", { mode: "json" }).$type<{ card: string; klarna: string; afterpay: string }>().notNull().default(sql`'{"card":"","klarna":"","afterpay":""}'`),
  /** "oauth" (Connect with Stripe, Standard account) or "created" (older accounts made by LeadDash). */
  connectedVia: text("connected_via").notNull().default("oauth"),
  livemode: integer("livemode", { mode: "boolean" }).notNull().default(true),
  connectedAt: integer("connected_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

export const MESSAGE_KINDS = [
  "welcome",
  "text_app",
  "app_reminder",
  "know_before",
  "morning_text",
  "speaker_welcome",
  "speaker_slides_reminder",
  "speaker_know_before",
  "speaker_thanks",
  "sponsor_welcome",
  "sponsor_passes_reminder",
  "sponsor_logo_reminder",
  "sponsor_know_before",
  "exhibitor_welcome",
  "exhibitor_booth_assigned",
  "exhibitor_know_before",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** The welcome email and the follow-ups sent to people who register. */
export const messageTemplates = sqliteTable(
  "message_templates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: MESSAGE_KINDS }).notNull(),
    channel: text("channel", { enum: ["email", "text"] }).notNull().default("email"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** When: "after_payment", "after_payment_1h", "days_before:7", "days_before:2", "at:2027-04-22T07:00". */
    sendRule: text("send_rule").notNull().default("after_payment"),
    /** Skip people who already opened the app (app reminder). */
    onlyIfNoApp: integer("only_if_no_app", { mode: "boolean" }).notNull().default(false),
    fromName: text("from_name").notNull().default(""),
    replyTo: text("reply_to").notNull().default(""),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    includes: text("includes", { mode: "json" })
      .$type<{ receipt: boolean; getApp: boolean; qr: boolean; calendar: boolean; hotel: boolean; hotelUrl?: string; [key: string]: boolean | string | undefined }>()
      .notNull()
      .default(sql`'{"receipt":true,"getApp":true,"qr":true,"calendar":true,"hotel":false}'`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("message_templates_kind").on(t.eventId, t.kind)]
);

/** Every message sent to an attendee, so nothing goes twice. */
export const messageLog = sqliteTable(
  "message_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    status: text("status", { enum: ["sent", "failed", "skipped"] }).notNull().default("sent"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("message_log_once").on(t.attendeeId, t.kind)]
);

export type Attendee = typeof attendees.$inferSelect;
export type TicketType = typeof ticketTypes.$inferSelect;
export type Order = typeof orders.$inferSelect;
