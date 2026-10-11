/**
 * Call for proposals: the public submission form, the admin screen (area
 * "proposals") and the review queue for reviewers (staff role kind "reviewer").
 * Reviewers only see proposals assigned to them, and never the submitter's
 * name, email or bio when blind review is on.
 */
import { asRichText, cleanRichText, richTextToPlain } from "../../_core/richtext";
import { z } from "zod";
import { and, eq, inArray, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Event, User } from "../../../drizzle/schema";
import { protectedProcedure, publicProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, eventAccess, forbidden, getEvent, getEventBySlug, notFound } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { ENV } from "../../_core/env";
import { randomToken } from "../../_core/crypto";
import { fmtDate, fmtTime } from "@shared/format";
import { activeRoles, hhmm, id, isoDate, slug } from "./common";
import { sendSpeakerAgreement, templateFor } from "../agreements/sign";
import { templateFor as messageTemplateFor } from "../registration/messages";
import { sendSpeakerWelcome } from "../registration/recipientMessages";

type Proposal = typeof schema.proposals.$inferSelect;
type Assignment = typeof schema.reviewAssignments.$inferSelect;
type Settings = typeof schema.cfpSettings.$inferSelect;

export function cfpSettingsFor(eventId: number): Settings {
  const db = getDb();
  const row = db.select().from(schema.cfpSettings).where(eq(schema.cfpSettings.eventId, eventId)).get();
  if (row) return row;
  db.insert(schema.cfpSettings).values({ eventId }).onConflictDoNothing().run();
  return db.select().from(schema.cfpSettings).where(eq(schema.cfpSettings.eventId, eventId)).get()!;
}

/** Today's date in the event's time zone. */
function todayIn(tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function cfpOpen(s: Settings, event: Event) {
  const today = todayIn(event.timezone);
  if (!s.closesOn && !s.opensOn) return false;
  if (s.opensOn && today < s.opensOn) return false;
  if (s.closesOn && today > s.closesOn) return false;
  return true;
}

/**
 * What the person can do with proposals: full access (from an admin or a
 * non-reviewer role that grants the proposals area) and/or reviewing.
 */
export function proposalsAccess(user: User, eventId: number) {
  const event = getEvent(eventId);
  const access = eventAccess(user, eventId);
  if (access.admin) return { event, full: "edit" as const, reviewer: access.kinds.has("reviewer") };
  let full: "edit" | "view" | null = null;
  let reviewer = false;
  for (const { role } of activeRoles(user, event)) {
    if (role.kind === "reviewer") {
      reviewer = true;
      continue;
    }
    const level = role.kind === "event_admin" ? "edit" : role.access.proposals;
    if (level === "edit") full = "edit";
    else if (level === "view" && !full) full = "view";
  }
  return { event, full, reviewer };
}

function requireFull(user: User, eventId: number, level: "view" | "edit" = "view") {
  const a = proposalsAccess(user, eventId);
  if (!a.full || (level === "edit" && a.full !== "edit")) throw forbidden();
  return a.event;
}

/** People who hold a reviewer role for the event. */
export function reviewersFor(event: Event) {
  const rows = getDb()
    .select({ user: schema.users, role: schema.staffRoles })
    .from(schema.staffAssignments)
    .innerJoin(schema.staffRoles, eq(schema.staffRoles.id, schema.staffAssignments.roleId))
    .innerJoin(schema.users, eq(schema.users.id, schema.staffAssignments.userId))
    .where(and(eq(schema.staffRoles.eventId, event.id), eq(schema.staffRoles.kind, "reviewer")))
    .all();
  const seen = new Map<number, { id: number; name: string; email: string }>();
  for (const r of rows) if (!seen.has(r.user.id)) seen.set(r.user.id, { id: r.user.id, name: r.user.name || r.user.email, email: r.user.email });
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** A review's score on a 0 to 5 scale (sum of items over sum of maximums). */
function reviewScore(a: Assignment, s: Settings) {
  if (!a.submittedAt || !a.scores) return null;
  const max = s.rubric.reduce((t, r) => t + r.max, 0);
  if (!max) return null;
  const got = s.rubric.reduce((t, r) => t + Math.min(r.max, Math.max(0, a.scores?.[r.key] ?? 0)), 0);
  return (got / max) * 5;
}

function summary(p: Proposal, assignments: Assignment[], s: Settings) {
  const mine = assignments.filter((a) => a.proposalId === p.id);
  const done = mine.filter((a) => a.submittedAt);
  const scores = done.map((a) => reviewScore(a, s)).filter((x): x is number => x !== null);
  const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
  const needed = Math.max(s.reviewersPerProposal, mine.length);
  const fullyReviewed = done.length >= needed && needed > 0;
  const decided = ["accepted", "waitlisted", "declined", "withdrawn"].includes(p.status);
  return { assigned: mine.length, reviewed: done.length, needed, avg, fullyReviewed, stage: decided ? p.status : fullyReviewed ? "needs_decision" : "in_review" };
}

const proposalInput = z.object({
  slug,
  name: z.string().trim().min(2).max(120),
  credentials: z.string().trim().max(60).default(""),
  organization: z.string().trim().max(160).default(""),
  bio: z.string().trim().max(2000).default(""),
  headshotFileId: id.nullable().default(null),
  title: z.string().trim().min(3).max(200),
  abstract: z.string().trim().min(20).max(3000),
  objectives: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
  format: z.string().trim().max(120),
  track: z.string().trim().max(120).default(""),
  ceRequested: z.boolean().default(true),
  coPresenters: z.array(z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email().max(200), credentials: z.string().trim().max(60).default("") })).max(6).default([]),
  answers: z.record(z.string().max(60), z.string().max(2000)).default({}),
});

