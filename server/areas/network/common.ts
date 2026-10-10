/** Helpers shared by the network area's routers. */
import { z } from "zod";
import { and, eq, or } from "drizzle-orm";
import type { Event, User } from "../../../drizzle/schema";
import { getDb, schema } from "../../_core/db";
import { forbidden, getEventBySlug, requireAttendee, roleActive, eventAccess } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { fullName } from "@shared/format";

export const slug = z.string().min(1).max(120);
export const id = z.number().int().positive();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

type Attendee = typeof schema.attendees.$inferSelect;
type FeatureKey = keyof Event["features"];

/** The event by slug and the signed-in person's attendee row (throws when they are not registered). */
export function attendeeCtx(user: User, eventSlug: string) {
  const event = getEventBySlug(eventSlug);
  const me = requireAttendee(user, event.id);
  return { event, me };
}

export function requireFeature(event: Event, key: FeatureKey, label: string) {
  if (!event.features[key]) throw forbidden(`${label} is turned off for this event.`);
}

/** Everyone this attendee blocked or was blocked by. */
export function blockedWith(attendeeId: number) {
  const rows = getDb()
    .select()
    .from(schema.blocks)
    .where(or(eq(schema.blocks.attendeeId, attendeeId), eq(schema.blocks.blockedAttendeeId, attendeeId)))
    .all();
  const iBlocked = new Set<number>();
  const blockedMe = new Set<number>();
  for (const r of rows) {
    if (r.attendeeId === attendeeId) iBlocked.add(r.blockedAttendeeId);
    else blockedMe.add(r.attendeeId);
  }
  return { iBlocked, blockedMe, any: (id: number) => iBlocked.has(id) || blockedMe.has(id) };
}

export function isBlocked(a: number, b: number) {
  return !!getDb()
    .select()
    .from(schema.blocks)
    .where(
      or(
        and(eq(schema.blocks.attendeeId, a), eq(schema.blocks.blockedAttendeeId, b)),
        and(eq(schema.blocks.attendeeId, b), eq(schema.blocks.blockedAttendeeId, a))
      )
    )
    .get();
}

/** What other attendees may see about a person. */
export function personCard(a: Attendee) {
  return {
    id: a.id,
    firstName: a.firstName,
    lastName: a.lastName,
    name: fullName(a),
    credentials: a.credentials,
    jobTitle: a.jobTitle,
    organization: a.organization,
    city: a.city,
    kind: a.kind,
    photoUrl: fileUrl(a.photoFileId),
  };
}

export function getAttendee(eventId: number, attendeeId: number) {
  const row = getDb().select().from(schema.attendees).where(and(eq(schema.attendees.id, attendeeId), eq(schema.attendees.eventId, eventId))).get();
  if (!row || row.status === "cancelled") return undefined;
  return row;
}

/** Active staff roles a person holds for an event (with the assignment). */
export function activeRoles(user: User, event: Event) {
  return getDb()
    .select({ role: schema.staffRoles, assignment: schema.staffAssignments })
    .from(schema.staffAssignments)
    .innerJoin(schema.staffRoles, eq(schema.staffRoles.id, schema.staffAssignments.roleId))
    .where(and(eq(schema.staffAssignments.userId, user.id), eq(schema.staffRoles.eventId, event.id)))
    .all()
    .filter((r) => roleActive(r.role, event));
}

export { eventAccess };

/** Escapes a value for a CSV cell. */
export const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
