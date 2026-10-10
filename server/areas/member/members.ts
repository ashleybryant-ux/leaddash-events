/**
 * Membership (admin) and the member hub's home, card, events and the public
 * card check. Members act through memberFor; admins through requireOrgAdmin.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { protectedProcedure, publicProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, forbidden, memberFor, notFound, requireOrgAdmin } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { queueContact } from "../../_core/platform";
import { randomToken } from "../../_core/crypto";
import { ENV } from "../../_core/env";
import { fullName } from "@shared/format";
import type { Member } from "../../../drizzle/schema";
import { activeMember, daysFromNow, getOrg, hubMember, isActive, memberCanOpen, memberGroups, memberSettings, nextMemberNumber, normalizeDate, orgBySlug, parseCsv, toCsv, today } from "./shared";
import { appleWalletConfigured, googleWalletConfigured } from "./wallet";

const STATUS = z.enum(["active", "grace", "lapsed", "cancelled"]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const memberInput = z.object({
  email: z.string().email().max(200),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  credentials: z.string().max(80).default(""),
  level: z.string().min(1).max(60).default("Professional"),
  memberNumber: z.string().max(40).default(""),
  memberSince: z.string().max(10).default(""),
  expiresOn: isoDate.nullable().default(null),
  status: STATUS.default("active"),
  autoRenew: z.boolean().default(false),
  photoFileId: z.number().int().nullable().default(null),
});

export const verifyUrl = (orgSlug: string, token: string) => `${ENV.appUrl}/m/${orgSlug}/verify/${token}`;

function memberRow(m: Member) {
  return { ...m, name: fullName(m), photoUrl: fileUrl(m.photoFileId) };
}

function checkPhoto(orgId: number, fileId: number | null) {
  if (!fileId) return;
  const f = getDb().select().from(schema.files).where(eq(schema.files.id, fileId)).get();
  if (!f || f.orgId !== orgId) throw forbidden("That photo belongs to another organization.");
}

/** Adds a member and queues the LeadDash platform contact (tag "member"). */
export function addMember(orgId: number, input: z.infer<typeof memberInput>) {
  const db = getDb();
  const email = input.email.trim().toLowerCase();
  if (db.select().from(schema.members).where(and(eq(schema.members.orgId, orgId), eq(schema.members.email, email))).get()) {
    throw new TRPCError({ code: "CONFLICT", message: `${email} is already a member.` });
  }
  const user = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  const row = db
    .insert(schema.members)
    .values({
      ...input,
      orgId,
      email,
      userId: user?.id ?? null,
      memberNumber: input.memberNumber.trim() || nextMemberNumber(orgId),
      cardToken: randomToken(18),
    })
    .returning()
    .get();
  queueContact(orgId, { email, firstName: row.firstName, lastName: row.lastName, tags: ["member"], source: "LeadDash Events member hub" });
  return row;
}

// ---------- What members see ----------

/** The organization's events with the member's registration for each. */
function eventsFor(orgId: number, email: string) {
  const db = getDb();
  const evs = db.select().from(schema.events).where(and(eq(schema.events.orgId, orgId), ne(schema.events.status, "draft"))).orderBy(schema.events.startDate).all();
  const upcoming = evs.filter((e) => e.endDate >= today());
  const ids = upcoming.map((e) => e.id);
  const regs = ids.length
    ? db
        .select()
        .from(schema.attendees)
        .where(and(inArray(schema.attendees.eventId, ids), eq(schema.attendees.email, email.toLowerCase()), ne(schema.attendees.status, "cancelled")))
        .all()
    : [];
  const sessions = ids.length ? db.select({ eventId: schema.sessions.eventId, ceHours: schema.sessions.ceHours }).from(schema.sessions).where(inArray(schema.sessions.eventId, ids)).all() : [];
  return upcoming.map((e) => ({
    id: e.id,
    slug: e.slug,
    name: e.name,
    startDate: e.startDate,
    endDate: e.endDate,
    city: e.city,
    venueName: e.venueName,
    ceHours: Math.round(sessions.filter((s) => s.eventId === e.id).reduce((a, s) => a + s.ceHours, 0) * 100) / 100,
    registered: regs.some((r) => r.eventId === e.id),
  }));
}

