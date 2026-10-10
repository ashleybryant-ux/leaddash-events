import fs from "node:fs";
import path from "node:path";
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

/** Link to a file. Private files get a signed link that works for 24 hours. */
export function fileUrl(fileId: number | null | undefined, absolute = false): string | null {
  if (!fileId) return null;
  const f = getDb().select().from(schema.files).where(eq(schema.files.id, fileId)).get();
  if (!f) return null;
  let url = `/files/${f.key}`;
  if (!f.isPublic) {
    const exp = Date.now() + 24 * 3600_000;
    url += `?exp=${exp}&sig=${sign(`${f.key}.${exp}`)}`;
  }
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
    const inline = f.mime.startsWith("image/") || f.mime === "application/pdf";
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(f.name)}"`);
    fs.createReadStream(file).pipe(res);
  });
}
