/**
 * Agreements: sponsor, exhibitor and speaker agreement templates, sending,
 * signing (on the checkout page or from an emailed link), and the signed copy.
 *
 * Templates need the area of their kind: "vendors" for sponsor and exhibitor
 * agreements, "speakers" for speaker agreements (view to read, edit to change
 * or send). The public sign and copy routes are reached only with the
 * agreement's random code.
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Express } from "express";
import { protectedProcedure, publicProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, eventAccess, forbidden, notFound, requireArea } from "../../_core/access";
import { cleanRichText, richTextToPlain } from "../../_core/richtext";
import { fileUrl, saveFile } from "../../_core/files";
import { fmtWhen } from "@shared/format";
import type { User } from "../../../drizzle/schema";
import { sendSpeakerWelcome } from "../registration/recipientMessages";
import type { AreaModule } from "../types";
import { DATE_VALUES, FIELDS, ORG_VALUES, SAMPLE, STARTERS, usedOn, type AgreementKind } from "./templates";
import { eventValues, fillAgreement, templateValues } from "./fill";
import {
  agreementForSpeaker,
  agreementsForVendor,
  chosenTemplateForVendor,
  copyLink,
  nextReminderAt,
  resendAgreement,
  resendSignedCopy,
  runAgreementReminders,
  sendSpeakerAgreement,
  sendVendorAgreement,
  setVendorTemplate,
  signAgreement,
  signLink,
  speakerSessionCard,
  templateFor,
} from "./sign";
import { agreementPdf } from "./pdf";
import { COUNTERSIGN_FILE, COUNTERSIGN_NAME, countersignFileId, signedCopy } from "./signed";

export * from "./sign";
export { fillAgreement, valuesForVendor, valuesForCheckout, valuesForSpeaker, valuesFor, paymentTerms } from "./fill";

const id = z.number().int().positive();
const KINDS = ["sponsor", "exhibitor", "speaker"] as const;
const areaOf = (kind: AgreementKind) => (kind === "speaker" ? ("speakers" as const) : ("vendors" as const));
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

/** Kinds of agreement the person can see (or edit) for this event. */
function kindsFor(user: User, eventId: number, level: "view" | "edit" = "view") {
  const a = eventAccess(user, eventId);
  const ok = (area: "vendors" | "speakers") => (level === "edit" ? a.areas[area] === "edit" : a.areas[area] !== "none");
  return KINDS.filter((k) => ok(areaOf(k)));
}

function getTemplate(eventId: number, templateId: number) {
  const t = getDb().select().from(schema.agreementTemplates).where(eq(schema.agreementTemplates.id, templateId)).get();
  if (!t || t.eventId !== eventId) throw notFound("That agreement");
  return t;
}

const REMINDERS = { off: [0, 0], "2x3": [2, 3], "3x3": [3, 3], "7x2": [7, 2] } as const;

const templateInput = z.object({
  eventId: id,
  templateId: id,
  name: z.string().trim().min(1, "Give the agreement a name.").max(120),
  kind: z.enum(KINDS),
  body: z.string().max(100_000),
  values: z.record(z.string().max(60), z.string().trim().max(500)).default({}),
  signWhen: z.enum(["checkout", "email"]).default("checkout"),
  sendOnAccept: z.boolean().default(true),
  sendOnAdd: z.boolean().default(true),
  reminders: z.enum(["off", "2x3", "3x3", "7x2"]).default("3x3"),
  askRecording: z.boolean().default(false),
  signerName: z.string().trim().max(120).default(""),
  signerTitle: z.string().trim().max(120).default(""),
  countersign: z.boolean().default(true),
  /** The organization signer's name drawn in the signature font (PNG data URL), sent when the name changes. */
  countersignPng: z.string().max(400_000).optional(),
});

/** Reminder choice from the stored numbers. */
const reminderKey = (days: number, max: number) => (days <= 0 || max <= 0 ? "off" : (Object.entries(REMINDERS).find(([, [d, m]]) => d === days && m === max)?.[0] ?? "3x3"));

