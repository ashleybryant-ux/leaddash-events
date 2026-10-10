import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.hoisted(() => {
  // Signature images go to a throwaway folder.
  process.env.UPLOADS_DIR = require("node:path").join(require("node:os").tmpdir(), `ld-agreements-${process.pid}`);
});

const welcome = vi.hoisted(() => ({ calls: [] as number[] }));
vi.mock("../server/areas/registration/recipientMessages", () => ({
  sendSpeakerWelcome: async (id: number) => {
    welcome.calls.push(id);
  },
  sendVendorWelcome: async () => {},
}));

import { freshDb, caller, setupEvent, outbox, getDb, schema, user } from "./helpers";
import { BLANK, fillAgreement, paymentTerms, valuesForCheckout } from "../server/areas/agreements/fill";
import { agreementForSpeaker, createAgreement, runAgreementReminders, signAgreement, templateFor } from "../server/areas/agreements/sign";
import { agreementPdf, htmlBlocks, winAnsi } from "../server/areas/agreements/pdf";
import { buildRawEmail } from "../server/_core/email";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function setup() {
  const s = await setupEvent({ orgName: "Sample Organization" });
  return s;
}

async function sponsorTemplate(s: Awaited<ReturnType<typeof setup>>) {
  const t = await s.admin.agreements.templates.create({ eventId: s.event.id, starter: "sponsor" });
  await s.admin.agreements.templates.save({
    eventId: s.event.id,
    templateId: t.id,
    name: t.name,
    kind: "sponsor",
    body: t.body,
    values: { "Cancel by date": "2027-01-15", "Cancel fee": "$500.00" },
    signWhen: "checkout",
    sendOnAccept: true,
    sendOnAdd: true,
    reminders: "3x3",
    askRecording: false,
    signerName: "Jordan Hayes",
    signerTitle: "Executive Director",
    countersign: true,
  });
  return t;
}

async function speakerTemplate(s: Awaited<ReturnType<typeof setup>>, sendOnAdd = true) {
  const t = await s.admin.agreements.templates.create({ eventId: s.event.id, starter: "speaker" });
  await s.admin.agreements.templates.save({
    eventId: s.event.id,
    templateId: t.id,
    name: t.name,
    kind: "speaker",
    body: t.body,
    values: { "Speaker benefits": "Free full conference registration", "Materials due date": "2027-03-26" },
    signWhen: "email",
    sendOnAccept: true,
    sendOnAdd,
    reminders: "3x3",
    askRecording: true,
    signerName: "Jordan Hayes",
    signerTitle: "Executive Director",
    countersign: true,
  });
  return t;
}

describe("filling agreements", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("fills fields, escapes values and leaves a blank line for empty or unknown fields", () => {
    const html = fillAgreement("<p>{Company name} pays {Package price} by {Cancel by date}. {Nope}</p>", { "Company name": "A & B <Co>", "Package price": "$10.00", "Cancel by date": "" });
    expect(html).toBe(`<p>A &amp; B &lt;Co&gt; pays $10.00 by ${BLANK}. ${BLANK}</p>`);
    expect(html).not.toContain("{");
  });

  it("writes payment terms for full, deposit and invoice", () => {
    expect(paymentTerms({ option: "full", totalCents: 117500 })).toBe("The full amount of $1,175.00 is paid today");
    expect(paymentTerms({ option: "deposit", totalCents: 1_000_000, dueTodayCents: 500_000, balanceDueOn: "2027-03-01" })).toBe(
      "A deposit of $5,000.00 is paid today and the remaining $5,000.00 is charged automatically to the same payment method on Mar 1, 2027"
    );
    expect(paymentTerms({ option: "invoice", totalCents: 250_000, dueBy: "2027-02-01" })).toBe("The full amount of $2,500.00 is due by Feb 1, 2027");
  });

  it("builds checkout values with add-ons and event dates with the year", async () => {
    const s = await setup();
    const db = getDb();
    const pkg = db.insert(schema.vendorPackages).values({ eventId: s.event.id, kind: "exhibitor", name: "Standard booth", priceCents: 95000 }).returning().get();
    const addon = db.insert(schema.vendorAddons).values({ eventId: s.event.id, name: "Electricity", priceCents: 22500 }).returning().get();
    const t = await s.admin.agreements.templates.create({ eventId: s.event.id, starter: "exhibitor" });
    const c = db
      .insert(schema.vendorCheckouts)
      .values({
        eventId: s.event.id,
        kind: "exhibitor",
        packageId: pkg.id,
        buyer: { company: "Cedar Counseling Supply", website: "", firstName: "Jamie", lastName: "Fox", email: "jamie@example.com", phone: "", category: "", about: "", offer: "", boothRequest: "", logoFileId: null, people: [], addons: [{ addonId: addon.id, qty: 1 }] },
        payOption: "full",
        totalCents: 117500,
        dueTodayCents: 117500,
        doneToken: "tok-123",
      })
      .returning()
      .get();
    const tpl = templateFor(s.event.id, "exhibitor")!;
    const v = valuesForCheckout(s.event, tpl, c);
    expect(v).toMatchObject({
      "Organization name": "Sample Organization",
      "Event dates": "Apr 22, 2027 to Apr 24, 2027",
      "Company name": "Cedar Counseling Supply",
      "Package name": "Standard booth",
      "Package price": "$950.00",
      "Add-ons": "electricity",
      "Payment terms": "The full amount of $1,175.00 is paid today",
    });
    const a = createAgreement({ eventId: s.event.id, templateId: t.id, kind: "exhibitor", checkoutId: c.id, signerEmail: "Jamie@Example.com", values: v });
    expect(a.status).toBe("draft");
    expect(a.html).toContain("Cedar Counseling Supply (the Exhibitor)");
    expect(a.code.length).toBeGreaterThanOrEqual(24);
    expect(a.signerEmail).toBe("jamie@example.com");
  });
});