/** CE hours this cycle (the last 2 years): certificates from the organization's events plus CE entries. */
export function ceHoursThisCycle(orgId: number, email: string) {
  const db = getDb();
  const since = new Date(Date.now() - 730 * 86400_000);
  const sinceIso = since.toISOString().slice(0, 10);
  const certs = db
    .select({ hours: schema.certificates.hours })
    .from(schema.certificates)
    .innerJoin(schema.attendees, eq(schema.attendees.id, schema.certificates.attendeeId))
    .innerJoin(schema.events, eq(schema.events.id, schema.certificates.eventId))
    .where(and(eq(schema.events.orgId, orgId), eq(schema.attendees.email, email.toLowerCase()), isNull(schema.certificates.revokedAt), gte(schema.certificates.createdAt, since)))
    .all();
  const entries = db
    .select({ hours: schema.ceEntries.hours, date: schema.ceEntries.date })
    .from(schema.ceEntries)
    .where(and(eq(schema.ceEntries.orgId, orgId), eq(schema.ceEntries.email, email.toLowerCase())))
    .all()
    .filter((e) => e.date >= sinceIso);
  const total = certs.reduce((a, c) => a + c.hours, 0) + entries.reduce((a, e) => a + e.hours, 0);
  return Math.round(total * 100) / 100;
}

/** CE sessions the member checked in to with no evaluation yet. */
function evaluationsDue(orgId: number, email: string) {
  const db = getDb();
  const rows = db
    .select({ sessionId: schema.sessions.id, title: schema.sessions.title, attendeeId: schema.attendees.id, slug: schema.events.slug, eventName: schema.events.name })
    .from(schema.sessionCheckins)
    .innerJoin(schema.attendees, eq(schema.attendees.id, schema.sessionCheckins.attendeeId))
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionCheckins.sessionId))
    .innerJoin(schema.events, eq(schema.events.id, schema.sessions.eventId))
    .where(and(eq(schema.events.orgId, orgId), eq(schema.attendees.email, email.toLowerCase())))
    .all();
  return rows.filter((r) => {
    const s = db.select({ ce: schema.sessions.ceHours }).from(schema.sessions).where(eq(schema.sessions.id, r.sessionId)).get();
    if (!s || s.ce <= 0) return false;
    const done = db
      .select({ id: schema.evaluationResponses.id })
      .from(schema.evaluationResponses)
      .where(and(eq(schema.evaluationResponses.sessionId, r.sessionId), eq(schema.evaluationResponses.attendeeId, r.attendeeId)))
      .get();
    return !done;
  }).map((r) => ({ sessionId: r.sessionId, title: r.title, eventName: r.eventName, url: `/e/${r.slug}/eval/${r.sessionId}` }));
}

const FOURTEEN_DAYS = 14 * 86400_000;

/** Documents in folders the member can open that changed in the last 14 days. */
export function newDocumentCount(member: Member) {
  const db = getDb();
  const groups = memberGroups(member.id);
  const folders = db.select().from(schema.docFolders).where(eq(schema.docFolders.orgId, member.orgId)).all().filter((f) => memberCanOpen(member, f, groups));
  if (!folders.length) return 0;
  const since = Date.now() - FOURTEEN_DAYS;
  return db
    .select()
    .from(schema.documents)
    .where(inArray(schema.documents.folderId, folders.map((f) => f.id)))
    .all()
    .filter((d) => (d.updatedAt ?? d.createdAt).getTime() >= since).length;
}

function groupsSummary(member: Member) {
  const db = getDb();
  const mine = memberGroups(member.id);
  if (!mine.length) return [];
  const groups = db.select().from(schema.groups).where(inArray(schema.groups.id, mine.map((g) => g.groupId))).all();
  const since = new Date(Date.now() - FOURTEEN_DAYS);
  return groups.map((g) => {
    const folder = g.hasFolder ? db.select().from(schema.docFolders).where(eq(schema.docFolders.groupId, g.id)).get() : undefined;
    const newFiles = folder
      ? db.select().from(schema.documents).where(eq(schema.documents.folderId, folder.id)).all().filter((d) => (d.updatedAt ?? d.createdAt).getTime() >= since.getTime()).length
      : 0;
    const newPosts = g.hasChannel ? db.select({ id: schema.groupPosts.id }).from(schema.groupPosts).where(and(eq(schema.groupPosts.groupId, g.id), gte(schema.groupPosts.createdAt, since))).all().length : 0;
    return { id: g.id, name: g.name, kind: g.kind, role: mine.find((m) => m.groupId === g.id)!.role, nextMeeting: g.nextMeeting, newFiles, newPosts };
  });
}

