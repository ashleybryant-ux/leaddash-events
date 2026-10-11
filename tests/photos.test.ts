import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, caller, setupEvent, addAttendee, user, getDb, schema } from "./helpers";
import { pushLog } from "../server/_core/push";
import { canPostPhotos, photoMime } from "../server/areas/network/photos";

/** A tiny real JPEG and PNG header (the server checks the first bytes, not the name). */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 1)]).toString("base64");
const TEXT = Buffer.from("this is not a photo at all, just some text").toString("base64");

async function setup() {
  const ctx = await setupEvent();
  getDb().update(schema.events).set({ status: "live" }).where(eq(schema.events.id, ctx.event.id)).run();
  const a = addAttendee(ctx.event.id, "alex@example.com", "Alex", "Rivera");
  const b = addAttendee(ctx.event.id, "blair@example.com", "Blair", "Stone");
  return { ...ctx, slug: ctx.event.slug, a, b };
}

/** A staff role with community access and one person on it. */
function communityStaff(eventId: number, email: string, level: "view" | "edit") {
  const role = getDb().insert(schema.staffRoles).values({ eventId, name: "Moderator", kind: "custom", access: { community: level } as never, endsWithEvent: false }).returning().get();
  const u = user(email, "Casey Moderator");
  getDb().insert(schema.staffAssignments).values({ roleId: role.id, userId: u.id }).run();
  return { user: u, api: caller(u) };
}

