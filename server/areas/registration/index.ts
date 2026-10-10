/**
 * Registration: tickets and coupons, the public checkout page (direct link
 * and embed), Stripe Connect payments on the organization's own account, and
 * the welcome email with its follow-ups.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { protectedProcedure, publicProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, getEventBySlug, notFound, orgRole, requireArea, requireOrgAdmin } from "../../_core/access";
import { ENV } from "../../_core/env";
import { fileUrl } from "../../_core/files";
import { sendEmail } from "../../_core/email";
import { MESSAGE_KINDS, type CheckoutQuestion } from "../../../drizzle/schema";
import type { AreaModule } from "../types";
import { platformFee, stripe, stripeConfigured, type Stripe } from "./stripe";
import {
  DEFAULT_QUESTIONS,
  checkAnswers,
  checkoutPageFor,
  cleanQuestions,
  eventToday,
  findCoupon,
  fulfillOrder,
  isActiveMember,
  markRefunded,
  newDoneToken,
  normalizeCode,
  priceWith,
  registeredCount,
  soldByTicket,
  ticketsOnSale,
  type Buyer,
} from "./logic";
import { KIND_LABELS, coverFor, describeRule, renderEmail, renderText, runFollowUps, sampleCtx, seedTemplates, templateFor } from "./messages";
import { accountRow, accountView, connectReady, connectUrl, disconnectAccount, refreshAccount } from "./connect";
import { registerHttp, registerRawHttp } from "./http";

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slugIn = z.object({ slug: z.string().min(1).max(120) });
const eventIn = z.object({ eventId: z.number().int().positive() });
const orgIn = z.object({ orgId: z.number().int().positive() });

const buyerIn = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).default(""),
  credentials: z.string().trim().max(80).default(""),
  licenseNumber: z.string().trim().max(60).default(""),
  licenseState: z.string().trim().max(30).default(""),
  answers: z.record(z.string().max(60), z.string().max(1000)).default({}),
  textConsent: z.boolean().default(false),
});

const questionIn = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(120),
  kind: z.enum(["text", "phone", "license", "select", "textarea"]),
  required: z.boolean(),
  locked: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
});

const includesIn = z.object({
  receipt: z.boolean(),
  getApp: z.boolean(),
  qr: z.boolean(),
  calendar: z.boolean(),
  hotel: z.boolean(),
  hotelUrl: z.string().trim().url().max(500).optional().or(z.literal("")),
});

const ruleIn = z.string().regex(/^(after_payment|after_payment_1h|days_before:\d{1,2}|at:\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/);

const draftIn = z.object({
  kind: z.enum(MESSAGE_KINDS),
  enabled: z.boolean(),
  sendRule: ruleIn,
  onlyIfNoApp: z.boolean(),
  fromName: z.string().trim().max(80),
  replyTo: z.string().trim().email().max(200).or(z.literal("")),
  subject: z.string().max(200),
  body: z.string().max(5000),
  includes: includesIn,
});

/** What the public checkout page shows about the event. */
function publicEventInfo(ev: typeof schema.events.$inferSelect) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
  return {
    id: ev.id,
    slug: ev.slug,
    name: ev.name,
    shortName: ev.shortName || ev.name,
    startDate: ev.startDate,
    endDate: ev.endDate,
    venueName: ev.venueName,
    venueAddress: ev.venueAddress,
    city: ev.city,
    status: ev.status,
    orgName: org.name,
    branding: { colorPrimary: ev.branding.colorPrimary, colorAccent: ev.branding.colorAccent },
    logoUrl: fileUrl(ev.branding.logoFileId ?? org.logoFileId),
  };
}

/** Whether this organization can take card payments right now. */
function paymentsFor(orgId: number) {
  const row = accountRow(orgId);
  const ready = !!row && row.chargesEnabled && stripeConfigured() && (!!ENV.stripePublishable || ENV.isTest);
  return {
    ready,
    publishableKey: ready ? ENV.stripePublishable : null,
    accountId: ready ? row!.accountId : null,
    businessName: row?.businessName ?? "",
    refundPolicy: row?.refundPolicy ?? "",
    /** Klarna and Afterpay are on in the organization's Stripe account. */
    klarna: row?.payMethods.klarna === "active",
    afterpay: row?.payMethods.afterpay === "active",
  };
}