const templatesRouter = router({
  /** Templates the person can see, with signed counts and where each is used. */
  list: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    const kinds = kindsFor(ctx.user, input.eventId);
    if (!kinds.length) throw forbidden();
    const db = getDb();
    const rows = db.select().from(schema.agreementTemplates).where(eq(schema.agreementTemplates.eventId, input.eventId)).all().filter((t) => kinds.includes(t.kind));
    const ids = rows.map((t) => t.id);
    const agrs = ids.length ? db.select({ templateId: schema.agreements.templateId, status: schema.agreements.status }).from(schema.agreements).where(inArray(schema.agreements.templateId, ids)).all() : [];
    const pages = db.select().from(schema.vendorCheckoutPages).where(eq(schema.vendorCheckoutPages.eventId, input.eventId)).all();
    const editKinds = kindsFor(ctx.user, input.eventId, "edit");
    return {
      kinds,
      editKinds,
      fields: FIELDS,
      orgValues: ORG_VALUES,
      dateValues: Array.from(DATE_VALUES),
      starters: (Object.keys(STARTERS) as (keyof typeof STARTERS)[]).filter((k) => k === "blank" || kinds.includes(k as AgreementKind)).map((k) => ({ key: k, name: STARTERS[k].name, summary: STARTERS[k].summary })),
      notify: Object.fromEntries(pages.map((p) => [p.kind, p.notifyEmail])) as Partial<Record<"sponsor" | "exhibitor", string>>,
      templates: rows
        .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.id - b.id)
        .map((t) => {
          const mine = agrs.filter((a) => a.templateId === t.id && (a.status === "sent" || a.status === "signed"));
          return {
            ...t,
            reminders: reminderKey(t.reminderDays, t.reminderMax),
            usedOn: usedOn(t),
            signed: mine.filter((a) => a.status === "signed").length,
            total: mine.length,
            lastEdited: t.updatedAt ?? t.createdAt,
            onCheckout: pages.some((p) => p.agreementTemplateId === t.id),
          };
        }),
    };
  }),

  /** New template from a starting point (sponsor, exhibitor, speaker or blank). */
  create: protectedProcedure.input(z.object({ eventId: id, starter: z.enum(["sponsor", "exhibitor", "speaker", "blank"]) })).mutation(({ ctx, input }) => {
    const s = STARTERS[input.starter];
    const kind = input.starter === "blank" ? kindsFor(ctx.user, input.eventId, "edit")[0] : s.kind;
    if (!kind) throw forbidden();
    const { event } = requireArea(ctx.user, input.eventId, areaOf(kind), "edit");
    const year = event.startDate.slice(0, 4);
    const row = getDb()
      .insert(schema.agreementTemplates)
      .values({
        eventId: event.id,
        kind,
        name: input.starter === "blank" ? "New agreement" : `${s.name} ${year}`,
        body: s.body,
        values: s.values,
        signWhen: "checkout",
        askRecording: kind === "speaker",
        updatedAt: new Date(),
      })
      .returning()
      .get();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "agreement_template.create", detail: row.name });
    return row;
  }),

  save: protectedProcedure.input(templateInput).mutation(({ ctx, input }) => {
    const t = getTemplate(input.eventId, input.templateId);
    requireArea(ctx.user, input.eventId, areaOf(t.kind), "edit");
    const { event } = requireArea(ctx.user, input.eventId, areaOf(input.kind), "edit");
    const body = cleanRichText(input.body);
    if (richTextToPlain(body).length > 40_000) throw bad("The agreement is too long. Keep it under 40,000 characters.");
    if (input.kind !== t.kind) {
      const page = getDb().select().from(schema.vendorCheckoutPages).where(eq(schema.vendorCheckoutPages.agreementTemplateId, t.id)).get();
      if (page && page.kind !== input.kind) throw bad(`This agreement is set on the ${page.kind} checkout page. Pick another agreement there first.`);
    }
    const allowed = new Set(ORG_VALUES[input.kind]);
    const values = Object.fromEntries(Object.entries(input.values).filter(([k]) => allowed.has(k)));
    for (const k of DATE_VALUES) if (values[k] && !/^\d{4}-\d{2}-\d{2}$/.test(values[k])) throw bad(`Use a date for ${k}.`);
    const [reminderDays, reminderMax] = REMINDERS[input.reminders];
    if (input.countersign && !input.signerName) throw bad("Add the organization signer, or turn off Countersign automatically.");
    // The organization signer's drawn signature: a new one for a new name, kept while the name is the same.
    const sigM = input.countersignPng ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.countersignPng.trim()) : null;
    if (sigM && input.signerName) {
      const png = Buffer.from(sigM[1], "base64");
      if (png.length < 60 || png.subarray(1, 4).toString("ascii") !== "PNG") throw bad("The signature did not come through. Try again.");
      const file = saveFile({ orgId: event.orgId, name: "countersignature.png", mime: "image/png", base64: sigM[1], isPublic: false, userId: ctx.user.id });
      Object.assign(values, { [COUNTERSIGN_FILE]: String(file.id), [COUNTERSIGN_NAME]: input.signerName });
    } else if (countersignFileId(t, input.signerName)) {
      Object.assign(values, { [COUNTERSIGN_FILE]: t.values[COUNTERSIGN_FILE], [COUNTERSIGN_NAME]: t.values[COUNTERSIGN_NAME] });
    }
    getDb()
      .update(schema.agreementTemplates)
      .set({
        name: input.name,
        kind: input.kind,
        body,
        values,
        signWhen: input.signWhen,
        sendOnAccept: input.sendOnAccept,
        sendOnAdd: input.sendOnAdd,
        reminderDays,
        reminderMax,
        askRecording: input.kind === "speaker" && input.askRecording,
        signerName: input.signerName,
        signerTitle: input.signerTitle,
        countersign: input.countersign,
        updatedAt: new Date(),
      })
      .where(eq(schema.agreementTemplates.id, t.id))
      .run();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "agreement_template.save", detail: input.name });
    return { ok: true };
  }),

  /** Deletes a template. Not while a checkout page uses it. Agreements already sent keep their frozen text. */
  delete: protectedProcedure.input(z.object({ eventId: id, templateId: id })).mutation(({ ctx, input }) => {
    const t = getTemplate(input.eventId, input.templateId);
    const { event } = requireArea(ctx.user, input.eventId, areaOf(t.kind), "edit");
    const page = getDb().select().from(schema.vendorCheckoutPages).where(eq(schema.vendorCheckoutPages.agreementTemplateId, t.id)).get();
    if (page) throw bad(`This agreement is set on the ${page.kind} checkout page. Pick another agreement there first.`);
    getDb().delete(schema.agreementTemplates).where(eq(schema.agreementTemplates.id, t.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "agreement_template.delete", detail: t.name });
    return { ok: true };
  }),

  /** The agreement filled with the event's details, the organization's values and sample buyer or speaker details. */
  preview: protectedProcedure
    .input(z.object({ eventId: id, kind: z.enum(KINDS), body: z.string().max(100_000), values: z.record(z.string().max(60), z.string().max(500)).default({}) }))
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, areaOf(input.kind));
      return { html: fillAgreement(cleanRichText(input.body), { ...eventValues(event), ...templateValues({ values: input.values }), ...SAMPLE[input.kind] }) };
    }),
});

