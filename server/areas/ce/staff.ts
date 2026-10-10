/**
 * Event staff roles (event admins only): built-in roles, custom roles with
 * per-area access, and the people in each role.
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, requireEventAdmin } from "../../_core/access";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { ENV } from "../../_core/env";
import { userForEmail } from "../../core/auth";
import { STAFF_AREAS, type Access, type StaffArea } from "../../../drizzle/schema";
import { badRequest } from "./shared";

type Role = typeof schema.staffRoles.$inferSelect;

export const AREA_LABELS: Record<StaffArea, string> = {
  checkin: "Check-in desk",
  attendees: "Attendees",
  sessions: "Sessions",
  help: "Help",
  proposals: "Proposals",
  vendors: "Vendors",
  registration: "Registration",
  reports: "Reports",
  speakers: "Speakers",
  community: "Community",
  announcements: "Announcements",
  evaluations: "Evaluations",
  certificates: "Certificates",
};

/** Built-in roles every new event starts with. */
export function seedStaffRoles(eventId: number) {
  const db = getDb();
  const have = db.select().from(schema.staffRoles).where(eq(schema.staffRoles.eventId, eventId)).all();
  const builtIns: Omit<typeof schema.staffRoles.$inferInsert, "eventId">[] = [
    { name: "Event admin", kind: "event_admin", description: "Everything for this event", access: {} },
    { name: "Check-in volunteer", kind: "checkin", description: "Check-in desk only", access: { checkin: "edit", attendees: "view", help: "edit" } },
    { name: "Proposal reviewer", kind: "reviewer", description: "Only proposals assigned to them, names hidden", access: { proposals: "view" } },
    { name: "Booth staff", kind: "booth", description: "Lead scanning and their own booth's leads", access: {} },
    { name: "Speaker", kind: "speaker", description: "Their own sessions, poll results, and Q&A", access: {} },
  ];
  for (const r of builtIns) {
    if (have.some((h) => h.kind === r.kind)) continue;
    db.insert(schema.staffRoles).values({ ...r, eventId }).run();
  }
}

/** "Check-in desk, Attendees (view)" for roles without a written description. */
export function accessSummary(role: Pick<Role, "kind" | "access" | "description">) {
  if (role.kind === "event_admin") return "Everything for this event";
  if (role.description) return role.description;
  const parts = STAFF_AREAS.filter((a) => role.access[a] && role.access[a] !== "none").map((a) => `${AREA_LABELS[a]}${role.access[a] === "view" ? " (view)" : ""}`);
  return parts.length ? parts.join(", ") : "Nothing yet";
}

function getRole(roleId: number, eventId: number) {
  const r = getDb().select().from(schema.staffRoles).where(eq(schema.staffRoles.id, roleId)).get();
  if (!r || r.eventId !== eventId) throw badRequest("That role was not found.");
  return r;
}

async function sendStaffInvite(role: Role, user: { email: string; name: string }, ev: typeof schema.events.$inferSelect) {
  const link = role.kind === "booth" ? `${ENV.appUrl}/e/${ev.slug}/leads` : `${ENV.appUrl}/admin/e/${ev.id}`;
  await sendEmail({
    to: user.email,
    fromName: ev.shortName || ev.name,
    subject: `You are on the ${ev.shortName || ev.name} team: ${role.name}`,
    text: `You were added as ${role.name} for ${ev.name}. Sign in with this email at ${link}`,
    html: emailLayout({
      brand: ev.branding.colorPrimary,
      accent: ev.branding.colorAccent,
      title: `You are on the team for ${ev.shortName || ev.name}`,
      blocks: [
        `<p>You were added as <b>${escapeHtml(role.name)}</b> for ${escapeHtml(ev.name)}.</p>`,
        `<p>Sign in with ${escapeHtml(user.email)}. We will email you a six-digit code.</p>`,
        emailButton("Sign in", link, ev.branding.colorAccent),
      ],
    }),
  });
}

const accessLevel = z.enum(["edit", "view", "none"]);

