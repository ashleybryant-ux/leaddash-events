import type { AppRoute } from "../types";
import { EditProfileScreen, MeetingRequestScreen, PeopleScreen, ProfileScreen } from "./people";
import { ChatScreen, MessagesScreen } from "./messages";
import { ChannelScreen, CommunityScreen, NewTopicScreen } from "./community";
import { ExhibitorScreen, ExhibitorsScreen, FloorMapScreen, LeadScanScreen } from "./booths";
import { LivePollScreen } from "./poll";
import { ProposalSubmitPage } from "./cfp";
import { AdminProposalsScreen } from "./admin-proposals";
import { AdminVendorsScreen } from "./admin-vendors";
import { AdminCommunityScreen } from "./admin-community";
import { PhotosScreen } from "./photos";
import { AdminPhotosScreen } from "./admin-photos";

const n = (v: string | undefined) => Number(v) || 0;

/** "/community/new" is listed before "/community/:channelId" so it wins. */
export const routes: AppRoute[] = [
  { path: "/e/:slug/people", shell: "event", render: () => <PeopleScreen /> },
  { path: "/e/:slug/people/:attendeeId", shell: "event", render: (p) => <ProfileScreen key={p.attendeeId} attendeeId={n(p.attendeeId)} /> },
  { path: "/e/:slug/profile", shell: "event", render: () => <EditProfileScreen /> },
  { path: "/e/:slug/messages", shell: "event", render: () => <MessagesScreen /> },
  { path: "/e/:slug/messages/:threadId", shell: "event", render: (p) => <ChatScreen key={p.threadId} threadId={n(p.threadId)} /> },
  { path: "/e/:slug/meet/:attendeeId", shell: "event", render: (p) => <MeetingRequestScreen key={p.attendeeId} attendeeId={n(p.attendeeId)} /> },
  { path: "/e/:slug/community", shell: "event", render: () => <CommunityScreen /> },
  { path: "/e/:slug/community/new", shell: "event", render: () => <NewTopicScreen /> },
  { path: "/e/:slug/community/:channelId", shell: "event", render: (p) => <ChannelScreen key={p.channelId} channelId={n(p.channelId)} /> },
  { path: "/e/:slug/exhibitors", shell: "event", render: () => <ExhibitorsScreen /> },
  { path: "/e/:slug/exhibitors/:vendorId", shell: "event", render: (p) => <ExhibitorScreen key={p.vendorId} vendorId={n(p.vendorId)} /> },
  { path: "/e/:slug/map", shell: "event", render: () => <FloorMapScreen /> },
  { path: "/e/:slug/poll/:sessionId", shell: "event", render: (p) => <LivePollScreen key={p.sessionId} sessionId={n(p.sessionId)} /> },
  { path: "/e/:slug/leads", shell: "event", render: () => <LeadScanScreen /> },
  { path: "/e/:slug/photos", shell: "event", render: () => <PhotosScreen /> },

  { path: "/cfp/:slug", shell: "public", render: (p) => <ProposalSubmitPage slug={p.slug} /> },

  { path: "/admin/e/:eventId/proposals", shell: "admin", render: () => <AdminProposalsScreen /> },
  { path: "/admin/e/:eventId/vendors", shell: "admin", render: () => <AdminVendorsScreen /> },
  { path: "/admin/e/:eventId/vendors/:vendorId", shell: "admin", render: (p) => <AdminVendorsScreen vendorId={n(p.vendorId)} /> },
  { path: "/admin/e/:eventId/community", shell: "admin", render: () => <AdminCommunityScreen /> },
  { path: "/admin/e/:eventId/photos", shell: "admin", render: () => <AdminPhotosScreen /> },
];