/** Agreement status for every speaker of the event (Speakers page). */
function speakerRows(eventId: number) {
  const db = getDb();
  const speakers = db.select({ id: schema.speakers.id }).from(schema.speakers).where(eq(schema.speakers.eventId, eventId)).all();
  const ids = speakers.map((s) => s.id);
  const t = templateFor(eventId, "speaker");
  const welcome = new Set(
    ids.length
      ? db
          .select({ id: schema.recipientLog.recipientId })
          .from(schema.recipientLog)
          .where(and(eq(schema.recipientLog.eventId, eventId), eq(schema.recipientLog.recipientType, "speaker"), eq(schema.recipientLog.kind, "speaker_welcome"), eq(schema.recipientLog.status, "sent")))
          .all()
          .map((r) => r.id)
      : []
  );
  const templates = new Map(db.select().from(schema.agreementTemplates).where(eq(schema.agreementTemplates.eventId, eventId)).all().map((x) => [x.id, x]));
  return {
    template: t ? { id: t.id, name: t.name } : null,
    speakers: ids.map((sid) => {
      const a = agreementForSpeaker(sid);
      const next = a ? nextReminderAt(a, a.templateId ? templates.get(a.templateId) : undefined) : null;
      return {
        speakerId: sid,
        welcomeSent: welcome.has(sid),
        agreement: a
          ? {
              id: a.id,
              status: a.status,
              name: (a.templateId ? templates.get(a.templateId)?.name : "") || a.title,
              sentAt: a.sentAt,
              signedAt: a.signedAt,
              signerName: a.signerName,
              nextReminderAt: next,
              welcomeAfterSign: a.welcomeAfterSign,
              recordingAllowed: a.recordingAllowed,
              signLink: signLink(a.code),
              copyLink: copyLink(a.code),
            }
          : null,
      };
    }),
  };
}

