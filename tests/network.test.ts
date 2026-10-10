import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, caller, setupEvent, addAttendee, outbox, user, getDb, schema } from "./helpers";
import { pushLog } from "../server/_core/push";

async function setup() {
  const ctx = await setupEvent();
  const a = addAttendee(ctx.event.id, "alex@example.com", "Alex", "Rivera");
  const b = addAttendee(ctx.event.id, "blair@example.com", "Blair", "Stone");
  return { ...ctx, a, b };
}

/** A staff role of a built-in kind with one person on it. */
function staff(eventId: number, kind: "reviewer" | "booth" | "custom", email: string, name: string, opts: { vendorId?: number; access?: Record<string, string> } = {}) {
  const db = getDb();
  const role = db.insert(schema.staffRoles).values({ eventId, name: kind, kind, access: (opts.access ?? {}) as never, endsWithEvent: false }).returning().get();
  const u = user(email, name);
  db.insert(schema.staffAssignments).values({ roleId: role.id, userId: u.id, vendorId: opts.vendorId ?? null }).run();
  return { user: u, api: caller(u), role };
}

describe("messages", () => {
  beforeEach(async () => {
    await freshDb();
    pushLog.length = 0;
  });

  it("sends messages, counts unread and clears them on read", async () => {
    const { event, a, b } = await setup();
    const { threadId } = await a.api.network.messages.start({ slug: event.slug, attendeeId: b.attendee.id });
    const again = await a.api.network.messages.start({ slug: event.slug, attendeeId: b.attendee.id });
    expect(again.threadId).toBe(threadId);
    const back = await b.api.network.messages.start({ slug: event.slug, attendeeId: a.attendee.id });
    expect(back.threadId).toBe(threadId);

    await a.api.network.messages.send({ slug: event.slug, threadId, body: "Coffee before the 2:00 session?" });
    await a.api.network.messages.send({ slug: event.slug, threadId, body: "I will be by the lounge." });
    expect(await b.api.network.unreadMessages({ slug: event.slug })).toBe(2);
    expect(await a.api.network.unreadMessages({ slug: event.slug })).toBe(0);

    const push = pushLog.find((p) => p.userId === b.user.id)!;
    expect(push.title).toBe("New message from Alex");
    expect(push.body).toBe("");
    expect(push.url).toBe(`/e/${event.slug}/messages/${threadId}`);

    const list = await b.api.network.messages.list({ slug: event.slug });
    expect(list[0].unread).toBe(2);
    expect(list[0].last.body).toBe("I will be by the lounge.");

    await b.api.network.messages.markRead({ slug: event.slug, threadId });
    expect(await b.api.network.unreadMessages({ slug: event.slug })).toBe(0);
    await a.api.network.messages.send({ slug: event.slug, threadId, body: "See you." });
    expect(await b.api.network.unreadMessages({ slug: event.slug })).toBe(1);

    await b.api.network.messages.mute({ slug: event.slug, threadId, muted: true });
    expect(await b.api.network.unreadMessages({ slug: event.slug })).toBe(0);
  });

  it("returns 0 unread for people who are not attendees and keeps strangers out of threads", async () => {
    const { event, a, b, admin } = await setup();
    expect(await admin.network.unreadMessages({ slug: event.slug })).toBe(0);
    const c = addAttendee(event.id, "casey@example.com", "Casey", "Lee");
    const { threadId } = await a.api.network.messages.start({ slug: event.slug, attendeeId: b.attendee.id });
    await expect(c.api.network.messages.get({ slug: event.slug, threadId })).rejects.toThrow();
    await expect(c.api.network.messages.send({ slug: event.slug, threadId, body: "hi" })).rejects.toThrow();
    await expect(a.api.network.messages.send({ slug: event.slug, threadId, body: "x".repeat(2001) })).rejects.toThrow();
  });

  it("stops blocked people from messaging and hides them from the directory", async () => {
    const { event, a, b } = await setup();
    const { threadId } = await a.api.network.messages.start({ slug: event.slug, attendeeId: b.attendee.id });
    await b.api.network.people.block({ slug: event.slug, attendeeId: a.attendee.id });
    await expect(a.api.network.messages.send({ slug: event.slug, threadId, body: "Hello?" })).rejects.toThrow();
    await expect(b.api.network.messages.send({ slug: event.slug, threadId, body: "Hello?" })).rejects.toThrow();
    await expect(a.api.network.messages.start({ slug: event.slug, attendeeId: b.attendee.id })).rejects.toThrow();

    const forA = await a.api.network.people.list({ slug: event.slug });
    expect(forA.people.map((p) => p.id)).not.toContain(b.attendee.id);
    await expect(a.api.network.people.get({ slug: event.slug, attendeeId: b.attendee.id })).rejects.toThrow();

    await b.api.network.people.unblock({ slug: event.slug, attendeeId: a.attendee.id });
    await a.api.network.messages.send({ slug: event.slug, threadId, body: "Hello again" });
    const forA2 = await a.api.network.people.list({ slug: event.slug });
    expect(forA2.people.map((p) => p.id)).toContain(b.attendee.id);
  });

  it("lists visible people with search and filters", async () => {
    const { event, a } = await setup();
    addAttendee(event.id, "hidden@example.com", "Hidden", "Person", { visible: false });
    addAttendee(event.id, "gone@example.com", "Gone", "Person", { status: "cancelled" });
    addAttendee(event.id, "dana@example.com", "Dana", "Whitfield", { organization: "Houston Counseling", interests: ["Trauma"], city: "Houston" });
    const all = await a.api.network.people.list({ slug: event.slug });
    const names = all.people.map((p) => p.firstName);
    expect(names).toContain("Dana");
    expect(names).not.toContain("Hidden");
    expect(names).not.toContain("Gone");
    expect(names).not.toContain("Alex");
    expect((await a.api.network.people.list({ slug: event.slug, q: "houston" })).people.map((p) => p.firstName)).toEqual(["Dana"]);
    expect((await a.api.network.people.list({ slug: event.slug, interest: "trauma" })).people).toHaveLength(1);
    expect((await a.api.network.people.list({ slug: event.slug, organization: "Houston Counseling" })).people).toHaveLength(1);
    await a.api.network.people.updateMe({ slug: event.slug, jobTitle: "Owner", organization: "Rivera Group", city: "Atlanta, GA", bio: "Hi", credentials: "LPC", interests: ["Practice"], photoFileId: null, visible: true });
    const me = await a.api.network.people.me({ slug: event.slug });
    expect(me.credentials).toBe("LPC");
  });
});

