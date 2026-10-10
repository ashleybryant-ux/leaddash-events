import type { AppRoute } from "../types";
import { OrgPaymentsScreen, RegistrationScreen } from "./admin";
import { DoneScreen, EmbedScreen, EventLandingScreen, GetAppScreen, PayScreen, RegisterScreen } from "./public";
import { VendorCheckoutScreen, VendorDoneScreen, VendorPayScreen } from "./vendorPublic";

export const routes: AppRoute[] = [
  { path: "/admin/e/:eventId/registration", shell: "admin", render: () => <RegistrationScreen /> },
  { path: "/admin/payments", shell: "admin", render: () => <OrgPaymentsScreen /> },
  { path: "/r/:slug", shell: "public", render: (p) => <EventLandingScreen slug={p.slug} /> },
  { path: "/r/:slug/register", shell: "public", render: (p) => <RegisterScreen slug={p.slug} /> },
  { path: "/r/:slug/pay", shell: "public", render: (p) => <PayScreen slug={p.slug} /> },
  { path: "/r/:slug/done", shell: "public", render: (p) => <DoneScreen slug={p.slug} /> },
  { path: "/r/:slug/sponsor", shell: "public", render: (p) => <VendorCheckoutScreen key="sponsor" slug={p.slug} kind="sponsor" /> },
  { path: "/r/:slug/exhibit", shell: "public", render: (p) => <VendorCheckoutScreen key="exhibitor" slug={p.slug} kind="exhibitor" /> },
  { path: "/r/:slug/sponsor/done", shell: "public", render: (p) => <VendorDoneScreen slug={p.slug} kind="sponsor" /> },
  { path: "/r/:slug/exhibit/done", shell: "public", render: (p) => <VendorDoneScreen slug={p.slug} kind="exhibitor" /> },
  { path: "/r/:slug/sponsor/pay", shell: "public", render: (p) => <VendorPayScreen slug={p.slug} kind="sponsor" /> },
  { path: "/r/:slug/exhibit/pay", shell: "public", render: (p) => <VendorPayScreen slug={p.slug} kind="exhibitor" /> },
  { path: "/embed/:slug", shell: "public", render: (p) => <EmbedScreen slug={p.slug} /> },
  { path: "/get/:slug", shell: "public", render: (p) => <GetAppScreen slug={p.slug} /> },
];