function agreementIn(eventId: number, agreementId: number) {
  const a = getDb().select().from(schema.agreements).where(eq(schema.agreements.id, agreementId)).get();
  if (!a || a.eventId !== eventId) throw notFound("That agreement");
  return a;
}

function speakerIn(eventId: number, speakerId: number) {
  const s = getDb().select().from(schema.speakers).where(eq(schema.speakers.id, speakerId)).get();
  if (!s || s.eventId !== eventId) throw notFound("That speaker");
  return s;
}

/** What the sign page and the signed copy page need from an agreement code. */
function publicAgreement(code: string) {
  const db = getDb();
  const a = db.select().from(schema.agreements).where(eq(schema.agreements.code, code)).get();
  if (!a || a.status === "void") throw notFound("That agreement");
  const event = db.select().from(schema.events).where(eq(schema.events.id, a.eventId)).get()!;
  const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, event.orgId)).get()!;
  const t = a.templateId ? db.select().from(schema.agreementTemplates).where(eq(schema.agreementTemplates.id, a.templateId)).get() : undefined;
  let summary = "";
  let prefill = { name: "", title: "" };
  if (a.vendorId) {
    const v = db.select().from(schema.vendors).where(eq(schema.vendors.id, a.vendorId)).get();
    const pkg = v?.packageId ? db.select().from(schema.vendorPackages).where(eq(schema.vendorPackages.id, v.packageId)).get() : undefined;
    summary = [v?.company, pkg?.name || v?.level, event.shortName || event.name].filter(Boolean).join(" · ");
    prefill = { name: v?.contactName ?? "", title: "" };
  } else if (a.checkoutId) {
    const c = db.select().from(schema.vendorCheckouts).where(eq(schema.vendorCheckouts.id, a.checkoutId)).get();
    prefill = { name: c ? `${c.buyer.firstName} ${c.buyer.lastName}`.trim() : "", title: "" };
  } else if (a.speakerId) {
    const s = db.select().from(schema.speakers).where(eq(schema.speakers.id, a.speakerId)).get();
    prefill = { name: s ? `${s.firstName} ${s.lastName}`.trim() || s.name : "", title: s?.credentials ?? "" };
  }
  return {
    a,
    data: {
      code: a.code,
      kind: a.kind,
      title: a.title,
      status: a.status,
      html: a.html,
      signedAt: a.signedAt,
      signerName: a.signerName,
      askRecording: a.kind === "speaker" && !!t?.askRecording,
      summary,
      session: a.speakerId ? speakerSessionCard(a.speakerId) : null,
      prefill,
      event: {
        name: event.name,
        shortName: event.shortName || event.name,
        slug: event.slug,
        orgName: org.name,
        branding: event.branding,
        logoUrl: fileUrl(event.branding.logoFileId ?? org.logoFileId),
        coverUrl: fileUrl(event.branding.coverFileId),
      },
    },
  };
}