/** Everything a buyer must pass before an order is created. */
function validatePurchase(slug: string, ticketId: number, buyer: Buyer | null, couponCode?: string | null) {
  const ev = getEventBySlug(slug);
  if (ev.status === "ended") throw bad("Registration for this event is closed.");
  const page = checkoutPageFor(ev.id);
  const ticket = ticketsOnSale(ev, { onlyIds: page.ticketIds }).find((t) => t.id === ticketId);
  if (!ticket) throw bad("That ticket is not on sale. Pick another ticket.");
  if (ticket.soldOut) throw bad("That ticket is sold out.");
  const coupon = findCoupon(ev, couponCode);
  const price = priceWith(ticket.priceCents, coupon);
  if (buyer) {
    const email = buyer.email.trim().toLowerCase();
    checkAnswers(cleanQuestions(page.questions), buyer);
    if (ticket.membersOnly && !isActiveMember(ev.orgId, email, eventToday(ev))) {
      throw bad("This ticket is for active members. Use the email on your membership, or pick another ticket.");
    }
    const existing = getDb()
      .select()
      .from(schema.attendees)
      .where(and(eq(schema.attendees.eventId, ev.id), eq(schema.attendees.email, email)))
      .get();
    if (existing?.status === "registered") throw bad(`${email} is already registered. Check that inbox for the welcome email.`);
  }
  return { ev, page, ticket, coupon, price };
}

const ticketRouter = router({
  list: protectedProcedure.input(eventIn).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "registration", "view");
    const sold = soldByTicket(input.eventId);
    return getDb()
      .select()
      .from(schema.ticketTypes)
      .where(eq(schema.ticketTypes.eventId, input.eventId))
      .orderBy(schema.ticketTypes.sort, schema.ticketTypes.id)
      .all()
      .map((t) => ({ ...t, sold: sold.get(t.id) ?? 0 }));
  }),

  save: protectedProcedure
    .input(
      eventIn.extend({
        id: z.number().int().positive().optional(),
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(300).default(""),
        priceCents: z.number().int().min(0).max(10_000_000),
        quantity: z.number().int().positive().max(1_000_000).nullable(),
        saleEndsOn: date.nullable(),
        afterSale: z.enum(["close", "switch"]),
        switchToTicketId: z.number().int().positive().nullable(),
        includes: z.string().trim().max(80).default("All days"),
        audience: z.enum(["anyone", "members"]),
        ribbon: z.string().trim().max(40).default(""),
        active: z.boolean(),
        sort: z.number().int().min(0).max(10_000).default(0),
      })
    )
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "registration", "edit");
      const db = getDb();
      const { id, eventId, ...rest } = input;
      if (rest.afterSale === "switch") {
        if (!rest.saleEndsOn) throw bad("Set the date the sale ends before choosing a ticket to switch to.");
        const target = rest.switchToTicketId ? db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, rest.switchToTicketId)).get() : undefined;
        if (!target || target.eventId !== eventId || target.id === id) throw bad("Pick the ticket buyers switch to.");
      } else rest.switchToTicketId = null;
      if (id) {
        const row = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, id)).get();
        if (!row || row.eventId !== eventId) throw notFound("That ticket");
        db.update(schema.ticketTypes).set(rest).where(eq(schema.ticketTypes.id, id)).run();
        audit(ctx.user, { orgId: event.orgId, eventId, action: "ticket.update", detail: rest.name });
        return { id };
      }
      const count = db.select({ id: schema.ticketTypes.id }).from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, eventId)).all().length;
      const row = db.insert(schema.ticketTypes).values({ ...rest, eventId, sort: rest.sort || count + 1 }).returning().get();
      audit(ctx.user, { orgId: event.orgId, eventId, action: "ticket.create", detail: rest.name });
      return { id: row.id };
    }),

  remove: protectedProcedure.input(eventIn.extend({ id: z.number().int().positive() })).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "registration", "edit");
    const db = getDb();
    const row = db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.id, input.id)).get();
    if (!row || row.eventId !== input.eventId) throw notFound("That ticket");
    const used = db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.ticketTypeId, row.id)).get();
    if (used) throw bad("People have registered with this ticket. Turn it off instead.");
    db.update(schema.ticketTypes).set({ afterSale: "close", switchToTicketId: null }).where(and(eq(schema.ticketTypes.eventId, input.eventId), eq(schema.ticketTypes.switchToTicketId, row.id))).run();
    db.delete(schema.ticketTypes).where(eq(schema.ticketTypes.id, row.id)).run();
    audit(ctx.user, { orgId: event.orgId, eventId: input.eventId, action: "ticket.delete", detail: row.name });
    return { ok: true };
  }),
});