function cardInfo(member: Member, org: { name: string; slug: string; logoFileId: number | null }) {
  return {
    name: fullName(member),
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    level: member.level,
    memberNumber: member.memberNumber,
    memberSince: member.memberSince,
    expiresOn: member.expiresOn,
    status: member.status,
    autoRenew: member.autoRenew,
    photoUrl: fileUrl(member.photoFileId),
    orgName: org.name,
    logoUrl: fileUrl(org.logoFileId),
    verifyUrl: verifyUrl(org.slug, member.cardToken),
  };
}

export const hubRouter = router({
  /** Who the signed-in person is in this organization (null when they are not a member). */
  me: protectedProcedure.input(z.object({ orgSlug: z.string().max(120) })).query(({ ctx, input }) => {
    const org = orgBySlug(input.orgSlug);
    const m = memberFor(ctx.user, org.id);
    if (!m) return null;
    return { id: m.id, firstName: m.firstName, status: m.status, active: isActive(m) };
  }),

  /** Member home: the one member dashboard. */
  home: protectedProcedure.input(z.object({ orgSlug: z.string().max(120) })).query(({ ctx, input }) => {
    const { org, member } = hubMember(ctx.user, input.orgSlug);
    const card = cardInfo(member, org);
    const settings = memberSettings(org.id);
    if (!isActive(member)) {
      return { active: false as const, card, renewUrl: settings.renewUrl, ceHours: 0, groups: [], events: [], evaluationsDue: [], newDocuments: 0 };
    }
    return {
      active: true as const,
      card,
      renewUrl: settings.renewUrl,
      ceHours: ceHoursThisCycle(org.id, member.email),
      groups: groupsSummary(member),
      events: eventsFor(org.id, member.email),
      evaluationsDue: evaluationsDue(org.id, member.email),
      newDocuments: newDocumentCount(member),
    };
  }),

  /** The digital membership card. Lapsed members see it marked lapsed with a renew prompt. */
  card: protectedProcedure.input(z.object({ orgSlug: z.string().max(120) })).query(({ ctx, input }) => {
    const { org, member } = hubMember(ctx.user, input.orgSlug);
    const settings = memberSettings(org.id);
    return {
      ...cardInfo(member, org),
      renewUrl: settings.renewUrl,
      wallet: { apple: appleWalletConfigured(), google: googleWalletConfigured() },
      orgAddressName: org.name,
    };
  }),

  /** Upcoming organization events, with Register or Open the app. */
  events: protectedProcedure.input(z.object({ orgSlug: z.string().max(120) })).query(({ ctx, input }) => {
    const { org, member } = hubMember(ctx.user, input.orgSlug);
    return eventsFor(org.id, member.email);
  }),

  /** Public card check (the QR code): name, level, status and expiry only. */
  verify: publicProcedure.input(z.object({ orgSlug: z.string().max(120), token: z.string().min(8).max(80) })).query(({ input }) => {
    const org = orgBySlug(input.orgSlug);
    const m = getDb()
      .select()
      .from(schema.members)
      .where(and(eq(schema.members.orgId, org.id), eq(schema.members.cardToken, input.token)))
      .get();
    if (!m) return { found: false as const, orgName: org.name };
    const expired = !!m.expiresOn && m.expiresOn < today() && m.status === "active";
    return { found: true as const, orgName: org.name, name: fullName(m), level: m.level, status: expired ? ("lapsed" as const) : m.status, expiresOn: m.expiresOn, valid: isActive(m) && !expired };
  }),
});

// ---------- Admin: Membership ----------

const IMPORT_COLUMNS = ["email", "first", "last", "credentials", "level", "member_number", "member_since", "expires_on", "status"];

