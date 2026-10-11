/**
 * The attendee app frame: event branding, the sign-in gate, the brand header
 * or back bar, and the bottom nav (Home, Agenda, People, Community, Messages).
 *
 * Screens are rendered inside <EventApp slug> (set up by the router) and use
 * useEventApp() for the event, the signed-in person and their attendee row.
 */
import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { trpc, type RouterOutputs } from "../lib/trpc";
import { PageLoading, ErrorNote } from "../ui/components";
import { IconBack, IconCalendar, IconChat, IconHouse, IconMail, IconPeople } from "../ui/icons";
import { BrandSignIn, EventWelcome, NotRegisteredCard } from "../core/EventWelcome";
import { fontHref, lookOf, themeVars, type BrandLike } from "@shared/brand";

type PublicEvent = RouterOutputs["core"]["events"]["publicBySlug"];
type Me = RouterOutputs["core"]["events"]["me"];

type Ctx = { slug: string; event: PublicEvent; me: Me; base: string };
const EventCtx = createContext<Ctx | null>(null);

export function useEventApp() {
  const ctx = useContext(EventCtx);
  if (!ctx) throw new Error("useEventApp must be used inside <EventApp>");
  return ctx;
}

/** Adds the stylesheet for an event font once (Plus Jakarta Sans is already loaded by index.html). */
export function loadBrandFont(branding: Partial<BrandLike>) {
  if (typeof document === "undefined") return;
  const font = lookOf(branding).font;
  const href = fontHref(font);
  if (!href || document.getElementById(`brand-font-${font}`)) return;
  const link = document.createElement("link");
  link.id = `brand-font-${font}`;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

/**
 * CSS variables for an event's look: colors, button text and shape, font,
 * page background, text size and header style. Put on the root of every
 * attendee-facing page.
 */
export function brandStyle(branding: BrandLike, coverUrl?: string | null): CSSProperties {
  loadBrandFont(branding);
  return themeVars(branding, coverUrl) as CSSProperties;
}

/** Points the browser at this event's install manifest (name, icon, start page). */
function useEventManifest(slug: string, color: string) {
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "manifest";
      document.head.appendChild(link);
    }
    link.href = `/e/${slug}/manifest.webmanifest`;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  }, [slug, color]);
}

/**
 * Gate for every attendee screen. `publicOk` screens (none by default) render
 * without sign-in; everything else needs a signed-in, registered person (or event staff).
 */
export function EventApp({ slug, children }: { slug: string; children: ReactNode }) {
  const event = trpc.core.events.publicBySlug.useQuery({ slug });
  const auth = trpc.auth.me.useQuery();
  const me = trpc.core.events.me.useQuery({ slug }, { enabled: !!auth.data });
  useEventManifest(slug, event.data?.branding.colorPrimary ?? "#1F5F4A");
  useEffect(() => {
    if (event.data) document.title = event.data.shortName;
  }, [event.data]);

  if (event.isLoading || auth.isLoading) return <PageLoading />;
  if (event.error) return <div className="app"><ErrorNote error={event.error} /></div>;
  const ev = event.data!;

  if (!auth.data) {
    return (
      <EventWelcome event={ev}>
        <BrandSignIn eventName={ev.shortName} />
      </EventWelcome>
    );
  }
  if (me.isLoading) return <PageLoading />;
  if (me.error) return <div className="app"><ErrorNote error={me.error} /></div>;
  const m = me.data!;
  const isStaff = m.staff.admin || Object.values(m.staff.areas).some((v) => v !== "none") || m.staff.kinds.length > 0;
  if (!m.attendee && !isStaff) {
    return (
      <EventWelcome event={ev} register={false}>
        <NotRegisteredCard email={auth.data.email} slug={ev.slug} />
      </EventWelcome>
    );
  }
  if (ev.status === "draft" && !isStaff) {
    return (
      <EventWelcome event={ev} register={false}>
        <div className="col" style={{ gap: 10 }}>
          <h2>The app opens soon</h2>
          <p>You are registered. We will let you know by email when the agenda is ready.</p>
        </div>
      </EventWelcome>
    );
  }
  return <EventCtx.Provider value={{ slug, event: ev, me: m, base: `/e/${slug}` }}>{children}</EventCtx.Provider>;
}