const couponRouter = router({
  list: protectedProcedure.input(eventIn).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "registration", "view");
    return getDb().select().from(schema.coupons).where(eq(schema.coupons.eventId, input.eventId)).orderBy(schema.coupons.code).all();
  }),

  save: protectedProcedure
    .input(
      eventIn.extend({
        id: z.number().int().positive().optional(),
        code: z.string().trim().regex(/^[A-Za-z0-9_-]{2,30}$/, "Codes use letters, numbers, dashes and underscores (2 to 30)."),
        percentOff: z.number().int().min(1).max(100).nullable(),
        amountOffCents: z.number().int().min(1).max(10_000_000).nullable(),
        maxUses: z.number().int().positive().max(1_000_000).nullable(),
        endsOn: date.nullable(),
        active: z.boolean(),
      })
    )
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "registration", "edit");
      const db = getDb();
      const { id, eventId, ...rest } = input;
      if (!rest.percentOff === !rest.amountOffCents) throw bad("Set a percent off or an amount off.");
      const code = normalizeCode(rest.code);
      const clash = db.select().from(schema.coupons).where(and(eq(schema.coupons.eventId, eventId), eq(schema.coupons.code, code))).get();
      if (clash && clash.id !== id) throw bad("That code is already used for this event.");
      const values = { ...rest, code };
      if (id) {
        const row = db.select().from(schema.coupons).where(eq(schema.coupons.id, id)).get();
        if (!row || row.eventId !== eventId) throw notFound("That coupon");
        db.update(schema.coupons).set(values).where(eq(schema.coupons.id, id)).run();
        return { id };
      }
      const row = db.insert(schema.coupons).values({ ...values, eventId }).returning().get();
      audit(ctx.user, { orgId: event.orgId, eventId, action: "coupon.create", detail: code });
      return { id: row.id };
    }),

  remove: protectedProcedure.input(eventIn.extend({ id: z.number().int().positive() })).mutation(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "registration", "edit");
    const db = getDb();
    const row = db.select().from(schema.coupons).where(eq(schema.coupons.id, input.id)).get();
    if (!row || row.eventId !== input.eventId) throw notFound("That coupon");
    if (row.used > 0) throw bad("This coupon has been used. Turn it off instead.");
    db.delete(schema.coupons).where(eq(schema.coupons.id, row.id)).run();
    return { ok: true };
  }),
});