describe("meetings", () => {
  beforeEach(async () => {
    await freshDb();
    pushLog.length = 0;
  });

  it("requests, accepts and declines meetings with notices", async () => {
    const { event, a, b } = await setup();
    await expect(a.api.network.meetings.request({ slug: event.slug, attendeeId: b.attendee.id, date: "2027-05-01", startTime: "12:15", minutes: 30, place: "Lounge", note: "" })).rejects.toThrow();
    const m = await a.api.network.meetings.request({ slug: event.slug, attendeeId: b.attendee.id, date: "2027-04-22", startTime: "12:15", minutes: 30, place: "Networking lounge", note: "Hiring notes" });
    expect(pushLog.some((p) => p.userId === b.user.id && p.title === "Meeting request from Alex")).toBe(true);
    await expect(a.api.network.meetings.respond({ slug: event.slug, id: m.id, accept: true })).rejects.toThrow();
    await b.api.network.meetings.respond({ slug: event.slug, id: m.id, accept: true });
    const mine = await a.api.network.meetings.mine({ slug: event.slug });
    expect(mine[0].status).toBe("accepted");
    expect(pushLog.some((p) => p.userId === a.user.id && p.title === "Blair accepted your meeting")).toBe(true);

    const free = await a.api.network.meetings.freeTimes({ slug: event.slug, attendeeId: b.attendee.id, date: "2027-04-22", minutes: 30 });
    expect(free).not.toContain("12:15");
    expect(free).toContain("12:45");

    const m2 = await a.api.network.meetings.request({ slug: event.slug, attendeeId: b.attendee.id, date: "2027-04-23", startTime: "09:00", minutes: 15, place: "", note: "" });
    await b.api.network.meetings.respond({ slug: event.slug, id: m2.id, accept: false });
    expect((await a.api.network.meetings.mine({ slug: event.slug })).find((x) => x.id === m2.id)!.status).toBe("declined");
    await a.api.network.meetings.cancel({ slug: event.slug, id: m.id });
    expect((await b.api.network.meetings.mine({ slug: event.slug })).find((x) => x.id === m.id)!.status).toBe("cancelled");
  });
});

