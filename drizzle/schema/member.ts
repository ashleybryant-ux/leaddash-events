import { sqliteTable, integer, text, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createdAt, files, organizations, users } from "./core";

/** Association members (the member hub). The LeadDash platform stays the record for dues and payments. */
export const members = sqliteTable(
  "members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    credentials: text("credentials").notNull().default(""),
    level: text("level").notNull().default("Professional"),
    memberNumber: text("member_number").notNull(),
    /** Year they joined, "2019". */
    memberSince: text("member_since").notNull().default(""),
    /** "2027-12-31". */
    expiresOn: text("expires_on"),
    status: text("status", { enum: ["active", "grace", "lapsed", "cancelled"] }).notNull().default("active"),
    autoRenew: integer("auto_renew", { mode: "boolean" }).notNull().default(false),
    photoFileId: integer("photo_file_id").references(() => files.id, { onDelete: "set null" }),
    /** Secret in the member card QR code. */
    cardToken: text("card_token").notNull().unique(),
    platformContactId: text("platform_contact_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("members_org_email").on(t.orgId, t.email), index("members_user").on(t.userId)]
);

/** Divisions, committees and task forces. */
export const groups = sqliteTable(
  "groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["division", "committee", "task_force"] }).notNull().default("committee"),
    description: text("description").notNull().default(""),
    joinRule: text("join_rule", { enum: ["open", "appointment", "level"] }).notNull().default("appointment"),
    /** For joinRule "level": which member level may join. */
    joinLevel: text("join_level").notNull().default(""),
    termEndsOn: text("term_ends_on"),
    hasChannel: integer("has_channel", { mode: "boolean" }).notNull().default(true),
    hasFolder: integer("has_folder", { mode: "boolean" }).notNull().default(true),
    chairCanEmail: integer("chair_can_email", { mode: "boolean" }).notNull().default(true),
    chairCanAdd: integer("chair_can_add", { mode: "boolean" }).notNull().default(false),
    nextMeeting: text("next_meeting").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("groups_org").on(t.orgId)]
);

export const groupMembers = sqliteTable(
  "group_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    memberId: integer("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["member", "co_chair", "chair"] }).notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("group_members_unique").on(t.groupId, t.memberId)]
);

/** Group discussion posts (each group with a channel). */
export const groupPosts = sqliteTable(
  "group_posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    groupId: integer("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    memberId: integer("member_id").references(() => members.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("group_posts_group").on(t.groupId)]
);

export type FolderAccess = { type: "active_members" | "board" | "group" | "level" | "staff"; groupId?: number; level?: string };

export const docFolders = sqliteTable(
  "doc_folders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    access: text("access", { mode: "json" }).$type<FolderAccess>().notNull().default(sql`'{"type":"active_members"}'`),
    groupId: integer("group_id").references(() => groups.id, { onDelete: "cascade" }),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("doc_folders_org").on(t.orgId)]
);

export const documents = sqliteTable(
  "documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    folderId: integer("folder_id").notNull().references(() => docFolders.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    notify: text("notify", { enum: ["push_email", "push", "none"] }).notNull().default("push_email"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("documents_folder").on(t.folderId)]
);

export const documentVersions = sqliteTable(
  "document_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: integer("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    fileId: integer("file_id").notNull().references(() => files.id),
    note: text("note").notNull().default(""),
    uploadedBy: integer("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("document_versions_unique").on(t.documentId, t.version)]
);

/** CE earned outside LeadDash Events (webinars, imports), shown on the all-years transcript. */
export const ceEntries = sqliteTable(
  "ce_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    title: text("title").notNull(),
    provider: text("provider").notNull().default(""),
    date: text("date").notNull(),
    hours: real("hours").notNull(),
    certificateFileId: integer("certificate_file_id"),
    createdAt: createdAt(),
  },
  (t) => [index("ce_entries_email").on(t.orgId, t.email)]
);

/** Programs outside events counted in reports across programs (webinar series, mentoring). */
export const programs = sqliteTable("programs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const programParticipants = sqliteTable(
  "program_participants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    programId: integer("program_id").notNull().references(() => programs.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    rating: integer("rating"),
    date: text("date").notNull(),
  },
  (t) => [index("program_participants_program").on(t.programId)]
);

export type Member = typeof members.$inferSelect;
