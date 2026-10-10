import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { SESSION_COOKIE } from "@shared/const";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb, schema } from "../_core/db";
import { randomCode, randomToken, sha256 } from "../_core/crypto";
import { emailLayout, escapeHtml, sendEmail } from "../_core/email";
import { ENV } from "../_core/env";
import { isLeadDashStaff } from "../_core/access";

const CODE_MINUTES = 15;

function cookieOptions(req: { protocol: string; headers: Record<string, unknown> }) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "");
  const secure = ENV.isProduction || req.protocol === "https" || forwarded.includes("https");
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: ENV.sessionDays * 86400_000 };
}

/** Find or create the person for an email. */
export function userForEmail(email: string, name = "") {
  const db = getDb();
  const clean = email.trim().toLowerCase();
  const existing = db.select().from(schema.users).where(eq(schema.users.email, clean)).get();
  if (existing) {
    if (!existing.name && name) db.update(schema.users).set({ name }).where(eq(schema.users.id, existing.id)).run();
    return existing;
  }
  return db.insert(schema.users).values({ email: clean, name }).returning().get();
}

/** Starts a session for the person and sets the cookie. */
export function startSession(res: { cookie: (name: string, value: string, opts: object) => void }, req: { protocol: string; headers: Record<string, unknown> }, userId: number) {
  const token = randomToken(32);
  getDb()
    .insert(schema.authSessions)
    .values({ userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ENV.sessionDays * 86400_000) })
    .run();
  getDb().update(schema.users).set({ lastSignedInAt: new Date() }).where(eq(schema.users.id, userId)).run();
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  return token;
}

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user) return null;
    const db = getDb();
    const orgs = db
      .select({ id: schema.organizations.id, name: schema.organizations.name, slug: schema.organizations.slug, memberHub: schema.organizations.memberHub, role: schema.orgMembers.role })
      .from(schema.orgMembers)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgMembers.orgId))
      .where(eq(schema.orgMembers.userId, ctx.user.id))
      .all();
    return { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, isLeadDashStaff: isLeadDashStaff(ctx.user), orgs };
  }),

  /** Emails a six-digit code. Always answers the same way so it never reveals who has an account. */
  requestCode: publicProcedure
    .input(z.object({ email: z.string().email().max(200), eventName: z.string().max(120).optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const email = input.email.trim().toLowerCase();
      const recent = db
        .select()
        .from(schema.loginCodes)
        .where(and(eq(schema.loginCodes.email, email), gt(schema.loginCodes.createdAt, new Date(Date.now() - 60_000))))
        .all();
      if (recent.length >= 3) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Please wait a minute before asking for another code." });
      const code = randomCode();
      db.insert(schema.loginCodes).values({ email, codeHash: sha256(`${email}:${code}`), expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) }).run();
      const what = input.eventName ? escapeHtml(input.eventName) : "LeadDash Events";
      await sendEmail({
        to: email,
        subject: `Your sign-in code: ${code}`,
        text: `Your sign-in code for ${input.eventName || "LeadDash Events"} is ${code}. It works for ${CODE_MINUTES} minutes.`,
        html: emailLayout({
          brand: "#1F5F4A",
          accent: "#e88a3a",
          title: "Your sign-in code",
          blocks: [`<p>Use this code to sign in to ${what}:</p>`, `<p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:12px 0">${code}</p>`, `<p style="color:#4B5B57">It works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.</p>`],
        }),
      });
      return { ok: true };
    }),

  verifyCode: publicProcedure
    .input(z.object({ email: z.string().email().max(200), code: z.string().regex(/^\d{6}$/), name: z.string().max(120).optional() }))
    .mutation(({ ctx, input }) => {
      const db = getDb();
      const email = input.email.trim().toLowerCase();
      const row = db
        .select()
        .from(schema.loginCodes)
        .where(and(eq(schema.loginCodes.email, email), isNull(schema.loginCodes.usedAt), gt(schema.loginCodes.expiresAt, new Date())))
        .orderBy(desc(schema.loginCodes.id))
        .get();
      if (!row || row.attempts >= 5) throw new TRPCError({ code: "BAD_REQUEST", message: "That code has expired. Ask for a new one." });
      if (row.codeHash !== sha256(`${email}:${input.code}`)) {
        db.update(schema.loginCodes).set({ attempts: row.attempts + 1 }).where(eq(schema.loginCodes.id, row.id)).run();
        throw new TRPCError({ code: "BAD_REQUEST", message: "That code is not right. Check the email and try again." });
      }
      db.update(schema.loginCodes).set({ usedAt: new Date() }).where(eq(schema.loginCodes.id, row.id)).run();
      const user = userForEmail(email, input.name ?? "");
      startSession(ctx.res, ctx.req, user.id);
      return { ok: true };
    }),

  signOut: protectedProcedure.mutation(({ ctx }) => {
    const db = getDb();
    db.delete(schema.authSessions).where(eq(schema.authSessions.userId, ctx.user.id)).run();
    ctx.res.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }),
});
