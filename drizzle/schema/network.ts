import { sqliteTable, integer, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createdAt, events, files, users } from "./core";
import { attendees } from "./registration";
import { sessions } from "./program";

/** Direct message threads between attendees (two or more people). */
export const threads = sqliteTable(
  "threads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("threads_event").on(t.eventId)]
);

export const threadMembers = sqliteTable(
  "thread_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: integer("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    lastReadAt: integer("last_read_at", { mode: "timestamp_ms" }),
    /** The newest message this member has read (unread counts compare ids, not clock times). */
    lastReadMessageId: integer("last_read_message_id").notNull().default(0),
    muted: integer("muted", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("thread_members_unique").on(t.threadId, t.attendeeId)]
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: integer("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("messages_thread").on(t.threadId)]
);

/** People an attendee blocked: they cannot message each other. */
export const blocks = sqliteTable(
  "blocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    blockedAttendeeId: integer("blocked_attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("blocks_unique").on(t.attendeeId, t.blockedAttendeeId)]
);

export const meetingRequests = sqliteTable(
  "meeting_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    fromAttendeeId: integer("from_attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    toAttendeeId: integer("to_attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    startTime: text("start_time").notNull(),
    minutes: integer("minutes").notNull().default(30),
    place: text("place").notNull().default(""),
    note: text("note").notNull().default(""),
    status: text("status", { enum: ["pending", "accepted", "declined", "cancelled"] }).notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [index("meetings_event").on(t.eventId)]
);

/** Discussion channels in Community (attendees can start their own). */
export const channels = sqliteTable(
  "channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("General"),
    createdByAttendeeId: integer("created_by_attendee_id"),
    official: integer("official", { mode: "boolean" }).notNull().default(false),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    lastPostAt: integer("last_post_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("channels_event").on(t.eventId)]
);

export const channelMembers = sqliteTable(
  "channel_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    lastReadAt: integer("last_read_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("channel_members_unique").on(t.channelId, t.attendeeId)]
);

export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").references(() => attendees.id, { onDelete: "set null" }),
    /** Posted by an admin as the event (announcements in a channel). */
    byEvent: integer("by_event", { mode: "boolean" }).notNull().default(false),
    parentId: integer("parent_id"),
    body: text("body").notNull(),
    likes: integer("likes").notNull().default(0),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    reported: integer("reported").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("posts_channel").on(t.channelId)]
);

/** One report per person per post. */
export const postReports = sqliteTable(
  "post_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    reason: text("reason").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("post_reports_unique").on(t.postId, t.attendeeId)]
);

/** Community rules for an event. */
export const communitySettings = sqliteTable("community_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").notNull().unique().references(() => events.id, { onDelete: "cascade" }),
  /** Who can start topics. */
  whoCanStart: text("who_can_start", { enum: ["attendees", "team"] }).notNull().default("attendees"),
  /** Exhibitors can post only in topics they started, anywhere, or not at all. */
  exhibitorPosting: text("exhibitor_posting", { enum: ["own", "anywhere", "none"] }).notNull().default("own"),
  /** Hide a post once this many people report it. Empty means never. */
  hideAfterReports: integer("hide_after_reports").default(3),
});

export const postLikes = sqliteTable(
  "post_likes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("post_likes_unique").on(t.postId, t.attendeeId)]
);

export type VendorBenefit = { label: string; done: boolean; status?: "done" | "not_started" | "waiting" };

