import { sqliteTable, integer, text, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createdAt, events, files, users } from "./core";
import { attendees } from "./registration";

/** One block on the agenda: a session, keynote, workshop, break or meal. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind", { enum: ["session", "keynote", "workshop", "break", "meal", "general"] }).notNull().default("session"),
    /** Local date and times in the event's time zone: "2027-04-22", "10:30". */
    date: text("date").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    room: text("room").notNull().default(""),
    track: text("track").notNull().default(""),
    ceHours: real("ce_hours").notNull().default(0),
    capacity: integer("capacity"),
    /** Attendees must sign up to attend (seats are limited). */
    requiresSignup: integer("requires_signup", { mode: "boolean" }).notNull().default(false),
    /** Secret in the room's check-in QR code. */
    checkInCode: text("check_in_code").notNull(),
    evaluationId: integer("evaluation_id"),
    published: integer("published", { mode: "boolean" }).notNull().default(true),
    proposalId: integer("proposal_id"),
    /** When the evaluation opens: when the session ends, or as soon as the attendee checks in. */
    evaluationOpens: text("evaluation_opens", { enum: ["end", "checkin"] }).notNull().default("end"),
    /** Certificate template for this session. Empty means the event's default template. */
    certificateTemplateId: integer("certificate_template_id"),
    /** When the certificate is issued. Empty means the template's rule. */
    certificateAfter: text("certificate_after", { enum: ["evaluation", "checkin"] }),
    /** When attendees can download the slides: after the session starts, right away, or never. */
    slidesShare: text("slides_share", { enum: ["after_start", "now", "hidden"] }).notNull().default("after_start"),
    /** Calendar date slides are due from speakers. */
    slidesDueOn: text("slides_due_on"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_event").on(t.eventId, t.date)]
);

export const speakers = sqliteTable(
  "speakers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    /** Full name ("Taylor Reed"), kept in step with firstName and lastName. */
    name: text("name").notNull(),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    credentials: text("credentials").notNull().default(""),
    jobTitle: text("job_title").notNull().default(""),
    organization: text("organization").notNull().default(""),
    city: text("city").notNull().default(""),
    bio: text("bio").notNull().default(""),
    headshotFileId: integer("headshot_file_id").references(() => files.id, { onDelete: "set null" }),
    website: text("website").notNull().default(""),
    email: text("email").notNull().default(""),
    featured: integer("featured", { mode: "boolean" }).notNull().default(false),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Attendees can message this speaker from the bio sheet. */
    allowMessages: integer("allow_messages", { mode: "boolean" }).notNull().default(true),
    /** Secret in the speaker page link (/speak/:token): slides, bio and agreement. */
    portalToken: text("portal_token").unique(),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("speakers_event").on(t.eventId)]
);

export const sessionSpeakers = sqliteTable(
  "session_speakers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    speakerId: integer("speaker_id").notNull().references(() => speakers.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["presenter", "co-presenter", "moderator", "panelist"] }).notNull().default("presenter"),
  },
  (t) => [uniqueIndex("session_speakers_unique").on(t.sessionId, t.speakerId)]
);

