/**
 * CE certificates (area "certificates"): templates, issued certificates,
 * the attendee's Credits and Transcript, and the public certificate page
 * (/cert/:code), which is also how anyone checks a certificate is real.
 */
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { protectedProcedure, publicProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, getEvent, getEventBySlug, requireArea, requireAttendee } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { ENV } from "../../_core/env";
import { shortCode } from "../../_core/crypto";
import { fmtDate, fmtDates, fmtHours, fullName } from "@shared/format";
import type { CertificateShow } from "../../../drizzle/schema";
import { attendeeName, badRequest, defaultTemplate, evaluationWindow, formForSession, getAttendee, getSession, issueEligible, sessionBlocker, toCsv } from "./shared";

type Cert = typeof schema.certificates.$inferSelect;
type Template = typeof schema.certificateTemplates.$inferSelect;

export const DEFAULT_SHOW: CertificateShow = { credentials: true, sessionTitle: true, sessionDate: true, hours: true, code: true, presenter: false };

const templateInput = z.object({
  name: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(160),
  providerName: z.string().trim().max(200),
  providerNumber: z.string().trim().max(80),
  approvalText: z.string().trim().max(1200),
  signerName: z.string().trim().max(120),
  signerTitle: z.string().trim().max(120),
  signatureStyle: z.enum(["script", "image"]),
  signatureFileId: z.number().int().nullable(),
  scope: z.enum(["session", "event"]),
  requireEvaluation: z.boolean(),
  minMinutes: z.number().int().min(0).max(600),
  isDefault: z.boolean(),
  show: z.object({ credentials: z.boolean(), sessionTitle: z.boolean(), sessionDate: z.boolean(), hours: z.boolean(), code: z.boolean(), presenter: z.boolean() }),
});

function getTemplate(templateId: number, eventId: number) {
  const t = getDb().select().from(schema.certificateTemplates).where(eq(schema.certificateTemplates.id, templateId)).get();
  if (!t || t.eventId !== eventId) throw badRequest("That template was not found.");
  return t;
}

function getCert(certificateId: number, eventId: number) {
  const c = getDb().select().from(schema.certificates).where(eq(schema.certificates.id, certificateId)).get();
  if (!c || c.eventId !== eventId) throw badRequest("That certificate was not found.");
  return c;
}

/** Presenter names for sessions. */
function presenters(sessionIds: number[]) {
  if (!sessionIds.length) return new Map<number, string[]>();
  const rows = getDb()
    .select({ sessionId: schema.sessionSpeakers.sessionId, name: schema.speakers.name, credentials: schema.speakers.credentials })
    .from(schema.sessionSpeakers)
    .innerJoin(schema.speakers, eq(schema.speakers.id, schema.sessionSpeakers.speakerId))
    .where(inArray(schema.sessionSpeakers.sessionId, sessionIds))
    .all();
  const out = new Map<number, string[]>();
  for (const r of rows) out.set(r.sessionId, [...(out.get(r.sessionId) ?? []), r.credentials ? `${r.name}, ${r.credentials}` : r.name]);
  return out;
}

