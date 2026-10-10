import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";

vi.hoisted(() => {
  process.env.UPLOADS_DIR = `${process.env.TMPDIR || "/tmp"}/ld-member-test-${process.pid}`;
});

import { freshDb, caller, setupEvent, addAttendee, outbox, user, getDb, schema } from "./helpers";
import { randomToken } from "../server/_core/crypto";
import { googleSaveLink, appleWalletConfigured, googleWalletConfigured } from "../server/areas/member/wallet";
import { defaultPrefix, parseCsv } from "../server/areas/member/shared";
import { eq } from "drizzle-orm";

const iso = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
const b64 = (s: string) => Buffer.from(s).toString("base64");

type Setup = Awaited<ReturnType<typeof setupEvent>>;

async function addMember(s: Setup, email: string, extra: Record<string, unknown> = {}) {
  const row = await s.admin.member.admin.members.create({ orgId: s.org.id, email, firstName: email.split("@")[0], lastName: "Tester", ...extra });
  const u = user(email);
  return { row, api: caller(u), user: u };
}

async function uploadPrivate(s: Setup, name: string, text: string) {
  return s.admin.core.files.upload({ orgId: s.org.id, name, mime: "text/plain", base64: b64(text), isPublic: false });
}

describe("member hub", () => {
  let s: Setup;
  beforeEach(async () => {
    await freshDb();
    s = await setupEvent();
  });

  it("gives members a number, a card token, and a platform contact", async () => {
    getDb().update(schema.organizations).set({ platformLocationId: "loc_1" }).where(eq(schema.organizations.id, s.org.id)).run();
    const a = await addMember(s, "a@example.com");
    const b = await addMember(s, "b@example.com");
    expect(a.row.memberNumber).toMatch(/^[A-Z]{2}-\d{5}$/);
    expect(Number(b.row.memberNumber.split("-")[1])).toBe(Number(a.row.memberNumber.split("-")[1]) + 1);
    expect(a.row.cardToken.length).toBeGreaterThan(10);
    expect(defaultPrefix("nabc")).toBe("NB");
    const queued = getDb().select().from(schema.platformOutbox).all();
    expect(queued).toHaveLength(2);
    expect((queued[0].payload as { tags: string[] }).tags).toContain("member");
  });

  it("keeps non-members and lapsed members out of member content", async () => {
    const stranger = caller(user("nobody@example.com"));
    expect(await stranger.member.hub.me({ orgSlug: s.org.slug })).toBeNull();
    await expect(stranger.member.hub.home({ orgSlug: s.org.slug })).rejects.toThrow(/could not find a membership for nobody@example.com/);
    await expect(stranger.member.docs.folders({ orgSlug: s.org.slug })).rejects.toThrow();

    const lapsed = await addMember(s, "lapsed@example.com", { status: "lapsed", expiresOn: iso(-30) });
    await expect(lapsed.api.member.docs.folders({ orgSlug: s.org.slug })).rejects.toThrow(/lapsed/);
    await expect(lapsed.api.member.groups.mine({ orgSlug: s.org.slug })).rejects.toThrow(/lapsed/);
    const card = await lapsed.api.member.hub.card({ orgSlug: s.org.slug });
    expect(card.status).toBe("lapsed");
    const home = await lapsed.api.member.hub.home({ orgSlug: s.org.slug });
    expect(home.active).toBe(false);

    const folder = await s.admin.member.admin.docs.saveFolder({ orgId: s.org.id, name: "All members", access: { type: "active_members" } });
    const f = await uploadPrivate(s, "bylaws.txt", "bylaws");
    const doc = await s.admin.member.admin.docs.create({ orgId: s.org.id, folderId: folder.id, title: "Bylaws", fileId: f.id, notify: "none" });
    await expect(lapsed.api.member.docs.open({ orgSlug: s.org.slug, documentId: doc.id })).rejects.toThrow();
    const active = await addMember(s, "active@example.com");
    const opened = await active.api.member.docs.open({ orgSlug: s.org.slug, documentId: doc.id });
    expect(opened.url).toMatch(/\/files\/.+\?exp=\d+&sig=/);
  });

  it("opens folders by group and by member level", async () => {
    const inGroup = await addMember(s, "chair@example.com", { level: "Professional" });
    const student = await addMember(s, "student@example.com", { level: "Student" });
    const g = await s.admin.member.admin.groups.save({ orgId: s.org.id, name: "Ethics Committee", kind: "committee", joinRule: "appointment", hasChannel: true, hasFolder: true, chairCanEmail: true, chairCanAdd: false, members: [{ memberId: inGroup.row.id, role: "member" }] });
    const level = await s.admin.member.admin.docs.saveFolder({ orgId: s.org.id, name: "Students", access: { type: "level", level: "Student" } });
    const staff = await s.admin.member.admin.docs.saveFolder({ orgId: s.org.id, name: "Staff", access: { type: "staff" } });
    const board = await s.admin.member.admin.docs.saveFolder({ orgId: s.org.id, name: "Board", access: { type: "board" } });

    const names = async (api: typeof inGroup.api) => (await api.member.docs.folders({ orgSlug: s.org.slug })).folders.map((f) => f.name).sort();
    expect(await names(inGroup.api)).toEqual(["Ethics Committee"]);
    expect(await names(student.api)).toEqual(["Students"]);

    const groupFolder = getDb().select().from(schema.docFolders).where(eq(schema.docFolders.groupId, g.id)).get()!;
    await expect(student.api.member.docs.folder({ orgSlug: s.org.slug, folderId: groupFolder.id })).rejects.toThrow();
    await expect(inGroup.api.member.docs.folder({ orgSlug: s.org.slug, folderId: level.id })).rejects.toThrow();
    await expect(inGroup.api.member.docs.folder({ orgSlug: s.org.slug, folderId: staff.id })).rejects.toThrow();

    // Board folders open for the board group's members.
    await s.admin.member.admin.groups.save({ orgId: s.org.id, name: "Board of Directors", kind: "committee", joinRule: "appointment", hasChannel: false, hasFolder: false, chairCanEmail: false, chairCanAdd: false, isBoard: true, members: [{ memberId: student.row.id, role: "chair" }] });
    expect(await names(student.api)).toEqual(["Board", "Students"]);
    void board;
  });

  it("keeps version history, restores by copying, and tells the right members", async () => {
    const reader = await addMember(s, "reader@example.com");
    await reader.api.member.hub.me({ orgSlug: s.org.slug }); // links the sign-in
    const outsider = await addMember(s, "outsider@example.com", { level: "Student" });
    const folder = await s.admin.member.admin.docs.saveFolder({ orgId: s.org.id, name: "Professionals", access: { type: "level", level: "Professional" } });
    const v1 = await uploadPrivate(s, "ethics.txt", "version one");
    outbox.length = 0;
    const doc = await s.admin.member.admin.docs.create({ orgId: s.org.id, folderId: folder.id, title: "Code of Ethics", fileId: v1.id, notify: "push_email" });
    expect(doc.told).toBe(1);
    expect(outbox.map((m) => m.to)).toEqual(["reader@example.com"]);
    const alerts = getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, reader.user.id)).all();
    expect(alerts).toHaveLength(1);
    void outsider;

    const v2 = await uploadPrivate(s, "ethics-2.txt", "version two");
    outbox.length = 0;
    await s.admin.member.admin.docs.update({ orgId: s.org.id, documentId: doc.id, title: "Code of Ethics", folderId: folder.id, notify: "push" });
    await s.admin.member.admin.docs.addVersion({ orgId: s.org.id, documentId: doc.id, fileId: v2.id, note: "Telehealth section added" });
    expect(outbox).toHaveLength(0); // push only

    const restored = await s.admin.member.admin.docs.restore({ orgId: s.org.id, documentId: doc.id, version: 1 });
    expect(restored.version).toBe(3);
    const detail = await s.admin.member.admin.docs.document({ orgId: s.org.id, documentId: doc.id });
    expect(detail.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(detail.versions[0].note).toBe("Restored version 1");
    expect(detail.versions[0].current).toBe(true);
    expect(detail.versions[0].fileId).not.toBe(v1.id);
    expect(detail.versions[2].uploadedBy).toBe("Olivia Owner");
    const copy = getDb().select().from(schema.files).where(eq(schema.files.id, detail.versions[0].fileId)).get()!;
    expect(copy.name).toBe("ethics.txt");
    expect(copy.isPublic).toBe(false);

    const list = await reader.api.member.docs.folders({ orgSlug: s.org.slug });
    expect(list.recent[0].isNew).toBe(true);
    expect(list.recent[0].version).toBe(3);
  });

  it("lets chairs email the group only when allowed, and members join open groups", async () => {
    const chair = await addMember(s, "chair@example.com");
    const m1 = await addMember(s, "m1@example.com");
    const m2 = await addMember(s, "m2@example.com");
    const g = await s.admin.member.admin.groups.save({
      orgId: s.org.id,
      name: "Conference Planning Committee",
      kind: "committee",
      joinRule: "appointment",
      hasChannel: true,
      hasFolder: false,
      chairCanEmail: true,
      chairCanAdd: false,
      members: [
        { memberId: chair.row.id, role: "chair" },
        { memberId: m1.row.id, role: "member" },
      ],
    });
    outbox.length = 0;
    const sent = await chair.api.member.groups.email({ orgSlug: s.org.slug, groupId: g.id, subject: "Thursday meeting", body: "See you at 7 PM." });
    expect(sent.sent).toBe(1);
    expect(outbox.map((m) => m.to)).toEqual(["m1@example.com"]);
    await expect(m1.api.member.groups.email({ orgSlug: s.org.slug, groupId: g.id, subject: "Hi all", body: "Hello" })).rejects.toThrow(/Only the chair/);
    await expect(chair.api.member.groups.add({ orgSlug: s.org.slug, groupId: g.id, email: "m2@example.com" })).rejects.toThrow(/Only the chair/);

    await s.admin.member.admin.groups.save({ orgId: s.org.id, groupId: g.id, name: g.name, kind: "committee", joinRule: "appointment", hasChannel: true, hasFolder: false, chairCanEmail: false, chairCanAdd: true });
    await expect(chair.api.member.groups.email({ orgSlug: s.org.slug, groupId: g.id, subject: "Thursday meeting", body: "See you." })).rejects.toThrow(/Only the chair/);
    await chair.api.member.groups.add({ orgSlug: s.org.slug, groupId: g.id, email: "m2@example.com" });
    const page = await m2.api.member.groups.page({ orgSlug: s.org.slug, groupId: g.id });
    expect(page.joined).toBe(true);
    expect(page.members.find((x) => x.role === "chair")?.name).toBe("chair Tester");

    // Posting needs membership in the group.
    const outsider = await addMember(s, "out@example.com");
    await expect(outsider.api.member.groups.post({ orgSlug: s.org.slug, groupId: g.id, body: "hello" })).rejects.toThrow();
    await m2.api.member.groups.post({ orgSlug: s.org.slug, groupId: g.id, body: "Glad to help." });
    expect((await m1.api.member.groups.page({ orgSlug: s.org.slug, groupId: g.id })).posts[0].author).toBe("m2 Tester");

    // Joining: appointment groups are closed, open groups are not.
    await expect(outsider.api.member.groups.join({ orgSlug: s.org.slug, groupId: g.id })).rejects.toThrow(/appointment/);
    const open = await s.admin.member.admin.groups.save({ orgId: s.org.id, name: "Clinical Practice Division", kind: "division", joinRule: "open", hasChannel: true, hasFolder: true, chairCanEmail: true, chairCanAdd: false });
    await outsider.api.member.groups.join({ orgSlug: s.org.slug, groupId: open.id });
    const mine = await outsider.api.member.groups.mine({ orgSlug: s.org.slug });
    expect(mine.joined.map((x) => x.name)).toEqual(["Clinical Practice Division"]);

    const admin = await s.admin.member.admin.groups.list({ orgId: s.org.id });
    expect(admin.kpis).toMatchObject({ divisions: 1, committees: 1, membersInAny: 4 });
    expect(admin.groups.find((x) => x.id === g.id)?.chairName).toBe("chair Tester");
  });

  it("adds CE hours from certificates and CE entries on the home screen", async () => {
    const m = await addMember(s, "ce@example.com");
    const past = getDb()
      .insert(schema.events)
      .values({ orgId: s.org.id, slug: `past-${randomToken(4).toLowerCase()}`, name: "Spring Summit", startDate: iso(-90), endDate: iso(-89), status: "ended" })
      .returning()
      .get();
    const { attendee } = addAttendee(past.id, "ce@example.com");
    const session = getDb().insert(schema.sessions).values({ eventId: past.id, title: "Ethics", date: iso(-90), startTime: "09:00", endTime: "10:00", ceHours: 3, checkInCode: randomToken(6) }).returning().get();
    const session2 = getDb().insert(schema.sessions).values({ eventId: past.id, title: "Trauma care", date: iso(-90), startTime: "11:00", endTime: "12:00", ceHours: 1.5, checkInCode: randomToken(6) }).returning().get();
    getDb().insert(schema.certificates).values({ eventId: past.id, attendeeId: attendee.id, sessionId: session.id, title: "Ethics", hours: 3, code: randomToken(6) }).run();
    getDb().insert(schema.certificates).values({ eventId: past.id, attendeeId: attendee.id, sessionId: null, title: "Revoked", hours: 9, code: randomToken(6), revokedAt: new Date() }).run();
    getDb().insert(schema.sessionCheckins).values({ sessionId: session2.id, attendeeId: attendee.id }).run();
    getDb().insert(schema.ceEntries).values([
      { orgId: s.org.id, email: "ce@example.com", title: "Webinar", date: iso(-20), hours: 1.5 },
      { orgId: s.org.id, email: "ce@example.com", title: "Too old", date: iso(-1000), hours: 4 },
    ]).run();
    addAttendee(s.event.id, "ce@example.com");
    getDb().update(schema.events).set({ status: "live" }).where(eq(schema.events.id, s.event.id)).run();

    const home = await m.api.member.hub.home({ orgSlug: s.org.slug });
    expect(home.active).toBe(true);
    expect(home.ceHours).toBe(4.5);
    expect(home.evaluationsDue).toEqual([{ sessionId: session2.id, title: "Trauma care", eventName: "Spring Summit", url: `/e/${past.slug}/eval/${session2.id}` }]);
    expect(home.events.find((e) => e.id === s.event.id)?.registered).toBe(true);
  });

  it("checks a card in public with only name, level, status and expiry", async () => {
    const m = await addMember(s, "card@example.com", { credentials: "LPC", expiresOn: iso(200) });
    const anon = caller(null);
    const ok = await anon.member.hub.verify({ orgSlug: s.org.slug, token: m.row.cardToken });
    expect(ok).toEqual({ found: true, orgName: "NABC", name: "card Tester, LPC", level: "Professional", status: "active", expiresOn: iso(200), valid: true });
    const bad = await anon.member.hub.verify({ orgSlug: s.org.slug, token: "not-a-real-token" });
    expect(bad.found).toBe(false);
    const card = await m.api.member.hub.card({ orgSlug: s.org.slug });
    expect(card.verifyUrl).toContain(`/m/${s.org.slug}/verify/${m.row.cardToken}`);
    expect(card.wallet).toEqual({ apple: false, google: false });
  });

  it("signs a Google Wallet save link with the service account key", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOOGLE_WALLET_ISSUER_ID = "3388000000012345678";
    process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "wallet@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    try {
      expect(googleWalletConfigured()).toBe(true);
      expect(appleWalletConfigured()).toBe(false);
      const m = await addMember(s, "wallet@example.com");
      const url = googleSaveLink(s.org, m.row);
      const jwt = url.split("/save/")[1];
      const [h, p, sig] = jwt.split(".");
      expect(crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
      const payload = JSON.parse(Buffer.from(p, "base64url").toString());
      expect(payload.typ).toBe("savetowallet");
      expect(payload.payload.genericObjects[0].barcode.value).toContain(m.row.cardToken);
    } finally {
      delete process.env.GOOGLE_WALLET_ISSUER_ID;
      delete process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON;
    }
  });

  it("imports and exports members by CSV", async () => {
    await addMember(s, "existing@example.com", { level: "Student" });
    const csv = [
      "Email,First,Last,Credentials,Level,Member Number,Member Since,Expires On,Status",
      "new@example.com,Ana,Reyes,LPC,Professional,NB-30001,2019,12/31/2027,active",
      'existing@example.com,"Ellis, Jr.",Jordan,,Professional,,2015,2027-06-30,grace',
      "bad-email,No,Name,,,,,,active",
      "x@example.com,X,Y,,,,,13/45/2027,active",
    ].join("\n");
    const res = await s.admin.member.admin.members.importCsv({ orgId: s.org.id, csv });
    expect(res.added).toBe(1);
    expect(res.updated).toBe(1);
    expect(res.errors).toHaveLength(2);
    const list = await s.admin.member.admin.members.list({ orgId: s.org.id });
    const ana = list.members.find((m) => m.email === "new@example.com")!;
    expect(ana).toMatchObject({ memberNumber: "NB-30001", expiresOn: "2027-12-31", credentials: "LPC", memberSince: "2019" });
    const ex = list.members.find((m) => m.email === "existing@example.com")!;
    expect(ex).toMatchObject({ firstName: "Ellis, Jr.", level: "Professional", status: "grace", expiresOn: "2027-06-30" });
    expect(list.counts.grace).toBe(1);

    const out = await s.admin.member.admin.members.exportCsv({ orgId: s.org.id });
    const back = parseCsv(out.csv);
    expect(back.find((r) => r.email === "existing@example.com")?.first).toBe("Ellis, Jr.");
  });

  it("blocks members from admin routes", async () => {
    const m = await addMember(s, "member@example.com");
    const orgId = s.org.id;
    await expect(m.api.member.admin.members.list({ orgId })).rejects.toThrow();
    await expect(m.api.member.admin.members.importCsv({ orgId, csv: "email\nx@example.com" })).rejects.toThrow();
    await expect(m.api.member.admin.groups.list({ orgId })).rejects.toThrow();
    await expect(m.api.member.admin.docs.folders({ orgId })).rejects.toThrow();
    await expect(m.api.member.admin.insights.report({ orgId })).rejects.toThrow();
    await expect(m.api.member.admin.insights.followUp({ orgId, memberId: m.row.id })).rejects.toThrow();
    await expect(caller(null).member.admin.members.list({ orgId })).rejects.toThrow();
  });

  it("does the reports math across programs", async () => {
    const thisYear = new Date().getFullYear();
    const a = await addMember(s, "a@example.com", { memberSince: "2019", expiresOn: iso(-10) });
    const b = await addMember(s, "b@example.com", { memberSince: "2018" });
    await addMember(s, "c@example.com", { memberSince: "2017", status: "lapsed", expiresOn: iso(-60) });
    await addMember(s, "d@example.com", { memberSince: String(thisYear) });
    const e = await addMember(s, "e@example.com", { memberSince: "2015", expiresOn: iso(30), level: "Retired" });
    await addMember(s, "f@example.com", { memberSince: "2015", status: "cancelled", expiresOn: iso(-500) });

    await s.admin.member.admin.groups.save({ orgId: s.org.id, name: "Ethics", kind: "committee", joinRule: "appointment", hasChannel: false, hasFolder: false, chairCanEmail: false, chairCanAdd: false, members: [{ memberId: a.row.id, role: "member" }] });
    const past = getDb().insert(schema.events).values({ orgId: s.org.id, slug: `past-${randomToken(4).toLowerCase()}`, name: "Spring Summit", startDate: iso(-60), endDate: iso(-59), status: "ended" }).returning().get();
    const { attendee } = addAttendee(past.id, "b@example.com");
    addAttendee(past.id, "guest@example.com");
    getDb().insert(schema.certificates).values({ eventId: past.id, attendeeId: attendee.id, title: "Summit", hours: 2, code: randomToken(6) }).run();
    const program = await s.admin.member.admin.insights.programs.save({ orgId: s.org.id, name: "Mentoring program" });
    const imp = await s.admin.member.admin.insights.programs.importParticipants({ orgId: s.org.id, programId: program.id, csv: `email,date,rating\nb@example.com,${iso(-30)},5\nb@example.com,${iso(-30)},5\nnobody,${iso(-1)},3` });
    expect(imp).toMatchObject({ added: 1, skipped: 1 });
    expect(imp.errors).toHaveLength(1);

    const r = await s.admin.member.admin.insights.report({ orgId: s.org.id, range: "12m" });
    // Cohort: members whose expires-on date passed in the period. a is still active (renewed); c lapsed. f expired before the period; b, d, e have not come up yet.
    expect(r.kpis).toMatchObject({ activeMembers: 4, renewalRate: 50, renewedCount: 1, cohortCount: 2, ceHours: 2, noActivity: 2 });
    expect(r.byPrograms).toEqual([
      { label: "None", members: 1, rate: 0 },
      { label: "1 program", members: 1, rate: 100 },
      { label: "2 programs", members: 0, rate: null },
      { label: "3 or more", members: 0, rate: null },
    ]);
    expect(r.atRisk.map((x) => x.memberId)).toEqual([e.row.id]);
    expect(r.atRisk[0].reason).toBe("No events, groups or programs in 12 months");
    const summit = r.engagement.find((x) => x.name === "Spring Summit")!;
    expect(summit).toMatchObject({ people: 2, members: 1, renewed: 100 });
    expect(r.engagement.find((x) => x.name === "Mentoring program")).toMatchObject({ people: 1, members: 1, renewed: 100, rating: 5 });
    expect(r.engagement.find((x) => x.name === "Divisions and committees")).toMatchObject({ people: 1, members: 1, renewed: 100 });

    const retired = await s.admin.member.admin.insights.report({ orgId: s.org.id, range: "12m", level: "Retired" });
    expect(retired.kpis).toMatchObject({ activeMembers: 1, ceHours: 0 });

    getDb().update(schema.organizations).set({ platformLocationId: "loc_1" }).where(eq(schema.organizations.id, s.org.id)).run();
    const fu = await s.admin.member.admin.insights.followUp({ orgId: s.org.id, memberId: e.row.id });
    expect(fu.queued).toBe(true);
    const last = getDb().select().from(schema.platformOutbox).all().at(-1)!;
    expect(last.payload).toMatchObject({ email: "e@example.com", tags: ["renewal at risk"] });

    const csv = await s.admin.member.admin.insights.exportCsv({ orgId: s.org.id, range: "12m" });
    expect(csv.csv).toContain("Renewal rate,50%");
  });
});