/** The tab to light up. "my" (My agenda) lights Agenda; "more" (pages opened from Home) lights Home. */
export type NavKey = "home" | "agenda" | "my" | "people" | "community" | "messages" | "more" | null;

/** Green header with the event's short name above the screen title. */
export function BrandHeader({ title, children, eyebrow }: { title: ReactNode; children?: ReactNode; eyebrow?: string }) {
  const { event } = useEventApp();
  return (
    <header className="app-header">
      <div className="col gap-4" style={{ gap: 2 }}>
        <div className="eyebrow">{eyebrow ?? event.shortName}</div>
        <div className="title">{title}</div>
      </div>
      {children}
    </header>
  );
}

/** White bar with a back button and a title. */
export function BackBar({ title, back, right }: { title: ReactNode; back?: string; right?: ReactNode }) {
  const { base } = useEventApp();
  const [, navigate] = useLocation();
  return (
    <header className="app-bar">
      <button className="icon-btn" aria-label="Back" onClick={() => (back ? navigate(back) : window.history.length > 1 ? window.history.back() : navigate(`${base}/home`))}>
        <IconBack />
      </button>
      <div className="title grow clip">{title}</div>
      {right}
    </header>
  );
}

export function AppScreen({ nav, header, footer, children, bodyStyle }: { nav?: NavKey; header?: ReactNode; footer?: ReactNode; children: ReactNode; bodyStyle?: CSSProperties }) {
  const { event } = useEventApp();
  return (
    <div className="app" style={brandStyle(event.branding, event.coverUrl)}>
      {header}
      <main className="app-body" style={bodyStyle}>
        {children}
      </main>
      {footer ? <div className="app-footer">{footer}</div> : null}
      {nav !== undefined && nav !== null ? <BottomNav active={nav} /> : nav === null ? <BottomNav active={null} /> : null}
    </div>
  );
}

export function BottomNav({ active }: { active: NavKey }) {
  const { base, event, slug } = useEventApp();
  const unread = trpc.network.unreadMessages.useQuery({ slug }, { refetchInterval: 30_000, enabled: event.features.messaging });
  const count = unread.data ?? 0;
  const lit = active === "my" ? "agenda" : active === "more" ? "home" : active;
  const items: { key: Exclude<NavKey, null>; label: string; href: string; icon: ReactNode; show?: boolean }[] = [
    { key: "home", label: "Home", href: `${base}/home`, icon: <IconHouse /> },
    { key: "agenda", label: "Agenda", href: `${base}/agenda`, icon: <IconCalendar /> },
    { key: "people", label: "People", href: `${base}/people`, icon: <IconPeople />, show: event.features.networking },
    { key: "community", label: "Community", href: `${base}/community`, icon: <IconChat />, show: event.features.community },
    { key: "messages", label: "Messages", href: `${base}/messages`, icon: <IconMail />, show: event.features.messaging },
  ];
  const shown = items.filter((i) => i.show !== false);
  return (
    <nav aria-label="Main" className="bottom-nav" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}>
      {shown.map((i) => (
        <Link key={i.key} href={i.href} aria-current={lit === i.key ? "page" : undefined}>
          {i.icon}
          {i.label}
          {i.key === "messages" && count > 0 ? <span className="badge-count">{count > 99 ? "99+" : count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** Signs out of the app and returns to the event's sign-in page. */
export function useAppSignOut() {
  const { slug } = useEventApp();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const m = trpc.auth.signOut.useMutation();
  return {
    pending: m.isPending,
    signOut: async () => {
      await m.mutateAsync();
      await utils.invalidate();
      navigate(`/e/${slug}`);
    },
  };
}