/** Everything the certificate page prints. */
export function certificateView(c: Cert) {
  const db = getDb();
  const ev = getEvent(c.eventId);
  const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get();
  const a = db.select().from(schema.attendees).where(eq(schema.attendees.id, c.attendeeId)).get()!;
  const t: Template | undefined = (c.templateId ? db.select().from(schema.certificateTemplates).where(eq(schema.certificateTemplates.id, c.templateId)).get() : undefined) ?? defaultTemplate(ev.id);
  const s = c.sessionId ? db.select().from(schema.sessions).where(eq(schema.sessions.id, c.sessionId)).get() : undefined;
  const show = { ...DEFAULT_SHOW, ...(t?.show ?? {}) };
  return {
    code: c.code,
    revoked: !!c.revokedAt,
    revokedAt: c.revokedAt,
    issuedAt: c.createdAt,
    name: attendeeName(a, show.credentials),
    title: c.title,
    sessionTitle: show.sessionTitle ? c.title : "",
    date: show.sessionDate ? (s ? fmtDate(s.date) : fmtDates(ev.startDate, ev.endDate)) : "",
    hours: show.hours ? c.hours : null,
    presenters: show.presenter && s ? presenters([s.id]).get(s.id) ?? [] : [],
    showCode: show.code,
    certificateTitle: t?.title ?? "Certificate of Completion",
    providerName: t?.providerName || org?.name || "",
    providerNumber: t?.providerNumber ?? "",
    approvalText: t?.approvalText ?? "",
    signerName: t?.signerName ?? "",
    signerTitle: t?.signerTitle ?? "",
    signatureStyle: t?.signatureStyle ?? "script",
    signatureUrl: t?.signatureStyle === "image" ? fileUrl(t.signatureFileId) : null,
    eventName: ev.name,
    eventSlug: ev.slug,
    colorPrimary: ev.branding.colorPrimary,
    logoUrl: fileUrl(ev.branding.logoFileId ?? org?.logoFileId),
    verifyUrl: `${ENV.appUrl}/cert/${c.code}`,
  };
}

/** Sample data for the template preview. */
function previewView(t: Template, ev: typeof schema.events.$inferSelect) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get();
  const s = getDb().select().from(schema.sessions).where(eq(schema.sessions.eventId, ev.id)).all().find((x) => x.ceHours > 0);
  return {
    certificateTitle: t.title,
    providerName: t.providerName || org?.name || "",
    providerNumber: t.providerNumber,
    approvalText: t.approvalText,
    signerName: t.signerName,
    signerTitle: t.signerTitle,
    signatureStyle: t.signatureStyle,
    signatureUrl: t.signatureStyle === "image" ? fileUrl(t.signatureFileId) : null,
    eventName: ev.name,
    colorPrimary: ev.branding.colorPrimary,
    logoUrl: fileUrl(ev.branding.logoFileId ?? org?.logoFileId),
    sample: { title: t.scope === "event" ? ev.name : s?.title ?? "Session title", date: t.scope === "event" ? fmtDates(ev.startDate, ev.endDate) : fmtDate(s?.date ?? ev.startDate), hours: s?.ceHours ?? 1.5 },
  };
}

async function emailCertificate(c: Cert) {
  const v = certificateView(c);
  const a = getDb().select().from(schema.attendees).where(eq(schema.attendees.id, c.attendeeId)).get()!;
  const ev = getEvent(c.eventId);
  await sendEmail({
    to: a.email,
    fromName: ev.shortName || ev.name,
    subject: `Your CE certificate: ${c.title}`,
    text: `Your certificate for ${c.title} (${fmtHours(c.hours)}) is ready: ${v.verifyUrl}`,
    html: emailLayout({
      brand: ev.branding.colorPrimary,
      accent: ev.branding.colorAccent,
      look: ev.branding,
      title: "Your CE certificate",
      blocks: [`<p>Your certificate for <b>${escapeHtml(c.title)}</b> (${escapeHtml(fmtHours(c.hours))}) is ready.</p>`, emailButton("View certificate", v.verifyUrl, ev.branding)],
    }),
  });
}

