import webpush from "web-push";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "./db";
import { ENV } from "./env";

let configured = false;
function ready() {
  if (!ENV.vapidPublic || !ENV.vapidPrivate) return false;
  if (!configured) {
    webpush.setVapidDetails(ENV.vapidSubject, ENV.vapidPublic, ENV.vapidPrivate);
    configured = true;
  }
  return true;
}

export const pushReady = () => !!(ENV.vapidPublic && ENV.vapidPrivate);

/** Push notices sent during tests. */
export const pushLog: { userId: number; title: string; body: string; url: string }[] = [];

/** Sends a push notice to every device the person allowed. Dead subscriptions are removed. */
export async function sendPush(userId: number, payload: { title: string; body: string; url: string; tag?: string }) {
  if (ENV.isTest) {
    pushLog.push({ userId, ...payload });
    return;
  }
  if (!ready()) return;
  const db = getDb();
  const subs = db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId)).all();
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 12 });
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, s.id)).run();
        else console.error("[push] send failed:", (err as Error).message);
      }
    })
  );
}

export type Notice = { title: string; body?: string; url?: string; kind?: string; push?: boolean };

/**
 * Adds an alert to each person's Alerts screen and, unless push is false,
 * sends it to their devices. Never put a client's or patient's name in a notice.
 */
export async function notify(userIds: number[], eventId: number | null, notice: Notice) {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (!ids.length) return 0;
  const db = getDb();
  for (const userId of ids) {
    db.insert(schema.notifications)
      .values({ userId, eventId, kind: notice.kind ?? "general", title: notice.title, body: notice.body ?? "", url: notice.url ?? "" })
      .run();
  }
  if (notice.push !== false) {
    await Promise.all(ids.map((id) => sendPush(id, { title: notice.title, body: notice.body ?? "", url: notice.url ?? "/" })));
  }
  return ids.length;
}

export function unreadCount(userId: number, eventId?: number) {
  const db = getDb();
  const rows = db
    .select({ id: schema.notifications.id, readAt: schema.notifications.readAt, eventId: schema.notifications.eventId })
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .all();
  return rows.filter((r) => !r.readAt && (eventId === undefined || r.eventId === eventId)).length;
}

export function markRead(userId: number, ids: number[]) {
  if (!ids.length) return;
  getDb()
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notifications.userId, userId), inArray(schema.notifications.id, ids)))
    .run();
}
