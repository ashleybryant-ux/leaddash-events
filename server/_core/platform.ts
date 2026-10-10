/**
 * The LeadDash platform (GoHighLevel) connection.
 *
 * LeadDash Events runs on its own and never waits on the platform: contacts
 * and tags are put in an outbox and sent when the platform answers. The
 * agency authorizes the same marketplace app LeadDash EHR uses once (with this
 * app's callback added to the app's redirect URLs); each organization's
 * sub-account token is minted from that agency token, so no organization ever
 * pastes a key.
 */
import { and, eq, isNull, lte } from "drizzle-orm";
import { getDb, schema } from "./db";
import { ENV } from "./env";
import { decrypt, encrypt } from "./crypto";

const VERSION = "2021-07-28";
export const PLATFORM_SCOPES = ["contacts.readonly", "contacts.write", "conversations.readonly", "conversations.write", "conversations/message.readonly", "conversations/message.write", "locations.readonly", "oauth.write", "oauth.readonly"];

export const platformConfigured = () => !!(ENV.ghlClientId && ENV.ghlClientSecret);
export const redirectUri = () => `${ENV.appUrl}/api/platform/callback`;

export function authorizeUrl(state: string) {
  const q = new URLSearchParams({ response_type: "code", redirect_uri: redirectUri(), client_id: ENV.ghlClientId, scope: PLATFORM_SCOPES.join(" "), state });
  return `${ENV.ghlAuthBase}/oauth/chooselocation?${q}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(`${ENV.ghlApiBase}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: ENV.ghlClientId, client_secret: ENV.ghlClientSecret, ...body }).toString(),
  });
  if (!res.ok) throw new Error(`platform token request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; companyId?: string; userType?: string };
}

function saveAgency(data: { access_token: string; refresh_token: string; expires_in: number; companyId?: string }, companyId?: string) {
  const db = getDb();
  const row = {
    id: 1,
    companyId: data.companyId || companyId || "",
    accessTokenEnc: encrypt(data.access_token),
    refreshTokenEnc: encrypt(data.refresh_token),
    expiresAt: new Date(Date.now() + (Number(data.expires_in) || 86400) * 1000),
    updatedAt: new Date(),
  };
  db.insert(schema.platformAuth).values(row).onConflictDoUpdate({ target: schema.platformAuth.id, set: row }).run();
}

/** The agency owner finished authorizing: keep the agency token. */
export async function handleCallback(code: string) {
  const data = await tokenRequest({ grant_type: "authorization_code", code, user_type: "Company", redirect_uri: redirectUri() });
  saveAgency(data);
  return { companyId: data.companyId || "" };
}

export function agencyStatus() {
  const row = getDb().select().from(schema.platformAuth).where(eq(schema.platformAuth.id, 1)).get();
  return row ? { connected: true, companyId: row.companyId, updatedAt: row.updatedAt } : { connected: false as const };
}

async function agencyToken() {
  const row = getDb().select().from(schema.platformAuth).where(eq(schema.platformAuth.id, 1)).get();
  if (!row) throw new Error("The LeadDash agency has not authorized LeadDash Events yet.");
  if (row.expiresAt.getTime() - Date.now() > 5 * 60_000) return { token: decrypt(row.accessTokenEnc), companyId: row.companyId };
  const data = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(row.refreshTokenEnc), user_type: "Company" });
  saveAgency(data, row.companyId);
  return { token: data.access_token, companyId: row.companyId };
}

const locationTokens = new Map<string, { token: string; expiresAt: number }>();

async function locationToken(locationId: string) {
  const cached = locationTokens.get(locationId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const agency = await agencyToken();
  const res = await fetch(`${ENV.ghlApiBase}/oauth/locationToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: `Bearer ${agency.token}`, Version: VERSION },
    body: new URLSearchParams({ companyId: agency.companyId, locationId }).toString(),
  });
  if (!res.ok) throw new Error(`could not get the sub-account token (${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  locationTokens.set(locationId, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 86400) * 1000 });
  return data.access_token;
}

async function call<T = any>(locationId: string, path: string, method: string, body?: unknown): Promise<T> {
  const token = await locationToken(locationId);
  const res = await fetch(`${ENV.ghlApiBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Version: VERSION, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`platform ${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export type ContactInput = { email: string; firstName?: string; lastName?: string; phone?: string; tags?: string[]; source?: string };

async function upsertContact(locationId: string, c: ContactInput) {
  const up = await call<{ contact?: { id: string } }>(locationId, "/contacts/upsert", "POST", {
    locationId,
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone || undefined,
    source: c.source || "LeadDash Events",
  });
  const id = up.contact?.id;
  if (!id) throw new Error("the platform returned no contact");
  // Added, never replacing the tags a returning contact already has.
  if (c.tags?.length) await call(locationId, `/contacts/${encodeURIComponent(id)}/tags`, "POST", { tags: c.tags });
  return id;
}

/** Queue a contact (and tags) for the organization's sub-account. Does nothing if the organization has no sub-account set. */
export function queueContact(orgId: number, contact: ContactInput) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).get();
  if (!org?.platformLocationId) return false;
  getDb().insert(schema.platformOutbox).values({ orgId, kind: "upsert_contact", payload: contact as Record<string, unknown> }).run();
  return true;
}

/** Texts are sent through the organization's sub-account (its A2P-registered number). Returns false when texting is not set up. */
export async function sendText(orgId: number, to: ContactInput & { phone: string }, message: string) {
  const org = getDb().select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).get();
  if (ENV.isTest) {
    textLog.push({ orgId, phone: to.phone, message });
    return true;
  }
  if (!org?.platformLocationId || !platformConfigured()) return false;
  const contactId = await upsertContact(org.platformLocationId, to);
  await call(org.platformLocationId, "/conversations/messages", "POST", { type: "SMS", contactId, message });
  return true;
}

export const textLog: { orgId: number; phone: string; message: string }[] = [];

/** Runs every minute: sends what is waiting in the outbox, backing off on failure. */
export async function runOutbox() {
  if (!platformConfigured()) return;
  const db = getDb();
  const due = db
    .select()
    .from(schema.platformOutbox)
    .where(and(isNull(schema.platformOutbox.sentAt), lte(schema.platformOutbox.nextTryAt, new Date())))
    .limit(25)
    .all();
  for (const item of due) {
    const org = db.select().from(schema.organizations).where(eq(schema.organizations.id, item.orgId)).get();
    try {
      if (!org?.platformLocationId) throw new Error("no sub-account set for this organization");
      await upsertContact(org.platformLocationId, item.payload as ContactInput);
      db.update(schema.platformOutbox).set({ sentAt: new Date(), lastError: null }).where(eq(schema.platformOutbox.id, item.id)).run();
    } catch (err) {
      const attempts = item.attempts + 1;
      const wait = Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(attempts, 8));
      db.update(schema.platformOutbox)
        .set({ attempts, lastError: (err as Error).message.slice(0, 300), nextTryAt: new Date(Date.now() + wait) })
        .where(eq(schema.platformOutbox.id, item.id))
        .run();
    }
  }
}