/** The certificates and hours a person earned with an organization, across all its events, plus CE entered outside events. */
export function transcriptFor(orgId: number, email: string) {
  const db = getDb();
  const clean = email.toLowerCase();
  const events = db.select().from(schema.events).where(eq(schema.events.orgId, orgId)).all();
  const rows = events.length
    ? db
        .select()
        .from(schema.attendees)
        .where(and(eq(schema.attendees.email, clean), inArray(schema.attendees.eventId, events.map((e) => e.id))))
        .all()
    : [];
  const certs = rows.length
    ? db
        .select()
        .from(schema.certificates)
        .where(and(inArray(schema.certificates.attendeeId, rows.map((r) => r.id)), isNull(schema.certificates.revokedAt)))
        .all()
    : [];
  const sessionIds = certs.map((c) => c.sessionId).filter((x): x is number => !!x);
  const sessions = sessionIds.length ? db.select().from(schema.sessions).where(inArray(schema.sessions.id, sessionIds)).all() : [];
  const byEvent = events
    .map((e) => {
      const mine = certs.filter((c) => c.eventId === e.id);
      return {
        eventId: e.id,
        name: e.name,
        startDate: e.startDate,
        endDate: e.endDate,
        sessions: mine.length,
        hours: Math.round(mine.reduce((n, c) => n + c.hours, 0) * 100) / 100,
        certificates: mine.map((c) => {
          const s = sessions.find((x) => x.id === c.sessionId);
          return { code: c.code, title: c.title, date: s?.date ?? e.endDate, hours: c.hours };
        }),
      };
    })
    .filter((e) => e.sessions > 0)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  const entries = db
    .select()
    .from(schema.ceEntries)
    .where(and(eq(schema.ceEntries.orgId, orgId), eq(schema.ceEntries.email, clean)))
    .all()
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((e) => ({ id: e.id, title: e.title, provider: e.provider, date: e.date, hours: e.hours, certificateUrl: fileUrl(e.certificateFileId) }));
  const total = byEvent.reduce((n, e) => n + e.hours, 0) + entries.reduce((n, e) => n + e.hours, 0);
  return { totalHours: Math.round(total * 100) / 100, events: byEvent, entries };
}