export const staffRouter = router({
  list: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    requireEventAdmin(ctx.user, input.eventId);
    const db = getDb();
    const roles = db.select().from(schema.staffRoles).where(eq(schema.staffRoles.eventId, input.eventId)).all();
    const people = roles.length
      ? db
          .select({ id: schema.staffAssignments.id, roleId: schema.staffAssignments.roleId, vendorId: schema.staffAssignments.vendorId, userId: schema.users.id, name: schema.users.name, email: schema.users.email })
          .from(schema.staffAssignments)
          .innerJoin(schema.users, eq(schema.users.id, schema.staffAssignments.userId))
          .where(inArray(schema.staffAssignments.roleId, roles.map((r) => r.id)))
          .all()
      : [];
    const vendors = db.select({ id: schema.vendors.id, company: schema.vendors.company }).from(schema.vendors).where(eq(schema.vendors.eventId, input.eventId)).all();
    const order = ["event_admin", "checkin", "reviewer", "booth", "speaker", "custom"];
    return {
      areas: STAFF_AREAS.map((a) => ({ key: a, label: AREA_LABELS[a] })),
      vendors,
      roles: roles
        .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id - b.id)
        .map((r) => ({
          ...r,
          canSee: accessSummary(r),
          people: people.filter((p) => p.roleId === r.id).map((p) => ({ ...p, vendor: vendors.find((v) => v.id === p.vendorId)?.company ?? "" })),
        })),
    };
  }),

  create: protectedProcedure.input(z.object({ eventId: z.number().int(), name: z.string().trim().min(1).max(80).default("New role") })).mutation(({ ctx, input }) => {
    requireEventAdmin(ctx.user, input.eventId);
    return getDb().insert(schema.staffRoles).values({ eventId: input.eventId, name: input.name, kind: "custom" }).returning().get();
  }),

  update: protectedProcedure
    .input(
      z.object({
        eventId: z.number().int(),
        roleId: z.number().int(),
        name: z.string().trim().min(1).max(80),
        endsWithEvent: z.boolean(),
        signInWith: z.enum(["email", "text"]),
        access: z.partialRecord(z.enum(STAFF_AREAS), accessLevel),
      })
    )
    .mutation(({ ctx, input }) => {
      const ev = requireEventAdmin(ctx.user, input.eventId);
      const r = getRole(input.roleId, ev.id);
      const access: Partial<Record<StaffArea, Access>> = {};
      for (const a of STAFF_AREAS) if (input.access[a] && input.access[a] !== "none") access[a] = input.access[a];
      const changed = JSON.stringify(access) !== JSON.stringify(r.access);
      getDb()
        .update(schema.staffRoles)
        .set({ name: input.name, endsWithEvent: input.endsWithEvent, signInWith: input.signInWith, access, ...((r.kind === "custom" || r.kind === "checkin") && changed ? { description: "" } : {}) })
        .where(eq(schema.staffRoles.id, r.id))
        .run();
      audit(ctx.user, { orgId: ev.orgId, eventId: ev.id, action: "staff_role.update", detail: input.name });
      return { ok: true };
    }),

  remove: protectedProcedure.input(z.object({ eventId: z.number().int(), roleId: z.number().int() })).mutation(({ ctx, input }) => {
    const ev = requireEventAdmin(ctx.user, input.eventId);
    const r = getRole(input.roleId, ev.id);
    if (r.kind !== "custom") throw badRequest("Built-in roles cannot be deleted.");
    getDb().delete(schema.staffRoles).where(eq(schema.staffRoles.id, r.id)).run();
    audit(ctx.user, { orgId: ev.orgId, eventId: ev.id, action: "staff_role.remove", detail: r.name });
    return { ok: true };
  }),

  /** Add a person by email and email them a sign-in link. */
  addPerson: protectedProcedure
    .input(z.object({ eventId: z.number().int(), roleId: z.number().int(), email: z.string().trim().email().max(200), name: z.string().trim().max(120).default(""), vendorId: z.number().int().nullable().default(null) }))
    .mutation(async ({ ctx, input }) => {
      const ev = requireEventAdmin(ctx.user, input.eventId);
      const r = getRole(input.roleId, ev.id);
      const db = getDb();
      if (input.vendorId) {
        const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, input.vendorId)).get();
        if (!v || v.eventId !== ev.id) throw badRequest("Pick a vendor for this event.");
      }
      if (r.kind === "booth" && !input.vendorId) throw badRequest("Pick the vendor this person works for.");
      const user = userForEmail(input.email, input.name);
      const exists = db.select().from(schema.staffAssignments).where(and(eq(schema.staffAssignments.roleId, r.id), eq(schema.staffAssignments.userId, user.id))).get();
      if (exists) throw badRequest(`${user.name || user.email} is already in this role.`);
      db.insert(schema.staffAssignments).values({ roleId: r.id, userId: user.id, vendorId: input.vendorId }).run();
      audit(ctx.user, { orgId: ev.orgId, eventId: ev.id, action: "staff.add", detail: `${user.email}: ${r.name}` });
      await sendStaffInvite(r, { email: user.email, name: user.name }, ev);
      return { ok: true };
    }),

  removePerson: protectedProcedure.input(z.object({ eventId: z.number().int(), assignmentId: z.number().int() })).mutation(({ ctx, input }) => {
    const ev = requireEventAdmin(ctx.user, input.eventId);
    const db = getDb();
    const row = db.select().from(schema.staffAssignments).where(eq(schema.staffAssignments.id, input.assignmentId)).get();
    if (!row) throw badRequest("That person is not in this role.");
    const role = getRole(row.roleId, ev.id);
    const person = db.select().from(schema.users).where(eq(schema.users.id, row.userId)).get();
    db.delete(schema.staffAssignments).where(eq(schema.staffAssignments.id, row.id)).run();
    audit(ctx.user, { orgId: ev.orgId, eventId: ev.id, action: "staff.remove", detail: `${person?.name || person?.email || ""}: ${role.name}` });
    return { ok: true };
  }),
});
