import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, setupEvent, addAttendee, getDb, schema } from "./helpers";
import { readDate, readTime } from "../server/areas/program/importer";

// The sample event runs Apr 22, 2027 to Apr 24, 2027.
const sessionsCsv = [
  "Title,Date,Start time,End time,Room,Track,Type,CE hours,Speakers,Description",
  "Ethics in Telehealth,4/22/2027,1:30 PM,3:00 PM,Ballroom A,Ethics,,1.5,Priya Rao PhD,Telehealth ethics.",
  '"Trauma and the Body","Apr 23, 2027",9:00 AM,12:15 PM,Room 204,,Workshop,3,"Dana Brooks, LPC; Taylor Reed",',
  "Networking Lunch,2027-04-23,12:15 PM,1:30 PM,Terrace,,Lunch,,,",
  "Supervision Roundtable,Apr 26 2027,3:00 PM,4:00 PM,Room 110,,,1,Jordan Ellis,",
  "Late Night,Apr 24 2027,9:00 PM,8:00 PM,,,,,,",
  "Ethics in Telehealth,4/22/2027,1:30 PM,3:00 PM,Ballroom A,Ethics,,1.5,Priya Rao PhD,Telehealth ethics.",
].join("\n");

describe("program import", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("reads dates and times the way people type them", () => {
    expect(readDate("Mar 11, 2027")).toBe("2027-03-11");
    expect(readDate("Thursday, March 11, 2027")).toBe("2027-03-11");
    expect(readDate("3/11/2027")).toBe("2027-03-11");
    expect(readDate("3/11/27")).toBe("2027-03-11");
    expect(readDate("2027-02-30")).toBeNull();
    expect(readTime("10:30 AM")).toBe("10:30");
    expect(readTime("1:30pm")).toBe("13:30");
    expect(readTime("12 PM")).toBe("12:00");
    expect(readTime("12:15 a.m.")).toBe("00:15");
    expect(readTime("13:30")).toBe("13:30");
    expect(readTime("9")).toBeNull();
  });

  it("checks every session row without saving, then imports the ready ones with their speakers", async () => {
    const { event, admin } = await setupEvent();
    await admin.program.speakers.create({ eventId: event.id, firstName: "Taylor", lastName: "Reed", credentials: "LMFT" });
    const check = await admin.program.import.checkSessions({ eventId: event.id, csv: sessionsCsv });
    expect(check.counts).toEqual({ ready: 3, exists: 0, fix: 3, newSpeakers: 2 });
    expect(check.rows.find((r) => r.line === 5)?.problem).toContain("after the event ends");
    expect(check.rows.find((r) => r.line === 6)?.problem).toBe("The session ends before it starts.");
    expect(check.rows.find((r) => r.line === 7)?.problem).toBe("This session is in the file twice.");
    const trauma = check.rows.find((r) => r.title === "Trauma and the Body")!;
    expect(trauma).toMatchObject({ date: "2027-04-23", startTime: "09:00", endTime: "12:15", kind: "workshop", ceHours: 3 });
    expect(trauma.speakers).toEqual([{ name: "Dana Brooks, LPC", isNew: true }, { name: "Taylor Reed, LMFT", isNew: false }]);
    expect(check.rows.find((r) => r.title === "Networking Lunch")?.kind).toBe("meal");
    expect(getDb().select().from(schema.sessions).where(eq(schema.sessions.eventId, event.id)).all()).toHaveLength(0);

    const done = await admin.program.import.runSessions({ eventId: event.id, csv: sessionsCsv });
    expect(done).toEqual({ added: 3, newSpeakers: 2, skipped: 0, notAdded: [5, 6, 7] });
    const sessions = getDb().select().from(schema.sessions).where(eq(schema.sessions.eventId, event.id)).all();
    expect(sessions.map((s) => s.title).sort()).toEqual(["Ethics in Telehealth", "Networking Lunch", "Trauma and the Body"]);
    expect(new Set(sessions.map((s) => s.checkInCode)).size).toBe(3);
    const speakers = getDb().select().from(schema.speakers).where(eq(schema.speakers.eventId, event.id)).all();
    expect(speakers.map((s) => `${s.name}|${s.credentials}`).sort()).toEqual(["Dana Brooks|LPC", "Priya Rao PhD|", "Taylor Reed|LMFT"]);
    const t = sessions.find((s) => s.title === "Trauma and the Body")!;
    expect(getDb().select().from(schema.sessionSpeakers).where(eq(schema.sessionSpeakers.sessionId, t.id)).all()).toHaveLength(2);

    // Importing the same file again adds nothing.
    const again = await admin.program.import.runSessions({ eventId: event.id, csv: sessionsCsv });
    expect(again).toMatchObject({ added: 0, newSpeakers: 0, skipped: 4 });
  });

  it("imports speakers, skipping ones already on the list, and accepts one Name column", async () => {
    const { event, admin } = await setupEvent();
    await admin.program.speakers.create({ eventId: event.id, firstName: "Lena", lastName: "Hart", email: "lena@example.com" });
    const csv = [
      "First name,Last name,Credentials,Job title,Organization,City,Email,Website,Bio",
      "Dana,Brooks,LPC,Clinical Director,Brookside Counseling,\"Nashville, TN\",dana@example.com,brookside.example.com,Bio here.",
      "Lena,Hart,,,,,LENA@example.com,,",
      ",NoFirst,,,,,,,",
      "Ana,Cruz,PhD,,,,not-an-email,,",
    ].join("\n");
    const check = await admin.program.import.checkSpeakers({ eventId: event.id, csv });
    expect(check.counts).toEqual({ ready: 1, update: 0, exists: 1, fix: 2 });
    const done = await admin.program.import.runSpeakers({ eventId: event.id, csv });
    expect(done).toEqual({ added: 1, updated: 0, skipped: 1, notAdded: [4, 5] });
    const dana = getDb().select().from(schema.speakers).where(eq(schema.speakers.email, "dana@example.com")).get()!;
    expect(dana).toMatchObject({ name: "Dana Brooks", credentials: "LPC", city: "Nashville, TN", website: "https://brookside.example.com" });

    const byName = await admin.program.import.checkSpeakers({ eventId: event.id, csv: "Name,Email\n\"Ana Cruz, PhD\",ana@example.com\n" });
    expect(byName.rows[0]).toMatchObject({ firstName: "Ana", lastName: "Cruz", credentials: "PhD", status: "ready" });
  });

  it("fills in a speaker a session import added by name, without making a second one", async () => {
    const { event, admin } = await setupEvent();
    await admin.program.import.runSessions({ eventId: event.id, csv: "Title,Date,Start time,End time,Speakers\nGrief Work,4/22/2027,10:30 AM,12:00 PM,\"Dana Brooks, LPC\"\n" });
    const csv = "First name,Last name,Credentials,Job title,Email,Bio\nDana,Brooks,LCSW,Clinical Director,dana@example.com,Her bio.\n";
    const check = await admin.program.import.checkSpeakers({ eventId: event.id, csv });
    expect(check.counts).toEqual({ ready: 0, update: 1, exists: 0, fix: 0 });
    expect(await admin.program.import.runSpeakers({ eventId: event.id, csv })).toMatchObject({ added: 0, updated: 1 });
    const all = getDb().select().from(schema.speakers).where(eq(schema.speakers.eventId, event.id)).all();
    expect(all).toHaveLength(1);
    // Fills what was missing and keeps what was there (the credentials from the session file).
    expect(all[0]).toMatchObject({ name: "Dana Brooks", credentials: "LPC", jobTitle: "Clinical Director", email: "dana@example.com", bio: "Her bio." });
    expect((await admin.program.import.checkSpeakers({ eventId: event.id, csv })).counts).toMatchObject({ update: 0, exists: 1 });
  });

  it("asks for a header row and keeps attendees out", async () => {
    const { event, admin } = await setupEvent();
    await expect(admin.program.import.checkSessions({ eventId: event.id, csv: "Opening,4/22/2027,9 AM,10 AM\n" })).rejects.toThrow("Add a header row");
    const { api } = addAttendee(event.id, "a@example.com");
    await expect(api.program.import.runSessions({ eventId: event.id, csv: sessionsCsv })).rejects.toThrow();
    await expect(api.program.import.checkSpeakers({ eventId: event.id, csv: "First name,Last name\nA,B\n" })).rejects.toThrow();
  });
});