describe("agreement templates", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("creates from a starter, saves, previews with sample data and lists signed counts", async () => {
    const s = await setup();
    const t = await sponsorTemplate(s);
    expect(t.name).toBe("Sponsor agreement 2027");
    expect(t.body).toContain("<h2>Sponsor Agreement</h2>");
    expect(t.body).toContain("<strong>1. Package.</strong>");
    const list = await s.admin.agreements.templates.list({ eventId: s.event.id });
    expect(list.templates).toHaveLength(1);
    expect(list.templates[0]).toMatchObject({ usedOn: "Sponsor checkout, before paying", signed: 0, total: 0, signerName: "Jordan Hayes", values: { "Cancel by date": "2027-01-15" } });
    expect(list.starters.map((x) => x.name)).toEqual(["Sponsor agreement", "Exhibitor agreement", "Speaker agreement", "Blank"]);
    const prev = await s.admin.agreements.templates.preview({ eventId: s.event.id, kind: "sponsor", body: t.body, values: { "Cancel by date": "2027-01-15", "Cancel fee": "$500.00" } });
    expect(prev.html).toContain("before Jan 15, 2027");
    expect(prev.html).toContain("Brightpath Health (the Sponsor)");
    expect(prev.html).toContain("Sample Organization");
  });

  it("only lets people with the right area see or change templates", async () => {
    const s = await setup();
    await sponsorTemplate(s);
    await speakerTemplate(s);
    const db = getDb();
    const u = user("speakers@example.org", "Sam Staff");
    const role = db.insert(schema.staffRoles).values({ eventId: s.event.id, name: "Speakers", kind: "custom", access: { speakers: "edit" } as never, endsWithEvent: false }).returning().get();
    db.insert(schema.staffAssignments).values({ roleId: role.id, userId: u.id }).run();
    const api = caller(u);
    const list = await api.agreements.templates.list({ eventId: s.event.id });
    expect(list.templates.map((t) => t.kind)).toEqual(["speaker"]);
    const sponsor = templateFor(s.event.id, "sponsor")!;
    await expect(api.agreements.templates.delete({ eventId: s.event.id, templateId: sponsor.id })).rejects.toThrow();
    await expect(caller(user("nobody@example.org")).agreements.templates.list({ eventId: s.event.id })).rejects.toThrow();
  });

  it("will not delete a template set on a checkout page", async () => {
    const s = await setup();
    const t = await sponsorTemplate(s);
    getDb().insert(schema.vendorCheckoutPages).values({ eventId: s.event.id, kind: "sponsor", agreementTemplateId: t.id }).run();
    await expect(s.admin.agreements.templates.delete({ eventId: s.event.id, templateId: t.id })).rejects.toThrow(/checkout page/);
    getDb().update(schema.vendorCheckoutPages).set({ agreementTemplateId: null }).run();
    await s.admin.agreements.templates.delete({ eventId: s.event.id, templateId: t.id });
    expect(templateFor(s.event.id, "sponsor")).toBeUndefined();
  });
});

