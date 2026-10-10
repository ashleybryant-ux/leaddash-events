import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.hoisted(() => {
  // Signature images and PDFs go to a throwaway folder.
  process.env.UPLOADS_DIR = require("node:path").join(require("node:os").tmpdir(), `ld-welcome-${process.pid}`);
});

import { freshDb, caller, setupEvent, outbox, getDb, schema, user, addAttendee } from "./helpers";
import { createAgreement, signAgreement } from "../server/areas/agreements/sign";
import { runRecipientFollowUps, sendSpeakerWelcome, sendVendorWelcome } from "../server/areas/registration/recipientMessages";
import { runFollowUps } from "../server/areas/registration/messages";
import { randomToken } from "../server/_core/crypto";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

beforeEach(async () => {
  await freshDb();
});

type Setup = Awaited<ReturnType<typeof setupEvent>>;

function addSpeaker(s: Setup, name: string, email: string, session?: { title: string; slidesDueOn?: string }) {
  const db = getDb();
  const [firstName, lastName] = name.split(" ");
  const sp = db.insert(schema.speakers).values({ eventId: s.event.id, name, firstName, lastName, email }).returning().get();
  if (session) {
    const row = db
      .insert(schema.sessions)
      .values({ eventId: s.event.id, title: session.title, date: "2027-04-23", startTime: "10:30", endTime: "11:30", room: "Room A", checkInCode: randomToken(8), slidesDueOn: session.slidesDueOn ?? null })
      .returning()
      .get();
    db.insert(schema.sessionSpeakers).values({ sessionId: row.id, speakerId: sp.id, role: "presenter" }).run();
    return { sp, session: row };
  }
  return { sp, session: null };
}

function speakerAgreementTemplate(s: Setup) {
  return getDb().insert(schema.agreementTemplates).values({ eventId: s.event.id, kind: "speaker", name: "Speaker agreement", body: "<p>{Speaker name} agrees to present.</p>", updatedAt: new Date() }).returning().get();
}

async function signFor(s: Setup, opts: { templateId: number; kind: "speaker" | "sponsor" | "exhibitor"; speakerId?: number; vendorId?: number; email: string; name: string }) {
  const a = createAgreement({ eventId: s.event.id, templateId: opts.templateId, kind: opts.kind, speakerId: opts.speakerId, vendorId: opts.vendorId, signerEmail: opts.email, values: {}, status: "sent" });
  return signAgreement(a.code, { name: opts.name, title: "", signaturePng: PNG, recordingAllowed: null }, { sendCopy: false });
}

function logRows(type: "speaker" | "vendor", id: number) {
  return getDb()
    .select()
    .from(schema.recipientLog)
    .where(and(eq(schema.recipientLog.recipientType, type), eq(schema.recipientLog.recipientId, id)))
    .all();
}

function addVendor(s: Setup, extra: Partial<typeof schema.vendors.$inferInsert> = {}) {
  return getDb()
    .insert(schema.vendors)
    .values({ eventId: s.event.id, company: "Brightpath Health", kind: "sponsor", contactName: "Alex Morgan", email: "alex@example.com", amountCents: 500000, status: "confirmed", ...extra })
    .returning()
    .get();
}

function pay(s: Setup, vendorId: number, cents: number) {
  getDb().insert(schema.vendorPayments).values({ eventId: s.event.id, vendorId, amountCents: cents, method: "card", status: "paid", purpose: "full", paidOn: "2026-10-10" }).run();
}

function staffWith(s: Setup, email: string, access: Partial<Record<"speakers" | "vendors" | "registration", "view" | "edit">>) {
  const db = getDb();
  const u = user(email, "Sam Staff");
  const role = db.insert(schema.staffRoles).values({ eventId: s.event.id, name: "Helper", access }).returning().get();
  db.insert(schema.staffAssignments).values({ roleId: role.id, userId: u.id }).run();
  return caller(u);
}

