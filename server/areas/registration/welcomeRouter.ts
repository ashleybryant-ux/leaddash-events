/**
 * Welcome emails page: the Speakers, Sponsors and Exhibitors tabs (the
 * Attendees tab uses the templates router in index.ts). Speakers need the
 * "speakers" area; sponsors and exhibitors need "vendors"; changes need edit.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, eventAccess, notFound, requireArea } from "../../_core/access";
import { sendEmail } from "../../_core/email";
import { MESSAGE_KINDS, type MessageKind, type User } from "../../../drizzle/schema";
import { KIND_LABELS } from "./messages";
import { GROUP_FIELDS, INCLUDE_OPTIONS, SEND_CHOICES, groupOfKind, type RecipientGroup } from "./recipientDefaults";
import { GROUP_FOLLOW_UPS, GROUP_WELCOME, followUpRuleLabel, includesLabel, previewCtx, recipientTemplate, renderRecipientEmail, sendWelcomeToNew, welcomeRuleLabel, welcomeSummary } from "./recipientMessages";

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const GROUPS = ["speakers", "sponsors", "exhibitors"] as const;
const groupIn = z.object({ eventId: z.number().int().positive(), group: z.enum(GROUPS) });
const areaOf = (g: RecipientGroup) => (g === "speakers" ? "speakers" : "vendors") as "speakers" | "vendors";

function requireGroup(user: User, eventId: number, group: RecipientGroup, level: "view" | "edit" = "view") {
  return requireArea(user, eventId, areaOf(group), level);
}

const draftIn = z.object({
  eventId: z.number().int().positive(),
  kind: z.enum(MESSAGE_KINDS),
  enabled: z.boolean(),
  sendRule: z.string().max(40),
  fromName: z.string().trim().max(80),
  replyTo: z.string().trim().email().max(200).or(z.literal("")),
  subject: z.string().max(200),
  body: z.string().max(5000),
  includes: z.record(z.string().max(40), z.union([z.boolean(), z.string().max(40)])),
  /** Logo and ad reminder: the due date the organization sets. */
  logoDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).optional(),
});
type DraftIn = z.infer<typeof draftIn>;

/** Checks the kind, rule and includes for a group and returns the cleaned values to store. */
function cleanDraft(input: DraftIn) {
  const group = groupOfKind(input.kind);
  if (!group) throw notFound("That message");
  const isWelcome = GROUP_WELCOME[group] === input.kind;
  if (isWelcome) {
    if (!SEND_CHOICES[group].some((c) => c.value === input.sendRule)) throw bad("Pick when to send it.");
  } else if (input.kind === "exhibitor_booth_assigned") {
    if (input.sendRule !== "on_booth") throw bad("Pick when to send it.");
  } else {
    const m = input.sendRule.match(/^days_(before|after):(\d{1,3})$/);
    const want = input.kind === "speaker_thanks" ? "after" : "before";
    if (!m || m[1] !== want || Number(m[2]) < 1 || Number(m[2]) > 120) throw bad("Enter the number of days (1 to 120).");
  }
  if (!input.subject.trim()) throw bad("Add a subject.");
  if (!input.body.trim()) throw bad("Write the message.");
  return { group, isWelcome };
}

function view(t: typeof schema.messageTemplates.$inferSelect, group: RecipientGroup) {
  return {
    id: t.id,
    kind: t.kind,
    label: KIND_LABELS[t.kind],
    enabled: t.enabled,
    sendRule: t.sendRule,
    ruleLabel: GROUP_WELCOME[group] === t.kind ? welcomeRuleLabel(group, t.sendRule) : followUpRuleLabel(t),
    fromName: t.fromName,
    replyTo: t.replyTo,
    subject: t.subject,
    body: t.body,
    includes: t.includes,
    includesLabel: includesLabel(group, t.includes),
    logoDueOn: typeof t.includes.logoDueOn === "string" ? t.includes.logoDueOn : "",
    updatedAt: t.updatedAt,
  };
}

