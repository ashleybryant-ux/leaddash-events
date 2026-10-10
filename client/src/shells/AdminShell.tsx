/**
 * The admin frame: dark sidebar with the LEADDASH EVENTS wordmark, the main
 * nav, and the "This event" menu (only the areas the person may open).
 *
 * Event screens live at /admin/e/:eventId/<section>; organization screens at
 * /admin/<section>. Screens use useAdmin() for the organization, the event and
 * the person's access, and wrap their content in <AdminPage>.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { trpc, type RouterOutputs } from "../lib/trpc";
import { ErrorNote, PageLoading } from "../ui/components";
import { IconLeaf, IconMenu } from "../ui/icons";
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

type NavItem = { label: string; href: string; area?: Area; adminOnly?: boolean };

export function eventNav(eventId: number): NavItem[] {
  const b = `/admin/e/${eventId}`;
  return [
    { label: "Sessions", href: `${b}/sessions`, area: "sessions" },
    { label: "Speakers", href: `${b}/speakers`, area: "speakers" },
    { label: "Proposals", href: `${b}/proposals`, area: "proposals" },
    { label: "Registration", href: `${b}/registration`, area: "registration" },
    { label: "Attendees", href: `${b}/attendees`, area: "attendees" },
    { label: "Vendors", href: `${b}/vendors`, area: "vendors" },
    { label: "Evaluations", href: `${b}/evaluations`, area: "evaluations" },
    { label: "Certificates", href: `${b}/certificates`, area: "certificates" },
    { label: "Community", href: `${b}/community`, area: "community" },
    { label: "Announcements", href: `${b}/announcements`, area: "announcements" },
    { label: "Help", href: `${b}/help`, area: "help" },
    { label: "Dining", href: `${b}/dining`, adminOnly: true },
    { label: "About host", href: `${b}/host`, adminOnly: true },
    { label: "Branding", href: `${b}/branding`, adminOnly: true },
    { label: "Reports", href: `${b}/reports`, area: "reports" },
    { label: "Staff roles", href: `${b}/staff`, adminOnly: true },
    { label: "Event settings", href: `${b}/settings`, adminOnly: true },
  ];
}

export function AdminPage({ title, sub: subtitle, actions, children, banner }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; banner?: ReactNode }) {
  const { event, me, orgId } = useAdmin();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const orgs = me.orgs;
  const allOrgs = trpc.core.org.all.useQuery(undefined, { enabled: me.isLeadDashStaff });
  const orgName = (me.isLeadDashStaff ? allOrgs.data?.find((o) => o.id === orgId)?.name : undefined) ?? orgs.find((o) => o.id === orgId)?.name ?? "";
  const isActive = (href: string) => location === href || location.startsWith(`${href}/`);
  const main: NavItem[] = [
    { label: "Events", href: "/admin" },
    ...(event ? [{ label: "Check-in desk", href: `/admin/e/${event.id}/checkin` }] : []),
    ...(orgId && (orgs.some((o) => o.id === orgId) || me.isLeadDashStaff)
      ? [
          { label: "Membership", href: "/admin/members" },
          { label: "Divisions and committees", href: "/admin/divisions" },
          { label: "Documents", href: "/admin/documents" },
          { label: "Reports across programs", href: "/admin/insights" },
          { label: "Payments", href: "/admin/payments" },
          { label: "Settings", href: "/admin/settings" },
        ]
      : []),
  ];
  const mainActive = (href: string) => (href === "/admin" ? location === "/admin" || (location.startsWith("/admin/e/") && !location.endsWith("/checkin")) : isActive(href));
  const sub = event
    ? eventNav(event.id).filter((n) =>
        n.adminOnly
          ? event.access.admin
          : n.area
            ? event.access.areas[n.area] !== "none" || (n.area === "proposals" && event.access.kinds.includes("reviewer"))
            : true
      )
    : [];
  return (
    <div className="admin">
      <aside className={`admin-aside${open ? " open" : ""}`}>
        <Link href="/admin" className="wordmark">
          <IconLeaf />
          <span className="wordmark-text">
            <b>LEADDASH</b>
            <span>EVENTS</span>
          </span>
        </Link>
        {orgName ? <div className="small" style={{ color: "var(--side-muted)", padding: "0 12px", marginTop: -10 }}>{orgName}</div> : null}
        <nav aria-label="Main">
          {main.map((n) => (
            <Link key={n.href} href={n.href} aria-current={mainActive(n.href) ? "page" : undefined} onClick={() => setOpen(false)}>
              {n.label}
            </Link>
          ))}
        </nav>
        {sub.length ? (
          <nav aria-label="This event" className="sub">
            <span className="nav-label">This event</span>
            {sub.map((n) => (
              <Link key={n.href} href={n.href} aria-current={isActive(n.href) ? "page" : undefined} onClick={() => setOpen(false)}>
                {n.label}
              </Link>
            ))}
          </nav>
        ) : null}
        {me.isLeadDashStaff ? (
          <nav aria-label="LeadDash staff" className="sub">
            <span className="nav-label">LeadDash staff</span>
            <Link href="/admin/leaddash" aria-current={isActive("/admin/leaddash") ? "page" : undefined} onClick={() => setOpen(false)}>
              LeadDash tools
            </Link>
          </nav>
        ) : null}
        <div style={{ marginTop: "auto" }} className="small">
          <SignOut />
        </div>
      </aside>
      <main className="admin-main">
        <div className="row wrap" style={{ alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <button className="icon-btn admin-menu-btn" aria-label="Menu" onClick={() => setOpen(!open)}>
              <IconMenu />
            </button>
            <div className="col" style={{ gap: 2 }}>
              <div className="sub">{subtitle ?? (event ? `${event.name} · ${fmtDates(event.startDate, event.endDate)}` : orgName)}</div>
              <h1 className="h1">{title}</h1>
            </div>
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
    <button className="btn btn-ghost btn-sm" style={{ color: "var(--side-text)", padding: "0 12px" }} onClick={() => signOut.mutate()}>
      Sign out
    </button>
  );
}
