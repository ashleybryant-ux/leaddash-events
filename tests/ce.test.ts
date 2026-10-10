import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, caller, setupEvent, addAttendee, outbox, user, getDb, schema } from "./helpers";
import { issueEligible } from "../server/areas/ce/shared";
import { sendEvaluationReminders } from "../server/areas/ce";
import { pushLog } from "../server/_core/push";
import { seedEvent } from "../server/areas";
import { randomToken } from "../server/_core/crypto";

/** Event local time (America/Chicago, daylight time in April = UTC-5). */
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(`${date}T${String(h + 5).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
};
const setNow = (date: string, hhmm: string) => vi.setSystemTime(at(date, hhmm));

function addSession(eventId: number, extra: Partial<typeof schema.sessions.$inferInsert> = {}) {
  return getDb()
    .insert(schema.sessions)
    .values({ eventId, title: "Culturally Responsive Trauma Care", date: "2027-04-22", startTime: "10:30", endTime: "12:00", room: "Room 204", ceHours: 1.5, checkInCode: "ROOM204X", ...extra })
    .returning()
    .get();
}

function defaultForm(eventId: number) {
  return getDb().select().from(schema.evaluations).where(eq(schema.evaluations.eventId, eventId)).get()!;
}

const goodAnswers = { q1: 5, q2: 4, q3: 5, q4: "Great session" };

describe("CE: session check-in, evaluations and certificates", () => {
  beforeEach(async () => {
    await freshDb();
    vi.useFakeTimers({ toFake: ["Date"] });
    setNow("2027-04-22", "09:00");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("only accepts a room check-in from 30 minutes before the start to 15 minutes after the end", async () => {
    const { event } = await setupEvent();
    const s = addSession(event.id);
    const { api } = addAttendee(event.id, "jordan@example.com");
    setNow("2027-04-22", "09:55");
    await expect(api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" })).rejects.toThrow(/opens at 10:00 AM/);
    setNow("2027-04-22", "10:05");
    await expect(api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "WRONG" })).rejects.toThrow(/not for this session/);
    const ok = await api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: `https://events.leaddash.io/e/${event.slug}/checkin/${s.id}?code=room204x` });
    expect(ok.already).toBe(false);
    const again = await api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" });
    expect(again.already).toBe(true);

    const { api: late } = addAttendee(event.id, "late@example.com", "Lee", "Late");
    setNow("2027-04-22", "12:16");
    await expect(late.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" })).rejects.toThrow(/closed/);
    setNow("2027-04-22", "12:14");
    await expect(late.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" })).resolves.toMatchObject({ ok: true });
  });

  it("opens the evaluation only after check-in and takes it once", async () => {
    const { event } = await setupEvent();
    const s = addSession(event.id);
    const { api } = addAttendee(event.id, "jordan@example.com");
    setNow("2027-04-22", "12:05");
    expect((await api.ce.evaluations.forSession({ slug: event.slug, sessionId: s.id })).status).toBe("not_checked_in");
    await expect(api.ce.evaluations.submit({ slug: event.slug, sessionId: s.id, answers: goodAnswers })).rejects.toThrow(/Check in/);

    setNow("2027-04-22", "10:20");
    await api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" });
    expect((await api.ce.evaluations.forSession({ slug: event.slug, sessionId: s.id })).status).toBe("upcoming");
    await expect(api.ce.evaluations.submit({ slug: event.slug, sessionId: s.id, answers: goodAnswers })).rejects.toThrow(/opens when the session ends/);

    setNow("2027-04-22", "12:05");
    const open = await api.ce.evaluations.forSession({ slug: event.slug, sessionId: s.id });
    expect(open.status).toBe("open");
    expect(open.form?.questions.length).toBe(4);
    await expect(api.ce.evaluations.submit({ slug: event.slug, sessionId: s.id, answers: { q1: 5 } })).rejects.toThrow(/Please answer/);
    const res = await api.ce.evaluations.submit({ slug: event.slug, sessionId: s.id, answers: goodAnswers });
    expect(res.certificates.length).toBe(1);
    await expect(api.ce.evaluations.submit({ slug: event.slug, sessionId: s.id, answers: goodAnswers })).rejects.toThrow(/already/);
    expect((await api.ce.evaluations.forSession({ slug: event.slug, sessionId: s.id })).status).toBe("submitted");
  });

  it("issues certificates only when the rules are met, and only once", async () => {
    const { event, admin } = await setupEvent();
    const s = addSession(event.id);
    const noCe = addSession(event.id, { title: "Lunch and networking", ceHours: 0, checkInCode: "LUNCH1" });
    const { api, attendee, user: u } = addAttendee(event.id, "jordan@example.com");

    setNow("2027-04-22", "10:25");
    await api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" });
    await api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: noCe.id, code: "LUNCH1" });
    // The template asks for the evaluation, so nothing yet.
    expect((await admin.ce.certificates.issued({ eventId: event.id })).length).toBe(0);
    const credits = await api.ce.certificates.credits({ slug: event.slug });
    expect(credits.waiting.map((w) => w.sessionId)).toEqual([s.id]);
    expect(credits.waiting[0].state).toBe("upcoming");

    setNow("2027-04-22", "12:10");
    await api.ce.evaluations.submit({ slug: event.slug, sessionId: s.id, answers: goodAnswers });
    await api.ce.evaluations.submit({ slug: event.slug, sessionId: noCe.id, answers: goodAnswers });
    await issueEligible(attendee.id);
    await issueEligible(attendee.id);
    const issued = await admin.ce.certificates.issued({ eventId: event.id });
    expect(issued.map((c) => c.title)).toEqual([s.title]);
    expect(issued[0].hours).toBe(1.5);
    expect(issued[0].code).toMatch(/^[A-Z2-9]{10}$/);
    expect(pushLog.some((p) => p.userId === u.id && /certificate/i.test(p.title))).toBe(true);
    expect((await api.ce.certificates.credits({ slug: event.slug })).hours).toBe(1.5);

    // Public page doubles as the check.
    const page = await caller(null).ce.certificates.byCode({ code: issued[0].code });
    expect(page?.revoked).toBe(false);
    expect(page?.name).toBe("Jordan Ellis");
  });

  it("applies the minimum minutes rule and the no-evaluation option", async () => {
    const { event, admin } = await setupEvent();
    const s = addSession(event.id);
    const tpl = (await admin.ce.certificates.templates({ eventId: event.id }))[0];
    await admin.ce.certificates.updateTemplate({
      eventId: event.id,
      templateId: tpl.id,
      name: tpl.name,
      title: tpl.title,
      providerName: tpl.providerName,
      providerNumber: "7890",
      approvalText: "Approved by NBCC",
      signerName: "Dr. Ashley Bryant",
      signerTitle: "CE Chair",
      signatureStyle: "script",
      signatureFileId: null,
      scope: "session",
      requireEvaluation: false,
      minMinutes: 60,
      isDefault: true,
      show: tpl.show,
    });
    const early = addAttendee(event.id, "early@example.com", "Avery", "Carter");
    const late = addAttendee(event.id, "late@example.com", "Taylor", "Reed");
    setNow("2027-04-22", "10:28");
    await early.api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" });
    setNow("2027-04-22", "11:30");
    await late.api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" });
    const issued = await admin.ce.certificates.issued({ eventId: event.id });
    expect(issued.map((c) => c.email)).toEqual(["early@example.com"]);

    // Staff can add a check-in by hand; it counts the full session.
    await admin.ce.checkin.session.remove({ eventId: event.id, sessionId: s.id, attendeeId: late.attendee.id });
    await admin.ce.checkin.session.add({ eventId: event.id, sessionId: s.id, attendeeId: late.attendee.id });
    expect((await admin.ce.certificates.issued({ eventId: event.id })).length).toBe(2);
  });

  it("revokes a certificate and never issues it again on its own", async () => {
    const { event, admin } = await setupEvent();
    const s = addSession(event.id);
    const { api, attendee } = addAttendee(event.id, "jordan@example.com");
    setNow("2027-04-22", "10:25");
    await api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" });
    setNow("2027-04-22", "12:10");
    await api.ce.evaluations.submit({ slug: event.slug, sessionId: s.id, answers: goodAnswers });
    const [cert] = await admin.ce.certificates.issued({ eventId: event.id });
    await admin.ce.certificates.revoke({ eventId: event.id, certificateId: cert.id });
    await issueEligible(attendee.id);
    const after = await admin.ce.certificates.issued({ eventId: event.id });
    expect(after.length).toBe(1);
    expect(after[0].revokedAt).toBeTruthy();
    expect((await caller(null).ce.certificates.byCode({ code: cert.code }))?.revoked).toBe(true);
    expect((await api.ce.certificates.credits({ slug: event.slug })).hours).toBe(0);
    await expect(admin.ce.certificates.resend({ eventId: event.id, certificateId: cert.id })).rejects.toThrow(/revoked/);
    // Issuing by hand restores it.
    await admin.ce.certificates.issue({ eventId: event.id, attendeeId: attendee.id, sessionId: s.id });
    expect((await api.ce.certificates.credits({ slug: event.slug })).hours).toBe(1.5);
  });

  it("builds a transcript across two events of the same organization", async () => {
    const { event, org, admin } = await setupEvent();
    const db = getDb();
    const older = db
      .insert(schema.events)
      .values({ orgId: org.id, slug: `ev-${randomToken(5).toLowerCase()}`, name: "NABC Annual Conference 2026", startDate: "2026-04-23", endDate: "2026-04-25" })
      .returning()
      .get();
    await seedEvent(older.id);
    const other = await setupEvent({ orgName: "Another organization", ownerEmail: "other@example.org" });
    const s1 = addSession(event.id);
    const s2 = addSession(older.id, { date: "2026-04-23", ceHours: 3 });
    const s3 = addSession(other.event.id, { ceHours: 6 });
    const now = addAttendee(event.id, "jordan@example.com");
    const before = db.insert(schema.attendees).values({ eventId: older.id, email: "jordan@example.com", firstName: "Jordan", lastName: "Ellis", qrToken: randomToken(12) }).returning().get();
    const elsewhere = db.insert(schema.attendees).values({ eventId: other.event.id, email: "jordan@example.com", firstName: "Jordan", lastName: "Ellis", qrToken: randomToken(12) }).returning().get();
    await admin.ce.certificates.issue({ eventId: event.id, attendeeId: now.attendee.id, sessionId: s1.id });
    await admin.ce.certificates.issue({ eventId: older.id, attendeeId: before.id, sessionId: s2.id });
    await other.admin.ce.certificates.issue({ eventId: other.event.id, attendeeId: elsewhere.id, sessionId: s3.id });
    db.insert(schema.ceEntries).values({ orgId: org.id, email: "jordan@example.com", title: "Ethics webinar", provider: "NABC", date: "2026-10-09", hours: 2 }).run();

    const t = await now.api.ce.certificates.transcript({ slug: event.slug });
    expect(t.totalHours).toBe(6.5);
    expect(t.events.map((e) => e.name)).toEqual(["NABC Annual Conference", "NABC Annual Conference 2026"]);
    expect(t.entries.map((e) => e.title)).toEqual(["Ethics webinar"]);
    const csv = await now.api.ce.certificates.transcriptCsv({ slug: event.slug });
    expect(csv.csv).toContain("Ethics webinar");
    expect(csv.csv).not.toContain("Another organization");
  });

  it("lets a session use its own evaluation form instead of the default", async () => {
    const { event, admin } = await setupEvent();
    const s = addSession(event.id);
    const other = addSession(event.id, { title: "Ethics in Supervision", checkInCode: "ETHICS1" });
    const form = await admin.ce.evaluations.create({ eventId: event.id, name: "Keynote evaluation" });
    expect(form.isDefault).toBe(false);
    await admin.ce.evaluations.update({
      eventId: event.id,
      evaluationId: form.id,
      name: "Keynote evaluation",
      isDefault: false,
      opensAt: "checkin",
      closesAfterHours: 336,
      neededForCertificate: true,
      sessionIds: [s.id],
      questions: [
        { kind: "yesno", label: "Would you attend again?", required: true },
        { kind: "choice", label: "Best part", required: false, options: ["Content", "Speaker"] },
      ],
    });
    const { api } = addAttendee(event.id, "jordan@example.com");
    setNow("2027-04-22", "10:20");
    await api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" });
    await api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: other.id, code: "ETHICS1" });
    const mine = await api.ce.evaluations.forSession({ slug: event.slug, sessionId: s.id });
    expect(mine.status).toBe("open");
    expect(mine.form?.questions.map((q) => q.label)).toEqual(["Would you attend again?", "Best part"]);
    expect((await api.ce.evaluations.forSession({ slug: event.slug, sessionId: other.id })).status).toBe("upcoming");
    await expect(api.ce.evaluations.submit({ slug: event.slug, sessionId: s.id, answers: { [mine.form!.questions[0].id]: "maybe" } })).rejects.toThrow(/yes or no/);
    await api.ce.evaluations.submit({ slug: event.slug, sessionId: s.id, answers: { [mine.form!.questions[0].id]: "yes" } });
    // Taking the session off the form sends it back to the default.
    await admin.ce.evaluations.setForSession({ eventId: event.id, sessionId: s.id, evaluationId: null });
    const forms = await admin.ce.evaluations.list({ eventId: event.id });
    expect(forms.find((f) => f.id === form.id)).toMatchObject({ sessionCount: 0, responseCount: 1 });
    await expect(admin.ce.evaluations.remove({ eventId: event.id, evaluationId: form.id })).rejects.toThrow(/responses/);
  });

  it("sends the evaluation-ready notice once, five minutes after the session ends", async () => {
    const { event } = await setupEvent();
    const s = addSession(event.id);
    const { api, user: u } = addAttendee(event.id, "jordan@example.com");
    setNow("2027-04-22", "10:25");
    await api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" });
    pushLog.length = 0;
    expect(await sendEvaluationReminders(at("2027-04-22", "12:03").getTime())).toBe(0);
    expect(await sendEvaluationReminders(at("2027-04-22", "12:05").getTime())).toBe(1);
    expect(await sendEvaluationReminders(at("2027-04-22", "12:06").getTime())).toBe(0);
    expect(pushLog.filter((p) => p.userId === u.id && p.title === "Your evaluation is ready").length).toBe(1);
  });
});

