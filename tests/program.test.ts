import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, setupEvent, addAttendee, outbox, getDb, schema, user, caller } from "./helpers";
import { pushLog } from "../server/_core/push";
import { runScheduledAnnouncements, runSessionReminders } from "../server/areas/program/announcements";
import { zonedToDate } from "@shared/time";

const base = { description: "", kind: "session" as const, room: "Room 204", track: "Clinical", ceHours: 1.5, capacity: null, requiresSignup: false, published: true, evaluationId: null, evaluationOpens: "end" as const, certificateTemplateId: null, certificateAfter: null };

async function liveEvent() {
  const ctx = await setupEvent();
  getDb().update(schema.events).set({ status: "live" }).where(eq(schema.events.id, ctx.event.id)).run();
  return ctx;
}

describe("program", () => {
  beforeEach(async () => {
    await freshDb();
    pushLog.length = 0;
  });

  it("seeds default help articles and keeps attendees out of admin routes", async () => {
    const { event, admin } = await liveEvent();
    const { api } = addAttendee(event.id, "a@example.com");
    const help = await admin.program.help.adminGet({ eventId: event.id });
    expect(help.articles.map((a) => a.question)).toContain("What is the Wi-Fi?");
    expect(help.articles.length).toBe(5);

    await expect(api.program.sessions.adminList({ eventId: event.id })).rejects.toThrow();
    await expect(api.program.sessions.create({ eventId: event.id, title: "Hack", date: "2027-04-22", startTime: "09:00", endTime: "10:00", ...base })).rejects.toThrow();
    await expect(api.program.speakers.adminList({ eventId: event.id })).rejects.toThrow();
    await expect(api.program.announcements.create({ eventId: event.id, title: "Hi all", body: "", audience: "everyone", ticketTypeId: null, sessionId: null, url: "", sendPush: true, sendEmail: false, sendAt: null, draft: false })).rejects.toThrow();
    await expect(api.program.branding.get({ eventId: event.id })).rejects.toThrow();
    await expect(api.program.dining.adminList({ eventId: event.id })).rejects.toThrow();
    await expect(api.program.host.adminGet({ eventId: event.id })).rejects.toThrow();
    await expect(api.program.help.adminGet({ eventId: event.id })).rejects.toThrow();

    // Someone not registered cannot read the agenda.
    await expect(caller(user("stranger@example.com")).program.sessions.agenda({ slug: event.slug })).rejects.toThrow();
  });

  it("checks session times and generates a check-in code", async () => {
    const { event, admin } = await liveEvent();
    await expect(admin.program.sessions.create({ eventId: event.id, title: "Backwards", date: "2027-04-22", startTime: "11:00", endTime: "10:00", ...base })).rejects.toThrow(/ends before/);
    await expect(admin.program.sessions.create({ eventId: event.id, title: "Too late", date: "2027-05-22", startTime: "09:00", endTime: "10:00", ...base })).rejects.toThrow(/between/);
    const s = await admin.program.sessions.create({ eventId: event.id, title: "Opening Keynote", date: "2027-04-22", startTime: "08:30", endTime: "10:00", ...base });
    expect(s.checkInCode.length).toBeGreaterThanOrEqual(8);
  });

  it("adds and removes My agenda items, warns about overlaps, and enforces capacity", async () => {
    const { event, admin } = await liveEvent();
    const a = await admin.program.sessions.create({ eventId: event.id, title: "Trauma Care", date: "2027-04-22", startTime: "10:30", endTime: "12:00", ...base });
    const b = await admin.program.sessions.create({ eventId: event.id, title: "Group Practice", date: "2027-04-22", startTime: "11:00", endTime: "12:30", ...base });
    const small = await admin.program.sessions.create({ eventId: event.id, title: "Workshop", date: "2027-04-23", startTime: "09:00", endTime: "10:00", ...base, capacity: 1, requiresSignup: true });
    const one = addAttendee(event.id, "one@example.com", "Avery", "Carter");
    const two = addAttendee(event.id, "two@example.com", "Jordan", "Mitchell");

    const first = await one.api.program.sessions.add({ slug: event.slug, sessionId: a.id });
    expect(first.conflicts).toEqual([]);
    const second = await one.api.program.sessions.add({ slug: event.slug, sessionId: b.id });
    expect(second.conflicts.map((c) => c.title)).toEqual(["Trauma Care"]);

    let my = await one.api.program.sessions.my({ slug: event.slug });
    expect(my.items.map((i) => i.title)).toEqual(["Trauma Care", "Group Practice"]);
    expect(my.items[0].conflicts[0].title).toBe("Group Practice");

    await one.api.program.sessions.remove({ slug: event.slug, sessionId: b.id });
    my = await one.api.program.sessions.my({ slug: event.slug });
    expect(my.items.length).toBe(1);

    await one.api.program.sessions.add({ slug: event.slug, sessionId: small.id });
    await expect(two.api.program.sessions.add({ slug: event.slug, sessionId: small.id })).rejects.toThrow(/full/);
    const agenda = await two.api.program.sessions.agenda({ slug: event.slug });
    expect(agenda.sessions.find((s) => s.id === small.id)?.seatsLeft).toBe(0);
    expect(agenda.tracks).toEqual(["Clinical"]);

    // Someone else's agenda is never touched.
    await two.api.program.sessions.remove({ slug: event.slug, sessionId: a.id });
    expect((await one.api.program.sessions.my({ slug: event.slug })).items.length).toBe(2);
  });

  it("sends announcements by push and email, and scheduled ones on time", async () => {
    const { event, admin } = await liveEvent();
    const signedIn = addAttendee(event.id, "in@example.com", "Avery", "Carter");
    // Registered but never signed in: no user yet, so email only.
    getDb().insert(schema.attendees).values({ eventId: event.id, email: "new@example.com", firstName: "Sam", lastName: "Lee", qrToken: "tok-new" }).run();

    const res = await admin.program.announcements.create({ eventId: event.id, title: "Lunch is served", body: "Grand Ballroom", audience: "everyone", ticketTypeId: null, sessionId: null, url: "", sendPush: true, sendEmail: true, sendAt: null, draft: false });
    expect(res.recipients).toBe(2);
    expect(pushLog.map((p) => p.userId)).toEqual([signedIn.user.id]);
    expect(outbox.filter((m) => m.subject === "Lunch is served").map((m) => m.to).sort()).toEqual(["in@example.com", "new@example.com"]);
    const alerts = await signedIn.api.core.notifications.list({ eventId: event.id });
    expect(alerts[0].title).toBe("Lunch is served");

    const list = await admin.program.announcements.list({ eventId: event.id });
    expect(list[0].sentAt).toBeTruthy();
    expect(list[0].recipients).toBe(2);
    expect(list[0].openedPercent).toBe(0);

    // Scheduled: nothing until it is due.
    pushLog.length = 0;
    const later = await admin.program.announcements.create({ eventId: event.id, title: "Doors open", body: "", audience: "everyone", ticketTypeId: null, sessionId: null, url: "", sendPush: true, sendEmail: false, sendAt: Date.now() + 3600_000, draft: false });
    await runScheduledAnnouncements();
    expect(pushLog.length).toBe(0);
    getDb().update(schema.announcements).set({ sendAt: new Date(Date.now() - 1000) }).where(eq(schema.announcements.id, later.id)).run();
    await runScheduledAnnouncements();
    await runScheduledAnnouncements();
    expect(pushLog.filter((p) => p.title === "Doors open").length).toBe(1);

    // Attendees who turned off announcement push still get the alert, without push.
    await signedIn.api.program.alerts.setPrefs({ slug: event.slug, reminders: true, evaluations: true, changes: true, announcements: false });
    pushLog.length = 0;
    await admin.program.announcements.create({ eventId: event.id, title: "Quiet one", body: "", audience: "everyone", ticketTypeId: null, sessionId: null, url: "", sendPush: true, sendEmail: false, sendAt: null, draft: false });
    expect(pushLog.length).toBe(0);
    expect((await signedIn.api.core.notifications.list({ eventId: event.id }))[0].title).toBe("Quiet one");
  });

  it("sends announcements to the people in one session", async () => {
    const { event, admin } = await liveEvent();
    const s = await admin.program.sessions.create({ eventId: event.id, title: "Ethics", date: "2027-04-22", startTime: "14:00", endTime: "15:30", ...base });
    const inSession = addAttendee(event.id, "x@example.com");
    addAttendee(event.id, "y@example.com");
    await inSession.api.program.sessions.add({ slug: event.slug, sessionId: s.id });
    const res = await admin.program.announcements.create({ eventId: event.id, title: "Room change", body: "Now in Room 118", audience: "session", ticketTypeId: null, sessionId: s.id, url: "", sendPush: true, sendEmail: false, sendAt: null, draft: false });
    expect(res.recipients).toBe(1);
    expect(pushLog.map((p) => p.userId)).toEqual([inSession.user.id]);
  });

  it("reminds people 15 minutes before a session, once", async () => {
    const { event, admin } = await liveEvent();
    const s = await admin.program.sessions.create({ eventId: event.id, title: "Trauma Care", date: "2027-04-22", startTime: "10:30", endTime: "12:00", ...base });
    const on = addAttendee(event.id, "on@example.com");
    const off = addAttendee(event.id, "off@example.com");
    await on.api.program.sessions.add({ slug: event.slug, sessionId: s.id });
    await off.api.program.sessions.add({ slug: event.slug, sessionId: s.id });
    await off.api.program.sessions.setRemind({ slug: event.slug, sessionId: s.id, remind: false });

    const start = zonedToDate("2027-04-22", "10:30", event.timezone);
    await runSessionReminders(new Date(start.getTime() - 30 * 60_000));
    expect(pushLog.length).toBe(0);
    await runSessionReminders(new Date(start.getTime() - 15 * 60_000));
    expect(pushLog.map((p) => [p.userId, p.title])).toEqual([[on.user.id, "Starting in 15 minutes"]]);
    await runSessionReminders(new Date(start.getTime() - 14 * 60_000));
    expect(pushLog.length).toBe(1);
    const item = getDb().select().from(schema.scheduleItems).where(eq(schema.scheduleItems.attendeeId, on.attendee.id)).get();
    expect(item?.remindedAt).toBeTruthy();
  });

  it("tells My agenda people when a room changes", async () => {
    const { event, admin } = await liveEvent();
    const s = await admin.program.sessions.create({ eventId: event.id, title: "Ethics", date: "2027-04-22", startTime: "14:00", endTime: "15:30", ...base });
    const a = addAttendee(event.id, "x@example.com");
    await a.api.program.sessions.add({ slug: event.slug, sessionId: s.id });
    await admin.program.sessions.update({ eventId: event.id, sessionId: s.id, title: "Ethics", date: "2027-04-22", startTime: "14:00", endTime: "15:30", ...base, room: "Room 118" });
    expect(pushLog[0]).toMatchObject({ userId: a.user.id, title: "Room change", body: "Ethics moved to Room 118." });
  });

  it("answers help requests and tells the attendee", async () => {
    const { event, admin } = await liveEvent();
    const a = addAttendee(event.id, "help@example.com", "Avery", "Carter");
    const other = addAttendee(event.id, "other@example.com");
    const { id } = await a.api.program.help.send({ slug: event.slug, topic: "Badge", message: "My badge has the wrong last name." });
    const inbox = await admin.program.help.adminGet({ eventId: event.id });
    expect(inbox.requests[0]).toMatchObject({ attendeeName: "Avery Carter", status: "open" });

    await expect(a.api.program.help.reply({ eventId: event.id, id, reply: "Nope" })).rejects.toThrow();
    await admin.program.help.reply({ eventId: event.id, id, reply: "Come to the desk and we will reprint it." });
    expect(pushLog.at(-1)).toMatchObject({ userId: a.user.id, title: "The help desk replied" });
    const page = await a.api.program.help.page({ slug: event.slug });
    expect(page.requests[0]).toMatchObject({ status: "answered", reply: "Come to the desk and we will reprint it." });
    expect((await other.api.program.help.page({ slug: event.slug })).requests).toEqual([]);

    await admin.program.help.setRequestStatus({ eventId: event.id, id, status: "closed" });
    expect((await a.api.program.help.page({ slug: event.slug })).requests[0].status).toBe("closed");
  });

  it("tells owners when a lost item turns up", async () => {
    const { event, admin } = await liveEvent();
    const a = addAttendee(event.id, "lost@example.com");
    const { id } = await a.api.program.help.report({ slug: event.slug, category: "Phone", item: "Black iPhone in a green case", place: "Room 204" });
    await admin.program.help.setItemStatus({ eventId: event.id, id, status: "claimed" });
    expect(pushLog.at(-1)).toMatchObject({ userId: a.user.id, title: "We found your item" });
    const mine = await a.api.program.help.lostFound({ slug: event.slug });
    expect(mine.mine[0].status).toBe("claimed");
  });

  it("saves speakers with sessions and shows them to attendees", async () => {
    const { event, admin } = await liveEvent();
    const s = await admin.program.sessions.create({ eventId: event.id, title: "Trauma Care", date: "2027-04-22", startTime: "10:30", endTime: "12:00", ...base });
    const sp = await admin.program.speakers.create({ eventId: event.id, firstName: "Taylor", lastName: "Reed", credentials: "PhD", jobTitle: "Counselor educator", organization: "", city: "Houston, TX", bio: "Bio", headshotFileId: null, website: "https://example.org", email: "taylor@example.com", featured: false, allowMessages: true, sort: 0 });
    expect(sp.name).toBe("Taylor Reed");
    await admin.program.sessions.setSpeakers({ eventId: event.id, sessionId: s.id, speakers: [{ speakerId: sp.id, role: "presenter" }] });
    const { api } = addAttendee(event.id, "a@example.com");
    const list = await api.program.speakers.list({ slug: event.slug, q: "trauma" });
    expect(list[0]).toMatchObject({ name: "Taylor Reed, PhD", sessions: [{ title: "Trauma Care", role: "presenter" }] });
    const detail = await api.program.sessions.get({ slug: event.slug, sessionId: s.id });
    expect(detail.speakers[0]).toMatchObject({ name: "Taylor Reed, PhD", role: "presenter" });
  });

  it("lets admins save branding, features and the host page", async () => {
    const { event, admin } = await liveEvent();
    const b = await admin.program.branding.get({ eventId: event.id });
    await admin.program.branding.update({ eventId: event.id, appName: "NABC 2027", colorPrimary: "#123456", colorAccent: "#abcdef", logoFileId: null, coverFileId: null, iconFileId: null, badge: { ...b.badge, nameStyle: "full", showQr: true }, features: { ...b.features, dining: false } });
    const again = await admin.program.branding.get({ eventId: event.id });
    expect(again).toMatchObject({ appName: "NABC 2027", colorPrimary: "#123456", badge: { nameStyle: "full" }, features: { dining: false } });

    await admin.program.host.update({ eventId: event.id, name: "NABC", about: "About us", mission: "", imageFileId: null, joinMode: "member", joinUrl: "", website: "https://nabc.example.org", email: "info@example.org", phone: "555-0100", instagram: "", facebook: "", linkedin: "" });
    const { api } = addAttendee(event.id, "a@example.com");
    const host = await api.program.host.get({ slug: event.slug });
    expect(host).toMatchObject({ name: "NABC", email: "info@example.org", phone: "555-0100", website: "https://nabc.example.org" });
    expect(host.joinUrl).toMatch(/^\/m\//);
    expect((await api.program.dining.list({ slug: event.slug })).menu).toEqual([]);
  });
  it("saves the app look, keeps it when left out, and shows it on attendee pages", async () => {
    const { event, admin } = await liveEvent();
    const b = await admin.program.branding.get({ eventId: event.id });
    expect(b.look).toEqual({ header: "solid", buttonShape: "rounded", font: "jakarta", buttonText: "auto", background: "gray", textSize: "standard" });
    const look = { header: "light" as const, buttonShape: "pill" as const, font: "lora" as const, buttonText: "dark" as const, background: "white" as const, textSize: "larger" as const };
    const rest = { eventId: event.id, appName: "", logoFileId: null, coverFileId: null, iconFileId: null, badge: { ...b.badge, nameStyle: "first" as const, showQr: true }, features: b.features };
    await admin.program.branding.update({ ...rest, colorPrimary: "#5B2A6E", colorAccent: "#E2B33C", look });
    expect((await admin.program.branding.get({ eventId: event.id })).look).toEqual(look);

    // An older screen that does not send the look leaves it alone.
    await admin.program.branding.update({ ...rest, colorPrimary: "#5B2A6E", colorAccent: "#E2B33C" });
    expect((await admin.program.branding.get({ eventId: event.id })).look).toEqual(look);
    await expect(admin.program.branding.update({ ...rest, colorPrimary: "#5B2A6E", colorAccent: "#E2B33C", look: { ...look, font: "comic" as never } })).rejects.toThrow();

    const { api } = addAttendee(event.id, "a@example.com");
    const pub = await api.core.events.publicBySlug({ slug: event.slug });
    expect(pub.branding).toMatchObject({ colorPrimary: "#5B2A6E", font: "lora", buttonShape: "pill", header: "light" });
    const cfp = await api.network.proposals.info({ slug: event.slug });
    expect(cfp.branding).toMatchObject({ font: "lora" });
  });

  it("saves dining and badge band colors, and keeps attendees out of editing them", async () => {
    const { event, admin } = await liveEvent();
    const a = addAttendee(event.id, "a@example.com");
    await expect(a.api.program.dining.saveMeal({ eventId: event.id, id: null, date: "2027-04-22", meal: "Lunch", time: "12:00", endTime: "13:15", location: "Ballroom", items: [], note: "", sort: 0 })).rejects.toThrow();
    await expect(admin.program.dining.saveMeal({ eventId: event.id, id: null, date: "2027-05-01", meal: "Lunch", time: "", endTime: "", location: "", items: [], note: "", sort: 0 })).rejects.toThrow(/during the event/);
    await admin.program.dining.saveMeal({ eventId: event.id, id: null, date: "2027-04-22", meal: "Lunch", time: "12:00", endTime: "13:15", location: "Grand Ballroom", items: [{ name: "Black bean bowl", dietary: ["VG", "GF"] }], note: "", sort: 0 });
    await admin.program.dining.savePlace({ eventId: event.id, id: null, title: "Corner Grind Coffee", category: "coffee", cuisine: "", price: "$", walkMinutes: 2, description: "", address: "", url: "", phone: "", note: "10% with badge", sort: 0 });
    const list = await a.api.program.dining.list({ slug: event.slug });
    expect(list.menu[0]).toMatchObject({ meal: "Lunch", dietary: ["VG", "GF"] });
    expect(list.nearby[0]).toMatchObject({ title: "Corner Grind Coffee", walkMinutes: 2, note: "10% with badge" });

    const b = await admin.program.branding.get({ eventId: event.id });
    expect(b.badge.bandColors?.speaker).toMatch(/^#/);
    await admin.program.branding.update({ eventId: event.id, appName: "", colorPrimary: b.colorPrimary, colorAccent: b.colorAccent, logoFileId: null, coverFileId: null, iconFileId: null, badge: { showCredentials: true, showOrg: false, showCity: true, ribbonByTicket: true, size: "4x6", nameStyle: "first", showQr: true, bandColors: { attendee: "#111111", speaker: "#222222", vendor: "#333333", staff: "#444444" } }, features: b.features });
    expect((await admin.program.branding.get({ eventId: event.id })).badge).toMatchObject({ size: "4x6", bandColors: { speaker: "#222222" } });
    await expect(a.api.program.speakers.create({ eventId: event.id, firstName: "Hack", lastName: "", credentials: "", jobTitle: "", organization: "", city: "", bio: "", headshotFileId: null, website: "", email: "", featured: false, allowMessages: true, sort: 0 })).rejects.toThrow();
  });
});