const signInput = z.object({
  code: z.string().min(10).max(80),
  name: z.string().max(200),
  title: z.string().max(200).default(""),
  signaturePng: z.string().max(600_000),
  recordingAllowed: z.boolean().nullable().default(null),
});

const publicRouter = router({
  /** The agreement behind a sign link (no sign-in; the code is the secret). */
  get: publicProcedure.input(z.object({ code: z.string().min(10).max(80) })).query(({ input }) => publicAgreement(input.code).data),

  /** Signs from the sign link or the checkout page. */
  sign: publicProcedure.input(signInput).mutation(async ({ ctx, input }) => {
    const a = await signAgreement(input.code, {
      name: input.name,
      title: input.title,
      signaturePng: input.signaturePng,
      recordingAllowed: input.recordingAllowed,
      ip: ctx.req.ip ?? "",
      userAgent: String(ctx.req.headers?.["user-agent"] ?? ""),
    });
    return { ok: true, code: a.code, signedAt: a.signedAt };
  }),

  /** The signed copy page. */
  copy: publicProcedure.input(z.object({ code: z.string().min(10).max(80) })).query(({ input }) => {
    const { a, data } = publicAgreement(input.code);
    const copy = signedCopy(a);
    return { ...data, footer: copy.footer, label: copy.label, signatures: copy.signatures.map(({ png: _p, ...s }) => s) };
  }),
});

export const agreementsRouter = router({
  templates: templatesRouter,
  public: publicRouter,

  /** Sends (or sends again) a sponsor or exhibitor their agreement from the template of their kind. */
  send: protectedProcedure.input(z.object({ eventId: id, vendorId: id })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, input.vendorId)).get();
    if (!v || v.eventId !== event.id) throw notFound("That sponsor");
    const a = await sendVendorAgreement(v.id);
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "agreement.send", detail: v.company });
    return { id: a.id, signLink: signLink(a.code) };
  }),

  /** Emails a sponsor or exhibitor their signed agreement again. */
  resendVendorCopy: protectedProcedure.input(z.object({ eventId: id, vendorId: id })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, input.vendorId)).get();
    if (!v || v.eventId !== event.id) throw notFound("That sponsor");
    const a = agreementsForVendor(v.id).find((x) => x.status === "signed");
    if (!a) throw bad("This agreement is not signed yet.");
    await resendSignedCopy(a.id);
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "agreement.resend", detail: v.company });
    return { ok: true, to: a.signerEmail };
  }),

  /** The agreement template a sponsor or exhibitor uses (picked in their details), and whether it is signed. */
  vendorTemplate: protectedProcedure.input(z.object({ eventId: id, vendorId: id })).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors");
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, input.vendorId)).get();
    if (!v || v.eventId !== event.id) throw notFound("That sponsor");
    const signed = agreementsForVendor(v.id).some((a) => a.status === "signed");
    return { templateId: chosenTemplateForVendor(v)?.id ?? null, signed };
  }),

  /** Picks the agreement template for a sponsor or exhibitor. Send agreement uses it. Nothing is emailed. */
  setVendorTemplate: protectedProcedure.input(z.object({ eventId: id, vendorId: id, templateId: id })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "vendors", "edit");
    const v = getDb().select().from(schema.vendors).where(eq(schema.vendors.id, input.vendorId)).get();
    if (!v || v.eventId !== event.id) throw notFound("That sponsor");
    getTemplate(event.id, input.templateId);
    setVendorTemplate(v.id, input.templateId);
    return { ok: true };
  }),

  /** Emails the sign link again (refreshing the text from the template while it is unsigned), or the signed copy once signed. */
  resend: protectedProcedure.input(z.object({ eventId: id, agreementId: id })).mutation(async ({ ctx, input }) => {
    const a = agreementIn(input.eventId, input.agreementId);
    const { event } = requireArea(ctx.user, input.eventId, areaOf(a.kind), "edit");
    // A signed agreement: the signer gets their signed copy again.
    if (a.status === "signed") await resendSignedCopy(a.id);
    else await resendAgreement(a.id);
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "agreement.resend", detail: a.title });
    return { ok: true };
  }),

  /** Agreement and welcome email status for each speaker (Speakers page). */
  speakers: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "speakers");
    return speakerRows(input.eventId);
  }),

  /** Sends one speaker their agreement. */
  sendSpeaker: protectedProcedure.input(z.object({ eventId: id, speakerId: id })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "speakers", "edit");
    const s = speakerIn(event.id, input.speakerId);
    if (!s.email) throw bad("Add the speaker's email first.");
    if (!templateFor(event.id, "speaker")) throw bad("Add a speaker agreement on Sponsors and exhibitors, Agreements first.");
    const a = await sendSpeakerAgreement(s.id);
    if (a?.status === "signed") throw bad("This agreement is already signed.");
    return { ok: true };
  }),

  /** How many speakers "Send agreements" would email (an email and no agreement yet). */
  unsentCount: protectedProcedure.input(z.object({ eventId: id })).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "speakers");
    const list = getDb().select().from(schema.speakers).where(eq(schema.speakers.eventId, input.eventId)).all();
    return { count: list.filter((s) => s.email && !agreementForSpeaker(s.id)).length, hasTemplate: !!templateFor(input.eventId, "speaker") };
  }),

  /** Sends the agreement to every speaker with an email who has none yet. */
  sendAllSpeakers: protectedProcedure.input(z.object({ eventId: id })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "speakers", "edit");
    if (!templateFor(event.id, "speaker")) throw bad("Add a speaker agreement on Sponsors and exhibitors, Agreements first.");
    const list = getDb().select().from(schema.speakers).where(eq(schema.speakers.eventId, event.id)).all();
    let sent = 0;
    for (const s of list) {
      if (!s.email || agreementForSpeaker(s.id)) continue;
      try {
        if (await sendSpeakerAgreement(s.id, { onlyIfNew: true })) sent++;
      } catch (err) {
        console.error(`[agreements] send to speaker ${s.id} failed:`, err);
      }
    }
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "agreement.send_all_speakers", detail: String(sent) });
    return { sent };
  }),

  /** Sends the speaker welcome email now. */
  sendWelcome: protectedProcedure.input(z.object({ eventId: id, speakerId: id })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "speakers", "edit");
    speakerIn(event.id, input.speakerId);
    await sendSpeakerWelcome(input.speakerId, { force: true });
    return { ok: true };
  }),
});

