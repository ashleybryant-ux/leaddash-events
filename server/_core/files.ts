import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb, schema } from "./db";
import { ENV } from "./env";
import { randomToken, safeEqual, sign } from "./crypto";

const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
]);
const MAX_BYTES = 15 * 1024 * 1024;

const root = () => path.resolve(ENV.uploadsDir);

/** Saves a base64 upload and returns the file row. Public files (photos, logos) are readable by anyone with the link. */
export function saveFile(opts: { orgId: number | null; name: string; mime: string; base64: string; isPublic: boolean; userId: number | null }) {
  if (!ALLOWED.has(opts.mime)) throw new TRPCError({ code: "BAD_REQUEST", message: "That file type is not supported." });
  const data = Buffer.from(opts.base64.replace(/^data:[^,]+,/, ""), "base64");
  if (data.length > MAX_BYTES) throw new TRPCError({ code: "BAD_REQUEST", message: "Files can be up to 15 MB." });
  if (opts.mime === "image/svg+xml" && /<script|on\w+=/i.test(data.toString("utf8"))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That SVG file is not allowed." });
  }
  const key = randomToken(18);
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(path.join(root(), key), data);
  const row = getDb()
    .insert(schema.files)
    .values({ orgId: opts.orgId, key, name: opts.name.slice(0, 200), mime: opts.mime, size: data.length, isPublic: opts.isPublic, uploadedBy: opts.userId })
    .returning()
    .get();
  return row;
}

/** Slide decks and handouts can be much larger than images, so they stream to disk instead of arriving as base64. */
export const DOC_MAX_BYTES = 100 * 1024 * 1024;

const DOC_TYPES: Record<string, { mime: string; magic: "pdf" | "zip" | "ole" }> = {
  pdf: { mime: "application/pdf", magic: "pdf" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", magic: "zip" },
  ppt: { mime: "application/vnd.ms-powerpoint", magic: "ole" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: "zip" },
  doc: { mime: "application/msword", magic: "ole" },
};
const MAGIC = {
  pdf: Buffer.from("%PDF"),
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  ole: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
};

/** The type of a slide deck or handout from its name and first bytes, or null when it is not a PDF, PowerPoint or Word file. */
export function docType(name: string, head: Buffer): string | null {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const t = DOC_TYPES[ext];
  if (!t) return null;
  const magic = MAGIC[t.magic];
  return head.length >= magic.length && head.subarray(0, magic.length).equals(magic) ? t.mime : null;
}

/** "PPTX", "PDF": the badge shown next to a file. */
export const docBadge = (name: string) => (name.split(".").pop() || "file").toUpperCase().slice(0, 4);

export class UploadError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Streams an upload (the raw request body) to disk and returns the private
 * file row. Never holds the whole file in memory. Stops and deletes the
 * partial file as soon as it passes `maxBytes`, and checks the file type
 * from the first bytes.
 */
export async function saveStream(body: NodeJS.ReadableStream, opts: { orgId: number | null; name: string; userId: number | null; maxBytes?: number }) {
  const max = opts.maxBytes ?? DOC_MAX_BYTES;
  const name = path.basename(opts.name.replace(/\\/g, "/")).replace(/[\u0000-\u001f]/g, "").slice(0, 200).trim();
  if (!name || !DOC_TYPES[(name.split(".").pop() || "").toLowerCase()]) throw new UploadError(415, "Upload a PDF, PowerPoint or Word file.");
  const key = randomToken(18);
  fs.mkdirSync(root(), { recursive: true });
  const file = path.join(root(), key);
  let size = 0;
  let head = Buffer.alloc(0);
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > max) return done(new UploadError(413, `Files can be up to ${Math.round(max / 1024 / 1024)} MB.`));
      if (head.length < 8) head = Buffer.concat([head, chunk.subarray(0, 8 - head.length)]);
      done(null, chunk);
    },
  });
  // Not stream.pipeline: it would destroy the request on a refusal, and the person would get a dropped connection instead of the reason.
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let ended = false;
    let failed = false;
    const stop = (err: unknown) => {
      if (failed) return;
      failed = true;
      body.unpipe(counter);
      counter.destroy();
      out.once("close", () => fs.rmSync(file, { force: true }));
      out.destroy();
      reject(err instanceof UploadError ? err : new UploadError(400, "The upload stopped before it finished. Try again."));
    };
    counter.on("error", stop);
    out.on("error", stop);
    body.on("error", stop);
    body.on("end", () => (ended = true));
    body.on("close", () => !ended && stop(null));
    out.on("finish", () => !failed && resolve());
    body.pipe(counter).pipe(out);
  });
  const mime = docType(name, head);
  if (!size || !mime) {
    fs.rmSync(file, { force: true });
    throw new UploadError(415, "That file is not a PDF, PowerPoint or Word file.");
  }
  return getDb()
    .insert(schema.files)
    .values({ orgId: opts.orgId, key, name, mime, size, isPublic: false, uploadedBy: opts.userId })
    .returning()
    .get();
}

/** Deletes a file row and its bytes on disk. */
export function deleteFile(fileId: number) {
  const f = getDb().delete(schema.files).where(eq(schema.files.id, fileId)).returning().get();
  if (f) fs.rmSync(path.join(root(), f.key), { force: true });
}

/** Path on disk of a stored file (for streaming it into a zip). */
export const filePath = (key: string) => path.join(root(), path.basename(key));

/** Link to a file. Private files get a signed link that works for 24 hours. */
export function fileUrl(fileId: number | null | undefined, absolute = false, download = false): string | null {
  if (!fileId) return null;
  const f = getDb().select().from(schema.files).where(eq(schema.files.id, fileId)).get();
  if (!f) return null;
  let url = `/files/${f.key}`;
  if (!f.isPublic) {
    const exp = Date.now() + 24 * 3600_000;
    url += `?exp=${exp}&sig=${sign(`${f.key}.${exp}`)}`;
  }
  if (download) url += `${url.includes("?") ? "&" : "?"}dl=1`;
  return absolute ? ENV.appUrl + url : url;
}

export function registerFileRoutes(app: Express) {
  app.get("/files/:key", (req, res) => {
    const f = getDb().select().from(schema.files).where(eq(schema.files.key, req.params.key)).get();
    if (!f) return res.status(404).send("Not found");
    if (!f.isPublic) {
      const exp = Number(req.query.exp);
      const sig = String(req.query.sig || "");
      if (!exp || exp < Date.now() || !safeEqual(sig, sign(`${f.key}.${exp}`))) return res.status(403).send("This link has expired.");
    }
    const file = path.join(root(), f.key);
    if (!fs.existsSync(file)) return res.status(404).send("Not found");
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Cache-Control", f.isPublic ? "public, max-age=86400" : "private, no-store");
    if (f.mime === "image/svg+xml") res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    const inline = (f.mime.startsWith("image/") || f.mime === "application/pdf") && req.query.dl !== "1";
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader("Content-Length", String(fs.statSync(file).size));
    // Streams from disk, so a 100 MB deck never sits in memory.
    fs.createReadStream(file).pipe(res);
  });
}