const draftOf = (t: { kind: string; enabled: boolean; sendRule: string; fromName: string; replyTo: string; subject: string; body: string; includes: Record<string, unknown>; logoDueOn: string }) => ({
  kind: t.kind as never,
  enabled: t.enabled,
  sendRule: t.sendRule,
  fromName: t.fromName,
  replyTo: t.replyTo,
  subject: t.subject,
  body: t.body,
  includes: t.includes as Record<string, boolean | string>,
  logoDueOn: t.logoDueOn,
});

describe("welcome email templates", () => {
  it("seeds the three groups for new events and recreates them for older events", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    const sp = await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "speakers" });
    expect(sp.welcome).toMatchObject({ kind: "speaker_welcome", sendRule: "after_sign", ruleLabel: "After they sign the speaker agreement", subject: "You're speaking at NABC 2027, {{first name}}" });
    expect(sp.welcome.includesLabel).toBe("Session details, Upload slides button, Bio and photo button, Registration QR code, Get the app button, Signed agreement (PDF)");
    expect(sp.followUps.map((f) => [f.label, f.ruleLabel, f.enabled])).toEqual([
      ["Slides reminder", "14 days before slides are due", true],
      ["Speaker know before you go", "3 days before", true],
      ["Thank you and evaluation results", "7 days after", false],
    ]);
    const sponsors = await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "sponsors" });
    expect(sponsors.welcome).toMatchObject({ subject: "Welcome, {{company name}}", ruleLabel: "After payment and a signed agreement" });
    expect(sponsors.followUps.map((f) => f.ruleLabel)).toEqual(["30 days before, if passes are open", "7 days before Feb 1, 2027", "3 days before"]);
    const exhibitors = await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "exhibitors" });
    expect(exhibitors.welcome.subject).toBe("Your booth is confirmed, {{company name}}");
    expect(exhibitors.followUps.map((f) => [f.label, f.ruleLabel])).toEqual([
      ["Booth number assigned", "When a booth number is set"],
      ["Exhibitor know before you go", "3 days before"],
    ]);

    // The attendee screen still lists only the attendee messages.
    const attendee = await s.admin.registration.templates.list({ eventId: s.event.id });
    expect(attendee.map((t) => t.kind)).toEqual(["welcome", "text_app", "app_reminder", "know_before", "morning_text"]);

    // An event made before these existed gets them on first read.
    getDb().delete(schema.messageTemplates).where(eq(schema.messageTemplates.kind, "sponsor_welcome")).run();
    const again = await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "sponsors" });
    expect(again.welcome.kind).toBe("sponsor_welcome");
  });

  it("saves edits and checks access by area", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    const { welcome } = await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "speakers" });
    await s.admin.registration.welcomes.save({ eventId: s.event.id, ...draftOf(welcome), sendRule: "manual", subject: "See you soon, {{first name}}", includes: { ...welcome.includes, qr: false } });
    const after = await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "speakers" });
    expect(after.welcome).toMatchObject({ sendRule: "manual", ruleLabel: "Only when I send it", subject: "See you soon, {{first name}}" });
    expect(after.welcome.includes.qr).toBe(false);
    await expect(s.admin.registration.welcomes.save({ eventId: s.event.id, ...draftOf(welcome), sendRule: "after_payment" })).rejects.toThrow(/when to send/);

    const sponsors = await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "sponsors" });
    const logo = sponsors.followUps.find((f) => f.kind === "sponsor_logo_reminder")!;
    await s.admin.registration.welcomes.save({ eventId: s.event.id, ...draftOf(logo), sendRule: "days_before:10", logoDueOn: "2027-03-01" });
    const logoAfter = (await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "sponsors" })).followUps.find((f) => f.kind === "sponsor_logo_reminder")!;
    expect(logoAfter).toMatchObject({ logoDueOn: "2027-03-01", ruleLabel: "10 days before Mar 1, 2027" });

    const viewer = staffWith(s, "viewer@example.org", { speakers: "view" });
    await expect(viewer.registration.welcomes.get({ eventId: s.event.id, group: "speakers" })).resolves.toMatchObject({ canEdit: false });
    await expect(viewer.registration.welcomes.save({ eventId: s.event.id, ...draftOf(welcome) })).rejects.toThrow();
    await expect(viewer.registration.welcomes.sendToNew({ eventId: s.event.id, group: "speakers" })).rejects.toThrow();
    await expect(viewer.registration.welcomes.get({ eventId: s.event.id, group: "sponsors" })).rejects.toThrow();
    expect((await viewer.registration.welcomes.counts({ eventId: s.event.id })).map((c) => c.group)).toEqual(["speakers"]);
    await expect(caller(user("nobody@example.org")).registration.welcomes.get({ eventId: s.event.id, group: "exhibitors" })).rejects.toThrow();
    // The attendee save route cannot change these.
    await expect(s.admin.registration.templates.save({ eventId: s.event.id, kind: "speaker_welcome", enabled: true, sendRule: "after_payment", onlyIfNoApp: false, fromName: "", replyTo: "", subject: "x", body: "y", includes: { receipt: false, getApp: false, qr: false, calendar: false, hotel: false } })).rejects.toThrow();
  });

  it("previews with the first real speaker and sends a test", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    addSpeaker(s, "Renee Carter", "renee@example.com", { title: "Trauma-Informed Care in Group Settings", slidesDueOn: "2027-03-26" });
    const { welcome } = await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "speakers" });
    const p = await s.admin.registration.welcomes.preview({ eventId: s.event.id, ...draftOf(welcome) });
    expect(p.subject).toBe("You're speaking at NABC 2027, Renee");
    expect(p.html).toContain("You are speaking at NABC Annual Conference");
    expect(p.html).toContain("Trauma-Informed Care in Group Settings");
    expect(p.html).toContain("Apr 23, 2027 at 10:30 AM");
    expect(p.html).toContain("Mar 26, 2027");
    expect(p.html).toContain("Attached: your signed speaker agreement (PDF)");
    await s.admin.registration.welcomes.sendTest({ eventId: s.event.id, ...draftOf(welcome) });
    expect(outbox.at(-1)).toMatchObject({ to: "owner@example.org", subject: "Test: You're speaking at NABC 2027, Renee" });
  });
});

