import type { AppRoute } from "../types";
import { BadgePrintPage, CheckInDesk } from "./CheckInDesk";
import { AdminAttendees } from "./AdminAttendees";
import { AdminEvaluationEdit, AdminEvaluations } from "./AdminEvaluations";
import { AdminCertificateEdit, AdminCertificates } from "./AdminCertificates";
import { AdminReports } from "./AdminReports";
import { AdminStaffRoles } from "./AdminStaffRoles";
import { CreditsScreen, EvaluationScreen, MyBadgeScreen, SessionCheckIn, TranscriptScreen } from "./AttendeeScreens";
import { CertificatePage } from "./CertificatePage";

export const routes: AppRoute[] = [
  // Admin
  { path: "/admin/e/:eventId/checkin", shell: "admin", render: () => <CheckInDesk /> },
  { path: "/admin/e/:eventId/checkin/badge/:attendeeId", shell: "admin", render: (p) => <BadgePrintPage eventId={Number(p.eventId)} attendeeId={Number(p.attendeeId)} /> },
  { path: "/admin/e/:eventId/attendees", shell: "admin", render: () => <AdminAttendees /> },
  { path: "/admin/e/:eventId/evaluations", shell: "admin", render: () => <AdminEvaluations /> },
  { path: "/admin/e/:eventId/evaluations/:evaluationId", shell: "admin", render: (p) => <AdminEvaluationEdit evaluationId={Number(p.evaluationId)} /> },
  { path: "/admin/e/:eventId/certificates", shell: "admin", render: () => <AdminCertificates /> },
  { path: "/admin/e/:eventId/certificates/:templateId", shell: "admin", render: (p) => <AdminCertificateEdit templateId={Number(p.templateId)} /> },
  { path: "/admin/e/:eventId/reports", shell: "admin", render: () => <AdminReports /> },
  { path: "/admin/e/:eventId/staff", shell: "admin", render: () => <AdminStaffRoles /> },

  // Attendee app
  { path: "/e/:slug/checkin/:sessionId", shell: "event", render: (p) => <SessionCheckIn sessionId={Number(p.sessionId)} /> },
  { path: "/e/:slug/eval/:sessionId", shell: "event", render: (p) => <EvaluationScreen sessionId={Number(p.sessionId)} /> },
  { path: "/e/:slug/credits", shell: "event", render: () => <CreditsScreen /> },
  { path: "/e/:slug/transcript", shell: "event", render: () => <TranscriptScreen /> },
  { path: "/e/:slug/badge", shell: "event", render: () => <MyBadgeScreen /> },

  // Public
  { path: "/cert/:code", shell: "public", render: (p) => <CertificatePage code={p.code} /> },
];
