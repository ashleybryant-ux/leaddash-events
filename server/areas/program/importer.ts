/**
 * Program import: sessions and speakers from a CSV file. Check reads the file and says what each
 * row will do without saving anything; Run reads the same file again and saves the rows that are ready.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, getSqlite, schema } from "../../_core/db";
import { audit, requireArea } from "../../_core/access";
import { randomToken } from "../../_core/crypto";
import { fmtDate } from "@shared/format";
import { parseCsv } from "../ce/shared";
import { bad } from "./util";

const KINDS = ["session", "keynote", "workshop", "break", "meal", "general"] as const;
type Kind = (typeof KINDS)[number];
const MAX_ROWS = 2000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const pad = (n: number) => String(n).padStart(2, "0");
const validDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** "2027-03-11", "3/11/2027", "Mar 11, 2027", "March 11 2027" or "Thursday, March 11, 2027" to "2027-03-11". */
export function readDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return validDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  m = /^(?:[a-z]+,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mon >= 0) return validDate(+m[3], mon + 1, +m[2]);
  }
  return null;
}

/** "10:30 AM", "1:30pm", "9 AM", "13:30" or "noon" to "13:30". */
export function readTime(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\./g, "");
  if (s === "noon") return "12:00";
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3].startsWith("p") && h !== 12) h += 12;
    if (m[3].startsWith("a") && h === 12) h = 0;
  } else if (!m[2] || h > 23) return null;
  return `${pad(h)}:${pad(min)}`;
}

function readKind(raw: string): Kind | null {
  const s = raw.trim().toLowerCase();
  if (!s) return "session";
  if (s === "lunch" || s === "breakfast" || s === "dinner" || s === "reception") return "meal";
  if (s === "general session" || s === "plenary") return "general";
  return (KINDS as readonly string[]).includes(s) ? (s as Kind) : s.endsWith("s") && (KINDS as readonly string[]).includes(s.slice(0, -1)) ? (s.slice(0, -1) as Kind) : null;
}

/** Splits "Dr. Lena Hart" into first and last name. */
function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Reads the header row and finds each column. Returns null when the file has no header row we recognize. */
function headerIndex(rows: string[][], cols: Record<string, RegExp>) {
  if (!rows.length) return null;
  const head = rows[0].map((c) => norm(c));
  const idx: Record<string, number> = {};
  for (const [key, re] of Object.entries(cols)) idx[key] = head.findIndex((h) => re.test(h));
  return idx;
}

const cellOf = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");

function readFile(csv: string) {
  const rows = parseCsv(csv);
  if (rows.length > MAX_ROWS + 1) throw bad(`The file has more than ${MAX_ROWS} rows. Split it into smaller files.`);
  return rows;
}

// ---------- Sessions ----------

type SpeakerRow = typeof schema.speakers.$inferSelect;

/** Speakers on the list, by every way a row might name them ("Marcus Webb", "Marcus Webb, LPC"). */
function speakerLookup(eventId: number) {
  const map = new Map<string, SpeakerRow>();
  for (const s of getDb().select().from(schema.speakers).where(eq(schema.speakers.eventId, eventId)).all()) {
    map.set(norm(s.name), s);
    if (s.credentials) map.set(norm(`${s.name}, ${s.credentials}`), s);
  }
  return map;
}

/** "Marcus Webb, LPC" to the name and credentials. */
function nameAndCredentials(raw: string) {
  const i = raw.indexOf(",");
  return i < 0 ? { name: raw.trim(), credentials: "" } : { name: raw.slice(0, i).trim(), credentials: raw.slice(i + 1).trim() };
}

type SessionRowOut = {
  line: number;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  room: string;
  track: string;
  kind: Kind;
  ceHours: number;
  description: string;
  speakers: { name: string; isNew: boolean }[];
  status: "ready" | "exists" | "fix";
  problem: string;
};

