/**
 * Divisions, committees and task forces. Admins set them up; members join
 * open groups; chairs email the group and add members when the group allows.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, forbidden, notFound, requireOrgAdmin } from "../../_core/access";
import { emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { ENV } from "../../_core/env";
import { fullName } from "@shared/format";
import type { Group, Member } from "../../../drizzle/schema";
import { activeMember, getOrg, isActive, memberGroups, today } from "./shared";
import { folderDocs } from "./docs";

const KIND = z.enum(["division", "committee", "task_force"]);
const ROLE = z.enum(["member", "co_chair", "chair"]);
const JOIN = z.enum(["open", "appointment", "level"]);

export const kindLabel = (k: string) => (k === "task_force" ? "Task force" : k === "division" ? "Division" : "Committee");
export const joinLabel = (g: Pick<Group, "joinRule" | "joinLevel">) =>
  g.joinRule === "open" ? "Any member, opt in" : g.joinRule === "level" ? (g.joinLevel ? `${g.joinLevel} members` : "Member level only") : "By appointment";
const isChair = (role: string | undefined) => role === "chair" || role === "co_chair";

function getGroup(groupId: number) {
  const g = getDb().select().from(schema.groups).where(eq(schema.groups.id, groupId)).get();
  if (!g) throw notFound("That group");
  return g;
}

function groupRoster(groupId: number) {
  return getDb()
    .select({ memberId: schema.members.id, firstName: schema.members.firstName, lastName: schema.members.lastName, credentials: schema.members.credentials, email: schema.members.email, status: schema.members.status, userId: schema.members.userId, role: schema.groupMembers.role })
    .from(schema.groupMembers)
    .innerJoin(schema.members, eq(schema.members.id, schema.groupMembers.memberId))
    .where(eq(schema.groupMembers.groupId, groupId))
    .orderBy(schema.members.lastName)
    .all()
    .map((r) => ({ ...r, name: fullName(r) }));
}

/** A group with a folder gets its own document folder, open to the group. */
function ensureGroupFolder(g: Group) {
  const db = getDb();
  const folder = db.select().from(schema.docFolders).where(eq(schema.docFolders.groupId, g.id)).get();
  if (g.hasFolder && !folder) {
    db.insert(schema.docFolders).values({ orgId: g.orgId, name: g.name, groupId: g.id, access: { type: "group", groupId: g.id }, sort: 100 }).run();
  } else if (folder && folder.name !== g.name) {
    db.update(schema.docFolders).set({ name: g.name }).where(eq(schema.docFolders.id, folder.id)).run();
  }
}

/** Whether a member may join a group on their own. */
export const canJoin = (g: Group, m: Member) => isActive(m) && (g.joinRule === "open" || (g.joinRule === "level" && !!g.joinLevel && g.joinLevel.toLowerCase() === m.level.toLowerCase()));

const groupInput = z.object({
  name: z.string().min(2).max(120),
  kind: KIND,
  description: z.string().max(2000).default(""),
  joinRule: JOIN,
  joinLevel: z.string().max(60).default(""),
  termEndsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  hasChannel: z.boolean(),
  hasFolder: z.boolean(),
  chairCanEmail: z.boolean(),
  chairCanAdd: z.boolean(),
  nextMeeting: z.string().max(120).default(""),
  isBoard: z.boolean().default(false),
  /** The whole roster with roles; members not listed are removed. */
  members: z.array(z.object({ memberId: z.number(), role: ROLE })).max(5000).optional(),
});

function saveRoster(orgId: number, groupId: number, roster: { memberId: number; role: z.infer<typeof ROLE> }[]) {
  const db = getDb();
  const ids = roster.map((r) => r.memberId);
  if (ids.length) {
    const found = db.select({ id: schema.members.id }).from(schema.members).where(and(eq(schema.members.orgId, orgId), inArray(schema.members.id, ids))).all();
    if (found.length !== new Set(ids).size) throw forbidden("Someone on that list is not a member of this association.");
  }
  const current = db.select().from(schema.groupMembers).where(eq(schema.groupMembers.groupId, groupId)).all();
  for (const c of current) if (!ids.includes(c.memberId)) db.delete(schema.groupMembers).where(eq(schema.groupMembers.id, c.id)).run();
  for (const r of roster) {
    db.insert(schema.groupMembers)
      .values({ groupId, memberId: r.memberId, role: r.role })
      .onConflictDoUpdate({ target: [schema.groupMembers.groupId, schema.groupMembers.memberId], set: { role: r.role } })
      .run();
  }
}