function brandEmail(event: Event, title: string, blocks: string[]) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, event.orgId)).get()!;
  return { html: emailLayout({ brand: event.branding.colorPrimary, accent: event.branding.colorAccent, look: event.branding, coverUrl: fileUrl(event.branding.coverFileId, true), eventName: event.name, title, blocks, footer: escapeHtml(org.name) }), orgName: org.name };
}

function decisionEmail(event: Event, p: Proposal, session: { date: string; startTime: string; room: string } | null) {
  const name = event.shortName || event.name;
  const intro =
    p.status === "accepted"
      ? `Your proposal "${p.title}" was accepted for ${event.name}.`
      : p.status === "waitlisted"
        ? `Your proposal "${p.title}" is on the waitlist for ${event.name}. We will let you know if a spot opens.`
        : `Thank you for submitting "${p.title}" to ${event.name}. We are not able to include it this year.`;
  const when = session ? `Your session: ${fmtDate(session.date)} at ${fmtTime(session.startTime)}${session.room ? `, ${session.room}` : ""}.` : "";
  const note = p.decisionNote ? p.decisionNote : "";
  const { html, orgName } = brandEmail(event, p.status === "accepted" ? "Your proposal was accepted" : p.status === "waitlisted" ? "Your proposal is on the waitlist" : "About your proposal", [
    `<p>Hello ${escapeHtml(p.name)},</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    when ? `<p>${escapeHtml(when)}</p>` : "",
    note ? `<p>${escapeHtml(note).replace(/\n/g, "<br>")}</p>` : "",
  ]);
  return {
    to: p.email,
    fromName: `${name} Team`,
    subject: `${name}: ${p.status === "accepted" ? "your proposal was accepted" : p.status === "waitlisted" ? "your proposal is on the waitlist" : "about your proposal"}`,
    text: [`Hello ${p.name},`, intro, when, note, orgName].filter(Boolean).join("\n\n"),
    html,
  };
}

const settingsInput = z.object({
  eventId: id,
  opensOn: isoDate.nullable(),
  closesOn: isoDate.nullable(),
  /** Formatted guidelines from the editor (HTML, cleaned on save). */
  intro: z.string().trim().max(60000),
  formats: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  tracks: z.array(z.string().trim().min(1).max(120)).max(30),
  rubric: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/), label: z.string().trim().min(1).max(80), max: z.number().int().min(1).max(10) })).min(1).max(10),
  blind: z.boolean(),
  reviewersPerProposal: z.number().int().min(1).max(10),
});

/** Assigns reviewers so each proposal has enough, spreading the work evenly. */
export function autoAssign(event: Event) {
  const db = getDb();
  const s = cfpSettingsFor(event.id);
  const reviewers = reviewersFor(event);
  if (!reviewers.length) return 0;
  const proposals = db
    .select()
    .from(schema.proposals)
    .where(and(eq(schema.proposals.eventId, event.id), inArray(schema.proposals.status, ["submitted", "in_review"])))
    .orderBy(schema.proposals.id)
    .all();
  const all = proposals.length ? db.select().from(schema.reviewAssignments).where(inArray(schema.reviewAssignments.proposalId, proposals.map((p) => p.id))).all() : [];
  const load = new Map(reviewers.map((r) => [r.id, 0]));
  for (const a of all) if (load.has(a.reviewerUserId)) load.set(a.reviewerUserId, load.get(a.reviewerUserId)! + 1);
  let added = 0;
  for (const p of proposals) {
    const have = new Set(all.filter((a) => a.proposalId === p.id).map((a) => a.reviewerUserId));
    while (have.size < s.reviewersPerProposal) {
      const pick = reviewers
        .filter((r) => !have.has(r.id) && r.id !== p.userId && r.email !== p.email)
        .sort((a, b) => load.get(a.id)! - load.get(b.id)! || a.id - b.id)[0];
      if (!pick) break;
      db.insert(schema.reviewAssignments).values({ proposalId: p.id, reviewerUserId: pick.id }).onConflictDoNothing().run();
      have.add(pick.id);
      load.set(pick.id, load.get(pick.id)! + 1);
      added++;
    }
    if (have.size && p.status === "submitted") db.update(schema.proposals).set({ status: "in_review" }).where(eq(schema.proposals.id, p.id)).run();
  }
  return added;
}

const adminRouter = router({
  /** Whether the signed-in person sees the admin view, the review queue, or both. */
  mode: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    const a = proposalsAccess(ctx.user, input.eventId);
    if (!a.full && !a.reviewer) throw forbidden();
    return { full: a.full, reviewer: a.reviewer };
  }),

  settings: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    const event = requireFull(ctx.user, input.eventId);
    const s = cfpSettingsFor(event.id);
    return { ...s, intro: asRichText(s.intro), open: cfpOpen(s, event), reviewers: reviewersFor(event), link: `${ENV.appUrl}/cfp/${event.slug}` };
  }),

  updateSettings: protectedProcedure.input(settingsInput).mutation(({ ctx, input }) => {
    const event = requireFull(ctx.user, input.eventId, "edit");
    if (input.opensOn && input.closesOn && input.closesOn < input.opensOn) throw new TRPCError({ code: "BAD_REQUEST", message: "The due date is before the open date." });
    const keys = new Set<string>();
    for (const r of input.rubric) {
      if (keys.has(r.key)) throw new TRPCError({ code: "BAD_REQUEST", message: "Each score needs a different name." });
      keys.add(r.key);
    }
    const s = cfpSettingsFor(event.id);
    const { eventId: _e, ...rest } = input;
    const intro = cleanRichText(rest.intro);
    if (richTextToPlain(intro).length > 15000) throw new TRPCError({ code: "BAD_REQUEST", message: "The guidelines are too long. Keep them under 15,000 characters." });
    getDb().update(schema.cfpSettings).set({ ...rest, intro }).where(eq(schema.cfpSettings.id, s.id)).run();
    audit(ctx.user, { eventId: event.id, action: "cfp.settings" });
    return { ok: true };
  }),

  /** Every proposal with its reviews, for the admin table. */
  list: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    const event = requireFull(ctx.user, input.eventId);
    const db = getDb();
    const s = cfpSettingsFor(event.id);
    const rows = db.select().from(schema.proposals).where(eq(schema.proposals.eventId, event.id)).orderBy(schema.proposals.id).all();
    const assignments = rows.length ? db.select().from(schema.reviewAssignments).where(inArray(schema.reviewAssignments.proposalId, rows.map((r) => r.id))).all() : [];
    const userIds = Array.from(new Set(assignments.map((a) => a.reviewerUserId)));
    const users = new Map(userIds.length ? db.select().from(schema.users).where(inArray(schema.users.id, userIds)).all().map((u) => [u.id, u.name || u.email]) : []);
    const proposals = rows.map((p) => ({
      ...p,
      headshotUrl: fileUrl(p.headshotFileId),
      summary: summary(p, assignments, s),
      reviews: assignments
        .filter((a) => a.proposalId === p.id)
        .map((a) => ({ id: a.id, reviewerUserId: a.reviewerUserId, reviewer: users.get(a.reviewerUserId) ?? "", scores: a.scores, recommendation: a.recommendation, comment: a.comment, submittedAt: a.submittedAt, score: reviewScore(a, s) })),
    }));
    const stats = {
      submitted: rows.filter((r) => r.status !== "withdrawn").length,
      fullyReviewed: proposals.filter((p) => p.summary.fullyReviewed).length,
      accepted: rows.filter((r) => r.status === "accepted").length,
      declined: rows.filter((r) => r.status === "declined").length,
    };
    const agreement = templateFor(event.id, "speaker");
    return { proposals, stats, rubric: s.rubric, eventDays: { start: event.startDate, end: event.endDate }, speakerAgreement: agreement ? { name: agreement.name, sendOnAccept: agreement.sendOnAccept } : null };
  }),

  /** Sets who reviews a proposal. Reviews already submitted stay. */
  assign: protectedProcedure.input(z.object({ eventId: id, proposalId: id, reviewerUserIds: z.array(id).max(20) })).mutation(({ ctx, input }) => {
    const event = requireFull(ctx.user, input.eventId, "edit");
    const db = getDb();
    const p = db.select().from(schema.proposals).where(eq(schema.proposals.id, input.proposalId)).get();
    if (!p || p.eventId !== event.id) throw notFound("That proposal");
    const allowed = new Set(reviewersFor(event).map((r) => r.id));
    for (const uid of input.reviewerUserIds) if (!allowed.has(uid)) throw new TRPCError({ code: "BAD_REQUEST", message: "Only people with a reviewer role can review." });
    const current = db.select().from(schema.reviewAssignments).where(eq(schema.reviewAssignments.proposalId, p.id)).all();
    for (const a of current) if (!input.reviewerUserIds.includes(a.reviewerUserId) && !a.submittedAt) db.delete(schema.reviewAssignments).where(eq(schema.reviewAssignments.id, a.id)).run();
    for (const uid of input.reviewerUserIds) db.insert(schema.reviewAssignments).values({ proposalId: p.id, reviewerUserId: uid }).onConflictDoNothing().run();
    if (input.reviewerUserIds.length && p.status === "submitted") db.update(schema.proposals).set({ status: "in_review" }).where(eq(schema.proposals.id, p.id)).run();
    return { ok: true };
  }),

  autoAssign: protectedProcedure.input(z.object({ eventId: id })).mutation(({ ctx, input }) => {
    const event = requireFull(ctx.user, input.eventId, "edit");
    const added = autoAssign(event);
    audit(ctx.user, { eventId: event.id, action: "cfp.auto_assign", detail: String(added) });
    return { added };
  }),

  /** Accept, waitlist or decline, with the decision email. Accepting can add the session and speakers to the program. */
  decide: protectedProcedure
    .input(
      z.object({
        eventId: id,
        proposalId: id,
        decision: z.enum(["accepted", "waitlisted", "declined"]),
        note: z.string().trim().max(2000).default(""),
        sendEmail: z.boolean().default(true),
        session: z.object({ date: isoDate, startTime: hhmm, endTime: hhmm, room: z.string().trim().max(120) }).nullable().default(null),
        /** Accepting: email the speaker agreement to sign (when the event has one). */
        sendAgreement: z.boolean().default(false),
        /** Accepting: send the speaker welcome email once they sign. */
        welcomeAfterSign: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const event = requireFull(ctx.user, input.eventId, "edit");
      const db = getDb();
      const p = db.select().from(schema.proposals).where(eq(schema.proposals.id, input.proposalId)).get();
      if (!p || p.eventId !== event.id) throw notFound("That proposal");
      let sessionId = p.sessionId;
      if (input.decision === "accepted" && input.session && !sessionId) {
        const s = input.session;
        if (s.date < event.startDate || s.date > event.endDate) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a day during the event." });
        if (s.endTime <= s.startTime) throw new TRPCError({ code: "BAD_REQUEST", message: "The end time is before the start time." });
        const kind = /workshop/i.test(p.format) ? "workshop" : "session";
        const session = db
          .insert(schema.sessions)
          .values({ eventId: event.id, title: p.title, description: p.abstract, kind, date: s.date, startTime: s.startTime, endTime: s.endTime, room: s.room, track: p.track, checkInCode: randomToken(10), proposalId: p.id })
          .returning()
          .get();
        sessionId = session.id;
        const people = [
          { name: p.name, email: p.email, credentials: p.credentials, organization: p.organization, bio: p.bio, headshotFileId: p.headshotFileId, userId: p.userId, role: "presenter" as const },
          ...p.coPresenters.map((c) => ({ name: c.name, email: c.email, credentials: c.credentials, organization: "", bio: "", headshotFileId: null, userId: null, role: "co-presenter" as const })),
        ];
        for (const person of people) {
          const email = person.email.toLowerCase();
          let speaker = db.select().from(schema.speakers).where(and(eq(schema.speakers.eventId, event.id), eq(schema.speakers.email, email))).get();
          if (!speaker) {
            const u = person.userId ? { id: person.userId } : db.select().from(schema.users).where(eq(schema.users.email, email)).get();
            speaker = db
              .insert(schema.speakers)
              .values({ eventId: event.id, name: person.name, credentials: person.credentials, organization: person.organization, bio: person.bio, headshotFileId: person.headshotFileId, email, userId: u?.id ?? null })
              .returning()
              .get();
          }
          db.insert(schema.sessionSpeakers).values({ sessionId: session.id, speakerId: speaker.id, role: person.role }).onConflictDoNothing().run();
        }
      }
      db.update(schema.proposals).set({ status: input.decision, decisionNote: input.note, sessionId }).where(eq(schema.proposals.id, p.id)).run();
      const updated = db.select().from(schema.proposals).where(eq(schema.proposals.id, p.id)).get()!;
      if (input.sendEmail) {
        const session = sessionId ? db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get() ?? null : null;
        await sendEmail(decisionEmail(event, updated, input.decision === "accepted" && session ? session : null));
        db.update(schema.proposals).set({ notifiedAt: new Date() }).where(eq(schema.proposals.id, p.id)).run();
      }
      let agreementsSent = 0;
      if (input.decision === "accepted" && input.sendAgreement && sessionId && templateFor(event.id, "speaker")) {
        // Every presenter on the accepted session gets the speaker agreement to sign.
        const people = db.select({ speakerId: schema.sessionSpeakers.speakerId }).from(schema.sessionSpeakers).where(eq(schema.sessionSpeakers.sessionId, sessionId)).all();
        for (const { speakerId } of people) {
          try {
            const a = await sendSpeakerAgreement(speakerId, { welcomeAfterSign: input.welcomeAfterSign });
            if (a && a.status !== "signed") agreementsSent++;
          } catch (err) {
            console.error("[proposals] agreement send failed:", err);
          }
        }
      }
      if (input.decision === "accepted" && sessionId && messageTemplateFor(event.id, "speaker_welcome")?.sendRule === "after_accept") {
        // The speaker welcome is set to go when a proposal is accepted.
        for (const { speakerId } of db.select({ speakerId: schema.sessionSpeakers.speakerId }).from(schema.sessionSpeakers).where(eq(schema.sessionSpeakers.sessionId, sessionId)).all()) {
          try {
            await sendSpeakerWelcome(speakerId);
          } catch (err) {
            console.error("[proposals] speaker welcome failed:", err);
          }
        }
      }
      audit(ctx.user, { eventId: event.id, action: `cfp.${input.decision}`, detail: p.title });
      return { ok: true, sessionId, agreementsSent };
    }),
});

const reviewRouter = router({
  /** Proposals assigned to the signed-in reviewer. Names are hidden when blind review is on. */
  queue: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    const a = proposalsAccess(ctx.user, input.eventId);
    if (!a.reviewer) throw forbidden();
    const db = getDb();
    const s = cfpSettingsFor(a.event.id);
    const rows = db
      .select({ assignment: schema.reviewAssignments, proposal: schema.proposals })
      .from(schema.reviewAssignments)
      .innerJoin(schema.proposals, eq(schema.proposals.id, schema.reviewAssignments.proposalId))
      .where(and(eq(schema.reviewAssignments.reviewerUserId, ctx.user.id), eq(schema.proposals.eventId, a.event.id)))
      .orderBy(schema.proposals.id)
      .all();
    return {
      blind: s.blind,
      rubric: s.rubric,
      items: rows
        .filter((r) => r.proposal.status !== "withdrawn")
        .map(({ assignment, proposal: p }) => ({
          assignmentId: assignment.id,
          proposalId: p.id,
          title: p.title,
          abstract: p.abstract,
          objectives: p.objectives,
          format: p.format,
          track: p.track,
          ceRequested: p.ceRequested,
          answers: p.answers,
          createdAt: p.createdAt,
          submitter: s.blind ? null : { name: p.name, credentials: p.credentials, organization: p.organization, bio: p.bio, headshotUrl: fileUrl(p.headshotFileId), coPresenters: p.coPresenters.map((c) => `${c.name}${c.credentials ? `, ${c.credentials}` : ""}`) },
          presenters: 1 + p.coPresenters.length,
          scores: assignment.scores,
          recommendation: assignment.recommendation,
          comment: assignment.comment,
          submittedAt: assignment.submittedAt,
        })),
    };
  }),

  submit: protectedProcedure
    .input(z.object({ eventId: id, assignmentId: id, scores: z.record(z.string().max(40), z.number().int().min(0).max(10)), recommendation: z.enum(["accept", "maybe", "decline"]), comment: z.string().trim().max(3000).default("") }))
    .mutation(({ ctx, input }) => {
      const a = proposalsAccess(ctx.user, input.eventId);
      if (!a.reviewer) throw forbidden();
      const db = getDb();
      const row = db.select().from(schema.reviewAssignments).where(eq(schema.reviewAssignments.id, input.assignmentId)).get();
      if (!row || row.reviewerUserId !== ctx.user.id) throw notFound("That review");
      const p = db.select().from(schema.proposals).where(eq(schema.proposals.id, row.proposalId)).get();
      if (!p || p.eventId !== a.event.id) throw notFound("That review");
      const s = cfpSettingsFor(a.event.id);
      const scores: Record<string, number> = {};
      for (const r of s.rubric) {
        const v = input.scores[r.key];
        if (v === undefined || v < 1 || v > r.max) throw new TRPCError({ code: "BAD_REQUEST", message: `Give a score for ${r.label}.` });
        scores[r.key] = v;
      }
      db.update(schema.reviewAssignments).set({ scores, recommendation: input.recommendation, comment: input.comment, submittedAt: new Date() }).where(eq(schema.reviewAssignments.id, row.id)).run();
      return { ok: true };
    }),
});

export const proposalsRouter = router({
  /** The public form's details. */
  info: publicProcedure.input(z.object({ slug })).query(({ input }) => {
    const event = getEventBySlug(input.slug);
    const s = cfpSettingsFor(event.id);
    const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, event.orgId)).get()!;
    return {
      eventName: event.name,
      shortName: event.shortName || event.name,
      orgName: org.name,
      branding: event.branding,
      logoUrl: fileUrl(event.branding.logoFileId ?? org.logoFileId),
      coverUrl: fileUrl(event.branding.coverFileId),
      intro: asRichText(s.intro),
      opensOn: s.opensOn,
      closesOn: s.closesOn,
      open: cfpOpen(s, event),
      formats: s.formats,
      tracks: s.tracks,
      questions: s.questions,
    };
  }),

  /** The signed-in person's proposals for the event. */
  mine: protectedProcedure.input(z.object({ slug })).query(({ ctx, input }) => {
    const event = getEventBySlug(input.slug);
    return getDb()
      .select({ id: schema.proposals.id, title: schema.proposals.title, status: schema.proposals.status, createdAt: schema.proposals.createdAt })
      .from(schema.proposals)
      .where(and(eq(schema.proposals.eventId, event.id), or(eq(schema.proposals.userId, ctx.user.id), eq(schema.proposals.email, ctx.user.email.toLowerCase()))))
      .all();
  }),

  submit: protectedProcedure.input(proposalInput).mutation(async ({ ctx, input }) => {
    const event = getEventBySlug(input.slug);
    const s = cfpSettingsFor(event.id);
    if (!cfpOpen(s, event)) throw new TRPCError({ code: "BAD_REQUEST", message: "The call for proposals is closed." });
    if (s.formats.length && !s.formats.includes(input.format)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a format." });
    if (s.tracks.length && input.track && !s.tracks.includes(input.track)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a track." });
    for (const q of s.questions) if (q.required && !input.answers[q.key]?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: `Answer "${q.label}".` });
    const db = getDb();
    if (input.headshotFileId) {
      const f = db.select().from(schema.files).where(eq(schema.files.id, input.headshotFileId)).get();
      if (!f || f.uploadedBy !== ctx.user.id || !f.mime.startsWith("image/")) throw new TRPCError({ code: "BAD_REQUEST", message: "That photo cannot be used." });
    }
    const { slug: _s, ...rest } = input;
    const p = db
      .insert(schema.proposals)
      .values({ ...rest, eventId: event.id, userId: ctx.user.id, email: ctx.user.email.toLowerCase() })
      .returning()
      .get();
    if (!ctx.user.name) db.update(schema.users).set({ name: input.name }).where(eq(schema.users.id, ctx.user.id)).run();
    const name = event.shortName || event.name;
    const { html, orgName } = brandEmail(event, "We received your proposal", [
      `<p>Hello ${escapeHtml(input.name)},</p>`,
      `<p>Thank you for submitting "${escapeHtml(input.title)}" to ${escapeHtml(event.name)}.</p>`,
      `<p>${s.closesOn ? `Proposals are due ${escapeHtml(fmtDate(s.closesOn))}. ` : ""}We will email you when decisions are made.</p>`,
      emailButton("See your proposals", `${ENV.appUrl}/cfp/${event.slug}`, event.branding),
    ]);
    await sendEmail({
      to: p.email,
      fromName: `${name} Team`,
      subject: `${name}: we received your proposal`,
      text: `Hello ${input.name},\n\nThank you for submitting "${input.title}" to ${event.name}.\n\nWe will email you when decisions are made.\n\n${orgName}`,
      html,
    });
    return { id: p.id };
  }),

  admin: adminRouter,
  review: reviewRouter,
});
