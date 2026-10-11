# LeadDash Events

A conference app sold as LeadDash Events (first customer: NABC). Each event brands its attendee app. Node + Express + tRPC server, SQLite (Drizzle), React client (Vite), installable web app (PWA) with web push. Runs on the LeadDash Employees server as its own PM2 process (`leaddash-events`, port 4200) at https://events.leaddash.io.

## Commands
- Install: `npm ci`
- Type check: `npm run check`
- Tests: `npm test` (Vitest). One area: `npx vitest run tests/<area>`
- Build: `npm run build`
- Database changes: edit `drizzle/schema/*.ts`, then `npx drizzle-kit generate --name <what_changed>` and commit the migration.

## Where things are
- `drizzle/schema/`: every table. `core.ts` (associations, people, events, files, staff roles, push, platform), `registration.ts` (tickets, attendees, orders, Stripe, messages), `program.ts` (sessions, speakers, agenda, announcements, dining, help, About host people), `ce.ts` (evaluations, check-ins, certificates), `network.ts` (messages, meetings, community, vendors, leads, maps, polls, proposals, event photos), `sponsor.ts` (sponsor and exhibitor packages, add-ons, vendor payments, sponsor/exhibitor checkout pages and checkouts, agreement templates and agreements, session slide files, recipient log).
- `server/_core/`: env, db, auth context, access rules (`access.ts`), email (SES), push (`notify()`), files, LeadDash platform outbox (`platform.ts`), scheduler.
- `server/core/`: sign-in (`auth.ts`) and association/event/file/push routes (`router.ts`).
- `server/areas/<area>/index.ts`: each feature area's tRPC router, defaults for new events (`seedEvent`), minute jobs, and plain HTTP routes. `agreements` holds agreement templates, signing and the signed PDF (pdf-lib). Vendor checkout and scheduled vendor charges are `registration/vendorCheckout.ts` and `vendorCharges.ts`; speaker and vendor welcome emails are `registration/recipientMessages.ts`; slides are `program/slides.ts`.
- `client/src/shells/`: `AttendeeShell` (event app frame, `useEventApp()`), `AdminShell` (`useAdmin()`, `<AdminPage>`, the sidebar with Find a page and the event switcher, breadcrumbs, and `eventGroups()`: every event page and its group).
- `client/src/ui/`: `theme.css` (design system), `components.tsx` (EditSection, ExpandRow, Sheet, Avatar, QR, UploadButton...), `icons.tsx`, `toast.tsx`.
- `client/src/areas/<area>/routes.tsx`: the area's screens (path, shell, render).
- `shared/format.ts` (dates with the year, money, names), `shared/time.ts` (event local times to real moments), `shared/address.ts` (venue address lines, Google Maps links and the map preview URL, US states).
- `deploy.sh`: the owner runs it on the server. Never deploy anything yourself.

## Rules
- American English. Never use em dashes or en dashes in anything users read (or in code comments).
- Screen copy is short and plain. Buttons fit on one line (shorten the label). Dates include the year ("Apr 22, 2027", "Oct 9, 2026").
- Sections show values read-only with an Edit button; Edit opens compact fields with Save and Cancel (`EditSection`). No click-to-edit. A value that depends on a choice shows right away in the same editor.
- List rows expand in place below the row (`ExpandRow`). Row action buttons are the same width (`btn btn-sm btn-w`) and line up in one column; no underlined text links mixed in with buttons.
- Category filters on busy admin tabs use folder tabs (`FolderTabs`), not chip rows. Dates of birth are never asked. Typed dates are plain text or native date inputs, never custom wheels.
- No cream or amber page backgrounds; pages use #F8FAFB. Amber pills and bars are fine.
- Show real names, never ids, wherever the app says who did something.
- Admin menu: a dark sidebar with icons. Find a page at the top, then the event card (name, dates, switch events), Event home, and the event's groups (Program, Tickets and sales, People, CE, In the app, Setup) that open and close, only the group in use open; then the organization's pages. A new event page goes into `eventGroups()` in its group. Pages for features an event turned off stay out of the menu.
- Organization screens look exactly as the organization sees them. LeadDash staff-only tools live on `/admin/leaddash`, never mixed into organization pages.
- Screens say "organization", never "association". Placeholders and sample text are generic: never a customer's real name or details (no NABC).
- The LeadDash Events wordmark stays in the admin. An event's own logo and colors appear only on attendee-facing pages (the app, checkout page, emails, badges, certificates).
- Every route checks access with `server/_core/access.ts` helpers. Attendees only see their own data. Staff see what their role allows.
- Events only: no membership, dues, member directory or member hub. Members tickets ask for a member ID; the organization checks it in its own membership system.
- Uploads: images and documents go through tRPC (15 MB); slide decks stream to `/api/upload/session-file` (100 MB). nginx `client_max_body_size` must stay at least 110m.
- Never commit keys, passwords or `.env`. No client or patient health information anywhere.
- Keep changes small and in the style of the code around them. Add or update a test for what you change.

## Route map (links between areas must use these)
Attendee app (`/e/:slug`): `` (welcome; signed-in people go to Home) · `/home` (Home tab) · `/agenda` · `/my` · `/session/:sessionId` · `/speakers` · `/alerts` · `/more` · `/dining` · `/nearby` · `/host` · `/help` · `/lost-found` · `/checkin/:sessionId` · `/eval/:sessionId` · `/credits` · `/transcript` · `/badge` · `/people` · `/people/:attendeeId` · `/profile` · `/messages` · `/messages/:threadId` · `/meet/:attendeeId` · `/community` · `/community/new` · `/community/:channelId` · `/exhibitors` · `/exhibitors/:vendorId` · `/map` · `/poll/:sessionId` · `/leads` · `/photos`

Public: `/r/:slug` (checkout page) · `/r/:slug/register` · `/r/:slug/pay` · `/r/:slug/done` · `/r/:slug/sponsor` · `/r/:slug/sponsor/done` · `/r/:slug/sponsor/pay` · `/r/:slug/exhibit` · `/r/:slug/exhibit/done` · `/r/:slug/exhibit/pay` · `/sign/:code` (sign an agreement) · `/agreement/:code` (signed copy, `/pdf`) · `/speak/:token` (speaker page: slides, bio, agreement) · `/embed/:slug` · `/embed.js` · `/get/:slug` (get the app) · `/cfp/:slug` (submit a proposal) · `/cert/:code` (certificate and check)

Admin event (`/admin/e/:eventId`): `` (event home) · `/sessions` · `/sessions/:sessionId` · `/speakers` · `/speakers/:speakerId` · `/announcements` · `/help` · `/dining` · `/host` · `/branding` · `/registration?tab=tickets|checkout|welcome|payments` (checkout and welcome take `&who=sponsors|exhibitors|speakers`) · `/checkin` · `/attendees` · `/evaluations` · `/evaluations/:evaluationId` · `/certificates` · `/certificates/:templateId` · `/reports` · `/staff` · `/agreements?open=<template id or kind>` (sponsor, exhibitor and speaker agreements; every event starts with all three) · `/proposals` · `/vendors?tab=sponsors|exhibitors|packages|addons|map` (Sponsors and exhibitors) · `/vendors/:vendorId` · `/community` · `/photos` · `/settings`

Admin association (`/admin`): `` (events) · `/settings` · `/payments` · `/leaddash` (LeadDash staff tools)
