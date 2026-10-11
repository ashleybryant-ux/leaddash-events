import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, setupEvent, addAttendee, getDb, schema } from "./helpers";
import { addressLines, directionsLink, mapEmbedUrl, mapQuery, hasPlace } from "@shared/address";
import { dayOfEvent } from "@shared/time";

async function liveEvent() {
  const ctx = await setupEvent();
  getDb().update(schema.events).set({ status: "live" }).where(eq(schema.events.id, ctx.event.id)).run();
  return ctx;
}

const person = { title: "", workplace: "", bio: "", photoFileId: null, sort: 0 };

describe("About host team members", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("lets admins add, edit and remove people, and shows them grouped in the app", async () => {
    const { event, admin } = await liveEvent();
    const dana = await admin.program.host.savePerson({ eventId: event.id, id: null, ...person, name: "Dana Brooks", title: "President", groupLabel: "Board of directors", bio: "Leads the board.", sort: 1 });
    await admin.program.host.savePerson({ eventId: event.id, id: null, ...person, name: "Jordan Ellis", title: "Executive Director", groupLabel: "Our team" });
    await admin.program.host.savePerson({ eventId: event.id, id: null, ...person, name: "Marcus Hill", title: "Vice President", groupLabel: "Board of directors", sort: 2 });
    await admin.program.host.savePerson({ eventId: event.id, id: null, ...person, name: "Ana Cruz", groupLabel: "Founders", sort: 3 });

    const { api } = addAttendee(event.id, "a@example.com");
    const host = await api.program.host.get({ slug: event.slug });
    expect(host.groups.map((g) => g.label)).toEqual(["Our team", "Board of directors", "Founders"]);
    expect(host.groups[1].people.map((p) => p.name)).toEqual(["Dana Brooks", "Marcus Hill"]);
    expect(host.groups[1].people[0]).toMatchObject({ title: "President", bio: "Leads the board." });

    await admin.program.host.savePerson({ eventId: event.id, id: dana.id, ...person, name: "Dana Brooks", title: "Board chair", groupLabel: "Board of directors", sort: 1 });
    expect((await admin.program.host.people({ eventId: event.id })).find((p) => p.id === dana.id)?.title).toBe("Board chair");

    await admin.program.host.removePerson({ eventId: event.id, id: dana.id });
    expect((await admin.program.host.people({ eventId: event.id })).map((p) => p.name)).not.toContain("Dana Brooks");
  });

  it("keeps attendees and other events out of team member edits", async () => {
    const { event, admin } = await liveEvent();
    const other = await setupEvent({ orgName: "Other Org", ownerEmail: "boss@example.org" });
    const p = await admin.program.host.savePerson({ eventId: event.id, id: null, ...person, name: "Dana Brooks", groupLabel: "Our team" });
    const { api } = addAttendee(event.id, "a@example.com");
    await expect(api.program.host.people({ eventId: event.id })).rejects.toThrow();
    await expect(api.program.host.savePerson({ eventId: event.id, id: null, ...person, name: "Hacker", groupLabel: "Our team" })).rejects.toThrow();
    await expect(other.admin.program.host.removePerson({ eventId: other.event.id, id: p.id })).rejects.toThrow();
    await expect(admin.program.host.savePerson({ eventId: event.id, id: null, ...person, name: "", groupLabel: "Our team" })).rejects.toThrow();
  });
});

describe("event location", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("saves the street, suite, city, state and ZIP and returns them to the app", async () => {
    const { event, admin } = await liveEvent();
    const ev = await admin.core.events.get({ eventId: event.id });
    await admin.core.events.update({
      eventId: event.id, name: ev.name, shortName: ev.shortName, startDate: ev.startDate, endDate: ev.endDate, timezone: ev.timezone, capacity: null, status: "live",
      venueName: "Grand Riverside Hotel", venueAddress: "200 Main Street", venueAddress2: "Conference level", city: "Dallas", state: "tx", zip: "75201",
    });
    const pub = await admin.core.events.publicBySlug({ slug: event.slug });
    expect(pub).toMatchObject({ venueName: "Grand Riverside Hotel", venueAddress: "200 Main Street", venueAddress2: "Conference level", city: "Dallas", state: "TX", zip: "75201" });
    await expect(
      admin.core.events.update({ eventId: event.id, name: ev.name, shortName: ev.shortName, startDate: ev.startDate, endDate: ev.endDate, timezone: ev.timezone, capacity: null, status: "live", venueName: "", venueAddress: "", city: "", zip: "7520" })
    ).rejects.toThrow();
  });

  it("builds the address lines and Google Maps links", () => {
    const v = { venueName: "Grand Riverside Hotel", venueAddress: "200 Main Street", venueAddress2: "Conference level", city: "Dallas", state: "TX", zip: "75201" };
    expect(addressLines(v)).toEqual(["200 Main Street, Conference level", "Dallas, TX 75201"]);
    expect(mapQuery(v)).toBe("Grand Riverside Hotel, 200 Main Street, Dallas, TX 75201");
    expect(mapEmbedUrl(v)).toContain("output=embed");
    expect(directionsLink(v)).toContain("destination=Grand%20Riverside%20Hotel");
    // Older events kept the whole address in one line.
    const old = { venueName: "Center", venueAddress: "650 S Griffin St, Dallas, TX 75202", city: "Dallas" };
    expect(addressLines(old)).toEqual(["650 S Griffin St, Dallas, TX 75202"]);
    expect(hasPlace({ venueName: "Center", venueAddress: "", city: "" })).toBe(false);
  });

  it("shows the day of the event only while it runs", () => {
    expect(dayOfEvent("2027-04-22", "2027-04-22", "2027-04-24")).toBe("Day 1 of 3");
    expect(dayOfEvent("2027-04-24", "2027-04-22", "2027-04-24")).toBe("Day 3 of 3");
    expect(dayOfEvent("2027-04-21", "2027-04-22", "2027-04-24")).toBe("");
  });
});

describe("sign-in page sponsors", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("shows confirmed sponsors without sign-in, and nothing while the event is a draft", async () => {
    const { event } = await setupEvent();
    const { caller } = await import("./helpers");
    getDb().insert(schema.vendors).values({ eventId: event.id, company: "Brightpath Health", kind: "sponsor", status: "paid", visible: true }).run();
    getDb().insert(schema.vendors).values({ eventId: event.id, company: "Lead Only Co", kind: "sponsor", status: "lead", visible: true }).run();
    expect(await caller(null).network.exhibitors.welcomeSponsors({ slug: event.slug })).toEqual([]);
    getDb().update(schema.events).set({ status: "live" }).where(eq(schema.events.id, event.id)).run();
    const list = await caller(null).network.exhibitors.welcomeSponsors({ slug: event.slug });
    expect(list.map((s) => s.company)).toEqual(["Brightpath Health"]);
  });
});