export const membersAdminRouter = router({
  list: protectedProcedure
    .input(z.object({ orgId: z.number(), search: z.string().max(120).default(""), status: z.enum(["all", "active", "grace", "lapsed", "cancelled", "expiring"]).default("all") }))
    .query(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      const db = getDb();
      let rows = db.select().from(schema.members).where(eq(schema.members.orgId, input.orgId)).orderBy(schema.members.lastName, schema.members.firstName).all();
      const all = rows;
      const soon = daysFromNow(90);
      if (input.status === "expiring") rows = rows.filter((m) => isActive(m) && !!m.expiresOn && m.expiresOn <= soon);
      else if (input.status !== "all") rows = rows.filter((m) => m.status === input.status);
      const q = input.search.trim().toLowerCase();
      if (q) rows = rows.filter((m) => `${m.firstName} ${m.lastName} ${m.email} ${m.memberNumber} ${m.level}`.toLowerCase().includes(q));
      const counts = {
        all: all.length,
        active: all.filter((m) => m.status === "active").length,
        grace: all.filter((m) => m.status === "grace").length,
        lapsed: all.filter((m) => m.status === "lapsed").length,
        cancelled: all.filter((m) => m.status === "cancelled").length,
        expiring: all.filter((m) => isActive(m) && !!m.expiresOn && m.expiresOn <= soon).length,
      };
      const levels = Array.from(new Set(all.map((m) => m.level))).sort();
      return { members: rows.slice(0, 500).map(memberRow), total: rows.length, counts, levels };
    }),

  create: protectedProcedure.input(memberInput.extend({ orgId: z.number() })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const { orgId, ...rest } = input;
    checkPhoto(orgId, rest.photoFileId);
    const row = addMember(orgId, rest);
    audit(ctx.user, { orgId, action: "member.create", detail: row.email });
    return memberRow(row);
  }),

  update: protectedProcedure.input(memberInput.extend({ orgId: z.number(), memberId: z.number() })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const db = getDb();
    const m = db.select().from(schema.members).where(eq(schema.members.id, input.memberId)).get();
    if (!m || m.orgId !== input.orgId) throw notFound("That member");
    const { orgId, memberId, ...rest } = input;
    checkPhoto(orgId, rest.photoFileId);
    const email = rest.email.trim().toLowerCase();
    if (email !== m.email && db.select().from(schema.members).where(and(eq(schema.members.orgId, orgId), eq(schema.members.email, email))).get()) {
      throw new TRPCError({ code: "CONFLICT", message: `${email} is already a member.` });
    }
    db.update(schema.members)
      .set({ ...rest, email, memberNumber: rest.memberNumber.trim() || m.memberNumber, userId: email === m.email ? m.userId : null })
      .where(eq(schema.members.id, memberId))
      .run();
    audit(ctx.user, { orgId, action: "member.update", detail: email });
    return { ok: true };
  }),

  remove: protectedProcedure.input(z.object({ orgId: z.number(), memberId: z.number() })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const m = getDb().select().from(schema.members).where(eq(schema.members.id, input.memberId)).get();
    if (!m || m.orgId !== input.orgId) throw notFound("That member");
    getDb().delete(schema.members).where(eq(schema.members.id, m.id)).run();
    audit(ctx.user, { orgId: input.orgId, action: "member.remove", detail: m.email });
    return { ok: true };
  }),

  /** CSV columns: email, first, last, credentials, level, member number, member since, expires on, status. Existing emails are updated. */
  importCsv: protectedProcedure.input(z.object({ orgId: z.number(), csv: z.string().max(5_000_000) })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const db = getDb();
    const rows = parseCsv(input.csv);
    let added = 0;
    let updated = 0;
    const errors: string[] = [];
    rows.forEach((r, i) => {
      const line = i + 2;
      const email = (r.email || "").toLowerCase();
      const first = r.first || r.first_name || r.firstname || "";
      const last = r.last || r.last_name || r.lastname || "";
      if (!z.string().email().safeParse(email).success) return void errors.push(`Row ${line}: the email is missing or not valid.`);
      if (!first || !last) return void errors.push(`Row ${line}: first and last name are needed.`);
      const statusRaw = (r.status || "active").toLowerCase();
      const status = STATUS.safeParse(statusRaw).success ? (statusRaw as z.infer<typeof STATUS>) : null;
      if (!status) return void errors.push(`Row ${line}: status must be active, grace, lapsed or cancelled.`);
      const expiresRaw = r.expires_on || r.expires || "";
      const expiresOn = normalizeDate(expiresRaw);
      if (expiresRaw && !expiresOn) return void errors.push(`Row ${line}: expires on must look like 12/31/2027.`);
      const values = {
        email,
        firstName: first.slice(0, 80),
        lastName: last.slice(0, 80),
        credentials: (r.credentials || "").slice(0, 80),
        level: (r.level || "Professional").slice(0, 60),
        memberNumber: (r.member_number || r.member_no || "").slice(0, 40),
        memberSince: (r.member_since || r.since || "").slice(0, 10),
        expiresOn,
        status,
        autoRenew: false,
        photoFileId: null,
      };
      const existing = db.select().from(schema.members).where(and(eq(schema.members.orgId, input.orgId), eq(schema.members.email, email))).get();
      if (existing) {
        db.update(schema.members)
          .set({ firstName: values.firstName, lastName: values.lastName, credentials: values.credentials || existing.credentials, level: values.level, memberNumber: values.memberNumber || existing.memberNumber, memberSince: values.memberSince || existing.memberSince, expiresOn: values.expiresOn ?? existing.expiresOn, status })
          .where(eq(schema.members.id, existing.id))
          .run();
        updated++;
      } else {
        addMember(input.orgId, values);
        added++;
      }
    });
    audit(ctx.user, { orgId: input.orgId, action: "member.import", detail: `${added} added, ${updated} updated` });
    return { added, updated, errors: errors.slice(0, 50), columns: IMPORT_COLUMNS };
  }),

  exportCsv: protectedProcedure.input(z.object({ orgId: z.number() })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const rows = getDb().select().from(schema.members).where(eq(schema.members.orgId, input.orgId)).orderBy(schema.members.lastName).all();
    return {
      filename: `members-${today()}.csv`,
      csv: toCsv(
        ["email", "first", "last", "credentials", "level", "member number", "member since", "expires on", "status", "auto renew"],
        rows.map((m) => [m.email, m.firstName, m.lastName, m.credentials, m.level, m.memberNumber, m.memberSince, m.expiresOn ?? "", m.status, m.autoRenew ? "yes" : "no"])
      ),
    };
  }),

  /** Member hub settings: member number prefix and the renewal link. */
  settings: protectedProcedure.input(z.object({ orgId: z.number() })).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const s = memberSettings(input.orgId);
    const org = getOrg(input.orgId);
    return { numberPrefix: s.numberPrefix, renewUrl: s.renewUrl, nextNumber: nextMemberNumber(input.orgId), hubUrl: `${ENV.appUrl}/m/${org.slug}` };
  }),

  saveSettings: protectedProcedure
    .input(z.object({ orgId: z.number(), numberPrefix: z.string().max(8).regex(/^[A-Za-z0-9]*$/), renewUrl: z.union([z.literal(""), z.string().url().max(500)]) }))
    .mutation(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      const values = { orgId: input.orgId, numberPrefix: input.numberPrefix.toUpperCase(), renewUrl: input.renewUrl, updatedAt: new Date() };
      getDb().insert(schema.memberSettings).values(values).onConflictDoUpdate({ target: schema.memberSettings.orgId, set: values }).run();
      return { ok: true };
    }),

  /** Recent sign-ins and changes, for the member row. */
  activity: protectedProcedure.input(z.object({ orgId: z.number(), memberId: z.number() })).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const db = getDb();
    const m = db.select().from(schema.members).where(eq(schema.members.id, input.memberId)).get();
    if (!m || m.orgId !== input.orgId) throw notFound("That member");
    const groups = db
      .select({ name: schema.groups.name, role: schema.groupMembers.role })
      .from(schema.groupMembers)
      .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
      .where(eq(schema.groupMembers.memberId, m.id))
      .all();
    const events = db
      .select({ name: schema.events.name, startDate: schema.events.startDate })
      .from(schema.attendees)
      .innerJoin(schema.events, eq(schema.events.id, schema.attendees.eventId))
      .where(and(eq(schema.events.orgId, input.orgId), eq(schema.attendees.email, m.email), ne(schema.attendees.status, "cancelled")))
      .orderBy(desc(schema.events.startDate))
      .limit(10)
      .all();
    return { groups, events, ceHours: ceHoursThisCycle(input.orgId, m.email) };
  }),
});


