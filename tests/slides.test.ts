import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import http, { type Server } from "node:http";
import { Readable } from "node:stream";
import express from "express";
import { eq } from "drizzle-orm";

vi.hoisted(() => {
  // Uploaded test files go to a throwaway folder.
  process.env.UPLOADS_DIR = require("node:path").join(require("node:os").tmpdir(), `ld-slides-${process.pid}`);
});

import { freshDb, setupEvent, addAttendee, outbox, getDb, schema, user, caller } from "./helpers";
import { SESSION_COOKIE } from "@shared/const";
import { sha256 } from "../server/_core/crypto";
import { docType, registerFileRoutes, saveStream, UploadError } from "../server/_core/files";
import { ensurePortalToken, registerSlidesHttp, slidesOpen, speakerPageUrl } from "../server/areas/program/slides";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2000, 32)]);
const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(500, 1)]);

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  registerSlidesHttp(app);
  app.use(express.json({ limit: "24mb" }));
  registerFileRoutes(app);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(path.join(os.tmpdir(), `ld-slides-${process.pid}`), { recursive: true, force: true });
});

/** A browser cookie for a signed-in person. */
function cookieFor(u: { id: number }) {
  const token = `t-${u.id}-${Math.random().toString(36).slice(2)}`;
  getDb().insert(schema.authSessions).values({ userId: u.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) }).run();
  return `${SESSION_COOKIE}=${token}`;
}

async function liveEvent() {
  const ctx = await setupEvent();
  getDb().update(schema.events).set({ status: "live" }).where(eq(schema.events.id, ctx.event.id)).run();
  const db = getDb();
  const session = db.insert(schema.sessions).values({ eventId: ctx.event.id, title: "Group Care Basics", date: "2027-04-23", startTime: "10:30", endTime: "11:45", room: "Ballroom B", checkInCode: "ABC123" }).returning().get();
  const other = db.insert(schema.sessions).values({ eventId: ctx.event.id, title: "Ethics Today", date: "2027-04-23", startTime: "13:00", endTime: "14:00", checkInCode: "DEF456" }).returning().get();
  db.insert(schema.sessions).values({ eventId: ctx.event.id, title: "Lunch", kind: "meal", date: "2027-04-23", startTime: "12:00", endTime: "13:00", checkInCode: "GHI789" }).run();
  const speaker = db.insert(schema.speakers).values({ eventId: ctx.event.id, name: "Renee Carter", firstName: "Renee", lastName: "Carter", credentials: "PhD", email: "renee@example.com" }).returning().get();
  const co = db.insert(schema.speakers).values({ eventId: ctx.event.id, name: "Mia Lopez", firstName: "Mia", lastName: "Lopez", email: "mia@example.com" }).returning().get();
  const third = db.insert(schema.speakers).values({ eventId: ctx.event.id, name: "Marcus Webb", firstName: "Marcus", lastName: "Webb", email: "marcus@example.com" }).returning().get();
  db.insert(schema.sessionSpeakers).values({ sessionId: session.id, speakerId: speaker.id, role: "presenter" }).run();
  db.insert(schema.sessionSpeakers).values({ sessionId: session.id, speakerId: co.id, role: "co-presenter" }).run();
  db.insert(schema.sessionSpeakers).values({ sessionId: other.id, speakerId: third.id, role: "presenter" }).run();
  return { ...ctx, session, other, speaker, co, third };
}

