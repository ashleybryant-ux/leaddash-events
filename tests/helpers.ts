/**
 * Test helpers: a fresh in-memory database per test file, people, an
 * association with an event, and tRPC callers signed in as anyone.
 */
import { eq } from "drizzle-orm";
import { useTestDb, getDb, schema } from "../server/_core/db";
import { appRouter } from "../server/routers";
import type { TrpcContext } from "../server/_core/context";
import { userForEmail } from "../server/core/auth";
import { seedEvent } from "../server/areas";
import { randomToken } from "../server/_core/crypto";
import { outbox } from "../server/_core/email";

export { getDb, schema, outbox };

export async function freshDb() {
  outbox.length = 0;
  return useTestDb();
}

/** Cookies the last signed-in caller set (sign-in tests). */
export const cookieJar: Record<string, string> = {};

/** A tRPC caller. Pass a user to be signed in as them. */
export function caller(user?: { id: number } | null) {
  const cookies = cookieJar;
  const full = user ? getDb().select().from(schema.users).where(eq(schema.users.id, user.id)).get()! : null;
  const ctx: TrpcContext = {
    req: { headers: {}, protocol: "https", ip: "127.0.0.1" } as unknown as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string) => (cookies[name] = value),
      clearCookie: (name: string) => delete cookies[name],
    } as unknown as TrpcContext["res"],
    user: full,
  };
  return appRouter.createCaller(ctx);
}

export const user = (email: string, name = "") => userForEmail(email, name);

/** An association with an owner, and one event (seeded with each area's defaults). */
export async function setupEvent(opts: { orgName?: string; ownerEmail?: string } = {}) {
  const db = getDb();
  const owner = user(opts.ownerEmail ?? "owner@example.org", "Olivia Owner");
  const org = db.insert(schema.organizations).values({ name: opts.orgName ?? "NABC", slug: `nabc-${randomToken(4).toLowerCase()}` }).returning().get();
  db.insert(schema.orgMembers).values({ orgId: org.id, userId: owner.id, role: "owner" }).run();
  const event = db
    .insert(schema.events)
    .values({ orgId: org.id, slug: `ev-${randomToken(5).toLowerCase()}`, name: "NABC Annual Conference", shortName: "NABC 2027", startDate: "2027-04-22", endDate: "2027-04-24", venueName: "Convention Center", city: "Houston" })
    .returning()
    .get();
  await seedEvent(event.id);
  return { org, owner, event, admin: caller(owner) };
}

/** Registers someone directly (no payment) and returns their attendee row and a signed-in caller. */
export function addAttendee(eventId: number, email: string, first = "Jordan", last = "Ellis", extra: Partial<typeof schema.attendees.$inferInsert> = {}) {
  const db = getDb();
  const u = user(email, `${first} ${last}`);
  const row = db
    .insert(schema.attendees)
    .values({ eventId, email: email.toLowerCase(), firstName: first, lastName: last, qrToken: randomToken(12), userId: u.id, ...extra })
    .returning()
    .get();
  return { attendee: row, user: u, api: caller(u) };
}
