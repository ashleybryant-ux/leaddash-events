/**
 * Every setting the server reads, in one place. Values come from .env on the
 * server (never committed). See .env.example for the full list.
 */
const list = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

export const ENV = {
  isProduction: process.env.NODE_ENV === "production",
  isTest: !!process.env.VITEST,
  port: parseInt(process.env.PORT || "4200", 10),
  /** Public address, used in emails, QR codes and Stripe return links. */
  appUrl: (process.env.APP_URL || "http://localhost:4200").replace(/\/+$/, ""),
  databasePath: process.env.DATABASE_PATH || "./data/events.db",
  uploadsDir: process.env.UPLOADS_DIR || "./data/uploads",
  /** Encrypts stored tokens and signs private file links. 32+ random characters. */
  secretsKey: process.env.SECRETS_KEY || "dev-only-secret-key-change-me-0000000000",
  /** LeadDash staff: tech support access to every association (never shown on their team lists). */
  staffEmails: list(process.env.LEADDASH_STAFF_EMAILS),
  sessionDays: parseInt(process.env.SESSION_DAYS || "30", 10),

  // Email (Amazon SES, same AWS account and verified leaddash.io domain as the other LeadDash apps)
  sesRegion: process.env.SES_REGION || "us-east-1",
  emailFromAddress: process.env.EMAIL_FROM_ADDRESS || "events@leaddash.io",
  emailFromName: process.env.EMAIL_FROM_NAME || "LeadDash Events",

  // Push notices (web push). Generate once with: npx web-push generate-vapid-keys
  vapidPublic: process.env.VAPID_PUBLIC_KEY || "",
  vapidPrivate: process.env.VAPID_PRIVATE_KEY || "",
  vapidSubject: process.env.VAPID_SUBJECT || "mailto:info@leaddash.io",

  // Stripe (LeadDash's platform account; each association connects its own account to it)
  stripeSecret: process.env.STRIPE_SECRET_KEY || "",
  stripePublishable: process.env.STRIPE_PUBLISHABLE_KEY || "",
  /** Connect client id (ca_...), the same LeadDash platform account and Connect app LeadDash EHR uses. */
  stripeConnectClientId: process.env.STRIPE_CONNECT_CLIENT_ID || "",
  /** Where Stripe sends the association back after "Connect with Stripe". Must be listed in the Connect settings' redirect URIs. */
  stripeConnectRedirect: process.env.STRIPE_CONNECT_REDIRECT_URI || "",
  /** Signing secret of the Connect webhook (events from connected accounts). */
  stripeConnectWebhookSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET || "",
  /** LeadDash fee per paid ticket, in cents (0 = none). */
  platformFeeCents: parseInt(process.env.PLATFORM_FEE_CENTS || "0", 10),
  /** LeadDash fee as a percent of each paid ticket (0 = none). Added to PLATFORM_FEE_CENTS. */
  platformFeePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT || "0"),
  /** Give LeadDash's fee back in proportion on refunds (off by default, like LeadDash EHR). */
  platformFeeRefund: (process.env.PLATFORM_FEE_REFUND || "").toLowerCase() === "true",

  // LeadDash platform (GoHighLevel) marketplace app, the same app LeadDash EHR uses
  ghlClientId: process.env.GHL_CLIENT_ID || "",
  ghlClientSecret: process.env.GHL_CLIENT_SECRET || "",
  ghlApiBase: process.env.GHL_API_BASE || "https://services.leadconnectorhq.com",
  ghlAuthBase: process.env.GHL_AUTH_BASE || "https://marketplace.leadconnectorhq.com",

  /** Turn off the minute-by-minute job runner (boot checks, tests). */
  noScheduler: process.env.NO_SCHEDULER === "1",
};

export const isStaffEmail = (email: string) => ENV.staffEmails.includes(email.toLowerCase());