describe("CE: check-in desk, attendees and staff roles", () => {
  beforeEach(async () => {
    await freshDb();
    vi.useFakeTimers({ toFake: ["Date"] });
    setNow("2027-04-22", "07:30");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds people by name or scanned badge, checks them in, prints and takes walk-ups", async () => {
    const { event, admin } = await setupEvent();
    const { attendee } = addAttendee(event.id, "jordan@example.com", "Jordan", "Mitchell", { credentials: "LPC", city: "Atlanta, GA" });
    expect((await admin.ce.checkin.search({ eventId: event.id, q: "jord" })).map((r) => r.id)).toEqual([attendee.id]);
    const byUrl = await admin.ce.checkin.lookup({ eventId: event.id, code: `https://events.leaddash.io/e/${event.slug}/badge?t=${attendee.qrToken}` });
    expect(byUrl?.id).toBe(attendee.id);
    expect((await admin.ce.checkin.lookup({ eventId: event.id, code: attendee.qrToken }))?.id).toBe(attendee.id);
    await admin.ce.checkin.checkIn({ eventId: event.id, attendeeId: attendee.id });
    await admin.ce.checkin.badgePrinted({ eventId: event.id, attendeeId: attendee.id });
    const badge = await admin.ce.checkin.badge({ eventId: event.id, attendeeId: attendee.id });
    expect(badge.ribbon).toBe("ATTENDEE");
    expect(badge.qr).toContain(`badge?t=${attendee.qrToken}`);
    const row = (await admin.ce.checkin.search({ eventId: event.id, q: "mitchell" }))[0];
    expect(row.checkedInBy).toBe("Olivia Owner");
    expect(row.badgePrints).toBe(1);
    await admin.ce.checkin.walkUp({ eventId: event.id, firstName: "Sam", lastName: "Walker", email: "sam@example.com", ticketTypeId: null });
    expect(await admin.ce.checkin.counts({ eventId: event.id })).toMatchObject({ total: 2, checkedIn: 2, walkIns: 1 });
    await admin.ce.checkin.undo({ eventId: event.id, attendeeId: attendee.id });
    expect(await admin.ce.checkin.counts({ eventId: event.id })).toMatchObject({ checkedIn: 1, notYet: 1 });
  });

  it("lets a check-in volunteer check people in but not open evaluations, until the event ends", async () => {
    const { event, admin } = await setupEvent();
    const roles = await admin.ce.staff.list({ eventId: event.id });
    expect(roles.roles.map((r) => r.kind)).toEqual(["event_admin", "checkin", "reviewer", "booth", "speaker"]);
    const volunteerRole = roles.roles.find((r) => r.kind === "checkin")!;
    await admin.ce.staff.addPerson({ eventId: event.id, roleId: volunteerRole.id, email: "kristen@example.com", name: "Kristen Trinidad" });
    expect(outbox.at(-1)?.to).toBe("kristen@example.com");
    expect(outbox.at(-1)?.text).toContain(`/admin/e/${event.id}`);
    const volunteer = caller(user("kristen@example.com"));
    const { attendee } = addAttendee(event.id, "jordan@example.com");
    await expect(volunteer.ce.checkin.checkIn({ eventId: event.id, attendeeId: attendee.id })).resolves.toMatchObject({ ok: true });
    await expect(volunteer.ce.attendees.list({ eventId: event.id })).resolves.toHaveLength(1);
    await expect(volunteer.ce.evaluations.list({ eventId: event.id })).rejects.toThrow();
    await expect(volunteer.ce.attendees.update({ eventId: event.id, attendeeId: attendee.id, firstName: "X", lastName: "Y", email: "jordan@example.com", ticketTypeId: null, kind: "attendee" })).rejects.toThrow();
    await expect(volunteer.ce.staff.list({ eventId: event.id })).rejects.toThrow();

    vi.setSystemTime(new Date("2027-04-26T12:00:00Z"));
    await expect(volunteer.ce.checkin.checkIn({ eventId: event.id, attendeeId: attendee.id })).rejects.toThrow();

    // A role that never ends keeps working.
    await admin.ce.staff.update({ eventId: event.id, roleId: volunteerRole.id, name: "Check-in volunteer", endsWithEvent: false, signInWith: "email", access: { checkin: "edit", attendees: "view", help: "edit" } });
    await expect(volunteer.ce.checkin.counts({ eventId: event.id })).resolves.toMatchObject({ checkedIn: 1 });
  });

  it("keeps attendees out of admin routes", async () => {
    const { event } = await setupEvent();
    const { api, attendee } = addAttendee(event.id, "jordan@example.com");
    await expect(api.ce.attendees.list({ eventId: event.id })).rejects.toThrow();
    await expect(api.ce.checkin.checkIn({ eventId: event.id, attendeeId: attendee.id })).rejects.toThrow();
    await expect(api.ce.certificates.issued({ eventId: event.id })).rejects.toThrow();
    await expect(api.ce.reports.event({ eventId: event.id })).rejects.toThrow();
    await expect(api.ce.staff.list({ eventId: event.id })).rejects.toThrow();
    await expect(api.ce.checkin.session.add({ eventId: event.id, sessionId: 1, attendeeId: attendee.id })).rejects.toThrow();
    await expect(api.ce.checkin.myBadge({ slug: event.slug })).resolves.toMatchObject({ firstName: "Jordan" });
  });

  it("imports attendees from CSV and exports them", async () => {
    const { event, admin } = await setupEvent();
    const ticket = getDb().insert(schema.ticketTypes).values({ eventId: event.id, name: "Board member", ribbon: "Board" }).returning().get();
    addAttendee(event.id, "already@example.com", "Al", "Ready");
    const csv = [
      "Name,Email,Ticket name,Credentials,Phone",
      'Jordan Mitchell,Jordan@Example.com,Board Member,LPC,(404) 555-0100',
      '"Avery Ann Carter",avery@example.com,,LMFT,',
      "Al Ready,already@example.com,,,",
      "No Email,,Board member,,",
      "Pat Smith,pat@example.com,VIP,,",
    ].join("\n");
    const res = await admin.ce.attendees.importCsv({ eventId: event.id, csv });
    expect(res.added).toBe(2);
    expect(res.skipped).toBe(1);
    expect(res.errors.length).toBe(2);
    const list = await admin.ce.attendees.list({ eventId: event.id });
    const jordan = list.find((r) => r.email === "jordan@example.com")!;
    expect(jordan).toMatchObject({ firstName: "Jordan", lastName: "Mitchell", credentials: "LPC", ticketTypeId: ticket.id });
    expect(list.find((r) => r.email === "avery@example.com")).toMatchObject({ firstName: "Avery Ann", lastName: "Carter" });
    const badge = await admin.ce.checkin.badge({ eventId: event.id, attendeeId: jordan.id });
    expect(badge.ribbon).toBe("BOARD");
    const out = await admin.ce.attendees.exportCsv({ eventId: event.id });
    expect(out.csv.split("\r\n")[0]).toContain("First name");
    expect(out.csv).toContain("jordan@example.com");

    await admin.ce.attendees.setStatus({ eventId: event.id, attendeeId: jordan.id, status: "cancelled" });
    expect(await admin.ce.checkin.counts({ eventId: event.id })).toMatchObject({ total: 2 });
  });

  it("reports registrations, check-ins, session attendance and evaluation scores", async () => {
    const { event, admin } = await setupEvent();
    const s = addSession(event.id, { capacity: 50 });
    const a = addAttendee(event.id, "jordan@example.com");
    addAttendee(event.id, "avery@example.com", "Avery", "Carter");
    await admin.ce.checkin.checkIn({ eventId: event.id, attendeeId: a.attendee.id });
    setNow("2027-04-22", "10:25");
    await a.api.ce.checkin.session.checkIn({ slug: event.slug, sessionId: s.id, code: "ROOM204X" });
    setNow("2027-04-22", "12:10");
    await a.api.ce.evaluations.submit({ slug: event.slug, sessionId: s.id, answers: { q1: 5, q2: 4, q3: 3 } });
    const r = await admin.ce.reports.event({ eventId: event.id });
    expect(r.kpis).toMatchObject({ registered: 2, checkedIn: 1, checkInRate: 50, ceHours: 1.5, certificates: 1 });
    expect(r.sessions[0]).toMatchObject({ checkedIn: 1, capacity: 50, ofCapacity: 2, evalScore: 4 });
    const results = await admin.ce.evaluations.results({ eventId: event.id, evaluationId: defaultForm(event.id).id });
    expect(results.perSession[0]).toMatchObject({ responses: 1, average: 4 });
    const all = await admin.ce.reports.exportCsv({ eventId: event.id, section: "all" });
    expect(all.csv).toContain("Registered");
  });
});
