import type { AppRoute } from "../types";
import { MemberCard, MemberDocs, MemberEvents, MemberGroup, MemberHome, VerifyCard } from "./hub";
import { AdminDivisions, AdminDocuments, AdminInsights, AdminMembers } from "./admin";

export const routes: AppRoute[] = [
  // Public card check (the QR code on the member card). Listed before the hub so it never asks for sign-in.
  { path: "/m/:orgSlug/verify/:token", shell: "public", render: (p) => <VerifyCard orgSlug={p.orgSlug} token={p.token} /> },

  // Member hub
  { path: "/m/:orgSlug", shell: "member", render: () => <MemberHome /> },
  { path: "/m/:orgSlug/card", shell: "member", render: () => <MemberCard /> },
  { path: "/m/:orgSlug/events", shell: "member", render: () => <MemberEvents /> },
  { path: "/m/:orgSlug/docs", shell: "member", render: () => <MemberDocs /> },
  { path: "/m/:orgSlug/docs/:folderId", shell: "member", render: (p) => <MemberDocs folderId={p.folderId} /> },
  { path: "/m/:orgSlug/groups/:groupId", shell: "member", render: (p) => <MemberGroup groupId={Number(p.groupId)} /> },

  // Association admin
  { path: "/admin/members", shell: "admin", render: () => <AdminMembers /> },
  { path: "/admin/divisions", shell: "admin", render: () => <AdminDivisions /> },
  { path: "/admin/documents", shell: "admin", render: () => <AdminDocuments /> },
  { path: "/admin/insights", shell: "admin", render: () => <AdminInsights /> },
];
