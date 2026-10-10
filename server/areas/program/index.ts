/**
 * The program: sessions and My agenda, speakers, announcements, dining,
 * About your host, the help center, branding, and the attendee's alert choices.
 */
import { router } from "../../_core/trpc";
import type { AreaModule } from "../types";
import { sessionsRouter } from "./sessions";
import { speakersRouter } from "./speakers";
import { announcementsRouter, runScheduledAnnouncements, runSessionReminders } from "./announcements";
import { alertsRouter, brandingRouter, diningRouter, hostRouter } from "./info";
import { helpRouter, seedHelp } from "./help";
import { slidesRouter } from "./slides";

export const programRouter = router({
  sessions: sessionsRouter,
  speakers: speakersRouter,
  announcements: announcementsRouter,
  dining: diningRouter,
  host: hostRouter,
  help: helpRouter,
  branding: brandingRouter,
  alerts: alertsRouter,
  slides: slidesRouter,
});

export const programArea: AreaModule<typeof programRouter> = {
  router: programRouter,
  seedEvent: (eventId) => seedHelp(eventId),
  jobs: [
    { name: "scheduled announcements", run: () => runScheduledAnnouncements() },
    { name: "session reminders", run: () => runSessionReminders() },
  ],
};