const upload = (q: string, body: Buffer, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/upload/session-file?${q}`, { method: "POST", body: new Uint8Array(body), headers: { "Content-Type": "application/octet-stream", ...headers } });

describe("slides and handouts", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("checks file types by name and first bytes", () => {
    expect(docType("deck.pdf", PDF)).toBe("application/pdf");
    expect(docType("deck.pptx", PPTX)).toContain("presentationml");
    expect(docType("handout.docx", PPTX)).toContain("wordprocessingml");
    expect(docType("old.ppt", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("application/vnd.ms-powerpoint");
    expect(docType("deck.pdf", PPTX)).toBeNull();
    expect(docType("evil.exe", PDF)).toBeNull();
    expect(docType("deck.key", PPTX)).toBeNull();
  });

  it("stops a stream that passes the size limit and leaves nothing on disk", async () => {
    const before = fs.existsSync(process.env.UPLOADS_DIR!) ? fs.readdirSync(process.env.UPLOADS_DIR!).length : 0;
    const big = Readable.from([PDF, Buffer.alloc(5000)]);
    await expect(saveStream(big, { orgId: null, name: "big.pdf", userId: null, maxBytes: 4000 })).rejects.toBeInstanceOf(UploadError);
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.readdirSync(process.env.UPLOADS_DIR!).length).toBe(before);
    const ok = await saveStream(Readable.from([PDF]), { orgId: null, name: "ok.pdf", userId: null, maxBytes: 4000 });
    expect(ok.isPublic).toBe(false);
    expect(ok.size).toBe(PDF.length);
  });

  it("makes one speaker page link per speaker", async () => {
    const { speaker } = await liveEvent();
    const t = ensurePortalToken(speaker.id);
    expect(t.length).toBeGreaterThan(20);
    expect(ensurePortalToken(speaker.id)).toBe(t);
    expect(speakerPageUrl(speaker.id)).toMatch(new RegExp(`/speak/${t}$`));
  });

  it("speaker page: shows sessions, uploads, sharing, bio, and refuses bad tokens", async () => {
    const { event, session, other, speaker, co } = await liveEvent();
    const token = ensurePortalToken(speaker.id);
    const anon = caller(null);
    await expect(anon.program.slides.page({ token: "x".repeat(30) })).rejects.toThrow();

    let page = await anon.program.slides.page({ token });
    expect(page.event.name).toBe(event.name);
    expect(page.sessions.map((s) => s.title)).toEqual(["Group Care Basics"]);
    expect(page.sessions[0].others).toEqual([{ name: "Mia Lopez", role: "co-presenter" }]);
    expect(page.agreement).toBeNull();
    expect(page.registration).toBeNull();

    // Upload as the speaker.
    let res = await upload(`sessionId=${session.id}&name=${encodeURIComponent("Group-Care-Carter.pdf")}&token=${token}`, PDF);
    expect(res.status).toBe(200);
    const up = (await res.json()) as { sessionFileId: number };
    // Wrong bytes for the name, and a session that is not theirs.
    res = await upload(`sessionId=${session.id}&name=fake.pdf&token=${token}`, PPTX);
    expect(res.status).toBe(415);
    res = await upload(`sessionId=${other.id}&name=deck.pdf&token=${token}`, PDF);
    expect(res.status).toBe(403);
    // Declared over 100 MB is refused before reading.
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request(`${base}/api/upload/session-file?sessionId=${session.id}&name=deck.pdf&token=${token}`, { method: "POST", headers: { "Content-Length": String(101 * 1024 * 1024) } }, (resp) => {
        resolve(resp.statusCode!);
        resp.resume();
        r.destroy();
      });
      r.on("error", reject);
      r.write(PDF);
    });
    expect(status).toBe(413);

    page = await anon.program.slides.page({ token });
    expect(page.sessions[0].files).toHaveLength(1);
    expect(page.sessions[0].files[0]).toMatchObject({ name: "Group-Care-Carter.pdf", badge: "PDF", mine: true });
    const sf = getDb().select().from(schema.sessionFiles).where(eq(schema.sessionFiles.id, up.sessionFileId)).get()!;
    expect(sf.label).toBe("Group Care Carter");
    expect(sf.uploadedBySpeakerId).toBe(speaker.id);
    const file = getDb().select().from(schema.files).where(eq(schema.files.id, sf.fileId)).get()!;
    expect(file).toMatchObject({ isPublic: false, orgId: event.orgId, mime: "application/pdf" });

    // Replace swaps the file.
    res = await upload(`sessionId=${session.id}&name=v2.pptx&token=${token}&replace=${up.sessionFileId}`, PPTX);
    expect(res.status).toBe(200);
    page = await anon.program.slides.page({ token });
    expect(page.sessions[0].files.map((f) => f.name)).toEqual(["v2.pptx"]);

    // The co-presenter cannot remove someone else's file.
    const coToken = ensurePortalToken(co.id);
    await expect(anon.program.slides.removeFile({ token: coToken, sessionFileId: page.sessions[0].files[0].id })).rejects.toThrow();

    await anon.program.slides.setShare({ token, sessionId: session.id, slidesShare: "now" });
    await expect(anon.program.slides.setShare({ token, sessionId: other.id, slidesShare: "now" })).rejects.toThrow();
    expect(getDb().select().from(schema.sessions).where(eq(schema.sessions.id, session.id)).get()!.slidesShare).toBe("now");

    await anon.program.slides.updateBio({ token, credentials: "PhD, LPC", jobTitle: "Clinical director", organization: "Sample Practice", bio: "Leads group programs.", headshotFileId: null });
    page = await anon.program.slides.page({ token });
    expect(page.speaker).toMatchObject({ credentials: "PhD, LPC", jobTitle: "Clinical director", bio: "Leads group programs." });

    await anon.program.slides.removeFile({ token, sessionFileId: page.sessions[0].files[0].id });
    page = await anon.program.slides.page({ token });
    expect(page.sessions[0].files).toHaveLength(0);
  });

  it("shows the agreement and registration on the speaker page", async () => {
    const { event, speaker } = await liveEvent();
    const token = ensurePortalToken(speaker.id);
    getDb().insert(schema.agreements).values({ eventId: event.id, kind: "speaker", speakerId: speaker.id, code: "AGR-1", status: "signed", signedAt: new Date("2026-10-10T15:00:00Z"), recordingAllowed: true }).run();
    addAttendee(event.id, "renee@example.com", "Renee", "Carter");
    const page = await caller(null).program.slides.page({ token });
    expect(page.agreement).toMatchObject({ status: "signed", code: "AGR-1", recordingAllowed: true });
    expect(page.registration).not.toBeNull();
  });

  it("staff upload, see names, set sharing, and attendees download only when shared", async () => {
    const { event, owner, admin, session, speaker } = await liveEvent();
    const staffCookie = cookieFor(owner);
    // Not signed in, and an attendee, cannot upload.
    expect((await upload(`sessionId=${session.id}&name=deck.pdf`, PDF)).status).toBe(401);
    const { user: att, api } = addAttendee(event.id, "a@example.com");
    expect((await upload(`sessionId=${session.id}&name=deck.pdf`, PDF, { Cookie: cookieFor(att) })).status).toBe(403);

    const res = await upload(`sessionId=${session.id}&name=handout.pdf`, PDF, { Cookie: staffCookie });
    expect(res.status).toBe(200);
    const { sessionFileId } = (await res.json()) as { sessionFileId: number };

    const view = await admin.program.slides.forSession({ eventId: event.id, sessionId: session.id });
    expect(view.files[0]).toMatchObject({ name: "handout.pdf", by: "Olivia Owner", badge: "PDF" });
    expect(view.slidesShare).toBe("after_start");

    // Before the session starts (2027), attendees get nothing.
    expect(slidesOpen(session, event.timezone)).toBe(false);
    expect((await api.program.slides.forAttendee({ slug: event.slug, sessionId: session.id })).files).toHaveLength(0);
    const attCookie = cookieFor(att);
    let dl = await fetch(`${base}/api/session-file/${sessionFileId}`, { headers: { Cookie: attCookie }, redirect: "manual" });
    expect(dl.status).toBe(403);

    // The speaker can always download with their page link; staff too; neither counts.
    const token = ensurePortalToken(speaker.id);
    dl = await fetch(`${base}/api/session-file/${sessionFileId}?token=${token}`, { redirect: "manual" });
    expect(dl.status).toBe(302);
    dl = await fetch(`${base}/api/session-file/${sessionFileId}`, { headers: { Cookie: staffCookie }, redirect: "manual" });
    expect(dl.status).toBe(302);

    await admin.program.slides.update({ eventId: event.id, sessionId: session.id, slidesShare: "now", slidesDueOn: "2027-03-26" });
    expect((await api.program.slides.forAttendee({ slug: event.slug, sessionId: session.id })).files[0]).toMatchObject({ label: "handout", badge: "PDF" });
    dl = await fetch(`${base}/api/session-file/${sessionFileId}`, { headers: { Cookie: attCookie }, redirect: "manual" });
    expect(dl.status).toBe(302);
    const signed = dl.headers.get("location")!;
    expect(signed).toMatch(/^\/files\/.+sig=.+dl=1$/);
    const file = await fetch(base + signed);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);

    const after = await admin.program.slides.forSession({ eventId: event.id, sessionId: session.id });
    expect(after.downloads).toBe(1);
    expect(after.slidesDueOn).toBe("2027-03-26");

    // Hidden: attendees are refused again.
    await admin.program.slides.update({ eventId: event.id, sessionId: session.id, slidesShare: "hidden", slidesDueOn: null });
    dl = await fetch(`${base}/api/session-file/${sessionFileId}`, { headers: { Cookie: attCookie }, redirect: "manual" });
    expect(dl.status).toBe(403);
    await expect(api.program.slides.forSession({ eventId: event.id, sessionId: session.id })).rejects.toThrow();
    await expect(api.program.slides.update({ eventId: event.id, sessionId: session.id, slidesShare: "now", slidesDueOn: null })).rejects.toThrow();

    await admin.program.slides.remove({ eventId: event.id, sessionFileId });
    expect((await admin.program.slides.forSession({ eventId: event.id, sessionId: session.id })).files).toHaveLength(0);
  });

  it("lists missing slides, reminds only those speakers, and zips the files", async () => {
    const { event, owner, admin, session, speaker } = await liveEvent();
    const token = ensurePortalToken(speaker.id);
    await upload(`sessionId=${session.id}&name=deck.pdf&token=${token}`, PDF);
    await upload(`sessionId=${session.id}&name=deck.pdf&token=${token}`, PDF);

    const ov = await admin.program.slides.overview({ eventId: event.id });
    expect(ov.rows.map((r) => r.title)).toEqual(["Group Care Basics", "Ethics Today"]); // no meals
    expect(ov.missing).toBe(1);
    expect(ov.rows[0].files).toHaveLength(2);
    expect(ov.rows[1].speakers).toEqual(["Marcus Webb"]);

    outbox.length = 0;
    const r = await admin.program.slides.remind({ eventId: event.id });
    expect(r).toEqual({ sent: 1, noEmail: 0 });
    expect(outbox.map((m) => m.to)).toEqual(["marcus@example.com"]);
    expect(outbox[0].html).toContain("/speak/");
    expect(outbox[0].html).toContain("Upload slides");

    const zip = await fetch(`${base}/api/slides/${event.id}/slides.zip`, { headers: { Cookie: cookieFor(owner) } });
    expect(zip.status).toBe(200);
    const buf = Buffer.from(await zip.arrayBuffer());
    expect(buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(buf.includes(Buffer.from("Group Care Basics/deck.pdf"))).toBe(true);
    expect(buf.includes(Buffer.from("Group Care Basics/deck (2).pdf"))).toBe(true);
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
    expect(buf.readUInt16LE(buf.length - 12)).toBe(2);
    expect((await fetch(`${base}/api/slides/${event.id}/slides.zip`)).status).toBe(401);
  });

  it("gives speakers who use the app a link to their speaker page", async () => {
    const { event, speaker } = await liveEvent();
    const { api } = addAttendee(event.id, "Renee@Example.com", "Renee", "Carter");
    const me = await api.program.slides.mySpeakerPage({ slug: event.slug });
    expect(me.url).toBe(`/speak/${ensurePortalToken(speaker.id)}`);
    const other = addAttendee(event.id, "b@example.com");
    expect((await other.api.program.slides.mySpeakerPage({ slug: event.slug })).url).toBeNull();
    void user;
  });
});