export const welcomeRouter = router({
  /** Tab counts for the groups this person can see. */
  counts: protectedProcedure.input(z.object({ eventId: z.number().int().positive() })).query(({ ctx, input }) => {
    const access = eventAccess(ctx.user, input.eventId);
    const out: { group: RecipientGroup; count: number }[] = [];
    for (const g of GROUPS) {
      if (access.areas[areaOf(g)] === "none") continue;
      out.push({ group: g, count: welcomeSummary(input.eventId, g).total });
    }
    return out;
  }),

  /** The welcome email, its follow-ups, the counts, and the editor's choices. */
  get: protectedProcedure.input(groupIn).query(({ ctx, input }) => {
    const { access } = requireGroup(ctx.user, input.eventId, input.group);
    const welcome = recipientTemplate(input.eventId, GROUP_WELCOME[input.group]);
    if (!welcome) throw notFound("That welcome email");
    const followUps = GROUP_FOLLOW_UPS[input.group].map((k) => recipientTemplate(input.eventId, k)).filter((t): t is NonNullable<typeof t> => !!t);
    const s = welcomeSummary(input.eventId, input.group);
    return {
      welcome: view(welcome, input.group),
      followUps: followUps.map((t) => view(t, input.group)),
      summary: { total: s.total, sent: s.sent, ready: s.ready, sentLabel: s.sentLabel },
      choices: SEND_CHOICES[input.group],
      fields: GROUP_FIELDS[input.group],
      includeOptions: INCLUDE_OPTIONS[input.group],
      canEdit: access.areas[areaOf(input.group)] === "edit",
    };
  }),

  save: protectedProcedure.input(draftIn).mutation(({ ctx, input }) => {
    const { group, isWelcome } = cleanDraft(input);
    const { event } = requireGroup(ctx.user, input.eventId, group, "edit");
    const t = recipientTemplate(input.eventId, input.kind);
    if (!t) throw notFound("That message");
    const allowed = new Set(INCLUDE_OPTIONS[group].map((o) => o.key));
    const includes = { ...t.includes };
    if (isWelcome) for (const k of allowed) includes[k] = input.includes[k] === true;
    else includes.getApp = input.includes.getApp === undefined ? t.includes.getApp : input.includes.getApp === true;
    if (input.kind === "sponsor_logo_reminder") includes.logoDueOn = input.logoDueOn ?? "";
    getDb()
      .update(schema.messageTemplates)
      .set({
        enabled: input.enabled,
        sendRule: input.sendRule,
        subject: input.subject,
        body: input.body,
        includes,
        ...(isWelcome ? { fromName: input.fromName, replyTo: input.replyTo } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.messageTemplates.id, t.id))
      .run();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "message.update", detail: input.kind });
    return { ok: true };
  }),

  /** The email as the first real person in the group (or a sample) would get it. */
  preview: protectedProcedure.input(draftIn.partial({ enabled: true, sendRule: true })).query(async ({ ctx, input }) => {
    const group = groupOfKind(input.kind as MessageKind);
    if (!group) throw notFound("That message");
    const { event } = requireGroup(ctx.user, input.eventId, group);
    const t = recipientTemplate(input.eventId, input.kind);
    if (!t) throw notFound("That message");
    const includes = { ...t.includes, ...input.includes, ...(input.kind === "sponsor_logo_reminder" ? { logoDueOn: input.logoDueOn ?? "" } : {}) };
    const c = await previewCtx(event, group, input.replyTo || t.replyTo);
    const m = await renderRecipientEmail({ kind: t.kind, subject: input.subject, body: input.body, sendRule: input.sendRule ?? t.sendRule, includes }, c, { preview: true });
    return m;
  }),

  /** Sends the draft to the signed-in person, filled in for the first real person in the group (or a sample). */
  sendTest: protectedProcedure.input(draftIn).mutation(async ({ ctx, input }) => {
    const { group } = cleanDraft(input);
    const { event } = requireGroup(ctx.user, input.eventId, group, "edit");
    const t = recipientTemplate(input.eventId, input.kind);
    if (!t) throw notFound("That message");
    const includes = { ...t.includes, ...input.includes, ...(input.kind === "sponsor_logo_reminder" ? { logoDueOn: input.logoDueOn ?? "" } : {}) };
    const c = await previewCtx(event, group, input.replyTo || t.replyTo);
    const m = await renderRecipientEmail({ kind: t.kind, subject: input.subject, body: input.body, sendRule: input.sendRule, includes }, c);
    await sendEmail({ to: ctx.user.email, subject: `Test: ${m.subject}`, text: m.text, html: m.html, fromName: (input.fromName || t.fromName) || undefined, replyTo: (input.replyTo || t.replyTo) || undefined });
    return { to: ctx.user.email };
  }),

  /** Send to new: the welcome email to everyone in the group who qualifies and has not gotten it. */
  sendToNew: protectedProcedure.input(groupIn).mutation(async ({ ctx, input }) => {
    const { event } = requireGroup(ctx.user, input.eventId, input.group, "edit");
    const t = recipientTemplate(input.eventId, GROUP_WELCOME[input.group]);
    if (!t) throw notFound("That welcome email");
    if (!t.enabled) throw bad("Turn the welcome email on first.");
    const sent = await sendWelcomeToNew(input.eventId, input.group);
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "welcome.send_to_new", detail: `${input.group}: ${sent}` });
    return { sent };
  }),
});