const checkoutRouter = router({
  get: protectedProcedure.input(eventIn).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "registration", "view");
    const page = checkoutPageFor(event.id);
    return { ...page, questions: cleanQuestions(page.questions), coverUrl: fileUrl(page.coverFileId ?? event.branding.coverFileId), link: `${ENV.appUrl}/r/${event.slug}`, appUrl: ENV.appUrl };
  }),

  save: protectedProcedure
    .input(
      eventIn.extend({
        coverFileId: z.number().int().positive().nullable(),
        headline: z.string().trim().max(160),
        description: z.string().trim().max(2000),
        buttonLabel: z.string().trim().min(1).max(30),
        ticketIds: z.array(z.number().int().positive()).max(100),
        questions: z.array(questionIn).max(30),
        showConfirmation: z.boolean(),
        sendWelcome: z.boolean(),
        platformTag: z.string().trim().max(60),
        embedStyle: z.enum(["inline", "popup"]),
        payOverTime: z.boolean(),
      })
    )
    .mutation(({ ctx, input }) => {
      const { event } = requireArea(ctx.user, input.eventId, "registration", "edit");
      const db = getDb();
      const { eventId, ...rest } = input;
      if (rest.coverFileId) {
        const f = db.select().from(schema.files).where(eq(schema.files.id, rest.coverFileId)).get();
        if (!f || (f.orgId !== null && f.orgId !== event.orgId) || !f.mime.startsWith("image/")) throw bad("Pick an image you uploaded.");
      }
      const keys = rest.questions.map((q) => q.key);
      if (new Set(keys).size !== keys.length) throw bad("Each question can be asked once.");
      const ids = db.select({ id: schema.ticketTypes.id }).from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, eventId)).all().map((t) => t.id);
      const ticketIds = rest.ticketIds.filter((id) => ids.includes(id));
      const questions: CheckoutQuestion[] = cleanQuestions(rest.questions.map((q) => ({ ...q, locked: undefined })));
      checkoutPageFor(eventId);
      db.update(schema.checkoutPages)
        .set({ ...rest, ticketIds, questions, updatedAt: new Date() })
        .where(eq(schema.checkoutPages.eventId, eventId))
        .run();
      audit(ctx.user, { orgId: event.orgId, eventId, action: "checkout.update" });
      return { ok: true };
    }),
});

const templateRouter = router({
  list: protectedProcedure.input(eventIn).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "registration", "view");
    const rows = getDb().select().from(schema.messageTemplates).where(eq(schema.messageTemplates.eventId, input.eventId)).all();
    return MESSAGE_KINDS.map((k) => rows.find((r) => r.kind === k))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({ ...r, label: KIND_LABELS[r.kind], ruleLabel: describeRule(r.sendRule, r.onlyIfNoApp) }));
  }),

  save: protectedProcedure.input(eventIn.merge(draftIn)).mutation(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "registration", "edit");
    const t = templateFor(input.eventId, input.kind);
    if (!t) throw notFound("That message");
    if (t.channel === "text" && input.body.length > 480) throw bad("Keep texts under 480 characters.");
    if (!input.body.trim()) throw bad("Write the message.");
    if (t.channel === "email" && !input.subject.trim()) throw bad("Add a subject.");
    const { eventId, kind, ...rest } = input;
    getDb()
      .update(schema.messageTemplates)
      .set({ ...rest, includes: { ...rest.includes, hotelUrl: rest.includes.hotelUrl || undefined }, updatedAt: new Date() })
      .where(eq(schema.messageTemplates.id, t.id))
      .run();
    audit(ctx.user, { orgId: event.orgId, eventId, action: "message.update", detail: kind });
    return { ok: true };
  }),

  /** The email (or text) as the sample person would get it, for the preview pane. */
  preview: protectedProcedure.input(eventIn.merge(draftIn.partial({ enabled: true, sendRule: true, onlyIfNoApp: true }))).query(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "registration", "view");
    const t = templateFor(input.eventId, input.kind);
    if (!t) throw notFound("That message");
    const c = await sampleCtx(event, ctx.user.name.split(" ")[0] || "Jordan");
    if (t.channel === "text") return { channel: "text" as const, subject: "", text: renderText({ body: input.body }, c), html: "" };
    const m = renderEmail({ ...t, ...input, kind: t.kind, channel: t.channel, enabled: true, sendRule: t.sendRule, onlyIfNoApp: t.onlyIfNoApp }, c);
    return { channel: "email" as const, ...m };
  }),

  /** Sends the draft to the signed-in admin. Texts arrive as an email showing the text. */
  sendTest: protectedProcedure.input(eventIn.merge(draftIn)).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "registration", "edit");
    const t = templateFor(input.eventId, input.kind);
    if (!t) throw notFound("That message");
    const c = await sampleCtx(event, ctx.user.name.split(" ")[0] || "Jordan");
    if (t.channel === "text") {
      const text = renderText({ body: input.body }, c);
      await sendEmail({ to: ctx.user.email, subject: `Test text: ${KIND_LABELS[t.kind]}`, text: `This is how the text reads:\n\n${text}` });
    } else {
      const m = renderEmail({ ...t, ...input, kind: t.kind, channel: t.channel }, c);
      await sendEmail({ to: ctx.user.email, subject: `Test: ${m.subject}`, text: m.text, html: m.html, fromName: input.fromName || undefined, replyTo: input.replyTo || undefined });
    }
    return { to: ctx.user.email };
  }),
});

