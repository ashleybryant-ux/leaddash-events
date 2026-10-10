/**
 * The admin frame: a slim icon menu (Event, Events, Payments, Reports, Members,
 * Settings), breadcrumbs and Find a page across the top, and on event screens
 * an Event home button with the other pages in the same group.
 *
 * Event screens live at /admin/e/:eventId/<section>; organization screens at
 * /admin/<section>. Screens use useAdmin() for the organization, the event and
 * the person's access, and wrap their content in <AdminPage>.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { trpc, type RouterOutputs } from "../lib/trpc";
import { ErrorNote, PageLoading } from "../ui/components";
import { IconAward, IconBack, IconCalendar, IconChart, IconGear, IconHome, IconLeaf, IconMenu, IconMoney, IconPeople, IconPhone, IconSearch, IconSignOut, IconStar, IconTicket, IconTools } from "../ui/icons";
import { SignIn } from "../core/SignIn";
import { fmtDates } from "@shared/format";

type Me = NonNullable<RouterOutputs["auth"]["me"]>;
type AdminEvent = RouterOutputs["core"]["events"]["get"];
type Area = keyof AdminEvent["access"]["areas"];

type Ctx = { me: Me; orgId: number | null; event: AdminEvent | null; setOrgId: (id: number) => void; can: (area: Area, level?: "view" | "edit") => boolean };
const AdminCtx = createContext<Ctx | null>(null);

export function useAdmin() {
  const ctx = useContext(AdminCtx);
  if (!ctx) throw new Error("useAdmin must be used inside <AdminApp>");
  return ctx;
}

/** The event (throws if the screen is not inside an event). */
export function useAdminEvent() {
  const { event } = useAdmin();
  if (!event) throw new Error("This screen needs an event");
  return event;
}

const ORG_KEY = "ld-events-org";

export function AdminApp({ eventId, children }: { eventId?: number; children: ReactNode }) {
  const auth = trpc.auth.me.useQuery();
  const event = trpc.core.events.get.useQuery({ eventId: eventId ?? 0 }, { enabled: !!auth.data && !!eventId });
  const [orgId, setOrgIdState] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem(ORG_KEY);
      return v ? Number(v) : null;
    } catch {
      return null;
    }
  });
  const setOrgId = (id: number) => {
    setOrgIdState(id);
    try {
      localStorage.setItem(ORG_KEY, String(id));
    } catch {
      /* private window */
    }
  };
  useEffect(() => {
    document.title = "LeadDash Events";
    document.querySelector('link[rel="manifest"]')?.remove();
  }, []);

  if (auth.isLoading || (eventId && event.isLoading)) return <PageLoading />;
  if (!auth.data) {
    return (
      <div className="center" style={{ minHeight: "100dvh", padding: 16 }}>
        <div className="card card-pad" style={{ width: "100%", maxWidth: 420, padding: 28 }}>
          <div className="row" style={{ marginBottom: 18 }}>
            <IconLeaf />
            <div className="wordmark-text" style={{ color: "var(--ink)" }}>
              <b>LEADDASH</b>
              <span>EVENTS</span>
            </div>
          </div>
          <SignIn title="Admin sign-in" subtitle="Enter your email. We will send you a six-digit code." variant="admin" />
        </div>
      </div>
    );
  }
  if (eventId && event.error) return <div className="admin-main"><ErrorNote error={event.error} /></div>;
  const ev = eventId ? event.data ?? null : null;
  const known = auth.data.orgs.map((o) => o.id);
  const resolvedOrg = ev?.orgId ?? (orgId && (known.includes(orgId) || auth.data.isLeadDashStaff) ? orgId : known[0] ?? null);
  const can = (area: Area, level: "view" | "edit" = "view") => {
    if (!ev) return false;
    const v = ev.access.areas[area];
    return level === "view" ? v !== "none" : v === "edit";
  };
  return <AdminCtx.Provider value={{ me: auth.data, orgId: resolvedOrg, event: ev, setOrgId, can }}>{children}</AdminCtx.Provider>;
}

type NavItem = { label: string; href: string; area?: Area; adminOnly?: boolean; feature?: keyof AdminEvent["features"]; reviewerOk?: boolean };
export type NavGroup = { key: string; label: string; icon: ReactNode; items: NavItem[] };

