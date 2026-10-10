/**
 * Apple Wallet and Google Wallet membership cards. Both stay off until the
 * owner adds credentials to the server's .env; the card screen then shows
 * the wallet buttons instead of "Download card".
 *
 * Apple: APPLE_PASS_TYPE_ID, APPLE_TEAM_ID, APPLE_PASS_CERT_PEM,
 *   APPLE_PASS_KEY_PEM, APPLE_WWDR_PEM (and APPLE_PASS_KEY_PASSPHRASE if the
 *   key has one). PEM values may be stored on one line with \n for newlines.
 * Google: GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SERVICE_ACCOUNT_JSON.
 */
import crypto from "node:crypto";
import zlib from "node:zlib";
import type { Express } from "express";
import { userFromCookie } from "../../_core/context";
import { ENV } from "../../_core/env";
import { fmtDate, fullName } from "@shared/format";
import type { Member, Organization } from "../../../drizzle/schema";
import { hubMember, isActive } from "./shared";

const pem = (v: string | undefined) => (v || "").replace(/\\n/g, "\n").trim();

export const appleWalletConfigured = () =>
  !!(process.env.APPLE_PASS_TYPE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_PASS_CERT_PEM && process.env.APPLE_PASS_KEY_PEM && process.env.APPLE_WWDR_PEM);

export const googleWalletConfigured = () => !!(process.env.GOOGLE_WALLET_ISSUER_ID && process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON);

const statusLabel = (m: Member) => (m.status === "grace" ? "Grace period" : m.status.charAt(0).toUpperCase() + m.status.slice(1));
const verifyLink = (org: Organization, m: Member) => `${ENV.appUrl}/m/${org.slug}/verify/${m.cardToken}`;

// ---------- A plain one-color PNG (Apple passes need an icon) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function solidPng(size: number, hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- Apple Wallet ----------

export async function applePass(org: Organization, m: Member) {
  const { PKPass } = await import("passkit-generator");
  const icon = solidPng(29, org.colorPrimary);
  const icon2 = solidPng(58, org.colorPrimary);
  const pass = new PKPass(
    { "icon.png": icon, "icon@2x.png": icon2 },
    { wwdr: pem(process.env.APPLE_WWDR_PEM), signerCert: pem(process.env.APPLE_PASS_CERT_PEM), signerKey: pem(process.env.APPLE_PASS_KEY_PEM), signerKeyPassphrase: process.env.APPLE_PASS_KEY_PASSPHRASE || undefined },
    {
      passTypeIdentifier: process.env.APPLE_PASS_TYPE_ID!,
      teamIdentifier: process.env.APPLE_TEAM_ID!,
      serialNumber: `${org.slug}-${m.id}`,
      organizationName: org.name,
      description: `${org.name} membership card`,
      logoText: org.name,
      backgroundColor: "rgb(15,42,35)",
      foregroundColor: "rgb(255,255,255)",
      labelColor: "rgb(143,181,166)",
    }
  );
  pass.type = "generic";
  pass.headerFields.push({ key: "status", label: "Status", value: statusLabel(m) });
  pass.primaryFields.push({ key: "name", label: `${m.level} member`, value: fullName(m) });
  pass.secondaryFields.push({ key: "number", label: "Member ID", value: m.memberNumber }, { key: "since", label: "Since", value: m.memberSince || "" });
  pass.auxiliaryFields.push({ key: "expires", label: "Expires", value: m.expiresOn ? fmtDate(m.expiresOn) : "" });
  pass.backFields.push({ key: "check", label: "Check this card", value: verifyLink(org, m) });
  pass.setBarcodes({ message: verifyLink(org, m), format: "PKBarcodeFormatQR", messageEncoding: "iso-8859-1" });
  if (m.expiresOn) pass.setExpirationDate(new Date(`${m.expiresOn}T23:59:59Z`));
  return pass.getAsBuffer();
}

// ---------- Google Wallet ----------

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** A "save to Google Wallet" link: a JWT signed (RS256) with the service account key. */
export function googleSaveLink(org: Organization, m: Member) {
  const account = JSON.parse(process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON || "{}") as { client_email?: string; private_key?: string };
  if (!account.client_email || !account.private_key) throw new Error("GOOGLE_WALLET_SERVICE_ACCOUNT_JSON has no client_email or private_key");
  const issuer = process.env.GOOGLE_WALLET_ISSUER_ID!;
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  const classId = `${issuer}.${safe(`leaddash_member_${org.slug}`)}`;
  const objectId = `${issuer}.${safe(`${org.slug}-member-${m.id}`)}`;
  const text = (value: string) => ({ defaultValue: { language: "en-US", value } });
  const payload = {
    iss: account.client_email,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    origins: [ENV.appUrl],
    payload: {
      genericClasses: [{ id: classId }],
      genericObjects: [
        {
          id: objectId,
          classId,
          state: isActive(m) ? "ACTIVE" : "EXPIRED",
          cardTitle: text(org.name),
          subheader: text(`${m.level} member`),
          header: text(fullName(m)),
          hexBackgroundColor: "#0F2A23",
          textModulesData: [
            { id: "number", header: "Member ID", body: m.memberNumber },
            { id: "since", header: "Since", body: m.memberSince || "" },
            { id: "expires", header: "Expires", body: m.expiresOn ? fmtDate(m.expiresOn) : "" },
            { id: "status", header: "Status", body: statusLabel(m) },
          ],
          barcode: { type: "QR_CODE", value: verifyLink(org, m), alternateText: m.memberNumber },
          ...(m.expiresOn ? { validTimeInterval: { end: { date: `${m.expiresOn}T23:59:59Z` } } } : {}),
        },
      ],
    },
  };
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(account.private_key.replace(/\\n/g, "\n"));
  return `https://pay.google.com/gp/v/save/${unsigned}.${b64url(signature)}`;
}

// ---------- HTTP routes (the card buttons link here) ----------

function memberFromRequest(req: { headers: { cookie?: string }; params: { orgSlug: string } }) {
  const user = userFromCookie(req.headers.cookie);
  if (!user) return null;
  try {
    return hubMember(user, req.params.orgSlug);
  } catch {
    return null;
  }
}

export function registerWalletRoutes(app: Express) {
  app.get("/api/member/:orgSlug/wallet/apple", async (req, res) => {
    if (!appleWalletConfigured()) return res.status(404).send("Apple Wallet is not set up.");
    const found = memberFromRequest(req);
    if (!found) return res.status(403).send("Sign in to the member hub first.");
    try {
      const buf = await applePass(found.org, found.member);
      res.setHeader("Content-Type", "application/vnd.apple.pkpass");
      res.setHeader("Content-Disposition", `attachment; filename="${found.org.slug}-member.pkpass"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(buf);
    } catch (err) {
      console.error("[member] apple pass failed:", (err as Error).message);
      res.status(500).send("The Apple Wallet card could not be made. Please try again later.");
    }
  });

  app.get("/api/member/:orgSlug/wallet/google", (req, res) => {
    if (!googleWalletConfigured()) return res.status(404).send("Google Wallet is not set up.");
    const found = memberFromRequest(req);
    if (!found) return res.status(403).send("Sign in to the member hub first.");
    try {
      res.redirect(googleSaveLink(found.org, found.member));
    } catch (err) {
      console.error("[member] google wallet link failed:", (err as Error).message);
      res.status(500).send("The Google Wallet card could not be made. Please try again later.");
    }
  });
}