export const certificatesRouter = router({
  templates: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "certificates");
    return getDb()
      .select()
      .from(schema.certificateTemplates)
      .where(eq(schema.certificateTemplates.eventId, input.eventId))
      .all()
      .map((t) => ({ ...t, show: { ...DEFAULT_SHOW, ...t.show }, signatureUrl: fileUrl(t.signatureFileId), preview: previewView(t, event) }));
  }),

  template: protectedProcedure.input(z.object({ eventId: z.number().int(), templateId: z.number().int() })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "certificates");
    const t = getTemplate(input.templateId, input.eventId);
    return { ...t, show: { ...DEFAULT_SHOW, ...t.show }, signatureUrl: fileUrl(t.signatureFileId), preview: previewView(t, event) };
  }),

  createTemplate: protectedProcedure.input(z.object({ eventId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "certificates", "edit");
    const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, event.orgId)).get();
    const hasDefault = getDb().select().from(schema.certificateTemplates).where(and(eq(schema.certificateTemplates.eventId, event.id), eq(schema.certificateTemplates.isDefault, true))).get();
    return getDb()
      .insert(schema.certificateTemplates)
      .values({ eventId: event.id, name: "New certificate", title: "Certificate of Completion", providerName: org?.name ?? "", isDefault: !hasDefault })
      .returning()
      .get();
  }),

  updateTemplate: protectedProcedure.input(templateInput.extend({ eventId: z.number().int(), templateId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "certificates", "edit");
    const t = getTemplate(input.templateId, event.id);
    const { eventId: _e, templateId: _t, ...rest } = input;
    const db = getDb();
    if (rest.isDefault) db.update(schema.certificateTemplates).set({ isDefault: false }).where(eq(schema.certificateTemplates.eventId, event.id)).run();
    db.update(schema.certificateTemplates).set(rest).where(eq(schema.certificateTemplates.id, t.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "certificate_template.update", detail: rest.name });
    return { ok: true };
  }),

  removeTemplate: protectedProcedure.input(z.object({ eventId: z.number().int(), templateId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "certificates", "edit");
    const t = getTemplate(input.templateId, event.id);
    getDb().delete(schema.certificateTemplates).where(eq(schema.certificateTemplates.id, t.id)).run();
    return { ok: true };
  }),

  /** Issued certificates for the event. */
  issued: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "certificates");
    const db = getDb();
    const certs = db.select().from(schema.certificates).where(eq(schema.certificates.eventId, input.eventId)).all();
    const people = certs.length ? db.select().from(schema.attendees).where(inArray(schema.attendees.id, Array.from(new Set(certs.map((c) => c.attendeeId))))).all() : [];
    return certs
      .map((c) => {
        const a = people.find((p) => p.id === c.attendeeId)!;
        return { id: c.id, code: c.code, attendeeId: c.attendeeId, name: fullName(a), email: a.email, title: c.title, sessionId: c.sessionId, hours: c.hours, issuedAt: c.createdAt, revokedAt: c.revokedAt };
      })
      .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
  }),

  revoke: protectedProcedure.input(z.object({ eventId: z.number().int(), certificateId: z.number().int() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "certificates", "edit");
    const c = getCert(input.certificateId, event.id);
    getDb().update(schema.certificates).set({ revokedAt: new Date() }).where(eq(schema.certificates.id, c.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "certificate.revoke", detail: `${c.code} ${c.title}` });
    return { ok: true };
  }),

  /** Issue a certificate by hand (for a session, or the whole event when sessionId is null). Restores a revoked one. */
  issue: protectedProcedure
    .input(z.object({ eventId: z.number().int(), attendeeId: z.number().int(), sessionId: z.number().int().nullable(), hours: z.number().min(0).max(100).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "certificates", "edit");
      const a = getAttendee(input.attendeeId, event.id);
      const s = input.sessionId ? getSession(input.sessionId, event.id) : null;
      const hours = input.hours ?? s?.ceHours ?? 0;
      if (!(hours > 0)) throw badRequest("Enter the CE hours for this certificate.");
      const db = getDb();
      const template = defaultTemplate(event.id);
      const mine = db.select().from(schema.certificates).where(eq(schema.certificates.attendeeId, a.id)).all();
      const existing = mine.find((c) => c.sessionId === (s?.id ?? null));
      let cert: Cert;
      if (existing) {
        if (!existing.revokedAt) throw badRequest("This person already has that certificate.");
        db.update(schema.certificates).set({ revokedAt: null, hours }).where(eq(schema.certificates.id, existing.id)).run();
        cert = { ...existing, revokedAt: null, hours };
      } else {
        cert = db
          .insert(schema.certificates)
          .values({ eventId: event.id, attendeeId: a.id, sessionId: s?.id ?? null, templateId: template?.id ?? null, title: s?.title ?? event.name, hours, code: shortCode(10) })
          .returning()
          .get();
      }
      audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "certificate.issue", detail: `${a.firstName} ${a.lastName}: ${cert.title}` });
      await emailCertificate(cert);
      return { ok: true, code: cert.code };
    }),

  resend: protectedProcedure.input(z.object({ eventId: z.number().int(), certificateId: z.number().int() })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "certificates", "edit");
    const c = getCert(input.certificateId, event.id);
    if (c.revokedAt) throw badRequest("This certificate was revoked.");
    await emailCertificate(c);
    return { ok: true };
  }),

  /** CE records for the CE approver: who earned what, with the certificate codes. */
  exportCsv: protectedProcedure.input(z.object({ eventId: z.number().int() })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "certificates");
    const db = getDb();
    const certs = db.select().from(schema.certificates).where(eq(schema.certificates.eventId, event.id)).all();
    const people = certs.length ? db.select().from(schema.attendees).where(inArray(schema.attendees.id, Array.from(new Set(certs.map((c) => c.attendeeId))))).all() : [];
    const sIds = certs.map((c) => c.sessionId).filter((x): x is number => !!x);
    const sessions = sIds.length ? db.select().from(schema.sessions).where(inArray(schema.sessions.id, sIds)).all() : [];
    const checkins = sIds.length ? db.select().from(schema.sessionCheckins).where(inArray(schema.sessionCheckins.sessionId, sIds)).all() : [];
    const responses = sIds.length ? db.select().from(schema.evaluationResponses).where(inArray(schema.evaluationResponses.sessionId, sIds)).all() : [];
    const csv = toCsv(
      ["First name", "Last name", "Credentials", "Email", "License number", "License state", "Session", "Session date", "CE hours", "Checked in", "Check-in method", "Evaluation submitted", "Certificate ID", "Issued", "Revoked"],
      certs.map((c) => {
        const a = people.find((p) => p.id === c.attendeeId)!;
        const s = sessions.find((x) => x.id === c.sessionId);
        const ci = checkins.find((x) => x.sessionId === c.sessionId && x.attendeeId === c.attendeeId);
        const ev = responses.find((x) => x.sessionId === c.sessionId && x.attendeeId === c.attendeeId);
        return [a.firstName, a.lastName, a.credentials, a.email, a.licenseNumber, a.licenseState, c.title, s ? s.date : "", c.hours, ci ? ci.createdAt.toISOString() : "", ci?.method ?? "", ev ? ev.createdAt.toISOString() : "", c.code, c.createdAt.toISOString(), c.revokedAt ? c.revokedAt.toISOString() : ""];
      })
    );
    return { filename: `${event.slug}-ce-records.csv`, csv };
  }),

  /** Public certificate page and check (/cert/:code). */
  byCode: publicProcedure.input(z.object({ code: z.string().trim().min(4).max(40) })).query(({ input }) => {
    const c = getDb().select().from(schema.certificates).where(eq(schema.certificates.code, input.code.toUpperCase())).get();
    if (!c) return null;
    return certificateView(c);
  }),

  /** Attendee: the Credits screen for this event. */
  credits: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const ev = getEventBySlug(input.slug);
    const a = requireAttendee(ctx.user, ev.id);
    const db = getDb();
    const certs = db.select().from(schema.certificates).where(and(eq(schema.certificates.attendeeId, a.id), isNull(schema.certificates.revokedAt))).all();
    const checkins = db.select().from(schema.sessionCheckins).where(eq(schema.sessionCheckins.attendeeId, a.id)).all();
    const sessions = checkins.length ? db.select().from(schema.sessions).where(inArray(schema.sessions.id, checkins.map((c) => c.sessionId))).all() : [];
    const template = defaultTemplate(ev.id);
    const waiting = template
      ? sessions
          .filter((s) => s.ceHours > 0 && !certs.some((c) => c.sessionId === s.id))
          .map((s) => {
            const blocker = sessionBlocker(a, s, checkins.find((c) => c.sessionId === s.id)!, template, ev.timezone);
            if (blocker !== "evaluation") return null;
            const form = formForSession(s)!;
            const win = evaluationWindow(form, s, ev.timezone);
            if (win.state === "closed") return null;
            return { sessionId: s.id, title: s.title, date: s.date, ceHours: s.ceHours, state: win.state, opensAt: win.opensAt };
          })
          .filter((x): x is NonNullable<typeof x> => !!x)
      : [];
    const certSessions = certs.map((c) => c.sessionId).filter((x): x is number => !!x);
    const certDates = certSessions.length ? db.select().from(schema.sessions).where(inArray(schema.sessions.id, certSessions)).all() : [];
    return {
      hours: Math.round(certs.reduce((n, c) => n + c.hours, 0) * 100) / 100,
      certificates: certs
        .map((c) => ({ code: c.code, title: c.title, hours: c.hours, date: certDates.find((s) => s.id === c.sessionId)?.date ?? ev.endDate, issuedAt: c.createdAt }))
        .sort((x, y) => x.date.localeCompare(y.date)),
      waiting,
      views: certs.map((c) => certificateView(c)),
    };
  }),

  /** Attendee: every year with this organization. */
  transcript: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const ev = getEventBySlug(input.slug);
    const a = requireAttendee(ctx.user, ev.id);
    const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
    return { orgName: org.name, name: fullName(a), ...transcriptFor(ev.orgId, a.email) };
  }),

  transcriptCsv: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const ev = getEventBySlug(input.slug);
    const a = requireAttendee(ctx.user, ev.id);
    const t = transcriptFor(ev.orgId, a.email);
    const rows: unknown[][] = [
      ...t.events.flatMap((e) => e.certificates.map((c) => [e.name, c.title, fmtDate(c.date), c.hours, c.code, `${ENV.appUrl}/cert/${c.code}`])),
      ...t.entries.map((e) => [e.provider || "Outside CE", e.title, fmtDate(e.date), e.hours, "", ""]),
    ];
    rows.push(["Total", "", "", t.totalHours, "", ""]);
    return { filename: "ce-transcript.csv", csv: toCsv(["Event or provider", "Title", "Date", "CE hours", "Certificate ID", "Check link"], rows) };
  }),
});

export { issueEligible };