const stripeRouter = router({
  status: protectedProcedure.input(orgIn).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    return accountView(input.orgId);
  }),

  /** The Stripe status bar on the event's Registration screen. */
  forEvent: protectedProcedure.input(eventIn).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "registration", "view");
    return { ...accountView(event.orgId), orgId: event.orgId, canManage: !!orgRole(ctx.user, event.orgId) };
  }),

  connect: protectedProcedure.input(orgIn).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    if (!connectReady()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Stripe Connect is not set up on the server yet (STRIPE_SECRET_KEY and STRIPE_CONNECT_CLIENT_ID)." });
    const url = connectUrl(input.orgId, ctx.user.id);
    audit(ctx.user, { orgId: input.orgId, action: "stripe.connect" });
    return { url };
  }),

  refresh: protectedProcedure.input(orgIn).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    await refreshAccount(input.orgId);
    return accountView(input.orgId);
  }),

  saveSettings: protectedProcedure
    .input(orgIn.extend({ statementDescriptor: z.string().trim().max(22).regex(/^[^<>\\'"*]*$/, "Leave out < > \\ ' \" and *."), refundPolicy: z.string().trim().max(400) }))
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      const row = accountRow(input.orgId);
      if (!row) throw bad("Connect Stripe first.");
      let note = "";
      if (input.statementDescriptor && input.statementDescriptor !== row.statementDescriptor) {
        if (input.statementDescriptor.length < 5) throw bad("The name on card statements needs at least 5 characters.");
        try {
          await stripe().accounts.update(row.accountId, { settings: { payments: { statement_descriptor: input.statementDescriptor.toUpperCase() } } });
        } catch {
          note = "Saved here. Stripe did not accept the statement name from LeadDash, so change it in your Stripe dashboard too.";
        }
      }
      getDb()
        .update(schema.stripeAccounts)
        .set({ statementDescriptor: input.statementDescriptor.toUpperCase(), refundPolicy: input.refundPolicy, updatedAt: new Date() })
        .where(eq(schema.stripeAccounts.id, row.id))
        .run();
      return { note };
    }),

  /** Ends LeadDash's access to the account and forgets it. Nothing else changes in Stripe; the checkout page stops taking payments. */
  disconnect: protectedProcedure.input(orgIn).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    await disconnectAccount(input.orgId);
    audit(ctx.user, { orgId: input.orgId, action: "stripe.disconnect" });
    return { ok: true };
  }),
});

