/**
 * Document library. Folders say who can open them (active members, the
 * board, a group, a member level, or staff only). Files are private and open
 * through signed links only after the access check. Each document keeps its
 * version history; restoring makes a new version that copies the old file.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, forbidden, notFound, requireOrgAdmin } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import { notify } from "../../_core/push";
import { emailButton, emailLayout, escapeHtml, sendEmail } from "../../_core/email";
import { ENV } from "../../_core/env";
import { randomToken } from "../../_core/crypto";
import type { FolderAccess } from "../../../drizzle/schema";
import { accessLabel, activeMember, getOrg, memberCanOpen, memberGroups, membersWhoCanOpen } from "./shared";

const FOURTEEN_DAYS = 14 * 86400_000;
const NOTIFY = z.enum(["push_email", "push", "none"]);
const accessInput = z.object({ type: z.enum(["active_members", "board", "group", "level", "staff"]), groupId: z.number().optional(), level: z.string().max(60).optional() });

const ext = (name: string, mime: string) => {
  const m = name.match(/\.([a-z0-9]{2,4})$/i);
  if (m) return m[1].toUpperCase().replace("DOCX", "DOC").replace("XLSX", "XLS").replace("PPTX", "PPT").replace("JPEG", "JPG");
  return mime === "application/pdf" ? "PDF" : "FILE";
};

const isNew = (d: { updatedAt: Date | null; createdAt: Date }) => (d.updatedAt ?? d.createdAt).getTime() >= Date.now() - FOURTEEN_DAYS;

function currentFile(documentId: number, version: number) {
  return getDb()
    .select({ fileId: schema.documentVersions.fileId, name: schema.files.name, mime: schema.files.mime, size: schema.files.size })
    .from(schema.documentVersions)
    .innerJoin(schema.files, eq(schema.files.id, schema.documentVersions.fileId))
    .where(and(eq(schema.documentVersions.documentId, documentId), eq(schema.documentVersions.version, version)))
    .get();
}

/** Documents in a folder, newest first (no file links; those come from open). */
export function folderDocs(folderId: number) {
  return getDb()
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.folderId, folderId))
    .all()
    .map((d) => {
      const f = currentFile(d.id, d.currentVersion);
      return { id: d.id, title: d.title, version: d.currentVersion, updatedAt: d.updatedAt ?? d.createdAt, ext: f ? ext(f.name, f.mime) : "FILE", isNew: isNew(d) };
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

function getFolder(orgId: number, folderId: number) {
  const f = getDb().select().from(schema.docFolders).where(eq(schema.docFolders.id, folderId)).get();
  if (!f || f.orgId !== orgId) throw notFound("That folder");
  return f;
}

function getDoc(orgId: number, documentId: number) {
  const d = getDb().select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
  if (!d) throw notFound("That document");
  const folder = getFolder(orgId, d.folderId);
  return { doc: d, folder };
}

/** The file must belong to the organization; library files are always private. */
function claimFile(orgId: number, fileId: number) {
  const db = getDb();
  const f = db.select().from(schema.files).where(eq(schema.files.id, fileId)).get();
  if (!f || f.orgId !== orgId) throw forbidden("That file belongs to another organization.");
  if (f.isPublic) db.update(schema.files).set({ isPublic: false }).where(eq(schema.files.id, f.id)).run();
  return f;
}

/** Copies a stored file into a new private file row (used by restore). */
function copyFile(fileId: number, userId: number) {
  const db = getDb();
  const f = db.select().from(schema.files).where(eq(schema.files.id, fileId)).get();
  if (!f) throw notFound("That version's file");
  const root = path.resolve(ENV.uploadsDir);
  const key = randomToken(18);
  const src = path.join(root, f.key);
  if (!fs.existsSync(src)) throw new TRPCError({ code: "NOT_FOUND", message: "That version's file is missing on the server." });
  fs.copyFileSync(src, path.join(root, key));
  return db.insert(schema.files).values({ orgId: f.orgId, key, name: f.name, mime: f.mime, size: f.size, isPublic: false, uploadedBy: userId }).returning().get();
}

function groupName(groupId: number | undefined | null) {
  if (!groupId) return undefined;
  return getDb().select({ name: schema.groups.name }).from(schema.groups).where(eq(schema.groups.id, groupId)).get()?.name;
}

const folderAccessLabel = (f: { access: FolderAccess; groupId: number | null }) => accessLabel(f.access, groupName(f.access.groupId ?? f.groupId));

/** Tells the members who can open the folder about a new document or version. */
async function tellMembers(orgId: number, folder: { id: number; name: string; access: FolderAccess; groupId: number | null }, doc: { title: string; notify: "push_email" | "push" | "none" }, isUpdate: boolean) {
  if (doc.notify === "none") return 0;
  const org = getOrg(orgId);
  const people = membersWhoCanOpen(orgId, folder);
  const url = `/m/${org.slug}/docs/${folder.id}`;
  const title = isUpdate ? `Updated: ${doc.title}` : `New document: ${doc.title}`;
  await notify(people.map((p) => p.userId!).filter(Boolean), null, { title, body: folder.name, url, kind: "document" });
  if (doc.notify === "push_email") {
    const html = emailLayout({
      brand: org.colorPrimary,
      accent: org.colorAccent,
      title,
      blocks: [`<p>${isUpdate ? "A new version is" : "A new document is"} in <b>${escapeHtml(folder.name)}</b> in the ${escapeHtml(org.name)} member hub.</p>`, emailButton("Open documents", ENV.appUrl + url, org.colorAccent)],
      footer: `${escapeHtml(org.name)} member hub`,
    });
    for (const p of people) await sendEmail({ to: p.email, subject: `${title} (${org.name})`, text: `${title}\n${folder.name}\n${ENV.appUrl}${url}`, html, fromName: org.name });
  }
  return people.length;
}

export const docsAdminRouter = router({
  folders: protectedProcedure.input(z.object({ orgId: z.number() })).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const db = getDb();
    const folders = db.select().from(schema.docFolders).where(eq(schema.docFolders.orgId, input.orgId)).orderBy(schema.docFolders.sort, schema.docFolders.name).all();
    const docs = folders.length ? db.select({ folderId: schema.documents.folderId }).from(schema.documents).where(inArray(schema.documents.folderId, folders.map((f) => f.id))).all() : [];
    const groups = db.select({ id: schema.groups.id, name: schema.groups.name }).from(schema.groups).where(eq(schema.groups.orgId, input.orgId)).orderBy(schema.groups.name).all();
    const levels = Array.from(new Set(db.select({ level: schema.members.level }).from(schema.members).where(eq(schema.members.orgId, input.orgId)).all().map((r) => r.level))).sort();
    return {
      folders: folders.map((f) => ({ ...f, accessLabel: folderAccessLabel(f), count: docs.filter((d) => d.folderId === f.id).length })),
      groups,
      levels,
    };
  }),

  saveFolder: protectedProcedure.input(z.object({ orgId: z.number(), folderId: z.number().optional(), name: z.string().min(1).max(120), access: accessInput })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const db = getDb();
    const access: FolderAccess = { type: input.access.type, ...(input.access.type === "group" ? { groupId: input.access.groupId } : {}), ...(input.access.type === "level" ? { level: input.access.level } : {}) };
    if (access.type === "group") {
      const g = access.groupId ? db.select().from(schema.groups).where(eq(schema.groups.id, access.groupId)).get() : undefined;
      if (!g || g.orgId !== input.orgId) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the division or committee." });
    }
    if (access.type === "level" && !access.level?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the member level." });
    if (input.folderId) {
      getFolder(input.orgId, input.folderId);
      return db.update(schema.docFolders).set({ name: input.name, access }).where(eq(schema.docFolders.id, input.folderId)).returning().get();
    }
    return db.insert(schema.docFolders).values({ orgId: input.orgId, name: input.name, access }).returning().get();
  }),

  removeFolder: protectedProcedure.input(z.object({ orgId: z.number(), folderId: z.number() })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const f = getFolder(input.orgId, input.folderId);
    getDb().delete(schema.docFolders).where(eq(schema.docFolders.id, f.id)).run();
    audit(ctx.user, { orgId: input.orgId, action: "folder.remove", detail: f.name });
    return { ok: true };
  }),

  documents: protectedProcedure.input(z.object({ orgId: z.number(), folderId: z.number() })).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const folder = getFolder(input.orgId, input.folderId);
    const label = folderAccessLabel(folder);
    return folderDocs(folder.id).map((d) => ({ ...d, accessLabel: label }));
  }),

  /** One document with its version history (signed file links for admins). */
  document: protectedProcedure.input(z.object({ orgId: z.number(), documentId: z.number() })).query(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const { doc } = getDoc(input.orgId, input.documentId);
    const versions = getDb()
      .select({ id: schema.documentVersions.id, version: schema.documentVersions.version, note: schema.documentVersions.note, createdAt: schema.documentVersions.createdAt, fileId: schema.documentVersions.fileId, uploadedBy: schema.users.name, uploadedByEmail: schema.users.email })
      .from(schema.documentVersions)
      .leftJoin(schema.users, eq(schema.users.id, schema.documentVersions.uploadedBy))
      .where(eq(schema.documentVersions.documentId, doc.id))
      .orderBy(desc(schema.documentVersions.version))
      .all()
      .map((v) => ({ ...v, uploadedBy: v.uploadedBy || v.uploadedByEmail || "", url: fileUrl(v.fileId), current: v.version === doc.currentVersion }));
    return { doc, versions };
  }),

  create: protectedProcedure
    .input(z.object({ orgId: z.number(), folderId: z.number(), title: z.string().min(1).max(200), fileId: z.number(), note: z.string().max(300).default(""), notify: NOTIFY.default("push_email") }))
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      const folder = getFolder(input.orgId, input.folderId);
      claimFile(input.orgId, input.fileId);
      const db = getDb();
      const doc = db.insert(schema.documents).values({ folderId: folder.id, title: input.title, notify: input.notify, currentVersion: 1, updatedAt: new Date() }).returning().get();
      db.insert(schema.documentVersions).values({ documentId: doc.id, version: 1, fileId: input.fileId, note: input.note || "First upload", uploadedBy: ctx.user.id }).run();
      const told = await tellMembers(input.orgId, folder, doc, false);
      audit(ctx.user, { orgId: input.orgId, action: "document.create", detail: doc.title });
      return { ...doc, told };
    }),

  update: protectedProcedure
    .input(z.object({ orgId: z.number(), documentId: z.number(), title: z.string().min(1).max(200), folderId: z.number(), notify: NOTIFY }))
    .mutation(({ ctx, input }) => {
      requireOrgAdmin(ctx.user, input.orgId);
      const { doc } = getDoc(input.orgId, input.documentId);
      getFolder(input.orgId, input.folderId);
      getDb().update(schema.documents).set({ title: input.title, folderId: input.folderId, notify: input.notify }).where(eq(schema.documents.id, doc.id)).run();
      return { ok: true };
    }),

  /** Upload a new version with a note. */
  addVersion: protectedProcedure.input(z.object({ orgId: z.number(), documentId: z.number(), fileId: z.number(), note: z.string().max(300).default("") })).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const { doc, folder } = getDoc(input.orgId, input.documentId);
    claimFile(input.orgId, input.fileId);
    const db = getDb();
    const version = doc.currentVersion + 1;
    db.insert(schema.documentVersions).values({ documentId: doc.id, version, fileId: input.fileId, note: input.note, uploadedBy: ctx.user.id }).run();
    db.update(schema.documents).set({ currentVersion: version, updatedAt: new Date() }).where(eq(schema.documents.id, doc.id)).run();
    const told = await tellMembers(input.orgId, folder, doc, true);
    return { version, told };
  }),

  /** Restoring makes a new version that copies the old one's file. */
  restore: protectedProcedure.input(z.object({ orgId: z.number(), documentId: z.number(), version: z.number().int().positive() })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const { doc } = getDoc(input.orgId, input.documentId);
    const db = getDb();
    const old = db.select().from(schema.documentVersions).where(and(eq(schema.documentVersions.documentId, doc.id), eq(schema.documentVersions.version, input.version))).get();
    if (!old) throw notFound("That version");
    const copy = copyFile(old.fileId, ctx.user.id);
    const version = doc.currentVersion + 1;
    db.insert(schema.documentVersions).values({ documentId: doc.id, version, fileId: copy.id, note: `Restored version ${old.version}`, uploadedBy: ctx.user.id }).run();
    db.update(schema.documents).set({ currentVersion: version, updatedAt: new Date() }).where(eq(schema.documents.id, doc.id)).run();
    audit(ctx.user, { orgId: input.orgId, action: "document.restore", detail: `${doc.title} v${old.version}` });
    return { version };
  }),

  remove: protectedProcedure.input(z.object({ orgId: z.number(), documentId: z.number() })).mutation(({ ctx, input }) => {
    requireOrgAdmin(ctx.user, input.orgId);
    const { doc } = getDoc(input.orgId, input.documentId);
    getDb().delete(schema.documents).where(eq(schema.documents.id, doc.id)).run();
    audit(ctx.user, { orgId: input.orgId, action: "document.remove", detail: doc.title });
    return { ok: true };
  }),
});