export const groupsAdminRouter = router({
  list: protectedProcedure.input(z.object({ orgId: z.number(), search: z.string().max(120).default(""), kind: z.enum(["all", "division", "committee", "task_force"]).default("all") })).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const db = getDb();
    const all = db.select().from(schema.groups).where(eq(schema.groups.orgId, input.orgId)).orderBy(schema.groups.name).all();
    const roster = all.length
      ? db
          .select({ groupId: schema.groupMembers.groupId, memberId: schema.groupMembers.memberId, role: schema.groupMembers.role, firstName: schema.members.firstName, lastName: schema.members.lastName, credentials: schema.members.credentials })
          .from(schema.groupMembers)
          .innerJoin(schema.members, eq(schema.members.id, schema.groupMembers.memberId))
          .where(inArray(schema.groupMembers.groupId, all.map((g) => g.id)))
          .all()
      : [];
    const year = today().slice(0, 4);
    const kpis = {
      divisions: all.filter((g) => g.kind === "division").length,
      committees: all.filter((g) => g.kind !== "division").length,
      membersInAny: new Set(roster.map((r) => r.memberId)).size,
      termsEnding: all.filter((g) => g.termEndsOn && g.termEndsOn.slice(0, 4) === year).length,
    };
    const q = input.search.trim().toLowerCase();
    const rows = all
      .filter((g) => input.kind === "all" || g.kind === input.kind)
      .filter((g) => !q || g.name.toLowerCase().includes(q))
      .map((g) => {
        const people = roster.filter((r) => r.groupId === g.id);
        const chair = people.find((p) => p.role === "chair") ?? people.find((p) => p.role === "co_chair");
        return { ...g, kindLabel: kindLabel(g.kind), joinLabel: joinLabel(g), chairName: chair ? fullName(chair) : "", memberCount: people.length };
      });
    return { groups: rows, kpis };
  }),

  get: protectedProcedure.input(z.object({ orgId: z.number(), groupId: z.number() })).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const g = getGroup(input.groupId);
    if (g.orgId !== input.orgId) throw notFound("That group");
    return { group: g, members: groupRoster(g.id) };
  }),

  save: protectedProcedure.input(groupInput.extend({ orgId: z.number(), groupId: z.number().optional() })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const db = getDb();
    const { orgId, groupId, members, ...fields } = input;
    if (fields.joinRule === "level" && !fields.joinLevel.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the member level that may join." });
    let g: Group;
    if (groupId) {
      const existing = getGroup(groupId);
      if (existing.orgId !== orgId) throw notFound("That group");
      g = db.update(schema.groups).set(fields).where(eq(schema.groups.id, groupId)).returning().get();
    } else {
      g = db.insert(schema.groups).values({ ...fields, orgId }).returning().get();
    }
    if (members) saveRoster(orgId, g.id, members);
    ensureGroupFolder(g);
    audit(ctx.user, { orgId, action: groupId ? "group.update" : "group.create", detail: g.name });
    return g;
  }),

  remove: protectedProcedure.input(z.object({ orgId: z.number(), groupId: z.number() })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const g = getGroup(input.groupId);
    if (g.orgId !== input.orgId) throw notFound("That group");
    getDb().delete(schema.groups).where(eq(schema.groups.id, g.id)).run();
    audit(ctx.user, { orgId: input.orgId, action: "group.remove", detail: g.name });
    return { ok: true };
  }),

  /** Members to pick from when adding to a group (name, email or member number). */
  findMembers: protectedProcedure.input(z.object({ orgId: z.number(), q: z.string().min(1).max(120) })).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const q = input.q.trim().toLowerCase();
    return getDb()
      .select()
      .from(schema.members)
      .where(eq(schema.members.orgId, input.orgId))
      .all()
      .filter((m) => `${m.firstName} ${m.lastName} ${m.email} ${m.memberNumber}`.toLowerCase().includes(q))
      .slice(0, 8)
      .map((m) => ({ memberId: m.id, name: fullName(m), email: m.email, status: m.status }));
  }),
});

