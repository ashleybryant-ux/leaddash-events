import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext, userFromCookie } from "./context";
import { serveStatic, setupVite } from "./vite";
import { ENV, isStaffEmail } from "./env";
import { getDb, schema } from "./db";
import { eq } from "drizzle-orm";
import { registerFileRoutes } from "./files";
import { registerAreaHttp, registerAreaRawHttp } from "../areas";
import { startScheduler } from "./scheduler";
import { handleCallback } from "./platform";
import { safeEqual, sign } from "./crypto";
import { mayBeFramed } from "../areas/registration/http";

async function startServer() {
  // Open the database and run pending migrations before taking traffic.
  getDb();

  const app = express();
  const server = createServer(app);
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // Pages other websites may frame: the checkout embed, and the sponsor and exhibitor checkout pages (their embed code).
    if (!mayBeFramed(req.path)) res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true, app: "leaddash-events" }));

  // Stripe webhooks need the raw body: registered before JSON parsing.
  registerAreaRawHttp(app);
  app.use(express.json({ limit: "24mb" })); // uploads arrive as base64
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  registerFileRoutes(app);

  // LeadDash platform: the agency owner comes back here after authorizing the marketplace app.
  app.get("/api/platform/callback", async (req, res) => {
    const user = userFromCookie(req.headers.cookie);
    const state = String(req.query.state || "");
    const [uid, ts, sig] = state.split(".");
    if (!user || !isStaffEmail(user.email) || String(user.id) !== uid || !sig || !safeEqual(sig, sign(`${uid}.${ts}`))) {
      return res.status(403).send("Sign in to LeadDash Events as LeadDash staff, then try again.");
    }
    try {
      await handleCallback(String(req.query.code || ""));
      res.redirect("/admin/leaddash?platform=connected");
    } catch (err) {
      console.error("[platform] callback failed:", err);
      res.redirect("/admin/leaddash?platform=failed");
    }
  });

  // Install manifest for an event's attendee app: its name, colors and start page.
  app.get("/e/:slug/manifest.webmanifest", (req, res) => {
    const ev = getDb().select().from(schema.events).where(eq(schema.events.slug, req.params.slug)).get();
    if (!ev) return res.status(404).end();
    res.setHeader("Content-Type", "application/manifest+json");
    res.json({
      name: ev.branding.appName || ev.name,
      short_name: (ev.shortName || ev.name).slice(0, 24),
      start_url: `/e/${ev.slug}/agenda`,
      scope: `/e/${ev.slug}/`,
      display: "standalone",
      background_color: "#F8FAFB",
      theme_color: ev.branding.colorPrimary,
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    });
  });

  registerAreaHttp(app);

  // Sign-in protection: at most 20 sign-in calls per 15 minutes per address, never batched.
  const hits = new Map<string, { n: number; reset: number }>();
  app.use("/api/trpc", (req, res, next) => {
    const procs = decodeURIComponent(req.path.replace(/^\//, "")).split(",");
    if (procs.length > 20) return res.status(400).json({ error: "Too many calls in one request" });
    if (!procs.some((p) => p.startsWith("auth.requestCode") || p.startsWith("auth.verifyCode"))) return next();
    if (procs.length > 1) return res.status(400).json({ error: "Sign-in calls cannot be batched" });
    const key = req.ip || "unknown";
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) hits.set(key, { n: 1, reset: now + 15 * 60_000 });
    else if (++entry.n > 20) return res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
    if (hits.size > 10_000) hits.forEach((v, k) => v.reset < now && hits.delete(k));
    next();
  });
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  if (process.env.NODE_ENV === "development") await setupVite(app, server);
  else serveStatic(app);

  server.listen(ENV.port, () => {
    console.log(`LeadDash Events listening on port ${ENV.port}`);
    startScheduler();
  });
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
