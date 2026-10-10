import type { ReactNode } from "react";

/**
 * One screen. `shell` decides the frame and sign-in gate:
 * - "event": attendee app at /e/:slug/... (inside <EventApp>, use useEventApp())
 * - "admin": admin at /admin/... or /admin/e/:eventId/... (inside <AdminApp>, use useAdmin())
 * - "public": no gate (checkout pages, proposal form, certificate check)
 */
export type AppRoute = {
  path: string;
  shell: "event" | "admin" | "public";
  render: (params: Record<string, string>) => ReactNode;
};
