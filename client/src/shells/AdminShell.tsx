/**
 * The admin frame: a dark sidebar with Find a page, the event card (name, dates,
 * switch events), Event home and the event's groups (only the group in use is
 * open), then the organization's pages. Breadcrumbs run across the top.
 *
 * Event screens live at /admin/e/:eventId/<section>; organization screens at
 * /admin/<section>. Screens use useAdmin() for the organization, the event and
 * the person's access, and wrap their content in <AdminPage>.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { trpc, type RouterOutputs } from "../lib/trpc";
import { ErrorNote, PageLoading } from "../ui/components";
import { IconAward, IconCalendar, IconChart, IconChevron, IconFolder, IconGear, IconHome, IconLeaf, IconMenu, IconMoney, IconPeople, IconPhone, IconSearch, IconSignOut, IconStar, IconTicket, IconTools } from "../ui/icons";
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

/** The organization's own pages. */
/** The organization's own pages. */
function orgPages(): (NavItem & { icon: ReactNode; short: string; related?: NavItem[] })[] {
  return [
    { label: "Events", short: "Events", href: "/admin", icon: <IconHome /> },
    { label: "Payments", short: "Payments", href: "/admin/payments", icon: <IconMoney /> },
    { label: "Organization settings", short: "Settings", href: "/admin/settings", icon: <IconGear /> },
  ];
}

const LAST_EVENT_KEY = "ld-events-last-event";
type LastEvent = { id: number; name: string; dates: string };
const readLastEvent = (): LastEvent | null => {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_EVENT_KEY) || "null");
    return v && typeof v.id === "number" ? v : null;
  } catch {
    return null;
  }
};

/** Whether the current address is this page (registration tabs count as their own pages). */
function useIsHere() {
  const [location] = useLocation();
  const search = useSearch();
  return (href: string) => {
    const [path, query] = href.split("?");
    if (query) {
      const want = new URLSearchParams(query).get("tab");
      const tab = new URLSearchParams(search).get("tab") ?? "tickets";
      return location === path && tab === want;
    }
    if (path === "/admin" || /^\/admin\/e\/\d+$/.test(path)) return location === path;
    return location === path || location.startsWith(`${path}/`);
  };
}