describe("photos", () => {
  beforeEach(async () => {
    await freshDb();
    pushLog.length = 0;
  });

  it("new events start with photos on, team review first, everyone can post", async () => {
    const { event, admin } = await setup();
    const ev = getDb().select().from(schema.events).where(eq(schema.events.id, event.id)).get()!;
    expect(ev.features.photos).toBe(true);
    const list = await admin.network.photos.admin.list({ eventId: event.id });
    expect(list.settings).toEqual({ on: true, review: true, who: "everyone" });
  });

  it("checks the image type from the bytes", () => {
    expect(photoMime(JPEG)).toBe("image/jpeg");
    expect(photoMime(PNG)).toBe("image/png");
    expect(photoMime(TEXT)).toBeNull();
  });

  it("keeps people who are not at the event out", async () => {
    const { slug, a } = await setup();
    const stranger = caller(user("stranger@example.com", "Sam Stranger"));
    await expect(stranger.network.photos.list({ slug })).rejects.toThrow(/not registered/);
    await expect(stranger.network.photos.upload({ slug, base64: JPEG })).rejects.toThrow(/not registered/);
    const { id } = await a.api.network.photos.upload({ slug, base64: JPEG });
    await expect(stranger.network.photos.like({ slug, photoId: id })).rejects.toThrow(/not registered/);
    expect(await stranger.network.photos.latest({ slug })).toBe(0);
    await expect(caller(null).network.photos.list({ slug })).rejects.toThrow();
  });

  it("refuses files that are not photos", async () => {
    const { slug, a } = await setup();
    await expect(a.api.network.photos.upload({ slug, base64: TEXT })).rejects.toThrow(/JPEG, PNG or WebP/);
  });

  it("attendees see posted photos plus their own waiting ones; review posts and hides", async () => {
    const { event, slug, a, b, admin } = await setup();
    const up = await a.api.network.photos.upload({ slug, base64: JPEG, thumbBase64: JPEG, caption: "Opening session crowd" });
    expect(up.status).toBe("pending");

    // Alex sees it under My photos, waiting; Blair sees nothing yet.
    const alexMine = await a.api.network.photos.list({ slug, mine: true });
    expect(alexMine.items.map((p) => [p.id, p.status])).toEqual([[up.id, "pending"]]);
    expect(alexMine.items[0].by.name).toBe("Alex Rivera");
    expect(alexMine.items[0].url).toMatch(/sig=/);
    expect((await a.api.network.photos.list({ slug })).items).toHaveLength(0);
    expect((await b.api.network.photos.list({ slug })).items).toHaveLength(0);
    expect((await b.api.network.photos.list({ slug, mine: true })).items).toHaveLength(0);

    // Photo files are private: the stored file is not public.
    const row = getDb().select().from(schema.eventPhotos).where(eq(schema.eventPhotos.id, up.id)).get()!;
    expect(getDb().select().from(schema.files).where(eq(schema.files.id, row.fileId)).get()!.isPublic).toBe(false);

    await admin.network.photos.admin.setStatus({ eventId: event.id, photoId: up.id, status: "posted" });
    const seen = await b.api.network.photos.list({ slug });
    expect(seen.items.map((p) => p.id)).toEqual([up.id]);
    expect(seen.counts).toEqual({ all: 1, mine: 0 });
    expect(seen.items[0].caption).toBe("Opening session crowd");
    expect(await b.api.network.photos.latest({ slug })).toBeGreaterThan(0);

    await admin.network.photos.admin.setStatus({ eventId: event.id, photoId: up.id, status: "hidden" });
    expect((await b.api.network.photos.list({ slug })).items).toHaveLength(0);
    expect((await a.api.network.photos.list({ slug, mine: true })).items).toHaveLength(0);
  });

  it("posts right away when review is off", async () => {
    const { event, slug, a, b, admin } = await setup();
    await admin.network.photos.admin.updateSettings({ eventId: event.id, on: true, review: false, who: "everyone" });
    const up = await a.api.network.photos.upload({ slug, base64: PNG });
    expect(up.status).toBe("posted");
    expect((await b.api.network.photos.list({ slug })).items).toHaveLength(1);
  });

  it("follows the who-can-post setting and turning photos off", async () => {
    const { event, slug, a, admin } = await setup();
    const mod = communityStaff(event.id, "mod@example.com", "edit");

    await admin.network.photos.admin.updateSettings({ eventId: event.id, on: true, review: true, who: "staff" });
    await expect(a.api.network.photos.upload({ slug, base64: JPEG })).rejects.toThrow(/Only the event team/);
    expect((await a.api.network.photos.list({ slug })).canPost).toBe(false);
    const staffUp = await mod.api.network.photos.upload({ slug, base64: JPEG });
    expect(staffUp.id).toBeGreaterThan(0);

    await admin.network.photos.admin.updateSettings({ eventId: event.id, on: true, review: true, who: "attendees" });
    await expect(mod.api.network.photos.upload({ slug, base64: JPEG })).rejects.toThrow(/Only attendees/);
    expect((await a.api.network.photos.upload({ slug, base64: JPEG })).status).toBe("pending");

    await admin.network.photos.admin.updateSettings({ eventId: event.id, on: false, review: true, who: "everyone" });
    await expect(a.api.network.photos.list({ slug })).rejects.toThrow(/turned off/);
    expect(getDb().select().from(schema.events).where(eq(schema.events.id, event.id)).get()!.features.photos).toBe(false);

    expect(canPostPhotos("everyone", { attendee: null, staff: true })).toBe(true);
    expect(canPostPhotos("attendees", { attendee: null, staff: true })).toBe(false);
    expect(canPostPhotos("staff", { attendee: null, staff: false })).toBe(false);
  });

  it("likes toggle once per person", async () => {
    const { event, slug, a, b, admin } = await setup();
    await admin.network.photos.admin.updateSettings({ eventId: event.id, on: true, review: false, who: "everyone" });
    const { id } = await a.api.network.photos.upload({ slug, base64: JPEG });
    expect(await b.api.network.photos.like({ slug, photoId: id })).toEqual({ liked: true, likes: 1 });
    expect(await a.api.network.photos.like({ slug, photoId: id })).toEqual({ liked: true, likes: 2 });
    expect(await b.api.network.photos.like({ slug, photoId: id })).toEqual({ liked: false, likes: 1 });
    expect(await b.api.network.photos.like({ slug, photoId: id })).toEqual({ liked: true, likes: 2 });
    const list = await b.api.network.photos.list({ slug });
    expect(list.items[0]).toMatchObject({ likes: 2, liked: true });
    expect(getDb().select().from(schema.photoLikes).all()).toHaveLength(2);
  });

  it("attendees delete only their own photos", async () => {
    const { event, slug, a, b, admin } = await setup();
    await admin.network.photos.admin.updateSettings({ eventId: event.id, on: true, review: false, who: "everyone" });
    const { id } = await a.api.network.photos.upload({ slug, base64: JPEG, thumbBase64: JPEG });
    await expect(b.api.network.photos.remove({ slug, photoId: id })).rejects.toThrow(/only your own/);
    const before = getDb().select().from(schema.files).all().length;
    await a.api.network.photos.remove({ slug, photoId: id });
    expect(getDb().select().from(schema.eventPhotos).all()).toHaveLength(0);
    expect(getDb().select().from(schema.files).all().length).toBe(before - 2);
  });

  it("report sends a photo back to review and lets community staff know", async () => {
    const { event, slug, a, b, admin } = await setup();
    const mod = communityStaff(event.id, "mod@example.com", "edit");
    const viewer = communityStaff(event.id, "viewer@example.com", "view");
    await admin.network.photos.admin.updateSettings({ eventId: event.id, on: true, review: false, who: "everyone" });
    const { id } = await a.api.network.photos.upload({ slug, base64: JPEG });
    await b.api.network.photos.report({ slug, photoId: id });
    expect((await b.api.network.photos.list({ slug })).items).toHaveLength(0);
    const adminList = await admin.network.photos.admin.list({ eventId: event.id });
    expect(adminList.photos[0]).toMatchObject({ id, status: "pending", reported: true });
    const notice = pushLog.find((p) => p.userId === mod.user.id)!;
    expect(notice.title).toBe("A photo was reported and is waiting for review");
    expect(notice.url).toBe(`/admin/e/${event.id}/photos`);
    expect(notice.body).not.toMatch(/Alex|Blair/);
    expect(pushLog.some((p) => p.userId === viewer.user.id)).toBe(false);
  });

  it("admin counts, access by role, and staff uploads post right away", async () => {
    const { event, slug, a, b, admin } = await setup();
    const viewer = communityStaff(event.id, "viewer@example.com", "view");
    const p1 = await a.api.network.photos.upload({ slug, base64: JPEG });
    const p2 = await b.api.network.photos.upload({ slug, base64: JPEG });
    await a.api.network.photos.upload({ slug, base64: JPEG });
    await admin.network.photos.admin.setStatus({ eventId: event.id, photoId: p1.id, status: "posted" });
    await admin.network.photos.admin.setStatus({ eventId: event.id, photoId: p2.id, status: "hidden" });
    await b.api.network.photos.like({ slug, photoId: p1.id });
    const staffUp = await admin.network.photos.admin.upload({ eventId: event.id, base64: PNG, caption: "Award night" });
    const list = await admin.network.photos.admin.list({ eventId: event.id });
    expect(list.counts).toEqual({ posted: 2, pending: 1, hidden: 1, likes: 1 });
    const staffRow = list.photos.find((p) => p.id === staffUp.id)!;
    expect(staffRow.status).toBe("posted");
    expect(staffRow.by.name).toBe("Olivia Owner");

    // View-only staff can look but not change; attendees cannot open the admin list.
    expect((await viewer.api.network.photos.admin.list({ eventId: event.id })).counts.posted).toBe(2);
    await expect(viewer.api.network.photos.admin.setStatus({ eventId: event.id, photoId: p1.id, status: "hidden" })).rejects.toThrow();
    await expect(viewer.api.network.photos.admin.updateSettings({ eventId: event.id, on: false, review: false, who: "staff" })).rejects.toThrow();
    await expect(a.api.network.photos.admin.list({ eventId: event.id })).rejects.toThrow();

    // A photo from one event cannot be changed through another event.
    const other = await setupEvent({ ownerEmail: "other-owner@example.org" });
    await expect(other.admin.network.photos.admin.remove({ eventId: other.event.id, photoId: p1.id })).rejects.toThrow(/not found/);
  });

  it("pages photos 60 at a time, newest first", async () => {
    const { event, slug, a, admin } = await setup();
    await admin.network.photos.admin.updateSettings({ eventId: event.id, on: true, review: false, who: "everyone" });
    for (let i = 0; i < 62; i++) await a.api.network.photos.upload({ slug, base64: JPEG });
    const first = await a.api.network.photos.list({ slug });
    expect(first.items).toHaveLength(60);
    expect(first.items[0].id).toBeGreaterThan(first.items[59].id);
    expect(first.next).toBe(first.items[59].id);
    const second = await a.api.network.photos.list({ slug, cursor: first.next });
    expect(second.items).toHaveLength(2);
    expect(second.next).toBeNull();
  });
});