const slugInput = z.object({ orgSlug: z.string().max(120) });

function myRole(groupId: number, memberId: number) {
  return getDb()
    .select()
    .from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.memberId, memberId)))
    .get()?.role;
}

function memberGroup(orgId: number, groupId: number) {
  const g = getGroup(groupId);
  if (g.orgId !== orgId) throw notFound("That group");
  return g;
}

export const groupsHubRouter = router({
  /** The member's groups and the groups they may join. */
  mine: protectedProcedure.input(slugInput).query(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const mine = memberGroups(member.id);
    const groups = getDb().select().from(schema.groups).where(eq(schema.groups.orgId, org.id)).orderBy(schema.groups.name).all();
    return {
      joined: groups.filter((g) => mine.some((m) => m.groupId === g.id)).map((g) => ({ id: g.id, name: g.name, kindLabel: kindLabel(g.kind), role: mine.find((m) => m.groupId === g.id)!.role, nextMeeting: g.nextMeeting })),
      canJoin: groups.filter((g) => !mine.some((m) => m.groupId === g.id) && canJoin(g, member)).map((g) => ({ id: g.id, name: g.name, kindLabel: kindLabel(g.kind), description: g.description })),
    };
  }),

  join: protectedProcedure.input(slugInput.extend({ groupId: z.number() })).mutation(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const g = memberGroup(org.id, input.groupId);
    if (!canJoin(g, member)) throw forbidden(g.joinRule === "appointment" ? "Members join this group by appointment." : "This group is for another member level.");
    getDb().insert(schema.groupMembers).values({ groupId: g.id, memberId: member.id, role: "member" }).onConflictDoNothing().run();
    return { ok: true };
  }),

  leave: protectedProcedure.input(slugInput.extend({ groupId: z.number() })).mutation(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const g = memberGroup(org.id, input.groupId);
    getDb().delete(schema.groupMembers).where(and(eq(schema.groupMembers.groupId, g.id), eq(schema.groupMembers.memberId, member.id))).run();
    return { ok: true };
  }),

  /** A group's page: who is in it, its discussion and its folder. Only the group's members see those. */
  page: protectedProcedure.input(slugInput.extend({ groupId: z.number() })).query(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const g = memberGroup(org.id, input.groupId);
    const role = myRole(g.id, member.id);
    const base = { id: g.id, name: g.name, kindLabel: kindLabel(g.kind), description: g.description, nextMeeting: g.nextMeeting, termEndsOn: g.termEndsOn, joinLabel: joinLabel(g), hasChannel: g.hasChannel, hasFolder: g.hasFolder };
    if (!role) {
      if (!canJoin(g, member)) throw forbidden("This group is open to its members only.");
      return { ...base, joined: false as const, canJoin: true, role: null, members: [], posts: [], folder: null, canEmail: false, canAdd: false };
    }
    const db = getDb();
    const roster = groupRoster(g.id);
    const posts = g.hasChannel
      ? db
          .select({ id: schema.groupPosts.id, body: schema.groupPosts.body, createdAt: schema.groupPosts.createdAt, memberId: schema.groupPosts.memberId, firstName: schema.members.firstName, lastName: schema.members.lastName, credentials: schema.members.credentials })
          .from(schema.groupPosts)
          .leftJoin(schema.members, eq(schema.members.id, schema.groupPosts.memberId))
          .where(eq(schema.groupPosts.groupId, g.id))
          .orderBy(desc(schema.groupPosts.id))
          .limit(100)
          .all()
          .map((p) => ({ id: p.id, body: p.body, createdAt: p.createdAt, mine: p.memberId === member.id, author: p.firstName ? fullName({ firstName: p.firstName, lastName: p.lastName ?? "", credentials: p.credentials }) : "Former member" }))
      : [];
    const folder = g.hasFolder ? db.select().from(schema.docFolders).where(eq(schema.docFolders.groupId, g.id)).get() : undefined;
    return {
      ...base,
      joined: true as const,
      canJoin: false,
      role,
      members: roster.map((r) => ({ memberId: r.memberId, name: r.name, role: r.role })),
      posts,
      folder: folder ? { id: folder.id, name: folder.name, documents: folderDocs(folder.id) } : null,
      canEmail: isChair(role) && g.chairCanEmail,
      canAdd: isChair(role) && g.chairCanAdd,
    };
  }),

  post: protectedProcedure.input(slugInput.extend({ groupId: z.number(), body: z.string().min(1).max(4000) })).mutation(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const g = memberGroup(org.id, input.groupId);
    if (!g.hasChannel) throw forbidden("This group has no discussion.");
    if (!myRole(g.id, member.id)) throw forbidden("Only the group's members can post.");
    return getDb().insert(schema.groupPosts).values({ groupId: g.id, memberId: member.id, body: input.body.trim() }).returning().get();
  }),

  deletePost: protectedProcedure.input(slugInput.extend({ groupId: z.number(), postId: z.number() })).mutation(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const g = memberGroup(org.id, input.groupId);
    const p = getDb().select().from(schema.groupPosts).where(eq(schema.groupPosts.id, input.postId)).get();
    if (!p || p.groupId !== g.id) throw notFound("That post");
    if (p.memberId !== member.id && !isChair(myRole(g.id, member.id))) throw forbidden();
    getDb().delete(schema.groupPosts).where(eq(schema.groupPosts.id, p.id)).run();
    return { ok: true };
  }),

  /** Chairs email everyone in the group (when the group allows it). */
  email: protectedProcedure.input(slugInput.extend({ groupId: z.number(), subject: z.string().min(2).max(160), body: z.string().min(2).max(10000) })).mutation(async ({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const g = memberGroup(org.id, input.groupId);
    if (!isChair(myRole(g.id, member.id)) || !g.chairCanEmail) throw forbidden("Only the chair can email this group.");
    const roster = groupRoster(g.id).filter((r) => isActive(r) && r.memberId !== member.id);
    const html = emailLayout({
      brand: org.colorPrimary,
      accent: org.colorAccent,
      title: input.subject,
      blocks: [...input.body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`), `<p style="color:#4B5B57">From ${escapeHtml(fullName(member))}, ${escapeHtml(g.name)}</p>`],
      footer: `Sent to members of ${escapeHtml(g.name)} through the ${escapeHtml(org.name)} member hub`,
    });
    for (const r of roster) {
      await sendEmail({ to: r.email, subject: input.subject, text: `${input.body}\n\nFrom ${fullName(member)}, ${g.name}\n${ENV.appUrl}/m/${org.slug}/groups/${g.id}`, html, fromName: `${g.name} (${org.name})`, replyTo: member.email });
    }
    audit(ctx.user, { orgId: org.id, action: "group.email", detail: `${g.name}: ${input.subject}` });
    return { sent: roster.length };
  }),

  /** Chairs add a member (when the group allows it). */
  add: protectedProcedure.input(slugInput.extend({ groupId: z.number(), email: z.string().email().max(200) })).mutation(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const g = memberGroup(org.id, input.groupId);
    if (!isChair(myRole(g.id, member.id)) || !g.chairCanAdd) throw forbidden("Only the chair can add members to this group.");
    const target = getDb()
      .select()
      .from(schema.members)
      .where(and(eq(schema.members.orgId, org.id), eq(schema.members.email, input.email.trim().toLowerCase())))
      .get();
    if (!target || !isActive(target)) throw new TRPCError({ code: "NOT_FOUND", message: `${input.email} is not an active member of ${getOrg(org.id).name}.` });
    getDb().insert(schema.groupMembers).values({ groupId: g.id, memberId: target.id, role: "member" }).onConflictDoNothing().run();
    return { ok: true, name: fullName(target) };
  }),
});