describe("community", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("seeds official channels, posts, replies, likes and moderates", async () => {
    const { event, a, b, admin } = await setup();
    const { channels } = await a.api.network.community.channels({ slug: event.slug });
    expect(channels.map((c) => c.name)).toEqual(expect.arrayContaining(["General", "Introductions", "Ask the organizers"]));
    expect(channels.every((c) => c.pinned)).toBe(true);

    const { channelId } = await a.api.network.community.start({ slug: event.slug, name: "Dinner meetup", body: "Dinner Thursday?", category: "Meetups" });
    const ch = await b.api.network.community.channel({ slug: event.slug, channelId });
    const root = ch.posts[0];
    expect(ch.replyToId).toBe(root.id);
    const reply = await b.api.network.community.post({ slug: event.slug, channelId, body: "I am in", parentId: root.id });
    await b.api.network.community.like({ slug: event.slug, postId: root.id, liked: true });
    await b.api.network.community.like({ slug: event.slug, postId: root.id, liked: true });
    const after = await a.api.network.community.channel({ slug: event.slug, channelId });
    expect(after.posts[0].likes).toBe(1);
    expect(after.posts[0].replies.map((r) => r.body)).toEqual(["I am in"]);

    await a.api.network.community.report({ slug: event.slug, postId: reply.id });
    const reported = await admin.network.community.admin.reported({ eventId: event.id });
    expect(reported[0].id).toBe(reply.id);
    expect(reported[0].author).toBe("Blair Stone");
    await admin.network.community.admin.setHidden({ eventId: event.id, postId: reply.id, hidden: true });
    const hiddenView = await a.api.network.community.channel({ slug: event.slug, channelId });
    expect(hiddenView.posts[0].replies).toHaveLength(0);
    expect(await admin.network.community.admin.reported({ eventId: event.id })).toHaveLength(0);
    const adminView = await admin.network.community.admin.posts({ eventId: event.id, channelId });
    expect(adminView[0].replies[0].hidden).toBe(true);

    await admin.network.community.admin.updateChannel({ eventId: event.id, channelId, locked: true });
    await expect(b.api.network.community.post({ slug: event.slug, channelId, body: "Late reply" })).rejects.toThrow();
    await admin.network.community.admin.postAsEvent({ eventId: event.id, channelId: channels[0].id, body: "Welcome!" });
    const general = await a.api.network.community.channel({ slug: event.slug, channelId: channels[0].id });
    expect(general.posts[0].byEvent).toBe(true);
    expect(general.posts[0].author).toBeNull();
  });

  it("hides posts automatically after enough reports and follows the start rule", async () => {
    const { event, a, b, admin } = await setup();
    const c = addAttendee(event.id, "casey@example.com", "Casey", "Lee");
    await admin.network.community.admin.updateSettings({ eventId: event.id, whoCanStart: "attendees", exhibitorPosting: "own", hideAfterReports: 2 });
    const { channels } = await a.api.network.community.channels({ slug: event.slug });
    const post = await a.api.network.community.post({ slug: event.slug, channelId: channels[0].id, body: "Buy my thing" });
    await b.api.network.community.report({ slug: event.slug, postId: post.id });
    await b.api.network.community.report({ slug: event.slug, postId: post.id });
    expect((await c.api.network.community.channel({ slug: event.slug, channelId: channels[0].id })).posts).toHaveLength(1);
    await c.api.network.community.report({ slug: event.slug, postId: post.id });
    expect((await c.api.network.community.channel({ slug: event.slug, channelId: channels[0].id })).posts).toHaveLength(0);

    await admin.network.community.admin.updateSettings({ eventId: event.id, whoCanStart: "team", exhibitorPosting: "own", hideAfterReports: 3 });
    await expect(a.api.network.community.start({ slug: event.slug, name: "New topic", body: "Hi" })).rejects.toThrow();
  });
});

