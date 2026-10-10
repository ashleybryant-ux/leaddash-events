/**
 * Networking: people, messages, meetings, community, exhibitors and vendors,
 * lead scanning, the venue map, live polls and Q&A, and the call for proposals.
 */
import { router } from "../../_core/trpc";
import type { AreaModule } from "../types";
import { peopleRouter } from "./people";
import { messagesRouter, unreadMessages } from "./messages";
import { meetingsRouter } from "./meetings";
import { communityRouter, seedCommunity } from "./community";
import { exhibitorsRouter, vendorsRouter } from "./vendors";
import { leadsRouter, mapsRouter } from "./leads";
import { pollsRouter } from "./polls";
import { cfpSettingsFor, proposalsRouter } from "./proposals";

export const networkRouter = router({
  /** Unread direct messages for the bottom nav badge (0 when the person is not an attendee). */
  unreadMessages,
  people: peopleRouter,
  messages: messagesRouter,
  meetings: meetingsRouter,
  community: communityRouter,
  exhibitors: exhibitorsRouter,
  vendors: vendorsRouter,
  leads: leadsRouter,
  maps: mapsRouter,
  polls: pollsRouter,
  proposals: proposalsRouter,
});

export const networkArea: AreaModule<typeof networkRouter> = {
  router: networkRouter,
  seedEvent: (eventId) => {
    seedCommunity(eventId);
    cfpSettingsFor(eventId);
  },
};
