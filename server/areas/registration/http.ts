/**
 * Plain HTTP routes for registration: the Stripe Connect webhook (raw body),
 * the embed script, the calendar file and the check-in QR image used in emails.
 */
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../../_core/db";
import { ENV } from "../../_core/env";
import { webhookVerifier, type Stripe } from "./stripe";
import { fulfillOrder, markRefunded } from "./logic";
import { calendarFile, qrPng } from "./messages";
import { finishConnect, saveAccountStatus } from "./connect";
import { userFromCookie } from "../../_core/context";

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id ?? null);

/** Handles one verified Stripe event from a connected account. */
export async function handleStripeEvent(event: Stripe.Event) {
  const db = getDb();
  const account = event.account ?? null;
  const orderForSession = (sessionId: string) => {
    const o = db.select().from(schema.orders).where(eq(schema.orders.stripeSessionId, sessionId)).get();
    // Only trust events from the account the order was created on.
    return o && o.stripeAccountId === account ? o : undefined;
  };
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const s = event.data.object as Stripe.Checkout.Session;
      const order = orderForSession(s.id);
      if (!order) return "ignored";
      if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") return "waiting";
      await fulfillOrder(order.id, { paymentIntentId: idOf(s.payment_intent) });
      return "fulfilled";
    }
    case "checkout.session.async_payment_failed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const order = orderForSession(s.id);
      if (!order || order.status !== "pending") return "ignored";
      db.update(schema.orders).set({ status: "failed" }).where(eq(schema.orders.id, order.id)).run();
      return "failed";
    }
    case "checkout.session.expired": {
      const s = event.data.object as Stripe.Checkout.Session;
      const order = orderForSession(s.id);
      if (!order || order.status !== "pending") return "ignored";
      db.update(schema.orders).set({ status: "expired" }).where(eq(schema.orders.id, order.id)).run();
      return "expired";
    }
    case "charge.refunded": {
      const c = event.data.object as Stripe.Charge;
      const pi = idOf(c.payment_intent);
      if (!pi) return "ignored";
      const order = db
        .select()
        .from(schema.orders)
        .where(and(eq(schema.orders.stripePaymentIntentId, pi), eq(schema.orders.stripeAccountId, account ?? "")))
        .get();
      if (!order) return "ignored";
      // Partial refunds keep the registration; only a full refund cancels it.
      if (!c.refunded && c.amount_refunded < c.amount) return "partial";
      markRefunded(order.id);
      return "refunded";
    }
    case "account.updated": {
      const a = event.data.object as Stripe.Account;
      saveAccountStatus(a);
      return "account";
    }
    case "account.application.deauthorized": {
      // The organization removed LeadDash from its Stripe account.
      if (account) db.delete(schema.stripeAccounts).where(eq(schema.stripeAccounts.accountId, account)).run();
      return "deauthorized";
    }
    default:
      return "ignored";
  }
}

/** Verifies the signature and handles the event. Returns the HTTP status and body. */
export async function handleWebhookRequest(raw: Buffer | string, signature: string | undefined) {
  if (!ENV.stripeConnectWebhookSecret) return { status: 400, body: { error: "Webhook secret not set" } };
  let event: Stripe.Event;
  try {
    event = webhookVerifier().constructEvent(raw, signature ?? "", ENV.stripeConnectWebhookSecret);
  } catch {
    return { status: 400, body: { error: "Bad signature" } };
  }
  try {
    const result = await handleStripeEvent(event);
    return { status: 200, body: { received: true, result } };
  } catch (err) {
    console.error("[stripe] webhook failed:", err);
    return { status: 500, body: { error: "Could not handle the event" } };
  }
}

export function registerRawHttp(app: Express) {
  app.post("/api/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const out = await handleWebhookRequest(req.body as Buffer, Array.isArray(sig) ? sig[0] : sig);
    res.status(out.status).json(out.body);
  });
}

