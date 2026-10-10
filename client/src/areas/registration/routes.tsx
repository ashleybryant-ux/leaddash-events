import type { AppRoute } from "../types";
import { OrgPaymentsScreen, RegistrationScreen } from "./admin";
import { DoneScreen, EmbedScreen, EventLandingScreen, GetAppScreen, PayScreen, RegisterScreen } from "./public";

export const routes: AppRoute[] = [
  { path: "/admin/e/:eventId/registration", shell: "admin", render: () => <RegistrationScreen /> },
  { path: "/admin/payments", shell: "admin", render: () => <OrgPaymentsScreen /> },
  { path: "/r/:slug", shell: "public", render: (p) => <EventLandingScreen slug={p.slug} /> },
  { path: "/r/:slug/register", shell: "public", render: (p) => <RegisterScreen slug={p.slug} /> },
  { path: "/r/:slug/pay", shell: "public", render: (p) => <PayScreen slug={p.slug} /> },
  { path: "/r/:slug/done", shell: "public", render: (p) => <DoneScreen slug={p.slug} /> },
  { path: "/embed/:slug", shell: "public", render: (p) => <EmbedScreen slug={p.slug} /> },
  { path: "/get/:slug", shell: "public", render: (p) => <GetAppScreen slug={p.slug} /> },
];
