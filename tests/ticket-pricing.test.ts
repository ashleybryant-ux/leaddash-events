import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, setupEvent, getDb, schema, caller } from "./helpers";
import { phaseOn, priceView } from "@shared/pricing";
import { ticketsOnSale } from "../server/areas/registration/logic";

const set = { early: 57500, regular: 67500, late: 79500 };
const dates = { earlyEndsOn: "2026-12-31", lateStartsOn: "2027-03-31" };

describe("price by date", () => {
  it("picks early bird, regular and late by the date", () => {
    expect(phaseOn(dates, set, "2026-10-10")).toBe("early");
    expect(phaseOn(dates, set, "2026-12-31")).toBe("early");
    expect(phaseOn(dates, set, "2027-01-01")).toBe("regular");
    expect(phaseOn(dates, set, "2027-03-31")).toBe("late");
    const v = priceView(dates, set, "2026-10-10");
    expect(v).toMatchObject({ phase: "early", cents: 57500, regularCents: 67500, saveCents: 10000 });
    expect(v.steps.map((s) => [s.phase, s.from, s.until])).toEqual([["early", null, "2026-12-31"], ["regular", "2027-01-01", "2027-03-30"], ["late", "2027-03-31", null]]);
    expect(priceView(dates, set, "2027-04-01").steps.map((s) => s.phase)).toEqual(["late"]);
  });
});

describe("tickets with buyer types", () => {
  beforeEach(async () => {
    await freshDb();
  });

  async function setup() {
    const ctx = await setupEvent();
    getDb().update(schema.events).set({ status: "live" }).where(eq(schema.events.id, ctx.event.id)).run();
    await ctx.admin.registration.buyerTypes.save({
      eventId: ctx.event.id,
      list: [
        { id: "", name: "Member", memberId: true, school: false, code: "" },
        { id: "", name: "Non-member", memberId: false, school: false, code: "" },
        { id: "", name: "Speaker", memberId: false, school: false, code: "Stage27" },
      ],
    });
    getDb().update(schema.ticketTypes).set({ active: false }).where(eq(schema.ticketTypes.eventId, ctx.event.id)).run();
    const { id } = await ctx.admin.registration.tickets.save({
      eventId: ctx.event.id, name: "Conference only", description: "", priceCents: 0, quantity: null, saleEndsOn: null, afterSale: "close", switchToTicketId: null,
      earlyEndsOn: "2099-12-31", lateStartsOn: null, buyerTypes: ["member", "non-member"],
      buyerPrices: { member: { early: 57500, regular: 67500, late: null }, "non-member": { early: 67500, regular: 79500, late: null } },
      includes: "All days", audience: "anyone", ribbon: "", active: true,
    });
    const speaker = await ctx.admin.registration.tickets.save({
      eventId: ctx.event.id, name: "Speaker", description: "", priceCents: 0, quantity: null, saleEndsOn: null, afterSale: "close", switchToTicketId: null,
      buyerTypes: ["speaker"], buyerPrices: { speaker: { early: null, regular: 0, late: null } }, includes: "All days", audience: "anyone", ribbon: "Speaker", active: true,
    });
    return { ...ctx, ticketId: id, speakerId: speaker.id };
  }

  const buyer = (answers: Record<string, string> = {}) => ({ firstName: "Robin", lastName: "Hale", email: "robin@example.com", phone: "5555550100", credentials: "", licenseNumber: "123", licenseState: "OK", answers, textConsent: false });

  it("prices each buyer type by date and keeps the base price on the first buyer type", async () => {
    const s = await setup();
    const pub = caller(null).registration;
    expect((await pub.quote({ slug: s.event.slug, ticketId: s.ticketId, buyerType: "member" })).amountCents).toBe(57500);
    expect((await pub.quote({ slug: s.event.slug, ticketId: s.ticketId, buyerType: "non-member" })).amountCents).toBe(67500);
    await expect(pub.quote({ slug: s.event.slug, ticketId: s.ticketId })).rejects.toThrow(/who is registering/);
    await expect(pub.quote({ slug: s.event.slug, ticketId: s.ticketId, buyerType: "speaker" })).rejects.toThrow(/not for Speaker/);
    const row = getDb().select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, s.ticketId)).get()!;
    expect(row).toMatchObject({ priceCents: 67500, earlyPriceCents: 57500 });
    const page = await pub.page({ slug: s.event.slug });
    expect(page.page.buyerTypes.find((b) => b.id === "speaker")).toEqual({ id: "speaker", name: "Speaker", memberId: false, school: false, needsCode: true });
    expect(JSON.stringify(page)).not.toContain("Stage27");
  });

  it("asks for the member ID and the speaker code, and keeps the buyer type with the answers", async () => {
    const s = await setup();
    const pub = caller(null).registration;
    await expect(pub.check({ slug: s.event.slug, ticketId: s.ticketId, buyer: buyer(), buyerType: "member" })).rejects.toThrow(/member ID/);
    await expect(pub.start({ slug: s.event.slug, ticketId: s.speakerId, buyer: buyer({ buyer_code: "nope" }), buyerType: "speaker" })).rejects.toThrow(/speaker code/);
    const res = await pub.start({ slug: s.event.slug, ticketId: s.speakerId, buyer: buyer({ buyer_code: "stage27" }), buyerType: "speaker" });
    expect(res.kind).toBe("free");
    const order = getDb().select().from(schema.orders).where(eq(schema.orders.email, "robin@example.com")).get()!;
    expect((order.buyer as { answers: Record<string, string> }).answers).toEqual({ buyer_type: "Speaker" });
  });

  it("refuses an early bird price with no date order and turns early prices off without a date", async () => {
    const s = await setup();
    const base = { eventId: s.event.id, name: "Workshop", description: "", quantity: null, saleEndsOn: null, afterSale: "close" as const, switchToTicketId: null, includes: "One day", audience: "anyone" as const, ribbon: "", active: true };
    await expect(s.admin.registration.tickets.save({ ...base, priceCents: 10000, earlyEndsOn: "2027-04-01", earlyPriceCents: 8000, lateStartsOn: "2027-03-01", latePriceCents: 12000 })).rejects.toThrow(/before late/);
    const { id } = await s.admin.registration.tickets.save({ ...base, priceCents: 10000, earlyEndsOn: null, earlyPriceCents: 8000 });
    expect(getDb().select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, id)).get()!.earlyPriceCents).toBeNull();
    const offers = ticketsOnSale(getDb().select().from(schema.events).where(eq(schema.events.id, s.event.id)).get()!);
    expect(offers.find((o) => o.id === id)?.priceCents).toBe(10000);
  });
});