const paymentRouter = router({
  list: protectedProcedure.input(eventIn).query(({ ctx, input }) => {
    requireArea(ctx.user, input.eventId, "registration", "view");
    const db = getDb();
    const rows = db
      .select({ order: schema.orders, firstName: schema.attendees.firstName, lastName: schema.attendees.lastName, ticketName: schema.ticketTypes.name, couponCode: schema.coupons.code })
      .from(schema.orders)
      .leftJoin(schema.attendees, eq(schema.attendees.id, schema.orders.attendeeId))
      .leftJoin(schema.ticketTypes, eq(schema.ticketTypes.id, schema.orders.ticketTypeId))
      .leftJoin(schema.coupons, eq(schema.coupons.id, schema.orders.couponId))
      .where(and(eq(schema.orders.eventId, input.eventId), inArray(schema.orders.status, ["paid", "refunded", "failed"])))
      .orderBy(desc(schema.orders.id))
      .limit(500)
      .all();
    return rows.map((r) => {
      const b = r.order.buyer as Partial<Buyer>;
      const { buyer: _buyer, ...order } = r.order;
      return {
        ...order,
        name: r.firstName ? `${r.firstName} ${r.lastName}` : `${b.firstName ?? ""} ${b.lastName ?? ""}`.trim() || order.email,
        ticketName: r.ticketName ?? "Ticket",
        couponCode: r.couponCode,
      };
    });
  }),

  /** Recent payments across every event of the organization (the organization's Payments page). */
  forOrg: protectedProcedure.input(orgIn).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const db = getDb();
    const rows = db
      .select({ order: schema.orders, eventName: schema.events.shortName, eventFull: schema.events.name, firstName: schema.attendees.firstName, lastName: schema.attendees.lastName, ticketName: schema.ticketTypes.name, couponCode: schema.coupons.code })
      .from(schema.orders)
      .innerJoin(schema.events, eq(schema.events.id, schema.orders.eventId))
      .leftJoin(schema.attendees, eq(schema.attendees.id, schema.orders.attendeeId))
      .leftJoin(schema.ticketTypes, eq(schema.ticketTypes.id, schema.orders.ticketTypeId))
      .leftJoin(schema.coupons, eq(schema.coupons.id, schema.orders.couponId))
      .where(and(eq(schema.events.orgId, input.orgId), inArray(schema.orders.status, ["paid", "refunded", "failed"])))
      .orderBy(desc(schema.orders.id))
      .limit(200)
      .all();
    return rows.map((r) => {
      const b = r.order.buyer as Partial<Buyer>;
      const { buyer: _buyer, ...order } = r.order;
      return {
        ...order,
        eventName: r.eventName || r.eventFull,
        name: r.firstName ? `${r.firstName} ${r.lastName}` : `${b.firstName ?? ""} ${b.lastName ?? ""}`.trim() || order.email,
        ticketName: r.ticketName ?? "Ticket",
        couponCode: r.couponCode,
      };
    });
  }),

  refund: protectedProcedure.input(eventIn.extend({ orderId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "registration", "edit");
    const db = getDb();
    const order = db.select().from(schema.orders).where(eq(schema.orders.id, input.orderId)).get();
    if (!order || order.eventId !== input.eventId) throw notFound("That payment");
    if (order.status !== "paid") throw bad("Only paid orders can be refunded.");
    if (!order.stripePaymentIntentId || !order.stripeAccountId) throw bad("This payment has no Stripe record to refund.");
    await stripe().refunds.create({ payment_intent: order.stripePaymentIntentId, refund_application_fee: ENV.platformFeeRefund, metadata: { leaddash_order_id: String(order.id) } }, { stripeAccount: order.stripeAccountId });
    markRefunded(order.id);
    audit(ctx.user, { orgId: event.orgId, eventId: event.id, action: "order.refund", detail: `${order.email} ${order.amountCents}` });
    return { ok: true };
  }),
});