describe("speaker welcome", () => {
  it("waits for a signed agreement under after_sign, then sends once with the PDF", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    const t = speakerAgreementTemplate(s);
    const { sp } = addSpeaker(s, "Renee Carter", "renee@example.com", { title: "Trauma-Informed Care", slidesDueOn: "2027-03-26" });
    addAttendee(s.event.id, "renee@example.com", "Renee", "Carter");
    expect(await sendSpeakerWelcome(sp.id)).toBe("waiting");
    expect(outbox).toHaveLength(0);
    expect((await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "speakers" })).summary.sentLabel).toBe("0 sent · 1 waiting on a signature");

    // Signing sends it (the agreement calls sendSpeakerWelcome).
    await signFor(s, { templateId: t.id, kind: "speaker", speakerId: sp.id, email: "renee@example.com", name: "Renee Carter" });
    const mails = outbox.filter((m) => m.to === "renee@example.com");
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe("You're speaking at NABC 2027, Renee");
    expect(mails[0].html).toContain("/speak/");
    expect(mails[0].html).toContain("Upload slides");
    expect(mails[0].html).toContain("Your registration");
    expect(mails[0].html).toContain("/get/");
    expect(mails[0].attachments?.[0]).toMatchObject({ contentType: "application/pdf" });
    expect(logRows("speaker", sp.id)).toMatchObject([{ kind: "speaker_welcome", status: "sent" }]);

    expect(await sendSpeakerWelcome(sp.id)).toBe("already");
    expect(outbox.filter((m) => m.to === "renee@example.com")).toHaveLength(1);
    expect((await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "speakers" })).summary.sentLabel).toBe("1 sent");
  });

  it("does nothing on its own when the rule is manual, but the staff Send welcome button sends", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    const { sp } = addSpeaker(s, "Taylor Kim", "taylor@example.com", { title: "Group Work" });
    getDb().update(schema.messageTemplates).set({ sendRule: "manual" }).where(and(eq(schema.messageTemplates.eventId, s.event.id), eq(schema.messageTemplates.kind, "speaker_welcome"))).run();
    expect(await sendSpeakerWelcome(sp.id)).toBe("skipped");
    await s.admin.agreements.sendWelcome({ eventId: s.event.id, speakerId: sp.id });
    expect(outbox.filter((m) => m.to === "taylor@example.com")).toHaveLength(1);
    expect(logRows("speaker", sp.id)).toMatchObject([{ recipientType: "speaker", kind: "speaker_welcome", status: "sent" }]);
  });

  it("sends when a proposal is accepted under after_accept", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    getDb().update(schema.messageTemplates).set({ sendRule: "after_accept" }).where(and(eq(schema.messageTemplates.eventId, s.event.id), eq(schema.messageTemplates.kind, "speaker_welcome"))).run();
    const p = getDb()
      .insert(schema.proposals)
      .values({ eventId: s.event.id, title: "Group Work Basics", abstract: "About group work.", name: "Lena Ortiz", email: "lena@example.com", status: "submitted" })
      .returning()
      .get();
    await s.admin.network.proposals.admin.decide({ eventId: s.event.id, proposalId: p.id, decision: "accepted", sendEmail: false, session: { date: "2027-04-23", startTime: "10:30", endTime: "11:30", room: "Room B" } });
    const mails = outbox.filter((m) => m.to === "lena@example.com");
    expect(mails).toHaveLength(1);
    expect(mails[0].html).toContain("Group Work Basics");
  });
});