/** The script websites paste in to show the checkout form (or a Register button that opens it). */
export const EMBED_JS = `(function () {
  var script = document.currentScript;
  var origin = new URL(script.src).origin;
  var slug = script.getAttribute("data-event");
  var style = script.getAttribute("data-style") || "inline";
  var label = script.getAttribute("data-label") || "Register";
  var color = script.getAttribute("data-color") || "#e88a3a";
  var host = document.getElementById("leaddash-checkout");
  if (!slug || !host) return;
  var src = origin + "/embed/" + encodeURIComponent(slug);
  function frame(height) {
    var f = document.createElement("iframe");
    f.src = src;
    f.title = "Registration";
    f.setAttribute("allow", "payment *");
    f.style.cssText = "width:100%;border:0;display:block;height:" + height + "px;max-width:100%";
    window.addEventListener("message", function (e) {
      if (e.origin !== origin || e.source !== f.contentWindow || !e.data || e.data.type !== "leaddash-checkout:height") return;
      f.style.height = Math.max(200, Math.ceil(e.data.height)) + "px";
    });
    return f;
  }
  if (style !== "popup") {
    host.appendChild(frame(720));
    return;
  }
  var button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = "height:50px;padding:0 28px;border-radius:12px;border:0;background:" + color + ";color:#1A1206;font:800 16px system-ui,sans-serif;cursor:pointer";
  host.appendChild(button);
  button.addEventListener("click", function () {
    var overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(15,42,35,0.55);display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 12px";
    var box = document.createElement("div");
    box.style.cssText = "position:relative;width:100%;max-width:480px;background:#F8FAFB;border-radius:16px;overflow:hidden";
    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "\\u00d7";
    close.style.cssText = "position:absolute;top:8px;right:8px;z-index:1;width:36px;height:36px;border-radius:18px;border:1px solid #D5DEDA;background:#FFFFFF;font:700 20px system-ui,sans-serif;cursor:pointer";
    function shut() { overlay.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") shut(); }
    close.addEventListener("click", shut);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) shut(); });
    document.addEventListener("keydown", onKey);
    box.appendChild(close);
    box.appendChild(frame(640));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
})();
`;

export function registerHttp(app: Express) {
  // Stripe sends the organization's admin back here after "Connect with Stripe".
  app.get("/api/stripe/connect/callback", async (req, res) => {
    const back = (q: string) => res.redirect(`/admin/payments?${q}`);
    if (req.query.error) return back(`stripe=failed&reason=${encodeURIComponent(String(req.query.error_description || "The connection was cancelled."))}`);
    const user = userFromCookie(req.headers.cookie);
    if (!user) return back("stripe=failed&reason=" + encodeURIComponent("Sign in to LeadDash Events, then connect Stripe again."));
    try {
      const out = await finishConnect(String(req.query.code || ""), String(req.query.state || ""));
      if (out.userId !== user.id) return back("stripe=failed&reason=" + encodeURIComponent("Connect Stripe from the same sign-in that started it."));
      back("stripe=connected");
    } catch (err) {
      console.error("[stripe] connect callback failed:", (err as Error).message);
      back(`stripe=failed&reason=${encodeURIComponent((err as Error).message)}`);
    }
  });

  app.get("/embed.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(EMBED_JS);
  });

  app.get("/r/:slug/calendar.ics", (req, res) => {
    const ev = getDb().select().from(schema.events).where(eq(schema.events.slug, req.params.slug)).get();
    if (!ev) return res.status(404).send("Not found");
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${ev.slug}.ics"`);
    res.send(calendarFile(ev));
  });

  // The check-in QR image in emails. The token in the link is the attendee's own check-in secret.
  app.get("/r/:slug/qr/:token.png", async (req, res) => {
    const db = getDb();
    const ev = db.select().from(schema.events).where(eq(schema.events.slug, req.params.slug)).get();
    const a = ev ? db.select().from(schema.attendees).where(and(eq(schema.attendees.eventId, ev.id), eq(schema.attendees.qrToken, req.params.token))).get() : undefined;
    if (!a) return res.status(404).send("Not found");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(await qrPng(a.qrToken));
  });
}
