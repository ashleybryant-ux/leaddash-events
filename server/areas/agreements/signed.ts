/** What the signed copy shows (the /agreement/:code page and the PDF share it). */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../_core/db";
import { fileUrl } from "../../_core/files";
import { ENV } from "../../_core/env";
import { fmtWhen } from "@shared/format";
import type { Agreement, AgreementTemplate, EventBranding } from "../../../drizzle/schema";

/** Template values keys for the organization signer's drawn signature (a PNG file id) and the name it was drawn for. */
export const COUNTERSIGN_FILE = "__countersignFileId";
export const COUNTERSIGN_NAME = "__countersignName";

/** The organization signer's signature PNG for this name, when the template has one drawn for it. */
export function countersignFileId(t: Pick<AgreementTemplate, "values"> | undefined, name: string): number | null {
  const v = t?.values ?? {};
  const id = Number(v[COUNTERSIGN_FILE]);
  return id > 0 && name.trim() && v[COUNTERSIGN_NAME] === name.trim() ? id : null;
}

/** "SA-2027-0004": kind letters, the event's year and the agreement number. */
export function agreementLabel(a: Pick<Agreement, "id" | "kind">, eventStart: string) {
  const prefix = a.kind === "sponsor" ? "SA" : a.kind === "exhibitor" ? "EA" : "SP";
  return `${prefix}-${eventStart.slice(0, 4)}-${String(a.id).padStart(4, "0")}`;
}

/** "Oct 10, 2026 at 4:52 PM CDT" in the event's time zone. */
export function whenInZone(d: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("month")} ${get("day")}, ${get("year")} at ${get("hour")}:${get("minute")} ${get("dayPeriod")} ${get("timeZoneName")}`.trim();
  } catch {
    return fmtWhen(d);
  }
}

/** Calendar date in the event's time zone ("Oct 10, 2026"). */
export function dateInZone(d: Date, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric" }).format(d);
  } catch {
    return fmtWhen(d);
  }
}

/** The company (or speaker's organization) on the signer's side. */
export function partyCompany(a: Agreement) {
  const db = getDb();
  if (a.vendorId) return db.select().from(schema.vendors).where(eq(schema.vendors.id, a.vendorId)).get()?.company ?? "";
  if (a.checkoutId) return db.select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.id, a.checkoutId)).get()?.buyer.company ?? "";
  if (a.speakerId) return db.select().from(schema.speakers).where(eq(schema.speakers.id, a.speakerId)).get()?.organization ?? "";
  return "";
}

export type Signature = { name: string; title: string; company: string; when: string; png: Buffer | null; pngUrl: string | null; drawn: boolean };

export function signedCopy(a: Agreement) {
  const db = getDb();
  const event = db.select().from(schema.events).where(eq(schema.events.id, a.eventId)).get()!;
  const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, event.orgId)).get()!;
  const logoId = event.branding.logoFileId ?? org.logoFileId;
  const logo = fileBytes(logoId);
  const sig = a.signatureFileId ? fileBytes(a.signatureFileId) : null;
  const signatures: Signature[] = [
    {
      name: a.signerName,
      title: a.signerTitle,
      company: partyCompany(a),
      when: a.signedAt ? `Signed ${whenInZone(a.signedAt, event.timezone)}` : "Not signed yet",
      png: sig?.data ?? null,
      pngUrl: fileUrl(a.signatureFileId),
      drawn: true,
    },
  ];
  if (a.countersignName) {
    // Drawn in the signature font when the template was saved, so it looks like the signer's.
    const t = a.templateId ? db.select().from(schema.agreementTemplates).where(eq(schema.agreementTemplates.id, a.templateId)).get() : undefined;
    const fid = countersignFileId(t, a.countersignName);
    const counter = fid ? fileBytes(fid) : null;
    signatures.push({
      name: a.countersignName,
      title: a.countersignTitle,
      company: org.name,
      when: a.signedAt ? `Signed ${dateInZone(a.signedAt, event.timezone)} (added automatically)` : "",
      png: counter?.data ?? null,
      pngUrl: counter ? fileUrl(fid) : null,
      drawn: !!counter,
    });
  }
  const label = agreementLabel(a, event.startDate);
  const footer = `Signed electronically through LeadDash Events. Signer email ${a.signerEmail || "not given"} · IP address ${a.ip || "not recorded"} · Agreement ID ${label}`;
  return {
    title: a.title || "Agreement",
    eventName: event.name,
    eventSlug: event.slug,
    orgName: org.name,
    branding: event.branding as EventBranding,
    logo: logo && (logo.mime === "image/png" || logo.mime === "image/jpeg") ? logo : null,
    logoUrl: fileUrl(logoId),
    coverUrl: fileUrl(event.branding.coverFileId),
    html: a.html,
    signatures,
    footer,
    label,
  };
}

/** Reads a stored file's bytes (signature PNG, event logo). */
export function fileBytes(fileId: number | null | undefined): { data: Buffer; mime: string } | null {
  if (!fileId) return null;
  const f = getDb().select().from(schema.files).where(eq(schema.files.id, fileId)).get();
  if (!f) return null;
  const p = path.join(path.resolve(ENV.uploadsDir), f.key);
  if (!fs.existsSync(p)) return null;
  return { data: fs.readFileSync(p), mime: f.mime };
}
