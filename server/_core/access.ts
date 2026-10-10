/**
 * Who may see and change what. Every route that touches an organization,
 * event or person checks access with these helpers.
 *
 * - LeadDash staff (LEADDASH_STAFF_EMAILS) have tech-support access to every
 *   organization and are never listed on an organization's team.
 * - Organization owners and admins (org_members) can do everything for every
 *   event their organization runs.
 * - Event staff (staff_roles + staff_assignments) get the areas their role
 *   allows, until the role's access ends.
 * - Attendees are matched by email: signing in with the email they registered
 *   with links them to their attendee row.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { FORBIDDEN_ERR_MSG } from "@shared/const";
import type { Access, StaffArea, User } from "../../drizzle/schema";
import { STAFF_AREAS } from "../../drizzle/schema";
import { getDb, schema } from "./db";
import { isStaffEmail } from "./env";

export const forbidden = (message = FORBIDDEN_ERR_MSG) => new TRPCError({ code: "FORBIDDEN", message });
export const notFound = (what = "That") => new TRPCError({ code: "NOT_FOUND", message: `${what} was not found.` });

export const isLeadDashStaff = (user: User | null | undefined) => !!user && isStaffEmail(user.email);

export function orgRole(user: User, orgId: number): "owner" | "admin" | "support" | null {
  const row = getDb()
    .select()
    .from(schema.orgMembers)
    .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, user.id)))
    .get();
  if (row) return row.role;
  return isLeadDashStaff(user) ? "support" : null;
}

export function requireOrgAdmin(user: User, orgId: number) {
  const role = orgRole(user, orgId);
  if (!role) throw forbidden();
  return role;
}

export function getEvent(eventId: number) {
  const ev = getDb().select().from(schema.events).where(eq(schema.events.id, eventId)).get();
  if (!ev) throw notFound("That event");
  return ev;
}

export function getEventBySlug(slug: string) {
  const ev = getDb().select().from(schema.events).where(eq(schema.events.slug, slug)).get();
  if (!ev) throw notFound("That event");
  return ev;
}

export type EventAccess = {
  /** Organization admin (or LeadDash support): everything. */
  admin: boolean;
  areas: Record<StaffArea, Access>;
  /** Built-in role kinds the person holds for this event. */
  kinds: Set<string>;
  /** Booth staff: the vendors they work for. */
  vendorIds: number[];
};

const RANK: Record<Access, number> = { none: 0, view: 1, edit: 2 };

/** A staff role's access ends the day after the event ends when the role is set to end with the event. */
export function roleActive(role: { endsWithEvent: boolean }, event: { endDate: string }) {
  if (!role.endsWithEvent) return true;
  const end = new Date(`${event.endDate}T23:59:59Z`).getTime() + 24 * 3600_000;
  return Date.now() <= end;
}

export function eventAccess(user: User, eventId: number): EventAccess {
  const ev = getEvent(eventId);
  const none = Object.fromEntries(STAFF_AREAS.map((a) => [a, "none"])) as Record<StaffArea, Access>;
  if (orgRole(user, ev.orgId)) {
    return { admin: true, areas: Object.fromEntries(STAFF_AREAS.map((a) => [a, "edit"])) as Record<StaffArea, Access>, kinds: new Set(["event_admin"]), vendorIds: [] };
  }
  const rows = getDb()
    .select({ role: schema.staffRoles, assignment: schema.staffAssignments })
    .from(schema.staffAssignments)
    .innerJoin(schema.staffRoles, eq(schema.staffRoles.id, schema.staffAssignments.roleId))
    .where(and(eq(schema.staffAssignments.userId, user.id), eq(schema.staffRoles.eventId, eventId)))
    .all();
  const areas = { ...none };
  const kinds = new Set<string>();
  const vendorIds: number[] = [];
  for (const { role, assignment } of rows) {
    if (!roleActive(role, ev)) continue;
    kinds.add(role.kind);
    if (role.kind === "event_admin") {
      for (const a of STAFF_AREAS) areas[a] = "edit";
    }
    for (const a of STAFF_AREAS) {
      const level = role.access[a];
      if (level && RANK[level] > RANK[areas[a]]) areas[a] = level;
    }
    if (assignment.vendorId) vendorIds.push(assignment.vendorId);
  }
  return { admin: kinds.has("event_admin"), areas, kinds, vendorIds };
}

/** Throws unless the person can view (or edit) this area of the event. Returns the event and the access. */
export function requireArea(user: User, eventId: number, area: StaffArea, level: "view" | "edit" = "view") {
  const access = eventAccess(user, eventId);
  if (RANK[access.areas[area]] < RANK[level]) throw forbidden();
  return { event: getEvent(eventId), access };
}

/** Throws unless the person is an organization admin for the event (or holds the event admin role). */
export function requireEventAdmin(user: User, eventId: number) {
  const access = eventAccess(user, eventId);
  if (!access.admin) throw forbidden();
  return getEvent(eventId);
}

/** The person's attendee row for this event, linking it to their sign-in the first time. */
export function attendeeFor(user: User, eventId: number) {
  const db = getDb();
  let row = db
    .select()
    .from(schema.attendees)
    .where(and(eq(schema.attendees.eventId, eventId), eq(schema.attendees.userId, user.id)))
    .get();
  if (!row) {
    row = db
      .select()
      .from(schema.attendees)
      .where(and(eq(schema.attendees.eventId, eventId), eq(schema.attendees.email, user.email.toLowerCase())))
      .get();
    if (row && !row.userId) {
      db.update(schema.attendees).set({ userId: user.id }).where(eq(schema.attendees.id, row.id)).run();
      row = { ...row, userId: user.id };
    }
  }
  if (row && row.status === "cancelled") return undefined;
  return row;
}

export function requireAttendee(user: User, eventId: number) {
  const row = attendeeFor(user, eventId);
  if (!row) throw forbidden("You are not registered for this event.");
  if (!row.appOpenedAt) getDb().update(schema.attendees).set({ appOpenedAt: new Date() }).where(eq(schema.attendees.id, row.id)).run();
  return row;
}

/** The person's member record in an organization, linking it to their sign-in the first time. */
export function memberFor(user: User, orgId: number) {
  const db = getDb();
  let row = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.orgId, orgId), eq(schema.members.userId, user.id)))
    .get();
  if (!row) {
    row = db
      .select()
      .from(schema.members)
      .where(and(eq(schema.members.orgId, orgId), eq(schema.members.email, user.email.toLowerCase())))
      .get();
    if (row && !row.userId) {
      db.update(schema.members).set({ userId: user.id }).where(eq(schema.members.id, row.id)).run();
      row = { ...row, userId: user.id };
    }
  }
  return row;
}

export function audit(user: User | null, opts: { orgId?: number | null; eventId?: number | null; action: string; detail?: string }) {
  getDb()
    .insert(schema.auditLog)
    .values({ orgId: opts.orgId ?? null, eventId: opts.eventId ?? null, userId: user?.id ?? null, action: opts.action, detail: opts.detail ?? "" })
    .run();
}
