import type { Look } from "../../shared/brand";
import { sqliteTable, integer, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** Created-at column used on every table (milliseconds since 1970, shown as a Date). */
export const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

/** An association (NABC is the first). Everything belongs to one. */
export const organizations = sqliteTable("organizations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoFileId: integer("logo_file_id"),
  /** Brand colors used by the member app and the checkout page. */
  colorPrimary: text("color_primary").notNull().default("#1F5F4A"),
  colorAccent: text("color_accent").notNull().default("#e88a3a"),
  /** Third brand color for small accents (tags, links, the active tab). Empty means the main color. */
  colorHighlight: text("color_highlight").notNull().default(""),
  /** LeadDash platform (GoHighLevel) sub-account this association mirrors contacts into. */
  platformLocationId: text("platform_location_id"),
  /** How many events the organization may add. Set by LeadDash staff (a sponsored organization gets 1). */
  eventAllowance: integer("event_allowance").notNull().default(1),
  createdAt: createdAt(),
});

/** Anyone who signs in: admins, staff, attendees, speakers, vendors, members. */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  phone: text("phone"),
  createdAt: createdAt(),
  lastSignedInAt: integer("last_signed_in_at", { mode: "timestamp_ms" }),
});

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("auth_sessions_user").on(t.userId)]
);

/** Six-digit sign-in codes sent by email. Only the hash is stored. */
export const loginCodes = sqliteTable(
  "login_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("login_codes_email").on(t.email)]
);

/** Association staff with admin access to every event the association runs. */
export const orgMembers = sqliteTable(
  "org_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin"] }).notNull().default("admin"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("org_members_unique").on(t.orgId, t.userId)]
);

export type EventBranding = Partial<Look> & {
  colorPrimary: string;
  colorAccent: string;
  /** Third color for small accents (tags, links, the active tab). Empty or missing means the main color. */
  colorHighlight?: string;
  logoFileId?: number | null;
  coverFileId?: number | null;
  appName?: string;
  /** Badge layout: which fields print on the badge. */
  badge?: { showCredentials: boolean; showOrg: boolean; showCity: boolean; ribbonByTicket: boolean; size: "4x3" | "4x6" };
};

export type HostLink = { label: string; url: string };

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    shortName: text("short_name").notNull().default(""),
    /** Calendar dates, "2027-04-22". */
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    timezone: text("timezone").notNull().default("America/Chicago"),
    venueName: text("venue_name").notNull().default(""),
    venueAddress: text("venue_address").notNull().default(""),
    /** Suite, building or floor. venueAddress is the street line. */
    venueAddress2: text("venue_address2").notNull().default(""),
    city: text("city").notNull().default(""),
    /** Two letter state, "TX". */
    state: text("state").notNull().default(""),
    zip: text("zip").notNull().default(""),
    capacity: integer("capacity"),
    status: text("status", { enum: ["draft", "live", "ended"] }).notNull().default("draft"),
    branding: text("branding", { mode: "json" }).$type<EventBranding>().notNull().default(sql`'{"colorPrimary":"#1F5F4A","colorAccent":"#e88a3a"}'`),
    /** "About your host" page the event can update. */
    hostName: text("host_name").notNull().default(""),
    hostAbout: text("host_about").notNull().default(""),
    hostMission: text("host_mission").notNull().default(""),
    hostImageFileId: integer("host_image_file_id"),
    hostLinks: text("host_links", { mode: "json" }).$type<HostLink[]>().notNull().default(sql`'[]'`),
    hostJoinUrl: text("host_join_url").notNull().default(""),
    /** Features attendees see in the app. */
    features: text("features", { mode: "json" })
      .$type<{ networking: boolean; community: boolean; messaging: boolean; meetings: boolean; polls: boolean; exhibitors: boolean; dining: boolean; photos: boolean }>()
      .notNull()
      .default(sql`'{"networking":true,"community":true,"messaging":true,"meetings":true,"polls":true,"exhibitors":true,"dining":true}'`),
    createdAt: createdAt(),
  },
  (t) => [index("events_org").on(t.orgId)]
);

/** Uploaded files (headshots, logos, cover images, documents). Stored on disk under UPLOADS_DIR. */
export const files = sqliteTable("files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  /** Random key used in the public URL /files/<key>. */
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  /** Public files (headshots, logos, covers) are served to anyone; private ones need access. */
  isPublic: integer("is_public", { mode: "boolean" }).notNull().default(true),
  uploadedBy: integer("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/** Event staff roles (check-in volunteer, proposal reviewer, booth staff, speaker...). */
export type Access = "edit" | "view" | "none";
export const STAFF_AREAS = ["checkin", "attendees", "sessions", "help", "proposals", "vendors", "registration", "reports", "speakers", "community", "announcements", "evaluations", "certificates"] as const;
export type StaffArea = (typeof STAFF_AREAS)[number];

export const staffRoles = sqliteTable(
  "staff_roles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    access: text("access", { mode: "json" }).$type<Partial<Record<StaffArea, Access>>>().notNull().default(sql`'{}'`),
    endsWithEvent: integer("ends_with_event", { mode: "boolean" }).notNull().default(true),
    signInWith: text("sign_in_with", { enum: ["email", "text"] }).notNull().default("email"),
    /** Built-in roles have special behavior (reviewer sees only assigned proposals, booth staff only their booth). */
    kind: text("kind", { enum: ["custom", "event_admin", "checkin", "reviewer", "booth", "speaker"] }).notNull().default("custom"),
    createdAt: createdAt(),
  },
  (t) => [index("staff_roles_event").on(t.eventId)]
);

export const staffAssignments = sqliteTable(
  "staff_assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roleId: integer("role_id").notNull().references(() => staffRoles.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** For booth staff: which vendor they work for. */
    vendorId: integer("vendor_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("staff_assignments_unique").on(t.roleId, t.userId)]
);

/** Browser push subscriptions (one per device). */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("push_user").on(t.userId)]
);

/** In-app alerts (the Alerts screen). Push notices are sent for the same rows when the person allows push. */
export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    eventId: integer("event_id").references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("general"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    url: text("url").notNull().default(""),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user").on(t.userId)]
);

/** Changes to the LeadDash platform waiting to be sent (contact upserts and tags). Retried until they go through. */
export const platformOutbox = sqliteTable("platform_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["upsert_contact", "add_tags"] }).notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  nextTryAt: integer("next_try_at", { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`),
  createdAt: createdAt(),
});

/** LeadDash platform agency authorization (one row). Tokens are encrypted. */
export const platformAuth = sqliteTable("platform_auth", {
  id: integer("id").primaryKey(),
  companyId: text("company_id").notNull(),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** Who changed what, for admins (shown on reports, kept for audits). */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id"),
    eventId: integer("event_id"),
    userId: integer("user_id"),
    action: text("action").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("audit_event").on(t.eventId)]
);

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Event = typeof events.$inferSelect;
export type StaffRole = typeof staffRoles.$inferSelect;