describe("home data", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("up next and the event switcher only show the person's own data", async () => {
    const { event, slug, a, b, admin } = await setup();
    const s1 = getDb().insert(schema.sessions).values({ eventId: event.id, title: "Opening General Session", date: "2027-04-22", startTime: "09:00", endTime: "10:00", published: true, checkInCode: `c-${Math.random()}` }).returning().get();
    const s2 = getDb().insert(schema.sessions).values({ eventId: event.id, title: "Trauma-Informed Care", date: "2027-04-22", startTime: "10:30", endTime: "11:45", room: "Ballroom B", ceHours: 1.25, published: true, checkInCode: `c-${Math.random()}` }).returning().get();
    await a.api.program.sessions.add({ slug, sessionId: s2.id });
    await b.api.program.sessions.add({ slug, sessionId: s1.id });
    const mine = await a.api.program.sessions.my({ slug });
    expect(mine.items.map((i) => i.id)).toEqual([s2.id]);
    expect(mine.items[0].endsAt).toBeGreaterThan(mine.items[0].startsAt);

    // A second event Alex is registered for shows in the switcher; one Alex is not in does not.
    const second = await setupEvent({ ownerEmail: "owner2@example.org" });
    getDb().insert(schema.attendees).values({ eventId: second.event.id, email: "alex@example.com", firstName: "Alex", lastName: "Rivera", qrToken: "tok-alex-2" }).run();
    const third = await setupEvent({ ownerEmail: "owner3@example.org" });
    const events = (await a.api.core.events.mine()).filter((e) => e.isAttendee).map((e) => e.id);
    expect(events.sort()).toEqual([event.id, second.event.id].sort());
    expect(events).not.toContain(third.event.id);
    void admin;
  });
});