/** The PDF (GET /agreement/:code/pdf). Anyone with the code can download it, like the signed copy page. */
function registerHttp(app: Express) {
  app.get("/agreement/:code/pdf", async (req, res) => {
    const code = String(req.params.code || "");
    if (code.length < 10 || code.length > 80) return res.status(404).send("Not found");
    const a = getDb().select().from(schema.agreements).where(eq(schema.agreements.code, code)).get();
    if (!a || a.status === "void") return res.status(404).send("Not found");
    try {
      const bytes = await agreementPdf(a);
      const name = `${(a.title || "Agreement").replace(/[^A-Za-z0-9 ._-]/g, "").trim() || "Agreement"}${a.status === "signed" ? " (signed)" : ""}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${name}"`);
      res.end(Buffer.from(bytes));
    } catch (err) {
      console.error("[agreements] pdf failed:", err);
      res.status(500).send("The PDF could not be made. Try again.");
    }
  });
}

export const agreementsArea: AreaModule<typeof agreementsRouter> = {
  router: agreementsRouter,
  jobs: [{ name: "agreement reminders", run: () => runAgreementReminders().then(() => undefined) }],
  registerHttp,
};

/** "Signed Oct 10, 2026" style label for lists (server side, for emails and exports). */
export const agreementStatusLabel = (a: { status: string; sentAt: Date | null; signedAt: Date | null } | null | undefined) =>
  !a ? "Not sent" : a.status === "signed" ? `Signed ${fmtWhen(a.signedAt)}` : a.status === "sent" ? `Sent ${fmtWhen(a.sentAt)}` : "Not sent";