/** The event's pages, grouped by job. Links between areas use the route map in CLAUDE.md. */
export function eventGroups(eventId: number): NavGroup[] {
  const b = `/admin/e/${eventId}`;
  return [
    { key: "program", label: "Program", icon: <IconCalendar />, items: [
      { label: "Sessions", href: `${b}/sessions`, area: "sessions" },
      { label: "Speakers", href: `${b}/speakers`, area: "speakers" },
      { label: "Proposals", href: `${b}/proposals`, area: "proposals", reviewerOk: true },
    ] },
    { key: "tickets", label: "Tickets and sales", icon: <IconTicket />, items: [
      { label: "Tickets", href: `${b}/registration?tab=tickets`, area: "registration" },
      { label: "Sales and payments", href: `${b}/registration?tab=payments`, area: "registration" },
      { label: "Checkout page", href: `${b}/registration?tab=checkout`, area: "registration" },
      { label: "Welcome email", href: `${b}/registration?tab=welcome`, area: "registration" },
    ] },
    { key: "people", label: "People", icon: <IconPeople />, items: [
      { label: "Attendees", href: `${b}/attendees`, area: "attendees" },
      { label: "Check-in desk", href: `${b}/checkin`, area: "checkin" },
      { label: "Staff roles", href: `${b}/staff`, adminOnly: true },
    ] },
    { key: "ce", label: "CE", icon: <IconAward />, items: [
      { label: "Evaluations", href: `${b}/evaluations`, area: "evaluations" },
      { label: "Certificates", href: `${b}/certificates`, area: "certificates" },
    ] },
    { key: "app", label: "In the app", icon: <IconPhone />, items: [
      { label: "Announcements", href: `${b}/announcements`, area: "announcements" },
      { label: "Community", href: `${b}/community`, area: "community", feature: "community" },
      { label: "Vendors", href: `${b}/vendors`, area: "vendors", feature: "exhibitors" },
      { label: "Help", href: `${b}/help`, area: "help" },
      { label: "Dining", href: `${b}/dining`, adminOnly: true, feature: "dining" },
      { label: "About host", href: `${b}/host`, adminOnly: true },
    ] },
    { key: "setup", label: "Setup", icon: <IconGear />, items: [
      { label: "Branding", href: `${b}/branding`, adminOnly: true },
      { label: "Reports", href: `${b}/reports`, area: "reports" },
      { label: "Event settings", href: `${b}/settings`, adminOnly: true },
    ] },
  ];
}

/** The groups and pages this person may open: their role's areas, and only features the event has turned on. */
export function visibleGroups(event: AdminEvent): NavGroup[] {
  const ok = (n: NavItem) => {
    if (n.feature && !event.features[n.feature]) return false;
    if (n.adminOnly) return event.access.admin;
    if (n.area) return event.access.areas[n.area] !== "none" || (!!n.reviewerOk && event.access.kinds.includes("reviewer"));
    return true;
  };
  return eventGroups(event.id)
    .map((g) => ({ ...g, items: g.items.filter(ok) }))
    .filter((g) => g.items.length);
}

/** The organization's own pages (Members and its pages only when the organization uses the member hub). */
function orgPages(memberHub: boolean): (NavItem & { icon: ReactNode; short: string; related?: NavItem[] })[] {
  const member = [
    { label: "Members", href: "/admin/members" },
    { label: "Divisions and committees", href: "/admin/divisions" },
    { label: "Documents", href: "/admin/documents" },
  ];
  return [
    { label: "Events", short: "Events", href: "/admin", icon: <IconHome /> },
    { label: "Payments", short: "Payments", href: "/admin/payments", icon: <IconMoney /> },
    { label: "Organization reports", short: "Reports", href: "/admin/insights", icon: <IconChart /> },
    ...(memberHub ? [{ label: "Members", short: "Members", href: "/admin/members", icon: <IconStar />, related: member }] : []),
    { label: "Organization settings", short: "Settings", href: "/admin/settings", icon: <IconGear /> },
  ];
}

