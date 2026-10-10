/**
 * Member hub helpers: finding the association and the member, the access
 * rules for member content and folders, member numbers, and CSV.
 *
 * The LeadDash platform stays the record for dues and payments. The member
 * hub only reads membership status and never keeps a copy of payments.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { FolderAccess, Member, User } from "../../../drizzle/schema";
import { getDb, schema } from "../../_core/db";
import { forbidden, memberFor, notFound, orgRole } from "../../_core/access";

export const ACTIVE = ["active", "grace"] as const;
export const isActive = (m: { status: string }) => (ACTIVE as readonly string[]).includes(m.status);

export const today = () => new Date().toISOString().slice(0, 10);
export const daysFromNow = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

export function orgBySlug(slug: string) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.slug, slug)).get();
  if (!org) throw notFound("That association");
  return org;
}

export function getOrg(orgId: number) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).get();
  if (!org) throw notFound("That association");
  return org;
}

/** The signed-in person's membership. Throws when they have none. */
export function hubMember(user: User, orgSlug: string) {
  const org = orgBySlug(orgSlug);
  const member = memberFor(user, org.id);
  if (!member) throw forbidden(`We could not find a membership for ${user.email}.`);
  return { org, member };
}

/** Member content (documents, groups) is for active and grace members only. */
export function activeMember(user: User, orgSlug: string) {
  const r = hubMember(user, orgSlug);
  if (!isActive(r.member)) throw forbidden("Your membership has lapsed. Renew to open member content.");
  return r;
}

/** Group ids the member belongs to, with their role. */
export function memberGroups(memberId: number) {
  return getDb()
    .select({ groupId: schema.groupMembers.groupId, role: schema.groupMembers.role, isBoard: schema.groups.isBoard })
    .from(schema.groupMembers)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
    .where(eq(schema.groupMembers.memberId, memberId))
    .all();
}

/** Whether a member may open a folder. Staff-only folders never open for members. */
export function memberCanOpen(member: Member, folder: { access: FolderAccess; groupId: number | null }, groups = memberGroups(member.id)) {
  if (!isActive(member)) return false;
  const a = folder.access;
  switch (a.type) {
    case "active_members":
      return true;
    case "board":
      return groups.some((g) => g.isBoard);
    case "group": {
      const gid = a.groupId ?? folder.groupId;
      return !!gid && groups.some((g) => g.groupId === gid);
    }
    case "level":
      return !!a.level && a.level.toLowerCase() === member.level.toLowerCase();
    case "staff":
    default:
      return false;
  }
}

/** Members who can open a folder (for notices when a file is added). */
export function membersWhoCanOpen(orgId: number, folder: { access: FolderAccess; groupId: number | null }) {
  const db = getDb();
  const all = db.select().from(schema.members).where(and(eq(schema.members.orgId, orgId), inArray(schema.members.status, [...ACTIVE]))).all();
  if (!all.length) return [];
  const rows = db
    .select({ memberId: schema.groupMembers.memberId, groupId: schema.groupMembers.groupId, role: schema.groupMembers.role, isBoard: schema.groups.isBoard })
    .from(schema.groupMembers)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
    .where(eq(schema.groups.orgId, orgId))
    .all();
  const byMember = new Map<number, typeof rows>();
  for (const r of rows) byMember.set(r.memberId, [...(byMember.get(r.memberId) ?? []), r]);
  return all.filter((m) => memberCanOpen(m, folder, byMember.get(m.id) ?? []));
}

export const isOrgAdmin = (user: User, orgId: number) => !!orgRole(user, orgId);

export function accessLabel(a: FolderAccess, groupName?: string) {
  switch (a.type) {
    case "active_members":
      return "Active members";
    case "board":
      return "Board only";
    case "group":
      return groupName ? `${groupName} only` : "A division or committee";
    case "level":
      return a.level ? `${a.level} members` : "Member level";
    case "staff":
      return "Staff only";
  }
}

/** "nabc" -> "NB": the first two consonants of the slug's first word, or its first two letters. */
export function defaultPrefix(slug: string) {
  const word = (slug.split("-")[0] || slug).toUpperCase().replace(/[^A-Z]/g, "");
  const consonants = word.replace(/[AEIOU]/g, "");
  return (consonants.length >= 2 ? consonants.slice(0, 2) : word.slice(0, 2)) || "MB";
}

export function memberSettings(orgId: number) {
  const db = getDb();
  return db.select().from(schema.memberSettings).where(eq(schema.memberSettings.orgId, orgId)).get() ?? { orgId, numberPrefix: "", renewUrl: "", updatedAt: null, id: 0 };
}

/** The next member number, "NB-20419" style. */
export function nextMemberNumber(orgId: number) {
  const org = getOrg(orgId);
  const prefix = memberSettings(orgId).numberPrefix || defaultPrefix(org.slug);
  const rows = getDb().select({ n: schema.members.memberNumber }).from(schema.members).where(eq(schema.members.orgId, orgId)).all();
  let max = 20000;
  for (const r of rows) {
    const m = r.n.match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

// ---------- CSV ----------

/** Parses CSV text (quotes, commas and newlines inside quotes). The first row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const clean = rows.filter((r) => r.some((c) => c.trim()));
  if (!clean.length) return [];
  const header = clean[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return clean.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

/** Typed dates: "2027-12-31" or "12/31/2027" -> "2027-12-31". Empty or unreadable -> null. */
export function normalizeDate(v: string | undefined | null) {
  const s = (v ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const out = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
  if (!out) return null;
  const d = new Date(`${out}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === out ? out : null;
}