export const registrationRouter = router({
  tickets: ticketRouter,
  coupons: couponRouter,
  checkout: checkoutRouter,
  templates: templateRouter,
  stripe: stripeRouter,
  payments: paymentRouter,

  /** KPIs on the Tickets tab. */
  summary: protectedProcedure.input(eventIn).query(({ ctx, input }) => {
    const { event } = requireArea(ctx.user, input.eventId, "registration", "view");
    const paid = getDb()
      .select({ amountCents: schema.orders.amountCents })
      .from(schema.orders)
      .where(and(eq(schema.orders.eventId, input.eventId), eq(schema.orders.status, "paid")))
      .all();
    return { registered: registeredCount(input.eventId), capacity: event.capacity, revenueCents: paid.reduce((s, o) => s + o.amountCents, 0) };
  }),

  /** Everything the public checkout page needs. */
  page: publicProcedure.input(slugIn).query(({ input }) => {
    const ev = getEventBySlug(input.slug);
    const page = checkoutPageFor(ev.id);
    const tickets = ticketsOnSale(ev, { onlyIds: page.ticketIds });
    return {
      event: publicEventInfo(ev),
      page: {
        headline: page.headline || ev.name,
        description: page.description,
        buttonLabel: page.buttonLabel || "Register",
        coverUrl: coverFor(ev, false),
        questions: cleanQuestions(page.questions),
        showConfirmation: page.showConfirmation,
        embedStyle: page.embedStyle,
        payOverTime: page.payOverTime,
      },
      tickets,
      payments: paymentsFor(ev.orgId),
      closed: ev.status === "ended",
    };
  }),

  /** Price with a coupon applied. */
  quote: publicProcedure
    .input(slugIn.extend({ ticketId: z.number().int().positive(), coupon: z.string().max(40).optional() }))
    .query(({ input }) => {
      const { price, coupon, ticket } = validatePurchase(input.slug, input.ticketId, null, input.coupon);
      return { ...price, couponCode: coupon?.code ?? null, ticketName: ticket.name };
    }),

  /** Checks the details on the Register step (membership, required questions, already registered). */
  check: publicProcedure.input(slugIn.extend({ ticketId: z.number().int().positive(), buyer: buyerIn })).mutation(({ input }) => {
    const { price, ticket } = validatePurchase(input.slug, input.ticketId, input.buyer);
    return { ...price, ticketName: ticket.name };
  }),

  /**
   * Creates the order. Free totals register right away; paid totals get an
   * embedded Stripe Checkout Session on the organization's own account.
   */
  start: publicProcedure
    .input(slugIn.extend({ ticketId: z.number().int().positive(), buyer: buyerIn, coupon: z.string().max(40).optional(), embed: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      const { ev, ticket, coupon, price } = validatePurchase(input.slug, input.ticketId, input.buyer, input.coupon);
      const db = getDb();
      const email = input.buyer.email.trim().toLowerCase();
      const doneToken = newDoneToken();
      const pay = paymentsFor(ev.orgId);
      if (price.amountCents > 0 && !pay.ready) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This event is not taking payments yet. Please try again later." });
      const fee = platformFee(price.amountCents);
      const order = db
        .insert(schema.orders)
        .values({
          eventId: ev.id,
          email,
          ticketTypeId: ticket.id,
          couponId: coupon?.id ?? null,
          ...price,
          feeCents: fee,
          status: "pending",
          stripeAccountId: price.amountCents > 0 ? pay.accountId : null,
          buyer: { ...input.buyer, email },
          doneToken,
        })
        .returning()
        .get();
      const embed = input.embed ? "&embed=1" : "";
      if (price.amountCents === 0) {
        await fulfillOrder(order.id, { free: true });
        return { kind: "free" as const, doneUrl: `/r/${ev.slug}/done?order=${doneToken}${embed}` };
      }
      const row = accountRow(ev.orgId)!;
      try {
        const session = await stripe().checkout.sessions.create(
          {
            ui_mode: "embedded_page",
            mode: "payment",
            // Dynamic payment methods: whatever the organization turned on in its Stripe dashboard
            // (card, Apple Pay, Google Pay, Klarna, Afterpay) shows when the buyer is eligible.
            ...(checkoutPageFor(ev.id).payOverTime ? {} : { excluded_payment_method_types: ["klarna", "afterpay_clearpay"] as Stripe.Checkout.SessionCreateParams.ExcludedPaymentMethodType[] }),
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: "usd",
                  unit_amount: price.amountCents,
                  product_data: { name: `${ev.shortName || ev.name}: ${ticket.name}${coupon ? ` (coupon ${coupon.code})` : ""}` },
                },
              },
            ],
            customer_email: email,
            client_reference_id: String(order.id),
            metadata: { leaddash_order_id: String(order.id), leaddash_event_id: String(ev.id) },
            payment_intent_data: {
              ...(fee > 0 ? { application_fee_amount: fee } : {}),
              receipt_email: email,
              description: `${ev.name}: ${ticket.name}`,
              metadata: { leaddash_order_id: String(order.id) },
            },
            expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
            return_url: `${ENV.appUrl}/r/${ev.slug}/done?session_id={CHECKOUT_SESSION_ID}${embed}`,
          },
          { stripeAccount: row.accountId, idempotencyKey: `leaddash-order-${order.id}` }
        );
        db.update(schema.orders).set({ stripeSessionId: session.id }).where(eq(schema.orders.id, order.id)).run();
        if (!session.client_secret) throw new Error("Stripe returned no client secret");
        return { kind: "paid" as const, clientSecret: session.client_secret };
      } catch (err) {
        db.update(schema.orders).set({ status: "failed" }).where(eq(schema.orders.id, order.id)).run();
        console.error("[stripe] checkout session failed:", err);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "We could not start the payment. Please try again." });
      }
    }),

  /** The confirmation page: checks the Stripe session (fulfilling it if the webhook has not yet). */
  done: publicProcedure
    .input(slugIn.extend({ sessionId: z.string().max(200).optional(), order: z.string().max(60).optional() }))
    .query(async ({ input }) => {
      const ev = getEventBySlug(input.slug);
      const db = getDb();
      let order = input.sessionId
        ? db.select().from(schema.orders).where(eq(schema.orders.stripeSessionId, input.sessionId)).get()
        : input.order
          ? db.select().from(schema.orders).where(eq(schema.orders.doneToken, input.order)).get()
          : undefined;
      if (!order || order.eventId !== ev.id) throw notFound("That registration");
      if (order.status === "pending" && order.stripeSessionId && order.stripeAccountId) {
        const s = await stripe().checkout.sessions.retrieve(order.stripeSessionId, {}, { stripeAccount: order.stripeAccountId });
        if (s.status === "complete" && (s.payment_status === "paid" || s.payment_status === "no_payment_required")) {
          order = (await fulfillOrder(order.id, { paymentIntentId: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id })) ?? order;
        } else if (s.status === "expired") {
          db.update(schema.orders).set({ status: "expired" }).where(eq(schema.orders.id, order.id)).run();
          order = { ...order, status: "expired" };
        }
      }
      const page = checkoutPageFor(ev.id);
      const b = order.buyer as Partial<Buyer>;
      const status = order.status === "paid" || order.status === "free" ? "registered" : order.status === "pending" ? "processing" : order.status;
      return { status, paid: order.status === "paid" || order.status === "refunded", firstName: b.firstName ?? "", email: order.email, showConfirmation: page.showConfirmation, sendWelcome: page.sendWelcome };
    }),
});

