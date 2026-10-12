import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDb, caller, setupEvent, outbox, user, getDb, schema } from "./helpers";
import { ENV } from "../server/_core/env";

/**
 * The owner hands the organization to someone on its admin team and stays on
 * as an admin. LeadDash staff can do it when an owner can't. The new owner
 * gets an email, the change is logged, and owner notices follow them.
 */

const roleOf = (orgId: number, userId: number) =>
  getDb().select().from(schema.orgMembers).where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId))).get()?.role;

describe("transferring ownership", () => {
  beforeEach(async () => {
    await freshDb();
    if (!ENV.staffEmails.includes("tech@leaddash.io")) ENV.staffEmails.push("tech@leaddash.io");
  });

  it("lets the owner make an admin the owner and stay on as an admin", async () => {
    const { org, owner, admin } = await setupEvent();
    await admin.core.org.addAdmin({ orgId: org.id, email: "jordan@client.org", name: "Jordan Ellis" });
    const team = await admin.core.org.team({ orgId: org.id });
    const jordanRow = team.find((t) => t.email === "jordan@client.org")!;
    const jordan = user("jordan@client.org");

    // An admin can't hand it to themselves.
    await expect(caller(jordan).core.org.transferOwner({ orgId: org.id, memberRowId: jordanRow.id })).rejects.toThrow(/Only the owner/);
    // Someone outside the organization can't either.
    await expect(caller(user("stranger@x.org")).core.org.transferOwner({ orgId: org.id, memberRowId: jordanRow.id })).rejects.toThrow();

    const sent = outbox.length;
    const r = await admin.core.org.transferOwner({ orgId: org.id, memberRowId: jordanRow.id });
    expect(r.owner).toBe("Jordan Ellis");
    expect(roleOf(org.id, jordan.id)).toBe("owner");
    expect(roleOf(org.id, owner.id)).toBe("admin");
    // The new owner is told.
    const mail = outbox.slice(sent).find((m) => m.to === "jordan@client.org")!;
    expect(mail.subject).toBe("You're now the owner of NABC");
    expect(mail.text).toMatch(/^Olivia Owner made you the owner of NABC on LeadDash Events on \w{3} \d{1,2}, \d{4}\./);
    // It's logged with both names.
    const log = getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "org.transfer_owner")).get();
    expect(log?.detail).toBe("From Olivia Owner to Jordan Ellis");
    // The old owner is an admin now: no more owner powers, and the new owner can remove them.
    await expect(admin.core.org.transferOwner({ orgId: org.id, memberRowId: jordanRow.id })).rejects.toThrow(/Only the owner/);
    const oldRow = (await caller(jordan).core.org.team({ orgId: org.id })).find((t) => t.userId === owner.id)!;
    await caller(jordan).core.org.removeAdmin({ orgId: org.id, memberRowId: oldRow.id });
    expect(roleOf(org.id, owner.id)).toBeUndefined();
  });

  it("lets LeadDash staff set the owner from LeadDash tools", async () => {
    const { org, owner, admin } = await setupEvent();
    await admin.core.org.addAdmin({ orgId: org.id, email: "jordan@client.org", name: "Jordan Ellis" });
    const row = (await admin.core.org.team({ orgId: org.id })).find((t) => t.email === "jordan@client.org")!;
    await caller(user("tech@leaddash.io")).core.org.transferOwner({ orgId: org.id, memberRowId: row.id });
    expect(roleOf(org.id, user("jordan@client.org").id)).toBe("owner");
    expect(roleOf(org.id, owner.id)).toBe("admin");
    // Exactly one owner.
    expect(getDb().select().from(schema.orgMembers).where(and(eq(schema.orgMembers.orgId, org.id), eq(schema.orgMembers.role, "owner"))).all()).toHaveLength(1);
  });

  it("only hands it to someone on this organization's admin team", async () => {
    const a = await setupEvent({ orgName: "First", ownerEmail: "a@first.org" });
    const b = await setupEvent({ orgName: "Second", ownerEmail: "b@second.org" });
    const bOwnerRow = (await b.admin.core.org.team({ orgId: b.org.id }))[0];
    await expect(a.admin.core.org.transferOwner({ orgId: a.org.id, memberRowId: bOwnerRow.id })).rejects.toThrow();
    const aOwnerRow = (await a.admin.core.org.team({ orgId: a.org.id }))[0];
    await expect(a.admin.core.org.transferOwner({ orgId: a.org.id, memberRowId: aOwnerRow.id })).rejects.toThrow(/already own/);
  });
});
