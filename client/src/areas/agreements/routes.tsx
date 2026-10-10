/** Agreement screens: the public sign page and the signed copy. */
import type { AppRoute } from "../types";
import { SignScreen, SignedCopyScreen } from "./public";

export const routes: AppRoute[] = [
  { path: "/sign/:code", shell: "public", render: (p) => <SignScreen code={p.code} /> },
  { path: "/agreement/:code", shell: "public", render: (p) => <SignedCopyScreen code={p.code} /> },
];
