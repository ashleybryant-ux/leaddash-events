import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { parse as parseCookies } from "cookie";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@shared/const";
import type { User } from "../../drizzle/schema";
import { getDb, schema } from "./db";
import { sha256 } from "./crypto";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

export function userFromCookie(cookieHeader: string | undefined): User | null {
  const token = parseCookies(cookieHeader ?? "")[SESSION_COOKIE];
  if (!token) return null;
  const db = getDb();
  const session = db.select().from(schema.authSessions).where(eq(schema.authSessions.tokenHash, sha256(token))).get();
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  return db.select().from(schema.users).where(eq(schema.users.id, session.userId)).get() ?? null;
}

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  let user: User | null = null;
  try {
    user = userFromCookie(opts.req.headers.cookie);
  } catch (err) {
    console.error("[auth] session lookup failed:", err);
  }
  return { req: opts.req, res: opts.res, user };
}