const LAST_EVENT_KEY = "ld-events-last-event";
const readLastEvent = () => {
  try {
    const v = localStorage.getItem(LAST_EVENT_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
};

/** Whether the current address is this page (registration tabs count as their own pages). */
function useIsHere() {
  const [location] = useLocation();
  const search = useSearch();
  return (href: string, exact = false) => {
    const [path, query] = href.split("?");
    if (query) {
      const want = new URLSearchParams(query).get("tab");
      const tab = new URLSearchParams(search).get("tab") ?? "tickets";
      return location === path && tab === want;
    }
    if (exact || path === "/admin") return location === path;
    return location === path || location.startsWith(`${path}/`);
  };
}

/** Find a page: type part of a page's name and pick it. */
function FindPage({ pages }: { pages: { label: string; where: string; href: string }[] }) {
  const [, navigate] = useLocation();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const hits = q.trim() ? pages.filter((p) => `${p.label} ${p.where}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];
  const go = (href: string) => {
    setQ("");
    setOpen(false);
    navigate(href);
  };
  return (
    <div className="find-page" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
      <IconSearch />
      <input
        aria-label="Find a page"
        placeholder="Find a page"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) go(hits[0].href);
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && hits.length ? (
        <div className="find-hits" role="listbox">
          {hits.map((h) => (
            <button key={h.href} type="button" role="option" aria-selected={false} onClick={() => go(h.href)}>
              <span className="strong">{h.label}</span>
              <span className="small muted">{h.where}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type Crumb = { label: string; href?: string };

export function AdminPage({ title: givenTitle, sub: givenSub, actions, children, banner }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; banner?: ReactNode }) {
  let title = givenTitle;
  let subtitle = givenSub;
  const { event, me, orgId } = useAdmin();
  const [location] = useLocation();
  const isHere = useIsHere();
  const [open, setOpen] = useState(false);
  const orgs = me.orgs;
  const allOrgs = trpc.core.org.all.useQuery(undefined, { enabled: me.isLeadDashStaff });
  const orgRow = (me.isLeadDashStaff ? allOrgs.data?.find((o) => o.id === orgId) : undefined) ?? orgs.find((o) => o.id === orgId);
  const orgName = orgRow?.name ?? "";
  const memberHub = orgRow ? orgRow.memberHub !== false : true;
  const isOrgAdmin = !!orgId && (orgs.some((o) => o.id === orgId) || me.isLeadDashStaff);

  // Keep the last event opened so the Event button stays in the menu on organization pages.
  useEffect(() => {
    if (!event) return;
    try {
      localStorage.setItem(LAST_EVENT_KEY, String(event.id));
    } catch {
      /* private window */
    }
  }, [event]);
  const lastEventId = event?.id ?? readLastEvent();

  const org = isOrgAdmin ? orgPages(memberHub) : [];
  const groups = event ? visibleGroups(event) : [];
  const eventHome = event ? `/admin/e/${event.id}` : lastEventId ? `/admin/e/${lastEventId}` : null;
  const onEventPage = location.startsWith("/admin/e/");

  // Where am I: the group and page for event screens, the page for organization screens.
  const group = groups.find((g) => g.items.some((i) => isHere(i.href)));
  const page = group?.items.find((i) => isHere(i.href));
  const orgPage = org.find((p) => isHere(p.href) || p.related?.some((r) => isHere(r.href)));
  const related = orgPage?.related?.find((r) => isHere(r.href));

  // Older event screens use the event's name as their title; the page's own name reads better.
  if (event && page && title === event.name) {
    title = page.label;
    subtitle = undefined;
  }

  const crumbs: Crumb[] = [];
  if (orgName) crumbs.push({ label: orgName, href: isOrgAdmin ? "/admin" : undefined });
  if (event) {
    if (isOrgAdmin) crumbs.push({ label: "Events", href: "/admin" });
    const home = `/admin/e/${event.id}`;
    const atHome = location === home;
    crumbs.push({ label: event.name, href: atHome ? undefined : home });
    if (page) {
      const [path] = page.href.split("?");
      const deeper = location !== path;
      crumbs.push({ label: page.label, href: deeper ? page.href : undefined });
      if (deeper && typeof title === "string") crumbs.push({ label: title });
    } else if (!atHome && typeof title === "string") crumbs.push({ label: title });
  } else if (orgPage) {
    crumbs.push({ label: related && related.href !== orgPage.href ? related.label : orgPage.label });
  } else if (typeof title === "string") crumbs.push({ label: title });

  const findPages = [
    ...groups.flatMap((g) => g.items.map((i) => ({ label: i.label, where: `${event!.name} · ${g.label}`, href: i.href }))),
    ...(event ? [{ label: "Event home", where: event.name, href: `/admin/e/${event.id}` }] : []),
    ...org.flatMap((p) => (p.related ?? [p]).map((r) => ({ label: r.label, where: orgName || "Organization", href: r.href }))),
    ...(me.isLeadDashStaff ? [{ label: "LeadDash tools", where: "LeadDash staff", href: "/admin/leaddash" }] : []),
  ];

  const rail: { key: string; label: string; href: string; icon: ReactNode; on: boolean }[] = [
    ...(eventHome ? [{ key: "event", label: "Event", href: eventHome, icon: <IconCalendar />, on: onEventPage }] : []),
    ...org.map((p) => ({ key: p.href, label: p.short, href: p.href, icon: p.icon, on: !onEventPage && p === orgPage })),
    ...(me.isLeadDashStaff ? [{ key: "staff", label: "LeadDash", href: "/admin/leaddash", icon: <IconTools />, on: isHere("/admin/leaddash") }] : []),
  ];

  return (
    <div className="admin">
      <aside className={`admin-rail${open ? " open" : ""}`} aria-label="Main">
        <Link href={isOrgAdmin ? "/admin" : eventHome ?? "/admin"} className="rail-logo" aria-label="LeadDash Events home">
          <IconLeaf />
          <span className="rail-word">
            <b>LEADDASH</b>
            <span>EVENTS</span>
          </span>
        </Link>
        <nav>
          {rail.map((r) => (
            <Link key={r.key} href={r.href} aria-current={r.on ? "page" : undefined} onClick={() => setOpen(false)}>
              {r.icon}
              <span>{r.label}</span>
            </Link>
          ))}
        </nav>
        <SignOut />
      </aside>
      <main className="admin-main">
        <div className="admin-top">
          <button className="icon-btn admin-menu-btn" aria-label="Menu" onClick={() => setOpen(!open)}>
            <IconMenu />
          </button>
          <nav aria-label="Breadcrumb" className="crumbs">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="row" style={{ gap: 8 }}>
                {i ? <span className="crumb-sep">›</span> : null}
                {c.href && i < crumbs.length - 1 ? <Link href={c.href}>{c.label}</Link> : <span className="crumb-here">{c.label}</span>}
              </span>
            ))}
          </nav>
          <FindPage pages={findPages} />
        </div>
        <div className="row wrap" style={{ alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
          <div className="col" style={{ gap: 2 }}>
            <div className="sub">{subtitle ?? (event ? `${event.name} · ${fmtDates(event.startDate, event.endDate)}` : orgName)}</div>
            <h1 className="h1">{title}</h1>
          </div>
          {actions ? <div className="row wrap gap-10">{actions}</div> : null}
        </div>
        {event && group ? (
          <div className="row wrap gap-8">
            <Link className="btn btn-sm" href={`/admin/e/${event.id}`}>
              <IconBack size={16} /> Event home
            </Link>
            <span className="page-tabs" role="navigation" aria-label={group.label}>
              {group.items.map((i) => (
                <Link key={i.href} href={i.href} aria-current={isHere(i.href) ? "page" : undefined}>
                  {i.label}
                </Link>
              ))}
            </span>
          </div>
        ) : orgPage?.related ? (
          <span className="page-tabs" role="navigation" aria-label={orgPage.label}>
            {orgPage.related.map((r) => (
              <Link key={r.href} href={r.href} aria-current={isHere(r.href) ? "page" : undefined}>
                {r.label}
              </Link>
            ))}
          </span>
        ) : null}
        {banner}
        {children}
      </main>
    </div>
  );
}

/** The usual subtitle for event screens: "Annual Conference · Apr 22, 2027 to Apr 24, 2027". */
export function useEventSub() {
  const { event } = useAdmin();
  return event ? `${event.name} · ${fmtDates(event.startDate, event.endDate)}` : "";
}

function SignOut() {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const signOut = trpc.auth.signOut.useMutation({
    onSuccess: async () => {
      await utils.invalidate();
      navigate("/admin");
    },
  });
  return (
    <button type="button" className="rail-signout" onClick={() => signOut.mutate()}>
      <IconSignOut />
      <span>Sign out</span>
    </button>
  );
}