describe("vendors and leads", () => {
  beforeEach(async () => {
    await freshDb();
  });

  async function vendorSetup() {
    const ctx = await setup();
    const { admin, event } = ctx;
    const v1 = await admin.network.vendors.create({ eventId: event.id, company: "Brooks Practice Software", kind: "exhibitor" });
    const v2 = await admin.network.vendors.create({ eventId: event.id, company: "Clearview Billing", kind: "sponsor" });
    const base = { kind: "exhibitor" as const, level: "", category: "Practice software", contactName: "Morgan Brooks", email: "morgan@example.com", phone: "", booth: "14", status: "confirmed" as const, amountCents: 150000, paidCents: 50000, description: "", website: "", offer: "", notes: "", logoFileId: null, contractFileId: null, benefits: [{ label: "Two staff badges", status: "done" as const }], visible: true, leadScanning: true };
    await admin.network.vendors.update({ ...base, eventId: event.id, vendorId: v1.id, company: v1.company, boothStaff: ["riley@example.com"] });
    await admin.network.vendors.update({ ...base, eventId: event.id, vendorId: v2.id, company: v2.company, kind: "sponsor", level: "Presenting sponsor", booth: "1", email: "sam@example.com", status: "paid", paidCents: 150000, boothStaff: ["sam@example.com"] });
    return { ...ctx, v1, v2 };
  }

  it("lists sponsors first for attendees and keeps the admin list to vendor staff", async () => {
    const { event, a, admin, v1, v2 } = await vendorSetup();
    const list = await a.api.network.exhibitors.list({ slug: event.slug });
    expect(list.map((v) => v.id)).toEqual([v2.id, v1.id]);
    await expect(a.api.network.vendors.list({ eventId: event.id })).rejects.toThrow();
    const adminList = await admin.network.vendors.list({ eventId: event.id });
    expect(adminList.stats.balanceDue).toBe(1);
    expect(adminList.vendors.find((v) => v.id === v1.id)!.benefits[0].status).toBe("done");
  });

  it("lets booth staff scan for their own vendor only", async () => {
    const { event, a, b, v1, v2 } = await vendorSetup();
    const riley = caller(user("riley@example.com"));
    const sam = caller(user("sam@example.com"));
    const ctx1 = await riley.network.leads.context({ slug: event.slug });
    expect(ctx1.map((v) => v.id)).toEqual([v1.id]);

    const found = await riley.network.leads.lookup({ slug: event.slug, vendorId: v1.id, code: `https://events.leaddash.io/e/${event.slug}/badge?t=${b.attendee.qrToken}` });
    expect(found.person.email).toBe("blair@example.com");
    await riley.network.leads.save({ slug: event.slug, vendorId: v1.id, attendeeId: b.attendee.id, rating: "hot", note: "Wants a demo" });
    await sam.network.leads.save({ slug: event.slug, vendorId: v2.id, attendeeId: a.attendee.id, rating: "warm", note: "" });

    expect((await riley.network.leads.list({ slug: event.slug, vendorId: v1.id })).map((l) => l.person.email)).toEqual(["blair@example.com"]);
    await expect(riley.network.leads.list({ slug: event.slug, vendorId: v2.id })).rejects.toThrow();
    await expect(riley.network.leads.save({ slug: event.slug, vendorId: v2.id, attendeeId: a.attendee.id, rating: "cold", note: "" })).rejects.toThrow();
    await expect(a.api.network.leads.list({ slug: event.slug, vendorId: v1.id })).rejects.toThrow();
    const csv = await riley.network.leads.exportCsv({ slug: event.slug, vendorId: v1.id });
    expect(csv.csv).toContain("blair@example.com");
    expect(csv.csv).not.toContain("alex@example.com");
  });

  it("shows venue maps with booths matched to exhibitors", async () => {
    const { event, a, admin, owner, v1 } = await vendorSetup();
    const f = getDb().insert(schema.files).values({ orgId: event.orgId, key: "mapkey", name: "map.png", mime: "image/png", size: 10, uploadedBy: owner.id }).returning().get();
    const m = await admin.network.maps.create({ eventId: event.id, name: "Level 1", fileId: f.id });
    await admin.network.maps.update({ eventId: event.id, mapId: m.id, name: "Level 1", fileId: f.id, sort: 0, pins: [{ label: "14", x: 40, y: 60, kind: "booth" }, { label: "Grand Ballroom", x: 20, y: 20, kind: "room" }] });
    const maps = await a.api.network.maps.list({ slug: event.slug });
    expect(maps[0].pins.find((p) => p.label === "14")!.vendorId).toBe(v1.id);
    await expect(a.api.network.maps.update({ eventId: event.id, mapId: m.id, name: "x", fileId: null, sort: 0, pins: [] })).rejects.toThrow();
  });
});

