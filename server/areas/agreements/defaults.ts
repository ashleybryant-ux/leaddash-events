/** The agreements every event starts with. */
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../_core/db";
import { STARTERS } from "./templates";

const KINDS = ["sponsor", "exhibitor", "speaker"] as const;

/**
 * Every event starts with a sponsor, exhibitor and speaker agreement to edit, so the
 * organization can review them before it has any sponsors, exhibitors or speakers.
 * Nothing is sent until the organization turns it on: the speaker agreement starts
 * with automatic sending off, and a new checkout page starts closed with its agreement picked.
 */
export function ensureAgreementTemplates(eventId: number) {
  const db = getDb();
  const have = db.select({ id: schema.agreementTemplates.id }).from(schema.agreementTemplates).where(eq(schema.agreementTemplates.eventId, eventId)).get();
  if (have) return;
  const event = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get();
  if (!event) return;
  const year = event.startDate.slice(0, 4);
  const now = new Date();
  for (const kind of KINDS) {
    const s = STARTERS[kind];
    db.insert(schema.agreementTemplates)
      .values({
        eventId,
        kind,
        name: `${s.name} ${year}`,
        body: s.body,
        values: s.values,
        signWhen: kind === "speaker" ? "email" : "checkout",
        sendOnAccept: kind !== "speaker",
        sendOnAdd: kind !== "speaker",
        askRecording: kind === "speaker",
        updatedAt: now,
      })
      .run();
  }
}