const slugInput = z.object({ orgSlug: z.string().max(120) });

/** The member's certificates from the organization's events (the "My certificates" folder). */
function memberCertificates(orgId: number, email: string) {
  return getDb()
    .select({ id: schema.certificates.id, title: schema.certificates.title, hours: schema.certificates.hours, code: schema.certificates.code, createdAt: schema.certificates.createdAt, eventName: schema.events.name })
    .from(schema.certificates)
    .innerJoin(schema.attendees, eq(schema.attendees.id, schema.certificates.attendeeId))
    .innerJoin(schema.events, eq(schema.events.id, schema.certificates.eventId))
    .where(and(eq(schema.events.orgId, orgId), eq(schema.attendees.email, email.toLowerCase()), isNull(schema.certificates.revokedAt)))
    .orderBy(desc(schema.certificates.id))
    .all()
    .map((c) => ({ ...c, url: `/cert/${c.code}` }));
}

export const docsHubRouter = router({
  /** Folders the member can open, with counts, "new" counts and the recently added files. */
  folders: protectedProcedure.input(slugInput).query(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const groups = memberGroups(member.id);
    const folders = getDb().select().from(schema.docFolders).where(eq(schema.docFolders.orgId, org.id)).orderBy(schema.docFolders.sort, schema.docFolders.name).all().filter((f) => memberCanOpen(member, f, groups));
    const withDocs = folders.map((f) => ({ folder: f, docs: folderDocs(f.id) }));
    const recent = withDocs
      .flatMap(({ folder, docs }) => docs.map((d) => ({ ...d, folderId: folder.id, folderName: folder.name })))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return {
      folders: withDocs.map(({ folder, docs }) => ({ id: folder.id, name: folder.name, restricted: folder.access.type !== "active_members", accessLabel: folderAccessLabel(folder), count: docs.length, newCount: docs.filter((d) => d.isNew).length })),
      certificates: memberCertificates(org.id, member.email).length,
      recent: recent.slice(0, 8),
      all: recent.slice(0, 500).map((d) => ({ id: d.id, title: d.title, folderId: d.folderId, folderName: d.folderName, version: d.version, updatedAt: d.updatedAt, ext: d.ext, isNew: d.isNew })),
    };
  }),

  folder: protectedProcedure.input(slugInput.extend({ folderId: z.number() })).query(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const folder = getFolder(org.id, input.folderId);
    if (!memberCanOpen(member, folder)) throw forbidden("This folder is not open to you.");
    return { id: folder.id, name: folder.name, accessLabel: folderAccessLabel(folder), documents: folderDocs(folder.id) };
  }),

  certificates: protectedProcedure.input(slugInput).query(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    return memberCertificates(org.id, member.email);
  }),

  /** A signed link to the current file, after the folder access check. */
  open: protectedProcedure.input(slugInput.extend({ documentId: z.number() })).mutation(({ ctx, input }) => {
    const { org, member } = activeMember(ctx.user, input.orgSlug);
    const { doc, folder } = getDoc(org.id, input.documentId);
    if (!memberCanOpen(member, folder)) throw forbidden("This document is not open to you.");
    const f = currentFile(doc.id, doc.currentVersion);
    if (!f) throw notFound("That file");
    return { url: fileUrl(f.fileId)!, name: f.name };
  }),
});