describe("polls and Q&A", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("lets presenters run polls and attendees vote once", async () => {
    const { event, a, b } = await setup();
    const db = getDb();
    const session = db.insert(schema.sessions).values({ eventId: event.id, title: "Trauma Care", date: "2027-04-22", startTime: "10:00", endTime: "11:00", room: "204", checkInCode: "c1" }).returning().get();
    const presenterUser = user("taylor@example.com", "Taylor Reed");
    const sp = db.insert(schema.speakers).values({ eventId: event.id, name: "Taylor Reed", email: "taylor@example.com", userId: presenterUser.id }).returning().get();
    db.insert(schema.sessionSpeakers).values({ sessionId: session.id, speakerId: sp.id }).run();
    const presenter = caller(presenterUser);

    await expect(a.api.network.polls.create({ slug: event.slug, sessionId: session.id, question: "How often?", options: ["Always", "Sometimes"] })).rejects.toThrow();
    const poll = await presenter.network.polls.create({ slug: event.slug, sessionId: session.id, question: "How often do you screen?", options: ["Every client", "Only when it comes up", "Rarely"] });
    expect((await a.api.network.polls.live({ slug: event.slug, sessionId: session.id })).polls).toHaveLength(0);
    await presenter.network.polls.setStatus({ slug: event.slug, pollId: poll.id, status: "open" });

    const before = await a.api.network.polls.live({ slug: event.slug, sessionId: session.id });
    expect(before.polls[0].results).toBeNull();
    await a.api.network.polls.vote({ slug: event.slug, pollId: poll.id, option: 0 });
    await expect(a.api.network.polls.vote({ slug: event.slug, pollId: poll.id, option: 1 })).rejects.toThrow();
    await b.api.network.polls.vote({ slug: event.slug, pollId: poll.id, option: 0 });
    const after = await a.api.network.polls.live({ slug: event.slug, sessionId: session.id });
    expect(after.polls[0].results).toEqual([2, 0, 0]);
    expect(after.polls[0].myVote).toBe(0);

    const q = await a.api.network.polls.ask({ slug: event.slug, sessionId: session.id, body: "How about telehealth?", anonymous: true });
    expect((await b.api.network.polls.upvote({ slug: event.slug, questionId: q.id })).counted).toBe(true);
    expect((await b.api.network.polls.upvote({ slug: event.slug, questionId: q.id })).counted).toBe(false);
    const live = await presenter.network.polls.live({ slug: event.slug, sessionId: session.id });
    expect(live.questions[0].votes).toBe(1);
    expect(live.questions[0].askedBy).toBe("");
    await expect(a.api.network.polls.markQuestion({ slug: event.slug, questionId: q.id, hidden: true })).rejects.toThrow();
    await presenter.network.polls.markQuestion({ slug: event.slug, questionId: q.id, hidden: true });
    expect((await b.api.network.polls.live({ slug: event.slug, sessionId: session.id })).questions).toHaveLength(0);
  });
});