/** The event card at the top of the menu: name and dates, and a list to switch events. */
function EventSwitcher({ current, orgId, canList, onPick }: { current: LastEvent; orgId: number | null; canList: boolean; onPick: () => void }) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const events = trpc.core.events.list.useQuery({ orgId: orgId ?? 0 }, { enabled: canList && open && !!orgId });
  return (
    <div className="side-event" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
      <button type="button" className="side-event-btn" aria-haspopup="true" aria-expanded={open} onClick={() => (canList ? setOpen(!open) : navigate(`/admin/e/${current.id}`))}>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="side-event-name">{current.name}</span>
          <span className="side-event-dates">{current.dates}</span>
        </span>
        <IconChevron size={16} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 0.15s", flexShrink: 0 }} />
      </button>
      {open ? (
        <div className="side-event-menu" role="menu">
          {(events.data ?? []).map((e) => (
            <button
              key={e.id}
              type="button"
              role="menuitem"
              className={e.id === current.id ? "on" : ""}
              onClick={() => {
                setOpen(false);
                onPick();
                navigate(`/admin/e/${e.id}`);
              }}
            >
              <span className="strong">{e.name}</span>
              <span className="small muted">
                {fmtDates(e.startDate, e.endDate)}
                {e.status === "draft" ? " · Draft" : e.status === "ended" ? " · Ended" : ""}
              </span>
            </button>
          ))}
          {events.isLoading ? <span className="small muted" style={{ padding: 8 }}>Loading</span> : null}
          <button
            type="button"
            role="menuitem"
            className="all"
            onClick={() => {
              setOpen(false);
              onPick();
              navigate("/admin");
            }}
          >
            All events
          </button>
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
  const [location, navigate] = useLocation();
  const isHere = useIsHere();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const orgs = me.orgs;
  const allOrgs = trpc.core.org.all.useQuery(undefined, { enabled: me.isLeadDashStaff });
  const orgRow = (me.isLeadDashStaff ? allOrgs.data?.find((o) => o.id === orgId) : undefined) ?? orgs.find((o) => o.id === orgId);
  const orgName = orgRow?.name ?? "";
  const isOrgAdmin = !!orgId && (orgs.some((o) => o.id === orgId) || me.isLeadDashStaff);

  // Remember the last event opened so the menu can offer it on organization pages too.
  const current: LastEvent | null = event ? { id: event.id, name: event.name, dates: fmtDates(event.startDate, event.endDate) } : readLastEvent();
  useEffect(() => {
    if (!event) return;
    try {
      localStorage.setItem(LAST_EVENT_KEY, JSON.stringify({ id: event.id, name: event.name, dates: fmtDates(event.startDate, event.endDate) }));
    } catch {
      /* private window */
    }
  }, [event]);

  const org = isOrgAdmin ? orgPages() : [];
  const groups = event ? visibleGroups(event) : [];
  const group = groups.find((g) => g.items.some((i) => isHere(i.href)));
  const page = group?.items.find((i) => isHere(i.href));
  const orgPage = org.find((p) => isHere(p.href) || p.related?.some((r) => isHere(r.href)));
  const related = orgPage?.related?.find((r) => isHere(r.href));

  // The group you are working in stays open; click another group to open it instead.
  useEffect(() => {
    setOpenGroup(group?.key ?? null);
  }, [group?.key]);

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

  // Find a page: typing filters the menu and opens the groups that match.
  const needle = q.trim().toLowerCase();
  const match = (label: string, extra = "") => !needle || `${label} ${extra}`.toLowerCase().includes(needle);
  const shownGroups = groups.map((g) => ({ ...g, items: g.items.filter((i) => match(i.label, g.label)) })).filter((g) => g.items.length);
  const orgLinks = org.flatMap((p) => (p.related ? p.related.map((r, i) => ({ ...r, icon: i === 0 ? p.icon : <IconFolder />, label: r.label })) : [{ ...p }])).filter((p) => match(p.label));
  const firstHit = shownGroups[0]?.items[0]?.href ?? orgLinks[0]?.href;
  const clear = () => {
    setQ("");
    setOpen(false);
  };
  const go = (href: string) => {
    clear();
    navigate(href);
  };

  return (
    <div className="admin">
      <aside className={`admin-aside${open ? " open" : ""}`} aria-label="Main">
        <Link href={isOrgAdmin ? "/admin" : current ? `/admin/e/${current.id}` : "/admin"} className="wordmark" onClick={() => setOpen(false)}>
          <IconLeaf />
          <span className="wordmark-text">
            <b>LEADDASH</b>
            <span>EVENTS</span>
          </span>
        </Link>
        <label className="side-search">
          <IconSearch />
          <input
            aria-label="Find a page"
            placeholder="Find a page"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && firstHit) go(firstHit);
              if (e.key === "Escape") setQ("");
            }}
          />
        </label>

        {current && !needle ? <EventSwitcher current={current} orgId={orgId} canList={isOrgAdmin} onPick={() => setOpen(false)} /> : null}
        {event ? (
          <nav aria-label="This event" className="side-nav">
            {match("Event home") ? (
              <Link href={`/admin/e/${event.id}`} className="side-link" aria-current={location === `/admin/e/${event.id}` ? "page" : undefined} onClick={() => setOpen(false)}>
                <IconHome />
                Event home
              </Link>
            ) : null}
            {shownGroups.map((g) => {
              const expanded = !!needle || openGroup === g.key;
              return (
                <div key={g.key} className={`side-group${expanded ? " open" : ""}`}>
                  <button type="button" className="side-link" aria-expanded={expanded} onClick={() => setOpenGroup(expanded && !needle ? null : g.key)}>
                    {g.icon}
                    <span className="grow">{g.label}</span>
                    <IconChevron size={16} className="side-chev" />
                  </button>
                  {expanded ? (
                    <div className="side-kids">
                      {g.items.map((i) => (
                        <Link key={i.href} href={i.href} aria-current={isHere(i.href) ? "page" : undefined} onClick={clear}>
                          {i.label}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </nav>
        ) : null}

        {orgLinks.length ? (
          <nav aria-label="Organization" className="side-nav">
            <span className="nav-label">{orgName || "Organization"}</span>
            {orgLinks.map((p) => (
              <Link key={p.href} href={p.href} className="side-link" aria-current={isHere(p.href) ? "page" : undefined} onClick={clear}>
                {p.icon}
                {p.label}
              </Link>
            ))}
          </nav>
        ) : null}

        {me.isLeadDashStaff && match("LeadDash tools") ? (
          <nav aria-label="LeadDash staff" className="side-nav">
            <span className="nav-label">LeadDash staff</span>
            <Link href="/admin/leaddash" className="side-link" aria-current={isHere("/admin/leaddash") ? "page" : undefined} onClick={clear}>
              <IconTools />
              LeadDash tools
            </Link>
          </nav>
        ) : null}
        {needle && !firstHit && !match("LeadDash tools") ? <span className="small" style={{ color: "var(--side-muted)", padding: "0 12px" }}>No page matches.</span> : null}

        <div style={{ marginTop: "auto" }}>
          <SignOut />
        </div>
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
        </div>
        <div className="row wrap" style={{ alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
          <div className="col" style={{ gap: 2 }}>
            <div className="sub">{subtitle ?? (event ? `${event.name} · ${fmtDates(event.startDate, event.endDate)}` : orgName)}</div>
            <h1 className="h1">{title}</h1>
          </div>
          {actions ? <div className="row wrap gap-10">{actions}</div> : null}
        </div>
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
    <button type="button" className="side-link" onClick={() => signOut.mutate()}>
      <IconSignOut />
      Sign out
    </button>
  );
}