describe("sponsor and exhibitor welcome", () => {
  it("waits for payment and a signed agreement, then attaches the signed PDF", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "sponsors" });
    getDb().update(schema.messageTemplates).set({ replyTo: "events@example.org" }).where(and(eq(schema.messageTemplates.eventId, s.event.id), eq(schema.messageTemplates.kind, "sponsor_welcome"))).run();
    const pkg = getDb().insert(schema.vendorPackages).values({ eventId: s.event.id, kind: "sponsor", name: "Gold", priceCents: 1000000, passes: 4 }).returning().get();
    const t = getDb().insert(schema.agreementTemplates).values({ eventId: s.event.id, kind: "sponsor", name: "Sponsor agreement", body: "<p>{Company name} agrees.</p>", updatedAt: new Date() }).returning().get();
    const v = addVendor(s, { packageId: pkg.id, amountCents: 1000000, nextChargeCents: 500000, nextChargeOn: "2027-03-01" });

    expect(await sendVendorWelcome(v.id)).toBe("waiting");
    pay(s, v.id, 500000);
    expect(await sendVendorWelcome(v.id)).toBe("waiting");
    expect((await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "sponsors" })).summary.sentLabel).toBe("0 sent · 1 waiting on a signature");
    // Signing is the last thing it waited for, so the welcome goes out on its own.
    await signFor(s, { templateId: t.id, kind: "sponsor", vendorId: v.id, email: "alex@example.com", name: "Alex Morgan" });

    const mail = outbox.filter((m) => m.to === "alex@example.com" && m.subject === "Welcome, Brightpath Health");
    expect(mail).toHaveLength(1);
    expect(mail[0].html).toContain("Gold");
    expect(mail[0].html).toContain("Paid Oct 10, 2026");
    expect(mail[0].html).toContain("Charged Mar 1, 2027");
    expect(mail[0].html).toContain("0 of 4 named");
    expect(mail[0].html).toContain("mailto:events@example.org");
    expect(mail[0].html).toContain("Receipt");
    expect(mail[0].attachments?.[0]?.contentType).toBe("application/pdf");
    expect(await sendVendorWelcome(v.id)).toBe("already");

    // With the PDF option off, nothing is attached.
    const v2 = addVendor(s, { company: "Cedar Supply", email: "jamie@example.com", contactName: "Jamie Lee" });
    pay(s, v2.id, 500000);
    const tpl = getDb().select().from(schema.messageTemplates).where(and(eq(schema.messageTemplates.eventId, s.event.id), eq(schema.messageTemplates.kind, "sponsor_welcome"))).get()!;
    getDb().update(schema.messageTemplates).set({ includes: { ...tpl.includes, agreementPdf: false } }).where(eq(schema.messageTemplates.id, tpl.id)).run();
    await signFor(s, { templateId: t.id, kind: "sponsor", vendorId: v2.id, email: "jamie@example.com", name: "Jamie Lee" });
    expect(await sendVendorWelcome(v2.id)).toBe("already");
    const welcome2 = outbox.filter((m) => m.to === "jamie@example.com" && m.subject === "Welcome, Cedar Supply");
    expect(welcome2).toHaveLength(1);
    expect(welcome2[0].attachments).toBeUndefined();
  });

  it("sends the welcome when staff record the payment it was waiting for", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "sponsors" });
    const pkg = getDb().insert(schema.vendorPackages).values({ eventId: s.event.id, kind: "sponsor", name: "Silver", priceCents: 500000, passes: 2 }).returning().get();
    const v = addVendor(s, { packageId: pkg.id, amountCents: 500000 });
    expect(await sendVendorWelcome(v.id)).toBe("waiting");
    await s.admin.network.packages.recordPayment({ eventId: s.event.id, vendorId: v.id, amountCents: 500000, method: "check", paidOn: "2026-10-09", note: "2231" });
    expect(outbox.filter((m) => m.to === "alex@example.com" && m.subject === "Welcome, Brightpath Health")).toHaveLength(1);
    expect(await sendVendorWelcome(v.id)).toBe("already");
  });

  it("Send to new reaches only people who qualify and have not gotten it", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    const t = speakerAgreementTemplate(s);
    const signed = addSpeaker(s, "Renee Carter", "renee@example.com", { title: "One" }).sp;
    addSpeaker(s, "Taylor Kim", "taylor@example.com", { title: "Two" });
    const done = addSpeaker(s, "Lena Ortiz", "lena@example.com", { title: "Three" }).sp;
    addSpeaker(s, "No Email", "", { title: "Four" });
    // Signed without the automatic welcome, and one who already got it.
    const a = createAgreement({ eventId: s.event.id, templateId: t.id, kind: "speaker", speakerId: signed.id, signerEmail: "renee@example.com", values: {}, status: "sent", welcomeAfterSign: false });
    await signAgreement(a.code, { name: "Renee Carter", title: "", signaturePng: PNG, recordingAllowed: null }, { sendCopy: false });
    getDb().insert(schema.recipientLog).values({ eventId: s.event.id, recipientType: "speaker", recipientId: done.id, kind: "speaker_welcome", status: "sent" }).run();
    outbox.length = 0;

    const before = await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "speakers" });
    expect(before.summary).toMatchObject({ total: 4, sent: 1, ready: 1, sentLabel: "1 sent · 1 waiting on a signature" });
    expect(await s.admin.registration.welcomes.sendToNew({ eventId: s.event.id, group: "speakers" })).toEqual({ sent: 1 });
    expect(outbox.map((m) => m.to)).toEqual(["renee@example.com"]);
    expect(await s.admin.registration.welcomes.sendToNew({ eventId: s.event.id, group: "speakers" })).toEqual({ sent: 0 });

    // Exhibitors: only the paid one.
    const paid = addVendor(s, { kind: "exhibitor", company: "Cedar Supply", email: "jamie@example.com" });
    pay(s, paid.id, 100000);
    addVendor(s, { kind: "exhibitor", company: "Unpaid Co", email: "unpaid@example.com", status: "lead" });
    const ex = await s.admin.registration.welcomes.get({ eventId: s.event.id, group: "exhibitors" });
    expect(ex.summary).toMatchObject({ total: 2, ready: 1, sentLabel: "0 sent · 1 waiting on payment" });
    expect(await s.admin.registration.welcomes.sendToNew({ eventId: s.event.id, group: "exhibitors" })).toEqual({ sent: 1 });
    expect(outbox.at(-1)).toMatchObject({ to: "jamie@example.com", subject: "Your booth is confirmed, Cedar Supply" });
  });
});

