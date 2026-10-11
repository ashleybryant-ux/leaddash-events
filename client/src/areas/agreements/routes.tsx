/** Agreement screens: the admin Agreements page, the public sign page and the signed copy. */
import type { AppRoute } from "../types";
import { SignScreen, SignedCopyScreen } from "./public";
import { AdminAgreementsScreen } from "./AdminAgreements";

export const routes: AppRoute[] = [
  { path: "/admin/e/:eventId/agreements", shell: "admin", render: () => <AdminAgreementsScreen /> },
  { path: "/sign/:code", shell: "public", render: (p) => <SignScreen code={p.code} /> },
  { path: "/agreement/:code", shell: "public", render: (p) => <SignedCopyScreen code={p.code} /> },
];
