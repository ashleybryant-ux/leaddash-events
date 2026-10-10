import type { ReactNode } from "react";
import { Route, Switch, Redirect } from "wouter";
import type { AppRoute } from "./areas/types";
import { routes as programRoutes } from "./areas/program/routes";
import { routes as registrationRoutes } from "./areas/registration/routes";
import { routes as ceRoutes } from "./areas/ce/routes";
import { routes as networkRoutes } from "./areas/network/routes";
import { EventApp } from "./shells/AttendeeShell";
import { AdminApp } from "./shells/AdminShell";
import { AdminHomeScreen, EventHomeScreen, EventSettingsScreen, HomeScreen, LeadDashToolsScreen, OrgSettingsScreen } from "./core/screens";

const coreRoutes: AppRoute[] = [
  { path: "/admin", shell: "admin", render: () => <AdminHomeScreen /> },
  { path: "/admin/settings", shell: "admin", render: () => <OrgSettingsScreen /> },
  { path: "/admin/leaddash", shell: "admin", render: () => <LeadDashToolsScreen /> },
  { path: "/admin/e/:eventId", shell: "admin", render: () => <EventHomeScreen /> },
  { path: "/admin/e/:eventId/settings", shell: "admin", render: () => <EventSettingsScreen /> },
];

const all: AppRoute[] = [...coreRoutes, ...programRoutes, ...registrationRoutes, ...ceRoutes, ...networkRoutes];

function wrap(r: AppRoute, params: Record<string, string>): ReactNode {
  const inner = r.render(params);
  switch (r.shell) {
    case "event":
      return <EventApp slug={params.slug}>{inner}</EventApp>;
    case "admin":
      return <AdminApp eventId={params.eventId ? Number(params.eventId) : undefined}>{inner}</AdminApp>;
    default:
      return inner;
  }
}

export function App() {
  return (
    <Switch>
      <Route path="/">
        <HomeScreen />
      </Route>
      {all.map((r) => (
        <Route key={`${r.shell}:${r.path}`} path={r.path}>
          {(params) => wrap(r, params as Record<string, string>)}
        </Route>
      ))}
      <Route path="/admin/e/:eventId">{(p) => <Redirect to={`/admin/e/${p.eventId}/sessions`} />}</Route>
      <Route>
        <div className="app">
          <div className="empty">This page was not found. <a href="/">Go to the start</a></div>
        </div>
      </Route>
    </Switch>
  );
}
