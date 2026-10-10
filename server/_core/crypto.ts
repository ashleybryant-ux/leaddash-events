import crypto from "node:crypto";
import { ENV } from "./env";

export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** URL-safe random token. */
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");

/** Six-digit code. */
export const randomCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/** Short human-readable code (certificates, member numbers): no 0/O or 1/I. */
export function shortCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}

const key = () => crypto.createHash("sha256").update(ENV.secretsKey).digest();

/** AES-256-GCM. Used for stored platform tokens. */
export function encrypt(plain: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(value: string) {
  const [iv, tag, data] = value.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** HMAC signature for links that expire (private files). */
export const sign = (value: string) => crypto.createHmac("sha256", key()).update(value).digest("base64url").slice(0, 32);

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