describe("call for proposals", () => {
  beforeEach(async () => {
    await freshDb();
  });

  const form = (slug: string, title: string) => ({
    slug,
    name: "Taylor Reed",
    credentials: "PhD",
    organization: "Houston University",
    bio: "Counselor educator.",
    title,
    abstract: "A practical session on culturally responsive trauma care for counselors.",
    objectives: ["Name three screening tools", "Adapt intake", "Plan follow up"],
    format: "Workshop (90 min)",
    track: "",
    ceRequested: true,
    coPresenters: [{ name: "Avery Carter", email: "avery@example.com", credentials: "LMFT" }],
  });

  async function cfpSetup() {
    const ctx = await setupEvent();
    const { admin, event } = ctx;
    const s = await admin.network.proposals.admin.settings({ eventId: event.id });
    await admin.network.proposals.admin.updateSettings({ eventId: event.id, opensOn: "2020-01-01", closesOn: "2099-12-31", intro: "", formats: s.formats, tracks: [], rubric: s.rubric, blind: true, reviewersPerProposal: 1 });
    const submitter = caller(user("taylor@example.com"));
    const p1 = await submitter.network.proposals.submit(form(event.slug, "Culturally Responsive Trauma Care"));
    const p2 = await submitter.network.proposals.submit(form(event.slug, "Supervision Skills"));
    const r1 = staff(event.id, "reviewer", "dana@example.com", "Dana Whitfield");
    const db = getDb();
    const r2u = user("marcus@example.com", "Marcus Hale");
    db.insert(schema.staffAssignments).values({ roleId: r1.role.id, userId: r2u.id }).run();
    return { ...ctx, submitter, p1, p2, r1, r2: { user: r2u, api: caller(r2u) } };
  }

  it("emails a confirmation and stays closed outside its dates", async () => {
    const { event, admin } = await cfpSetup();
    expect(outbox.some((m) => m.to === "taylor@example.com" && m.subject.includes("we received your proposal"))).toBe(true);
    const s = await admin.network.proposals.admin.settings({ eventId: event.id });
    await admin.network.proposals.admin.updateSettings({ eventId: event.id, opensOn: "2020-01-01", closesOn: "2020-02-01", intro: "", formats: s.formats, tracks: [], rubric: s.rubric, blind: true, reviewersPerProposal: 1 });
    expect((await caller(null).network.proposals.info({ slug: event.slug })).open).toBe(false);
    await expect(caller(user("late@example.com")).network.proposals.submit(form(event.slug, "Too late"))).rejects.toThrow();
  });

  it("shows reviewers only their assigned proposals, without names when blind", async () => {
    const { event, admin, p1, p2, r1, r2 } = await cfpSetup();
    await admin.network.proposals.admin.assign({ eventId: event.id, proposalId: p1.id, reviewerUserIds: [r1.user.id] });
    const q1 = await r1.api.network.proposals.review.queue({ eventId: event.id });
    expect(q1.items.map((i) => i.proposalId)).toEqual([p1.id]);
    expect(q1.items[0].submitter).toBeNull();
    expect(JSON.stringify(q1)).not.toContain("Taylor Reed");
    expect(JSON.stringify(q1)).not.toContain("taylor@example.com");
    expect(JSON.stringify(q1)).not.toContain("Counselor educator");
    await expect(r1.api.network.proposals.admin.list({ eventId: event.id })).rejects.toThrow();

    const added = await admin.network.proposals.admin.autoAssign({ eventId: event.id });
    expect(added.added).toBe(1);
    const q2 = await r2.api.network.proposals.review.queue({ eventId: event.id });
    expect(q2.items.map((i) => i.proposalId)).toEqual([p2.id]);

    await expect(r2.api.network.proposals.review.submit({ eventId: event.id, assignmentId: q1.items[0].assignmentId, scores: { relevance: 5, evidence: 5, objectives: 5 }, recommendation: "accept" })).rejects.toThrow();
    await r1.api.network.proposals.review.submit({ eventId: event.id, assignmentId: q1.items[0].assignmentId, scores: { relevance: 5, evidence: 4, objectives: 5 }, recommendation: "accept", comment: "Strong" });
    const list = await admin.network.proposals.admin.list({ eventId: event.id });
    const row = list.proposals.find((p) => p.id === p1.id)!;
    expect(row.summary.avg).toBeCloseTo(4.7, 1);
    expect(row.summary.stage).toBe("needs_decision");
    expect(row.reviews[0].reviewer).toBe("Dana Whitfield");
  });

  it("accepting a proposal creates the session and speakers and emails the decision", async () => {
    const { event, admin, p1, p2 } = await cfpSetup();
    const res = await admin.network.proposals.admin.decide({ eventId: event.id, proposalId: p1.id, decision: "accepted", note: "", session: { date: "2027-04-23", startTime: "09:00", endTime: "10:30", room: "Room 204" } });
    const db = getDb();
    const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, res.sessionId!)).get()!;
    expect(session.title).toBe("Culturally Responsive Trauma Care");
    expect(session.kind).toBe("workshop");
    expect(session.proposalId).toBe(p1.id);
    const speakers = db.select().from(schema.speakers).where(eq(schema.speakers.eventId, event.id)).all();
    expect(speakers.map((s) => s.name).sort()).toEqual(["Avery Carter", "Taylor Reed"]);
    expect(db.select().from(schema.sessionSpeakers).where(eq(schema.sessionSpeakers.sessionId, session.id)).all()).toHaveLength(2);
    expect(outbox.some((m) => m.to === "taylor@example.com" && m.subject.includes("accepted"))).toBe(true);

    await admin.network.proposals.admin.decide({ eventId: event.id, proposalId: p2.id, decision: "declined", note: "Thanks for sending this." });
    expect(outbox.some((m) => m.subject.includes("about your proposal"))).toBe(true);
    const mine = await caller(user("taylor@example.com")).network.proposals.mine({ slug: event.slug });
    expect(mine.map((m) => m.status).sort()).toEqual(["accepted", "declined"]);
  });
});

