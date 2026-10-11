import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, setupEvent, caller, user, getDb, schema } from "./helpers";
import { ENV } from "../server/_core/env";
import { eventHasEnded } from "@shared/time";

const newEvent = { name: "Second Event", shortName: "", startDate: "2028-04-20", endDate: "2028-04-22" };

function staff() {
  if (!ENV.staffEmails.includes("tech@leaddash.io")) ENV.staffEmails.push("tech@leaddash.io");
  return caller(user("tech@leaddash.io", "Tech Support"));
}

async function details(eventId: number, admin: ReturnType<typeof caller>) {
  const ev = await admin.core.events.get({ eventId });
  return { eventId, name: ev.name, shortName: ev.shortName, startDate: ev.startDate, endDate: ev.endDate, timezone: ev.timezone, venueName: ev.venueName, venueAddress: ev.venueAddress, city: ev.city, capacity: null, status: ev.status };
}

describe("events an organization may add", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("stops a new event once the included events are used, until LeadDash staff raise the number", async () => {
    const { org, admin } = await setupEvent();
    expect((await admin.core.org.get({ orgId: org.id })).eventAllowance).toBe(1);
    await expect(admin.core.events.create({ orgId: org.id, ...newEvent })).rejects.toThrow("Your account includes 1 event");

    await expect(admin.core.org.setEventAllowance({ orgId: org.id, eventAllowance: 2 })).rejects.toThrow();
    await staff().core.org.setEventAllowance({ orgId: org.id, eventAllowance: 2 });
    const ev = await admin.core.events.create({ orgId: org.id, ...newEvent });
    expect(ev.name).toBe("Second Event");
    await expect(admin.core.events.create({ orgId: org.id, ...newEvent, name: "Third Event" })).rejects.toThrow("Your account includes 2 events");
  });

  it("never sets the number below the events the organization already has", async () => {
    const { org } = await setupEvent();
    getDb().update(schema.organizations).set({ eventAllowance: 3 }).where(eq(schema.organizations.id, org.id)).run();
    await expect(staff().core.org.setEventAllowance({ orgId: org.id, eventAllowance: 0 })).rejects.toThrow();
    await staff().core.org.setEventAllowance({ orgId: org.id, eventAllowance: 1 });
    expect(getDb().select().from(schema.organizations).where(eq(schema.organizations.id, org.id)).get()!.eventAllowance).toBe(1);
  });
});

describe("dates lock after an event ends", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("lets admins move dates before the event, and locks dates and status after it ends", async () => {
    const { event, admin } = await setupEvent();
    const before = await details(event.id, admin);
    await admin.core.events.update({ ...before, startDate: "2027-05-01", endDate: "2027-05-03" });
    expect((await admin.core.events.get({ eventId: event.id })).ended).toBe(false);

    getDb().update(schema.events).set({ startDate: "2024-03-01", endDate: "2024-03-03", status: "live" }).where(eq(schema.events.id, event.id)).run();
    const ended = await details(event.id, admin);
    expect((await admin.core.events.get({ eventId: event.id })).ended).toBe(true);
    await expect(admin.core.events.update({ ...ended, startDate: "2028-03-01", endDate: "2028-03-03" })).rejects.toThrow("dates are locked");
    await expect(admin.core.events.update({ ...ended, status: "draft" })).rejects.toThrow("can't be opened again");
    await admin.core.events.update({ ...ended, name: "Renamed Summit", status: "ended" });
    const after = await admin.core.events.get({ eventId: event.id });
    expect(after).toMatchObject({ name: "Renamed Summit", status: "ended", startDate: "2024-03-01" });
    await expect(admin.core.events.update({ ...(await details(event.id, admin)), status: "live" })).rejects.toThrow("can't be opened again");
  });

  it("lets only LeadDash staff change an ended event's dates", async () => {
    const { event, admin } = await setupEvent();
    getDb().update(schema.events).set({ startDate: "2024-03-01", endDate: "2024-03-03" }).where(eq(schema.events.id, event.id)).run();
    await expect(admin.core.events.setDates({ eventId: event.id, startDate: "2028-03-01", endDate: "2028-03-03" })).rejects.toThrow();
    await expect(staff().core.events.setDates({ eventId: event.id, startDate: "2028-03-05", endDate: "2028-03-03" })).rejects.toThrow();
    await staff().core.events.setDates({ eventId: event.id, startDate: "2028-03-01", endDate: "2028-03-03" });
    expect(await admin.core.events.get({ eventId: event.id })).toMatchObject({ startDate: "2028-03-01", ended: false });
  });

  it("counts the last day as over only after it ends in the event's time zone", () => {
    const at = new Date("2027-04-25T04:30:00Z"); // 11:30 PM on Apr 24, 2027 in Chicago, 12:30 AM on Apr 25 in New York
    expect(eventHasEnded("2027-04-24", "America/Chicago", at)).toBe(false);
    expect(eventHasEnded("2027-04-24", "America/New_York", at)).toBe(true);
    expect(eventHasEnded("2027-04-24", "Not/AZone", new Date("2027-04-26T12:00:00Z"))).toBe(true);
  });
});
