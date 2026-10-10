import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, caller, setupEvent, addAttendee, outbox, user, cookieJar } from "./helpers";

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
});