describe("sending and signing", () => {
  beforeEach(async () => {
    await freshDb();
    welcome.calls.length = 0;
  });

  it("sends a sponsor added by hand the sign link; signing countersigns and emails the signed PDF", async () => {
    const s = await setup();
    await sponsorTemplate(s);
    const db = getDb();
    db.insert(schema.vendorCheckoutPages).values({ eventId: s.event.id, kind: "sponsor", notifyEmail: "events@example.org" }).run();
    const pkg = db.insert(schema.vendorPackages).values({ eventId: s.event.id, kind: "sponsor", name: "Session sponsor", priceCents: 250000, benefits: ["1 event pass", "Your logo on the session page you sponsor"] }).returning().get();
    const v = await s.admin.network.vendors.create({ eventId: s.event.id, company: "Meadow Wellness", kind: "sponsor", contactName: "Pat Lee", email: "pat@example.com", status: "confirmed", packageId: pkg.id });
    const sent = await s.admin.agreements.send({ eventId: s.event.id, vendorId: v.id });
    expect(sent.signLink).toMatch(/\/sign\/[A-Za-z0-9_-]{24,}$/);
    const mail = outbox.find((m) => m.to === "pat@example.com")!;
    expect(mail.subject).toContain("please sign your sponsor agreement");
    expect(mail.html).toContain(sent.signLink);
    const code = sent.signLink.split("/sign/")[1];

    const pub = await caller(null).agreements.public.get({ code });
    expect(pub).toMatchObject({ kind: "sponsor", status: "sent", summary: "Meadow Wellness · Session sponsor · NABC 2027", prefill: { name: "Pat Lee" } });
    expect(pub.html).toContain("Meadow Wellness (the Sponsor)");
    expect(pub.html).toContain("The full amount of $2,500.00 is due before the event");
    expect(pub.html).toContain("It includes: 1 event pass and your logo on the session page you sponsor.");

    const list = await s.admin.network.vendors.list({ eventId: s.event.id });
    expect(list.vendors.find((x) => x.id === v.id)!.statusLabel).toBe("Not signed");

    outbox.length = 0;
    await caller(null).agreements.public.sign({ code, name: " Pat  Lee ", title: "Director", signaturePng: PNG, recordingAllowed: null });
    const row = db.select().from(schema.agreements).where(eq(schema.agreements.code, code)).get()!;
    expect(row).toMatchObject({ status: "signed", signerName: "Pat Lee", signerTitle: "Director", countersignName: "Jordan Hayes", countersignTitle: "Executive Director", recordingAllowed: null, ip: "127.0.0.1" });
    expect(row.signatureFileId).toBeTruthy();
    const f = db.select().from(schema.files).where(eq(schema.files.id, row.signatureFileId!)).get()!;
    expect(f.isPublic).toBe(false);
    const toSigner = outbox.find((m) => m.to === "pat@example.com")!;
    expect(toSigner.attachments?.[0].filename).toBe("Sponsor agreement 2027 (signed).pdf");
    expect(toSigner.attachments?.[0].content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(outbox.find((m) => m.to === "events@example.org")?.attachments).toHaveLength(1);

    await expect(caller(null).agreements.public.sign({ code, name: "Pat Lee", title: "", signaturePng: PNG, recordingAllowed: null })).rejects.toThrow(/already signed/);
    const copy = await caller(null).agreements.public.copy({ code });
    expect(copy.signatures.map((x) => x.name)).toEqual(["Pat Lee", "Jordan Hayes"]);
    expect(copy.signatures[1].when).toMatch(/added automatically/);
    expect(copy.footer).toMatch(/Signer email pat@example.com · IP address 127.0.0.1 · Agreement ID SA-2027-\d{4}/);
    const after = await s.admin.agreements.templates.list({ eventId: s.event.id });
    expect(after.templates[0]).toMatchObject({ signed: 1, total: 1 });
  });

  it("rejects a bad signature image and an empty name", async () => {
    const s = await setup();
    const t = await sponsorTemplate(s);
    const a = createAgreement({ eventId: s.event.id, templateId: t.id, kind: "sponsor", signerEmail: "x@example.com", values: {} });
    await expect(signAgreement(a.code, { name: "X", title: "", signaturePng: PNG })).rejects.toThrow(/full name/);
    await expect(signAgreement(a.code, { name: "Alex Morgan", title: "", signaturePng: "data:image/png;base64,AAAA" })).rejects.toThrow(/signature/);
  });

  it("makes a real PDF with the agreement text", async () => {
    const s = await setup();
    const t = await sponsorTemplate(s);
    const a = createAgreement({ eventId: s.event.id, templateId: t.id, kind: "sponsor", signerEmail: "x@example.com", values: { "Company name": "Brightpath Health" } });
    const signed = await signAgreement(a.code, { name: "Alex Morgan", title: "Marketing Director", signaturePng: PNG }, { sendCopy: false });
    const bytes = await agreementPdf(signed);
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1500);
    const blocks = htmlBlocks("<h2>Title</h2><p><strong>1. Package.</strong> Text &amp; more</p><ul><li>One</li></ul>");
    expect(blocks.map((b) => b.kind)).toEqual(["h2", "p", "li"]);
    expect(blocks[1].runs[0]).toMatchObject({ text: "1. Package.", bold: true });
    expect(winAnsi("café → ok")).toBe("café ? ok");
  });

  it("builds a MIME message with the attachment", () => {
    const raw = buildRawEmail({ to: "a@example.com", subject: "Signed", text: "Hi", html: "<p>Hi</p>", attachments: [{ filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.7") }] }, { name: "Event Team", address: "events@leaddash.io" }).toString();
    expect(raw).toContain("Content-Type: multipart/mixed");
    expect(raw).toContain("Content-Type: multipart/alternative");
    expect(raw).toContain('Content-Disposition: attachment; filename="a.pdf"');
    expect(raw).toContain(Buffer.from("%PDF-1.7").toString("base64"));
  });
});

describe("speaker agreements", () => {
  beforeEach(async () => {
    await freshDb();
    welcome.calls.length = 0;
  });

  async function proposal(s: Awaited<ReturnType<typeof setup>>) {
    const u = user("renee@example.com", "Renee Carter");
    return getDb()
      .insert(schema.proposals)
      .values({ eventId: s.event.id, userId: u.id, email: "renee@example.com", name: "Dr. Renee Carter", credentials: "PhD, LPC", title: "Trauma-Informed Care in Group Settings", abstract: "A long enough abstract for the test.", objectives: ["One"], format: "Session", status: "in_review" })
      .returning()
      .get();
  }

  it("accepting a proposal sends the agreement; signing sends the welcome when chosen", async () => {
    const s = await setup();
    await speakerTemplate(s);
    const list = await s.admin.network.proposals.admin.list({ eventId: s.event.id });
    expect(list.speakerAgreement).toMatchObject({ sendOnAccept: true });
    const p = await proposal(s);
    const res = await s.admin.network.proposals.admin.decide({ eventId: s.event.id, proposalId: p.id, decision: "accepted", sendEmail: true, session: { date: "2027-04-23", startTime: "10:30", endTime: "11:30", room: "Ballroom B" }, sendAgreement: true, welcomeAfterSign: true });
    expect(res.agreementsSent).toBe(1);
    const speaker = getDb().select().from(schema.speakers).where(eq(schema.speakers.email, "renee@example.com")).get()!;
    const a = agreementForSpeaker(speaker.id)!;
    expect(a.status).toBe("sent");
    expect(a.html).toContain('present "Trauma-Informed Care in Group Settings" on Apr 23, 2027 at 10:30 AM in Ballroom B');
    expect(a.html).toContain("due by Mar 26, 2027");
    expect(outbox.some((m) => m.to === "renee@example.com" && m.subject.includes("speaker agreement"))).toBe(true);

    const pub = await caller(null).agreements.public.get({ code: a.code });
    expect(pub).toMatchObject({ askRecording: true, session: { title: "Trauma-Informed Care in Group Settings", when: "Apr 23, 2027 at 10:30 AM", room: "Ballroom B" } });
    await expect(caller(null).agreements.public.sign({ code: a.code, name: "Renee Carter", title: "PhD, LPC", signaturePng: PNG, recordingAllowed: null })).rejects.toThrow(/record/);
    await caller(null).agreements.public.sign({ code: a.code, name: "Renee Carter", title: "PhD, LPC", signaturePng: PNG, recordingAllowed: true });
    expect(welcome.calls).toEqual([speaker.id]);
    expect(agreementForSpeaker(speaker.id)).toMatchObject({ status: "signed", recordingAllowed: true });

    const rows = await s.admin.agreements.speakers({ eventId: s.event.id });
    expect(rows.speakers.find((r) => r.speakerId === speaker.id)!.agreement).toMatchObject({ status: "signed", name: "Speaker agreement 2027" });
  });

  it("does not send the welcome after signing when that box was off", async () => {
    const s = await setup();
    await speakerTemplate(s);
    const p = await proposal(s);
    await s.admin.network.proposals.admin.decide({ eventId: s.event.id, proposalId: p.id, decision: "accepted", sendEmail: false, session: { date: "2027-04-23", startTime: "10:30", endTime: "11:30", room: "" }, sendAgreement: true, welcomeAfterSign: false });
    const speaker = getDb().select().from(schema.speakers).where(eq(schema.speakers.email, "renee@example.com")).get()!;
    await signAgreement(agreementForSpeaker(speaker.id)!.code, { name: "Renee Carter", title: "", signaturePng: PNG, recordingAllowed: false });
    expect(welcome.calls).toEqual([]);
  });

  it("sends to speakers added by hand when the template says so, and Send agreements reaches the rest", async () => {
    const s = await setup();
    await speakerTemplate(s, true);
    const one = await s.admin.program.speakers.create({ eventId: s.event.id, firstName: "Taylor", lastName: "Kim", email: "taylor@example.com" });
    expect(agreementForSpeaker(one.id)?.status).toBe("sent");
    const t = templateFor(s.event.id, "speaker")!;
    getDb().update(schema.agreementTemplates).set({ sendOnAdd: false }).where(eq(schema.agreementTemplates.id, t.id)).run();
    const two = await s.admin.program.speakers.create({ eventId: s.event.id, firstName: "Lena", lastName: "Ortiz", email: "lena@example.com" });
    await s.admin.program.speakers.create({ eventId: s.event.id, firstName: "No", lastName: "Email" });
    expect(agreementForSpeaker(two.id)).toBeUndefined();
    expect((await s.admin.agreements.unsentCount({ eventId: s.event.id })).count).toBe(1);
    expect((await s.admin.agreements.sendAllSpeakers({ eventId: s.event.id })).sent).toBe(1);
    expect(agreementForSpeaker(two.id)?.status).toBe("sent");
    expect((await s.admin.agreements.unsentCount({ eventId: s.event.id })).count).toBe(0);
  });

  it("reminds every few days up to the limit, once per run", async () => {
    const s = await setup();
    await speakerTemplate(s);
    const sp = await s.admin.program.speakers.create({ eventId: s.event.id, firstName: "Marcus", lastName: "Webb", email: "marcus@example.com" });
    const a = agreementForSpeaker(sp.id)!;
    const db = getDb();
    const day = 86_400_000;
    db.update(schema.agreements).set({ sentAt: new Date(Date.now() - 3 * day - 1000) }).where(eq(schema.agreements.id, a.id)).run();
    outbox.length = 0;
    expect(await runAgreementReminders()).toBe(1);
    expect(await runAgreementReminders()).toBe(0);
    expect(outbox[0].subject).toContain("reminder to sign");
    const later = new Date(Date.now() + 3 * day + 1000);
    expect(await runAgreementReminders(later)).toBe(1);
    expect(await runAgreementReminders(new Date(later.getTime() + 3 * day + 1000))).toBe(1);
    expect(await runAgreementReminders(new Date(later.getTime() + 9 * day))).toBe(0);
    expect(db.select().from(schema.agreements).where(eq(schema.agreements.id, a.id)).get()!.remindersSent).toBe(3);
    await s.admin.agreements.resend({ eventId: s.event.id, agreementId: a.id });
    expect(db.select().from(schema.agreements).where(eq(schema.agreements.id, a.id)).get()!.remindersSent).toBe(0);
  });
});