describe("follow-ups", () => {
  it("sends the slides reminder once, only to speakers without files", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    addSpeaker(s, "Renee Carter", "renee@example.com", { title: "One", slidesDueOn: "2027-04-01" });
    const withFiles = addSpeaker(s, "Taylor Kim", "taylor@example.com", { title: "Two", slidesDueOn: "2027-04-01" });
    const file = getDb().insert(schema.files).values({ orgId: s.org.id, key: randomToken(10), name: "slides.pdf", mime: "application/pdf", size: 10 }).returning().get();
    getDb().insert(schema.sessionFiles).values({ eventId: s.event.id, sessionId: withFiles.session!.id, fileId: file.id, label: "Slides" }).run();

    // 14 days before Apr 1, 2027 at 9:00 AM Chicago time is 14:00 UTC on Mar 18.
    await runRecipientFollowUps(new Date("2027-03-18T13:59:00Z"));
    expect(outbox).toHaveLength(0);
    await runRecipientFollowUps(new Date("2027-03-18T14:01:00Z"));
    expect(outbox.map((m) => [m.to, m.subject])).toEqual([["renee@example.com", "Your slides are due Apr 1, 2027"]]);
    expect(outbox[0].html).toContain("Upload slides");
    await runRecipientFollowUps(new Date("2027-03-19T14:01:00Z"));
    expect(outbox).toHaveLength(1);
    // The attendee follow-up job leaves these alone.
    await runFollowUps(new Date("2027-04-19T15:00:00Z"));
    expect(outbox.filter((m) => m.to === "taylor@example.com")).toHaveLength(0);
  });

  it("sends Booth number assigned once when a booth number appears after the welcome", async () => {
    const s = await setupEvent({ orgName: "Sample Organization" });
    const v = addVendor(s, { kind: "exhibitor", company: "Cedar Supply", email: "jamie@example.com", contactName: "Jamie Lee" });
    pay(s, v.id, 500000);
    expect(await sendVendorWelcome(v.id)).toBe("sent");
    const now = new Date("2027-01-10T16:00:00Z");
    await runRecipientFollowUps(now);
    expect(outbox).toHaveLength(1);
    getDb().update(schema.vendors).set({ booth: "214" }).where(eq(schema.vendors.id, v.id)).run();
    await runRecipientFollowUps(now);
    expect(outbox.map((m) => m.subject)).toEqual(["Your booth is confirmed, Cedar Supply", "You are in booth 214"]);
    await runRecipientFollowUps(new Date("2027-01-11T16:00:00Z"));
    expect(outbox).toHaveLength(2);

    // A booth already set when the welcome went out is not emailed again.
    const v2 = addVendor(s, { kind: "exhibitor", company: "Oak Books", email: "oak@example.com", booth: "101" });
    pay(s, v2.id, 500000);
    expect(await sendVendorWelcome(v2.id)).toBe("sent");
    await runRecipientFollowUps(now);
    expect(outbox.filter((m) => m.to === "oak@example.com").map((m) => m.subject)).toEqual(["Your booth is confirmed, Oak Books"]);
  });
});
