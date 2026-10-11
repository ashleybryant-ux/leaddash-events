/** The program's screens: the attendee app's core screens and the admin program screens. */
import type { AppRoute } from "../types";
import { AgendaScreen, MyAgendaScreen, SessionScreen, SpeakersScreen, WelcomeScreen } from "./attendee";
import { AlertsScreen, DiningScreen, HelpScreen, HostScreen, LostFoundScreen, MoreScreen, NearbyScreen } from "./info";
import { AdminSessionEditScreen, AdminSessionsScreen, AdminSpeakerEditScreen, AdminSpeakersScreen } from "./adminProgram";
import { SpeakerPageScreen } from "./speakerPage";
import { HomeScreen } from "./home";
import { AdminAnnounceScreen, AdminBrandingScreen, AdminDiningScreen, AdminHelpScreen, AdminHostScreen } from "./adminInfo";

export const routes: AppRoute[] = [
  // The welcome screen does its own sign-in, so it has no gate.
  { path: "/e/:slug", shell: "public", render: (p) => <WelcomeScreen slug={p.slug} /> },
  { path: "/e/:slug/home", shell: "event", render: () => <HomeScreen /> },
  { path: "/e/:slug/agenda", shell: "event", render: () => <AgendaScreen /> },
  { path: "/e/:slug/my", shell: "event", render: () => <MyAgendaScreen /> },
  { path: "/e/:slug/session/:sessionId", shell: "event", render: (p) => <SessionScreen sessionId={Number(p.sessionId)} /> },
  { path: "/e/:slug/speakers", shell: "event", render: () => <SpeakersScreen /> },
  { path: "/e/:slug/alerts", shell: "event", render: () => <AlertsScreen /> },
  { path: "/e/:slug/more", shell: "event", render: () => <MoreScreen /> },
  { path: "/e/:slug/dining", shell: "event", render: () => <DiningScreen /> },
  { path: "/e/:slug/nearby", shell: "event", render: () => <NearbyScreen /> },
  { path: "/e/:slug/host", shell: "event", render: () => <HostScreen /> },
  { path: "/e/:slug/help", shell: "event", render: () => <HelpScreen /> },
  { path: "/e/:slug/lost-found", shell: "event", render: () => <LostFoundScreen /> },

  { path: "/speak/:token", shell: "public", render: (p) => <SpeakerPageScreen token={p.token} /> },

  { path: "/admin/e/:eventId/sessions", shell: "admin", render: () => <AdminSessionsScreen /> },
  { path: "/admin/e/:eventId/sessions/:sessionId", shell: "admin", render: (p) => <AdminSessionEditScreen sessionId={Number(p.sessionId)} /> },
  { path: "/admin/e/:eventId/speakers", shell: "admin", render: () => <AdminSpeakersScreen /> },
  { path: "/admin/e/:eventId/speakers/:speakerId", shell: "admin", render: (p) => <AdminSpeakerEditScreen speakerId={Number(p.speakerId)} /> },
  { path: "/admin/e/:eventId/announcements", shell: "admin", render: () => <AdminAnnounceScreen /> },
  { path: "/admin/e/:eventId/help", shell: "admin", render: () => <AdminHelpScreen /> },
  { path: "/admin/e/:eventId/dining", shell: "admin", render: () => <AdminDiningScreen /> },
  { path: "/admin/e/:eventId/host", shell: "admin", render: () => <AdminHostScreen /> },
  { path: "/admin/e/:eventId/branding", shell: "admin", render: () => <AdminBrandingScreen /> },
];