/** An attendee's own agenda ("My agenda"). */
export const scheduleItems = sqliteTable(
  "schedule_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    remind: integer("remind", { mode: "boolean" }).notNull().default(true),
    remindedAt: integer("reminded_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("schedule_unique").on(t.attendeeId, t.sessionId)]
);

/** Announcements: an in-app alert plus a push notice to everyone in the audience. */
export const announcements = sqliteTable(
  "announcements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    audience: text("audience", { enum: ["everyone", "checked_in", "not_checked_in", "speakers", "vendors", "ticket", "session"] }).notNull().default("everyone"),
    ticketTypeId: integer("ticket_type_id"),
    /** Audience "session": people with this session on My agenda or checked in to it. */
    sessionId: integer("session_id"),
    /** Saved without sending. */
    draft: integer("draft", { mode: "boolean" }).notNull().default(false),
    url: text("url").notNull().default(""),
    sendPush: integer("send_push", { mode: "boolean" }).notNull().default(true),
    sendEmail: integer("send_email", { mode: "boolean" }).notNull().default(false),
    /** Empty means send now. */
    sendAt: integer("send_at", { mode: "timestamp_ms" }),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    recipients: integer("recipients").notNull().default(0),
    createdBy: integer("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("announcements_event").on(t.eventId)]
);

export type MenuItem = { name: string; dietary: string[] };

/** Event meals (with their dishes) and restaurants near the venue. */
export const diningItems = sqliteTable(
  "dining_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["menu", "nearby"] }).notNull(),
    /** Menu: which meal ("Breakfast", "Lunch"), date and time. Nearby: cuisine and price. */
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    date: text("date").notNull().default(""),
    meal: text("meal").notNull().default(""),
    time: text("time").notNull().default(""),
    endTime: text("end_time").notNull().default(""),
    /** Menu: the dishes served at this meal. */
    items: text("items", { mode: "json" }).$type<MenuItem[]>().notNull().default(sql`'[]'`),
    /** Nearby: "quick", "sitdown" or "coffee". */
    category: text("category").notNull().default(""),
    location: text("location").notNull().default(""),
    dietary: text("dietary", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    cuisine: text("cuisine").notNull().default(""),
    price: text("price").notNull().default(""),
    walkMinutes: integer("walk_minutes"),
    address: text("address").notNull().default(""),
    url: text("url").notNull().default(""),
    phone: text("phone").notNull().default(""),
    note: text("note").notNull().default(""),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("dining_event").on(t.eventId, t.kind)]
);

/** Help center: answers to common questions. */
export const helpArticles = sqliteTable(
  "help_articles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    category: text("category").notNull().default("General"),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("help_articles_event").on(t.eventId)]
);

/** Requests attendees send from the help center. */
export const helpRequests = sqliteTable(
  "help_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").references(() => attendees.id, { onDelete: "set null" }),
    topic: text("topic").notNull(),
    message: text("message").notNull(),
    status: text("status", { enum: ["open", "answered", "closed"] }).notNull().default("open"),
    reply: text("reply").notNull().default(""),
    repliedBy: integer("replied_by"),
    repliedAt: integer("replied_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("help_requests_event").on(t.eventId)]
);

export const lostFound = sqliteTable(
  "lost_found",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["lost", "found"] }).notNull(),
    /** Phone, Keys, Wallet, Bag, Clothing, Other. */
    category: text("category").notNull().default(""),
    item: text("item").notNull(),
    description: text("description").notNull().default(""),
    place: text("place").notNull().default(""),
    photoFileId: integer("photo_file_id"),
    attendeeId: integer("attendee_id").references(() => attendees.id, { onDelete: "set null" }),
    status: text("status", { enum: ["open", "claimed", "returned"] }).notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [index("lost_found_event").on(t.eventId)]
);

/** The help desk shown at the top of the help center. */
export const helpDesks = sqliteTable("help_desks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").notNull().unique().references(() => events.id, { onDelete: "cascade" }),
  place: text("place").notNull().default(""),
  hours: text("hours").notNull().default(""),
  phone: text("phone").notNull().default(""),
  /** Shown on the lost and found page. */
  lostFoundNote: text("lost_found_note").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

/** People on the About your host page (board, team, staff), grouped under a heading. */
export const hostPeople = sqliteTable(
  "host_people",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title").notNull().default(""),
    workplace: text("workplace").notNull().default(""),
    /** The heading they show under: "Our team", "Board of directors" or the organization's own. */
    groupLabel: text("group_label").notNull().default("Our team"),
    bio: text("bio").notNull().default(""),
    photoFileId: integer("photo_file_id").references(() => files.id, { onDelete: "set null" }),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("host_people_event").on(t.eventId)]
);

/** Which push notices an attendee wants. In-app alerts are always kept. */
export const alertPrefs = sqliteTable("alert_prefs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  attendeeId: integer("attendee_id").notNull().unique().references(() => attendees.id, { onDelete: "cascade" }),
  reminders: integer("reminders", { mode: "boolean" }).notNull().default(true),
  evaluations: integer("evaluations", { mode: "boolean" }).notNull().default(true),
  changes: integer("changes", { mode: "boolean" }).notNull().default(true),
  announcements: integer("announcements", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

export type Session = typeof sessions.$inferSelect;
export type Speaker = typeof speakers.$inferSelect;