function checkSessions(eventId: number, csv: string) {
  const db = getDb();
  const event = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get()!;
  const rows = readFile(csv);
  const col = headerIndex(rows, {
    title: /^(session )?(title|name)$|^session$/,
    date: /^(session )?(date|day)$/,
    start: /^(start|starts|start time|begins|from)$/,
    end: /^(end|ends|end time|finishes|to)$/,
    room: /^(room|location|place)$/,
    track: /^track$/,
    kind: /^(type|kind|session type|format)$/,
    ce: /^(ce|ce hours|ces|credits|ce credits|ceu|ceus|hours)$/,
    speakers: /^(speakers?|presenters?|speaker names?)$/,
    description: /^(description|details|summary|abstract)$/,
  });
  if (!col || col.title < 0 || col.date < 0 || col.start < 0 || col.end < 0) throw bad("Add a header row with Title, Date, Start time and End time. Download the template to see the columns.");
  const existing = new Set(db.select().from(schema.sessions).where(eq(schema.sessions.eventId, eventId)).all().map((s) => `${norm(s.title)}|${s.date}|${s.startTime}`));
  const known = speakerLookup(eventId);
  const newNames = new Set<string>();
  const inFile = new Set<string>();
  const out: SessionRowOut[] = rows.slice(1).map((r, i) => {
    const line = i + 2;
    const title = cellOf(r, col.title).slice(0, 200);
    const rawDate = cellOf(r, col.date);
    const date = readDate(rawDate) ?? "";
    const startTime = readTime(cellOf(r, col.start)) ?? "";
    const endTime = readTime(cellOf(r, col.end)) ?? "";
    const kind = readKind(cellOf(r, col.kind));
    const ceRaw = cellOf(r, col.ce);
    const ceHours = ceRaw ? Number(ceRaw.replace(/[^\d.]/g, "")) : 0;
    const speakers = cellOf(r, col.speakers)
      .split(/;|\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((raw) => {
        const k = norm(raw);
        const hit = known.get(k) ?? known.get(norm(nameAndCredentials(raw).name));
        return { name: hit ? `${hit.name}${hit.credentials ? `, ${hit.credentials}` : ""}` : raw.slice(0, 120), isNew: !hit };
      });
    let problem = "";
    if (title.length < 2) problem = "Add a session title.";
    else if (!date) problem = rawDate ? `"${rawDate}" isn't a date. Use a date like Mar 11, 2027.` : "Add the date.";
    else if (date < event.startDate || date > event.endDate) problem = `The date ${fmtDate(date)} is ${date < event.startDate ? "before the event starts" : "after the event ends"} (${fmtDate(date < event.startDate ? event.startDate : event.endDate)}).`;
    else if (!startTime) problem = "Add the start time, like 10:30 AM.";
    else if (!endTime) problem = "Add the end time, like 12:00 PM.";
    else if (endTime <= startTime) problem = "The session ends before it starts.";
    else if (!kind) problem = `"${cellOf(r, col.kind)}" isn't a type. Use Session, Keynote, Workshop, Break, Meal or General.`;
    else if (!Number.isFinite(ceHours) || ceHours < 0 || ceHours > 40) problem = "CE hours must be a number from 0 to 40.";
    const key = `${norm(title)}|${date}|${startTime}`;
    let status: SessionRowOut["status"] = problem ? "fix" : existing.has(key) ? "exists" : "ready";
    if (status === "ready" && inFile.has(key)) {
      status = "fix";
      problem = "This session is in the file twice.";
    }
    if (status === "ready") {
      inFile.add(key);
      for (const s of speakers) if (s.isNew) newNames.add(norm(nameAndCredentials(s.name).name));
    }
    return { line, title, date, startTime, endTime, room: cellOf(r, col.room).slice(0, 120), track: cellOf(r, col.track).slice(0, 80), kind: kind ?? "session", ceHours: Number.isFinite(ceHours) ? Math.round(ceHours * 100) / 100 : 0, description: cellOf(r, col.description).slice(0, 5000), speakers, status, problem };
  });
  const count = (s: SessionRowOut["status"]) => out.filter((r) => r.status === s).length;
  return { rows: out, counts: { ready: count("ready"), exists: count("exists"), fix: count("fix"), newSpeakers: newNames.size } };
}

// ---------- Speakers ----------

type SpeakerRowOut = {
  line: number;
  firstName: string;
  lastName: string;
  credentials: string;
  jobTitle: string;
  organization: string;
  city: string;
  email: string;
  website: string;
  bio: string;
  /** "update": the speaker is already on the list (same name, no email yet) and the row fills in what is missing. */
  status: "ready" | "update" | "exists" | "fix";
  problem: string;
  matchId: number | null;
};

function checkSpeakers(eventId: number, csv: string) {
  const rows = readFile(csv);
  const col = headerIndex(rows, {
    first: /^(first|first name|given name)$/,
    last: /^(last|last name|surname|family name)$/,
    name: /^(name|full name|speaker|speaker name)$/,
    credentials: /^(credentials?|degrees?|licenses?|suffix)$/,
    jobTitle: /^(job title|title|role|position)$/,
    organization: /^(organization|organisation|company|employer|practice|works at)$/,
    city: /^(city|location|city state)$/,
    email: /^(e ?mail|email address)$/,
    website: /^(website|web|url|site|link)$/,
    bio: /^(bio|biography|about)$/,
  });
  if (!col || (col.first < 0 && col.name < 0)) throw bad("Add a header row with First name and Last name. Download the template to see the columns.");
  const db = getDb();
  const current = db.select().from(schema.speakers).where(eq(schema.speakers.eventId, eventId)).all();
  const emails = new Set(current.map((s) => s.email.toLowerCase()).filter(Boolean));
  const byName = new Map(current.map((s) => [norm(s.name), s]));
  const seen = new Set<string>();
  const out: SpeakerRowOut[] = rows.slice(1).map((r, i) => {
    const line = i + 2;
    const whole = col.first < 0 ? splitName(nameAndCredentials(cellOf(r, col.name)).name) : null;
    const firstName = (whole ? whole.firstName : cellOf(r, col.first)).slice(0, 80);
    const lastName = (whole ? whole.lastName : cellOf(r, col.last)).slice(0, 80);
    const credentials = (cellOf(r, col.credentials) || (col.first < 0 ? nameAndCredentials(cellOf(r, col.name)).credentials : "")).slice(0, 80);
    const email = cellOf(r, col.email).toLowerCase().slice(0, 200);
    let website = cellOf(r, col.website).slice(0, 500);
    if (website && !/^(https?:\/\/|mailto:|tel:|\/)/i.test(website)) website = `https://${website}`;
    const full = `${firstName} ${lastName}`.trim();
    let problem = "";
    if (!firstName) problem = "Add the first name.";
    else if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problem = `"${email}" isn't a valid email.`;
    const key = email || norm(full);
    const sameName = byName.get(norm(full));
    const v = { firstName, lastName, credentials, jobTitle: cellOf(r, col.jobTitle).slice(0, 120), organization: cellOf(r, col.organization).slice(0, 160), city: cellOf(r, col.city).slice(0, 120), email, website, bio: cellOf(r, col.bio).slice(0, 5000) };
    let status: SpeakerRowOut["status"] = "ready";
    let matchId: number | null = null;
    if (problem) status = "fix";
    else if (email && emails.has(email)) status = "exists";
    else if (sameName && (!sameName.email || sameName.email.toLowerCase() === email)) {
      // Already on the list (often added by a session import): fill in what is missing, never overwrite.
      const fills = (["credentials", "jobTitle", "organization", "city", "email", "website", "bio"] as const).some((k) => v[k] && !sameName[k]);
      status = fills ? "update" : "exists";
      matchId = fills ? sameName.id : null;
    }
    if ((status === "ready" || status === "update") && seen.has(key)) {
      status = "fix";
      problem = "This speaker is in the file twice.";
      matchId = null;
    }
    if (status === "ready" || status === "update") seen.add(key);
    return { line, ...v, status, problem, matchId };
  });
  const count = (s: SpeakerRowOut["status"]) => out.filter((r) => r.status === s).length;
  return { rows: out, counts: { ready: count("ready"), update: count("update"), exists: count("exists"), fix: count("fix") } };
}

const fileInput = z.object({ eventId: z.number().int(), csv: z.string().max(5_000_000) });

export const importRouter = router({
  checkSessions: protectedProcedure.input(fileInput).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "sessions", "edit");
    return checkSessions(input.eventId, input.csv);
  }),

  /** Saves the ready rows. New speakers named in the file are added to Speakers with their name. */
  runSessions: protectedProcedure.input(fileInput).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "sessions", "edit");
    const checked = checkSessions(event.id, input.csv);
    const db = getDb();
    let added = 0;
    let newSpeakers = 0;
    const tx = db;
    getSqlite().transaction(() => {
      const known = speakerLookup(event.id);
      const sortStart = tx.select().from(schema.speakers).where(eq(schema.speakers.eventId, event.id)).all().length;
      for (const r of checked.rows) {
        if (r.status !== "ready") continue;
        const s = tx
          .insert(schema.sessions)
          .values({ eventId: event.id, title: r.title, description: r.description, kind: r.kind, date: r.date, startTime: r.startTime, endTime: r.endTime, room: r.room, track: r.track, ceHours: r.ceHours, checkInCode: randomToken(6) })
          .returning()
          .get();
        added++;
        const linked = new Set<number>();
        for (const sp of r.speakers) {
          const { name, credentials } = nameAndCredentials(sp.name);
          let row = known.get(norm(sp.name)) ?? known.get(norm(name));
          if (!row) {
            const parts = splitName(name);
            row = tx
              .insert(schema.speakers)
              .values({ eventId: event.id, name: `${parts.firstName} ${parts.lastName}`.trim(), firstName: parts.firstName, lastName: parts.lastName, credentials: credentials.slice(0, 80), sort: sortStart + newSpeakers })
              .returning()
              .get();
            newSpeakers++;
            known.set(norm(row.name), row);
            if (row.credentials) known.set(norm(`${row.name}, ${row.credentials}`), row);
          }
          if (linked.has(row.id)) continue;
          linked.add(row.id);
          tx.insert(schema.sessionSpeakers).values({ sessionId: s.id, speakerId: row.id, role: "presenter" }).run();
        }
      }
    })();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "session.import", detail: `${added} sessions, ${newSpeakers} new speakers` });
    return { added, newSpeakers, skipped: checked.counts.exists, notAdded: checked.rows.filter((r) => r.status === "fix").map((r) => r.line) };
  }),

  checkSpeakers: protectedProcedure.input(fileInput).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "speakers", "edit");
    return checkSpeakers(input.eventId, input.csv);
  }),

  /** Saves the ready rows. Headshots are added later on each speaker's page or from their speaker page link. */
  runSpeakers: protectedProcedure.input(fileInput).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "speakers", "edit");
    const checked = checkSpeakers(event.id, input.csv);
    const db = getDb();
    let added = 0;
    let updated = 0;
    getSqlite().transaction(() => {
      const sortStart = db.select().from(schema.speakers).where(eq(schema.speakers.eventId, event.id)).all().length;
      for (const r of checked.rows) {
        const { line: _l, status: _s, problem: _p, matchId, ...v } = r;
        if (r.status === "ready") {
          db.insert(schema.speakers).values({ ...v, eventId: event.id, name: `${r.firstName} ${r.lastName}`.trim(), sort: sortStart + added }).run();
          added++;
        } else if (r.status === "update" && matchId) {
          const cur = db.select().from(schema.speakers).where(eq(schema.speakers.id, matchId)).get()!;
          const fill = Object.fromEntries((["credentials", "jobTitle", "organization", "city", "email", "website", "bio"] as const).filter((k) => v[k] && !cur[k]).map((k) => [k, v[k]]));
          db.update(schema.speakers).set(fill).where(eq(schema.speakers.id, matchId)).run();
          updated++;
        }
      }
    })();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "speaker.import", detail: `${added} added, ${updated} updated` });
    return { added, updated, skipped: checked.counts.exists, notAdded: checked.rows.filter((r) => r.status === "fix").map((r) => r.line) };
  }),
});