describe("access", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("keeps attendees out of admin routes", async () => {
    const { event, a } = await setup();
    await expect(a.api.network.community.admin.channels({ eventId: event.id })).rejects.toThrow();
    await expect(a.api.network.community.admin.createChannel({ eventId: event.id, name: "Mine" })).rejects.toThrow();
    await expect(a.api.network.vendors.create({ eventId: event.id, company: "Acme" })).rejects.toThrow();
    await expect(a.api.network.proposals.admin.settings({ eventId: event.id })).rejects.toThrow();
    await expect(a.api.network.proposals.admin.mode({ eventId: event.id })).rejects.toThrow();
    await expect(a.api.network.maps.adminList({ eventId: event.id })).rejects.toThrow();
    await expect(caller(null).network.people.list({ slug: event.slug })).rejects.toThrow();
    const outsider = caller(user("nobody@example.com"));
    await expect(outsider.network.people.list({ slug: event.slug })).rejects.toThrow();
  });

  it("respects features turned off", async () => {
    const { event, a, b } = await setup();
    getDb().update(schema.events).set({ features: { ...event.features, messaging: false } }).where(eq(schema.events.id, event.id)).run();
    await expect(a.api.network.messages.start({ slug: event.slug, attendeeId: b.attendee.id })).rejects.toThrow();
    expect(await a.api.network.unreadMessages({ slug: event.slug })).toBe(0);
  });
});
