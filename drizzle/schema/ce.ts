import { sqliteTable, integer, text, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createdAt, events } from "./core";
import { attendees } from "./registration";
import { sessions } from "./program";

export type EvalQuestion = {
  id: string;
  kind: "rating" | "choice" | "text" | "yesno";
  label: string;
  required: boolean;
  options?: string[];
  /** Rating scale size (default 5). */
  scale?: number;
};

/** A session evaluation form. One form can be used by many sessions. */
export const evaluations = sqliteTable(
  "evaluations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    questions: text("questions", { mode: "json" }).$type<EvalQuestion[]>().notNull().default(sql`'[]'`),
    /** Used for every CE session unless a session picks another form. */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /** Hours after the session ends that the evaluation stays open. */
    closesAfterHours: integer("closes_after_hours").notNull().default(720),
    /** When attendees can open it: when the session ends, or right after they check in. */
    opensAt: text("opens_at", { enum: ["session_end", "checkin"] }).notNull().default("session_end"),
    /** Certificates wait for this form when the certificate template asks for an evaluation. */
    neededForCertificate: integer("needed_for_certificate", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("evaluations_event").on(t.eventId)]
);

export const evaluationResponses = sqliteTable(
  "evaluation_responses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    evaluationId: integer("evaluation_id").notNull().references(() => evaluations.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    answers: text("answers", { mode: "json" }).$type<Record<string, string | number>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("evaluation_once").on(t.sessionId, t.attendeeId)]
);

/** Proof of attendance for CE: a scan of the room's QR code (or a staff check-in). */
export const sessionCheckins = sqliteTable(
  "session_checkins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    method: text("method", { enum: ["qr", "staff", "import"] }).notNull().default("qr"),
    checkedOutAt: integer("checked_out_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("session_checkin_once").on(t.sessionId, t.attendeeId)]
);

export type CertificateShow = { credentials: boolean; sessionTitle: boolean; sessionDate: boolean; hours: boolean; code: boolean; presenter: boolean };

/** Certificate design and the CE provider details printed on it. */
export const certificateTemplates = sqliteTable(
  "certificate_templates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title").notNull().default("Certificate of Attendance"),
    providerName: text("provider_name").notNull().default(""),
    providerNumber: text("provider_number").notNull().default(""),
    approvalText: text("approval_text").notNull().default(""),
    signerName: text("signer_name").notNull().default(""),
    signerTitle: text("signer_title").notNull().default(""),
    /** Issue one certificate per session, or one for the whole event. */
    scope: text("scope", { enum: ["session", "event"] }).notNull().default("session"),
    /** Certificates are issued only after the evaluation is submitted. */
    requireEvaluation: integer("require_evaluation", { mode: "boolean" }).notNull().default(true),
    /** Minimum minutes in the room (from check-in to session end) to earn credit. */
    minMinutes: integer("min_minutes").notNull().default(0),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(true),
    /** Signature printed as typed script, or an uploaded image. */
    signatureStyle: text("signature_style", { enum: ["script", "image"] }).notNull().default("script"),
    signatureFileId: integer("signature_file_id"),
    /** Which details print on the certificate. */
    show: text("show", { mode: "json" })
      .$type<CertificateShow>()
      .notNull()
      .default(sql`'{"credentials":true,"sessionTitle":true,"sessionDate":true,"hours":true,"code":true,"presenter":false}'`),
    createdAt: createdAt(),
  },
  (t) => [index("certificate_templates_event").on(t.eventId)]
);

export const certificates = sqliteTable(
  "certificates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
    templateId: integer("template_id").references(() => certificateTemplates.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    hours: real("hours").notNull(),
    /** Public verification code printed on the certificate. */
    code: text("code").notNull().unique(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("certificates_attendee").on(t.attendeeId), uniqueIndex("certificate_once").on(t.attendeeId, t.sessionId)]
);

/** Evaluation-ready notices already sent (one per attendee and session, never repeated). */
export const evaluationReminders = sqliteTable(
  "evaluation_reminders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id").notNull().references(() => attendees.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("evaluation_reminder_once").on(t.sessionId, t.attendeeId)]
);

export type Evaluation = typeof evaluations.$inferSelect;
export type CertificateTemplate = typeof certificateTemplates.$inferSelect;
export type Certificate = typeof certificates.$inferSelect;