export const registrationArea: AreaModule<typeof registrationRouter> = {
  router: registrationRouter,
  seedEvent: (eventId) => {
    const db = getDb();
    seedTemplates(eventId);
    if (!db.select().from(schema.checkoutPages).where(eq(schema.checkoutPages.eventId, eventId)).get()) {
      db.insert(schema.checkoutPages).values({ eventId, questions: DEFAULT_QUESTIONS, buttonLabel: "Register" }).run();
    }
    const ev = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get()!;
    const days = Math.round((Date.parse(`${ev.endDate}T12:00:00Z`) - Date.parse(`${ev.startDate}T12:00:00Z`)) / 86400_000) + 1;
    const includes = days > 1 ? `All ${days} days` : "All days";
    if (!db.select().from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, eventId)).get()) {
      const defaults = [
        { name: "Member", audience: "members" as const, ribbon: "" },
        { name: "Nonmember", audience: "anyone" as const, ribbon: "" },
        { name: "Student", audience: "anyone" as const, ribbon: "Student", description: "Student ID at check-in" },
      ];
      defaults.forEach((t, i) => db.insert(schema.ticketTypes).values({ eventId, priceCents: 0, active: false, includes, sort: i + 1, ...t }).run());
    }
    db.update(schema.checkoutPages)
      .set({ platformTag: `${ev.shortName || ev.name} registered`, headline: ev.name })
      .where(and(eq(schema.checkoutPages.eventId, eventId), eq(schema.checkoutPages.platformTag, "")))
      .run();
  },
  jobs: [{ name: "registration follow-ups", run: () => runFollowUps() }],
  registerHttp,
  registerRawHttp,
};