/** Exhibitors and sponsors. */
export const vendors = sqliteTable(
  "vendors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    company: text("company").notNull(),
    kind: text("kind", { enum: ["exhibitor", "sponsor", "both"] }).notNull().default("exhibitor"),
    level: text("level").notNull().default(""),
    contactName: text("contact_name").notNull().default(""),
    email: text("email").notNull().default(""),
    phone: text("phone").notNull().default(""),
    booth: text("booth").notNull().default(""),
    amountCents: integer("amount_cents").notNull().default(0),
    paidCents: integer("paid_cents").notNull().default(0),
    status: text("status", { enum: ["lead", "invited", "contract_sent", "confirmed", "paid", "cancelled"] }).notNull().default("lead"),
    description: text("description").notNull().default(""),
    website: text("website").notNull().default(""),
    logoFileId: integer("logo_file_id").references(() => files.id, { onDelete: "set null" }),
    contractFileId: integer("contract_file_id").references(() => files.id, { onDelete: "set null" }),
    benefits: text("benefits", { mode: "json" }).$type<VendorBenefit[]>().notNull().default(sql`'[]'`),
    boothStaff: text("booth_staff", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    offer: text("offer").notNull().default(""),
    notes: text("notes").notNull().default(""),
    visible: integer("visible", { mode: "boolean" }).notNull().default(true),
    /** Shown under the company name in the app ("Practice software"). */
    category: text("category").notNull().default(""),
    /** Booth staff can scan attendee badges for leads. */
    leadScanning: integer("lead_scanning", { mode: "boolean" }).notNull().default(true),
    /** Package sold (vendor_packages). Empty for vendors set up before packages. */
    packageId: integer("package_id"),
    /** Add-ons bought (VendorAddonLine[] from ./sponsor). */
    addons: text("addons", { mode: "json" }).$type<{ addonId: number; name: string; qty: number; priceCents: number }[]>().notNull().default(sql`'[]'`),
    /** manual: added by staff. checkout: bought on the sponsor or exhibitor checkout page. */
    source: text("source", { enum: ["manual", "checkout"] }).notNull().default("manual"),
    /** The rest of a deposit, charged automatically on nextChargeOn to the saved payment method. */
    nextChargeCents: integer("next_charge_cents").notNull().default(0),
    nextChargeOn: text("next_charge_on"),
    nextChargeReminderAt: integer("next_charge_reminder_at", { mode: "timestamp_ms" }),
    /** Last automatic charge attempt result ("" or the reason it failed). */
    nextChargeError: text("next_charge_error").notNull().default(""),
    stripeCustomerId: text("stripe_customer_id"),
    stripePaymentMethodId: text("stripe_payment_method_id"),
    /** "Bank ending 6789", "Visa ending 4242". */
    payMethodLabel: text("pay_method_label").notNull().default(""),
    /** Invoice choice on the checkout page: the package is held until this date. */
    holdUntil: text("hold_until"),
    /** When the organization was told the invoice hold ended with nothing paid (sent once). */
    holdNoticeAt: integer("hold_notice_at", { mode: "timestamp_ms" }),
    /** The open pay link Checkout Session, so the scheduled charge waits instead of collecting the same balance. */
    paySessionId: text("pay_session_id"),
    paySessionExpiresAt: integer("pay_session_expires_at", { mode: "timestamp_ms" }),
    /** Secret in the vendor's pay link (/r/:slug/sponsor/pay?v=): pay what is owed or change the saved payment method. */
    payToken: text("pay_token").unique(),
    createdAt: createdAt(),
  },
  (t) => [index("vendors_event").on(t.eventId)]
);

/** Leads booth staff scan from attendee badges. */
export const leads = sqliteTable(
  "leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    vendorId: integer("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    scannedBy: integer("scanned_by").references(() => users.id, { onDelete: "set null" }),
    rating: text("rating", { enum: ["hot", "warm", "cold"] }).notNull().default("warm"),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("leads_unique").on(t.vendorId, t.attendeeId)]
);

/** Venue map: an image with labeled pins. */
export const floorMaps = sqliteTable("floor_maps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  fileId: integer("file_id").references(() => files.id, { onDelete: "set null" }),
  /** Pins in percent of the image size. */
  pins: text("pins", { mode: "json" }).$type<{ label: string; x: number; y: number; kind: string }[]>().notNull().default(sql`'[]'`),
  sort: integer("sort").notNull().default(0),
});

export const polls = sqliteTable(
  "polls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    options: text("options", { mode: "json" }).$type<string[]>().notNull(),
    status: text("status", { enum: ["draft", "open", "closed"] }).notNull().default("draft"),
    createdAt: createdAt(),
  },
  (t) => [index("polls_session").on(t.sessionId)]
);

