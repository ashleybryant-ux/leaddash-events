import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, caller, setupEvent, addAttendee, outbox, user, cookieJar, getDb, schema } from "./helpers";
import { eq } from "drizzle-orm";

describe("sign-in and access", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("signs in with an emailed code", async () => {
    const api = caller(null);
    await api.auth.requestCode({ email: "Jordan@Example.com" });
    const code = outbox.at(-1)!.subject.match(/(\d{6})/)![1];
    await expect(api.auth.verifyCode({ email: "jordan@example.com", code: code === "000000" ? "111111" : "000000" })).rejects.toThrow();
    const res = await api.auth.verifyCode({ email: "jordan@example.com", code });
    expect(res.ok).toBe(true);
    expect(Object.keys(cookieJar)).toContain("ld_events_session");
  });

  it("keeps attendees out of admin routes and admins in", async () => {
    const { event, admin } = await setupEvent();
    const { api } = addAttendee(event.id, "a@example.com");
    await expect(api.core.events.get({ eventId: event.id })).rejects.toThrow();
    const got = await admin.core.events.get({ eventId: event.id });
    expect(got.access.admin).toBe(true);
    const me = await api.core.events.me({ slug: event.slug });
    expect(me.attendee?.email).toBe("a@example.com");
  });

  it("links a returning attendee by email", async () => {
    const { event } = await setupEvent();
    const { attendee } = addAttendee(event.id, "b@example.com");
    const other = user("b@example.com");
    const me = await caller(other).core.events.me({ slug: event.slug });
    expect(me.attendee?.id).toBe(attendee.id);
  });
  it("passes new organization colors to events that still use them", async () => {
    const { org, event, admin } = await setupEvent();
    const db = getDb();
    const other = db.insert(schema.events).values({ orgId: org.id, slug: "own-colors", name: "Own colors", startDate: "2027-06-01", endDate: "2027-06-02", branding: { colorPrimary: "#123456", colorAccent: "#654321" } }).returning().get();
    const res = await admin.core.org.update({ orgId: org.id, name: org.name, colorPrimary: "#7B219F", colorAccent: "#7A7A7A", logoFileId: null });
    expect(res.eventsUpdated).toBe(2); // both still use the organization logo (none)
    const after = (id: number) => db.select().from(schema.events).where(eq(schema.events.id, id)).get()!.branding;
    expect(after(event.id)).toMatchObject({ colorPrimary: "#7B219F", colorAccent: "#7A7A7A" });
    expect(after(other.id)).toMatchObject({ colorPrimary: "#123456", colorAccent: "#654321" });
  });
  it("saves a third brand color and passes it to events that follow the organization", async () => {
    const { org, event, admin } = await setupEvent();
    const res = await admin.core.org.update({ orgId: org.id, name: org.name, colorPrimary: "#7B219F", colorAccent: "#7A7A7A", colorHighlight: "#D4A017", logoFileId: null });
    expect(res.eventsUpdated).toBe(1);
    expect((await admin.core.org.get({ orgId: org.id })).colorHighlight).toBe("#D4A017");
    const after = getDb().select().from(schema.events).where(eq(schema.events.id, event.id)).get()!.branding;
    expect(after).toMatchObject({ colorPrimary: "#7B219F", colorAccent: "#7A7A7A", colorHighlight: "#D4A017" });
    // Clearing it means the main color again, and a bad value is refused.
    await admin.core.org.update({ orgId: org.id, name: org.name, colorPrimary: "#7B219F", colorAccent: "#7A7A7A", colorHighlight: "", logoFileId: null });
    expect((await admin.core.org.get({ orgId: org.id })).colorHighlight).toBe("");
    await expect(admin.core.org.update({ orgId: org.id, name: org.name, colorPrimary: "#7B219F", colorAccent: "#7A7A7A", colorHighlight: "gold", logoFileId: null })).rejects.toThrow();
  });
  it("shows the event home checklist and counts, and keeps attendees out", async () => {
    const { org, event, admin } = await setupEvent();
    const home = await admin.core.events.home({ eventId: event.id });
    expect(home.steps.map((x) => x.key)).toEqual(["stripe", "tickets", "look", "sessions", "speakers", "certificates", "live"]);
    expect(home.steps.find((x) => x.key === "live")?.done).toBe(false);
    expect(home.counts).toMatchObject({ sessions: 0, registered: 0, sales: 0 });
    addAttendee(event.id, "a@example.com");
    expect((await admin.core.events.home({ eventId: event.id })).counts.registered).toBe(1);
    const stranger = caller(user("stranger@example.com"));
    await expect(stranger.core.events.home({ eventId: event.id })).rejects.toThrow();

  });
});