export const pollVotes = sqliteTable(
  "poll_votes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pollId: integer("poll_id").notNull().references(() => polls.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    option: integer("option").notNull(),
  },
  (t) => [uniqueIndex("poll_votes_unique").on(t.pollId, t.attendeeId)]
);

/** Audience questions for a session (Q&A). */
export const sessionQuestions = sqliteTable(
  "session_questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").references(() => attendees.id, { onDelete: "set null" }),
    anonymous: integer("anonymous", { mode: "boolean" }).notNull().default(false),
    body: text("body").notNull(),
    votes: integer("votes").notNull().default(0),
    answered: integer("answered", { mode: "boolean" }).notNull().default(false),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("session_questions_session").on(t.sessionId)]
);

export const questionVotes = sqliteTable(
  "question_votes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    questionId: integer("question_id").notNull().references(() => sessionQuestions.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("question_votes_unique").on(t.questionId, t.attendeeId)]
);

export type CfpQuestion = { key: string; label: string; kind: "text" | "textarea" | "select"; required: boolean; options?: string[] };
export type RubricItem = { key: string; label: string; max: number };

/** Call for proposals settings for an event. */
export const cfpSettings = sqliteTable("cfp_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").notNull().unique().references(() => events.id, { onDelete: "cascade" }),
  opensOn: text("opens_on"),
  closesOn: text("closes_on"),
  intro: text("intro").notNull().default(""),
  formats: text("formats", { mode: "json" }).$type<string[]>().notNull().default(sql`'["Breakout session (60 min)","Workshop (90 min)","Poster"]'`),
  tracks: text("tracks", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  questions: text("questions", { mode: "json" }).$type<CfpQuestion[]>().notNull().default(sql`'[]'`),
  rubric: text("rubric", { mode: "json" })
    .$type<RubricItem[]>()
    .notNull()
    .default(sql`'[{"key":"relevance","label":"Relevance","max":5},{"key":"evidence","label":"Evidence base","max":5},{"key":"objectives","label":"Learning objectives","max":5}]'`),
  /** Reviewers do not see the submitter's name. */
  blind: integer("blind", { mode: "boolean" }).notNull().default(true),
  reviewersPerProposal: integer("reviewers_per_proposal").notNull().default(2),
});

export const proposals = sqliteTable(
  "proposals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    credentials: text("credentials").notNull().default(""),
    organization: text("organization").notNull().default(""),
    bio: text("bio").notNull().default(""),
    headshotFileId: integer("headshot_file_id"),
    title: text("title").notNull(),
    abstract: text("abstract").notNull(),
    objectives: text("objectives", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    format: text("format").notNull().default(""),
    track: text("track").notNull().default(""),
    ceRequested: integer("ce_requested", { mode: "boolean" }).notNull().default(true),
    coPresenters: text("co_presenters", { mode: "json" }).$type<{ name: string; email: string; credentials: string }[]>().notNull().default(sql`'[]'`),
    answers: text("answers", { mode: "json" }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
    status: text("status", { enum: ["submitted", "in_review", "accepted", "waitlisted", "declined", "withdrawn"] }).notNull().default("submitted"),
    decisionNote: text("decision_note").notNull().default(""),
    notifiedAt: integer("notified_at", { mode: "timestamp_ms" }),
    sessionId: integer("session_id"),
    createdAt: createdAt(),
  },
  (t) => [index("proposals_event").on(t.eventId)]
);

export const reviewAssignments = sqliteTable(
  "review_assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    proposalId: integer("proposal_id").notNull().references(() => proposals.id, { onDelete: "cascade" }),
    reviewerUserId: integer("reviewer_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    scores: text("scores", { mode: "json" }).$type<Record<string, number>>(),
    comment: text("comment").notNull().default(""),
    recommendation: text("recommendation", { enum: ["accept", "maybe", "decline"] }),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("review_assignments_unique").on(t.proposalId, t.reviewerUserId)]
);
