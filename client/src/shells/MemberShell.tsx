/**
 * The member hub frame (association branded): sign-in gate, the membership
 * gate, and the bottom nav (Home, My card, Events, Documents). Screens use
 * useMemberApp(). Lapsed members still get in: their card shows lapsed with
 * a renew prompt, and member content stays closed on the server.
 */
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { trpc, type RouterOutputs } from "../lib/trpc";
import { ErrorNote, PageLoading } from "../ui/components";
import { IconCalendar, IconCard, IconFolder, IconHome } from "../ui/icons";
import { SignIn } from "../core/SignIn";
import { brandStyle } from "./AttendeeShell";

type Org = RouterOutputs["core"]["org"]["publicBySlug"];
type Me = NonNullable<RouterOutputs["member"]["hub"]["me"]>;
type Ctx = { orgSlug: string; org: Org; base: string; member: Me; email: string };
const MemberCtx = createContext<Ctx | null>(null);

export function useMemberApp() {
  const ctx = useContext(MemberCtx);
  if (!ctx) throw new Error("useMemberApp must be used inside <MemberApp>");
  return ctx;
}

export function MemberApp({ orgSlug, children }: { orgSlug: string; children: ReactNode }) {
  const org = trpc.core.org.publicBySlug.useQuery({ slug: orgSlug });
  const auth = trpc.auth.me.useQuery();
  const me = trpc.member.hub.me.useQuery({ orgSlug }, { enabled: !!auth.data && !!org.data });
  useEffect(() => {
    if (org.data) document.title = `${org.data.name} Member`;
  }, [org.data]);
  if (org.isLoading || auth.isLoading) return <PageLoading />;
  if (org.error) return <div className="app"><ErrorNote error={org.error} /></div>;
  const o = org.data!;
  const style = brandStyle({ colorPrimary: o.colorPrimary, colorAccent: o.colorAccent });
  if (!auth.data) {
    return (
      <div className="app" style={style}>
        <header className="app-header">
          <div className="col" style={{ gap: 2 }}>
            <div className="eyebrow">{o.name} Member</div>
            <div className="title">Member hub</div>
          </div>
        </header>
        <div className="app-body">
          <SignIn title="Sign in" subtitle="Enter the email on your membership. We will send you a six-digit code." eventName={o.name} />
        </div>
      </div>
    );
  }
  if (me.isLoading) return <PageLoading />;
  if (me.error) return <div className="app" style={style}><ErrorNote error={me.error} /></div>;
  if (!me.data) return <NotAMember orgName={o.name} email={auth.data.email} style={style} />;
  return <MemberCtx.Provider value={{ orgSlug, org: o, base: `/m/${orgSlug}`, member: me.data, email: auth.data.email }}>{children}</MemberCtx.Provider>;
}

/** Signed in, but the email is not on the association's member list. */
function NotAMember({ orgName, email, style }: { orgName: string; email: string; style: ReturnType<typeof brandStyle> }) {
  const utils = trpc.useUtils();
  const [location, navigate] = useLocation();
  const signOut = trpc.auth.signOut.useMutation({
    onSuccess: async () => {
      await utils.invalidate();
      navigate(location);
    },
  });
  return (
    <div className="app" style={style}>
      <header className="app-header">
        <div className="col" style={{ gap: 2 }}>
          <div className="eyebrow">{orgName} Member</div>
          <div className="title">Member hub</div>
        </div>
      </header>
      <div className="app-body">
        <div className="card card-pad col gap-12">
          <span className="h3">We could not find a membership for {email}</span>
          <span className="muted">Sign in with the email on your membership.</span>
          <button className="btn btn-block" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export type MemberNav = "home" | "card" | "events" | "docs";

export function MemberScreen({ nav, header, children }: { nav?: MemberNav; header?: ReactNode; children: ReactNode }) {
  const { org, base } = useMemberApp();
  const items = [
    { key: "home", label: "Home", href: base, icon: <IconHome /> },
    { key: "card", label: "My card", href: `${base}/card`, icon: <IconCard /> },
    { key: "events", label: "Events", href: `${base}/events`, icon: <IconCalendar /> },
    { key: "docs", label: "Documents", href: `${base}/docs`, icon: <IconFolder /> },
  ];
  return (
    <div className="app" style={brandStyle({ colorPrimary: org.colorPrimary, colorAccent: org.colorAccent })}>
      {header}
      <main className="app-body">{children}</main>
      {nav ? (
        <nav aria-label="Member" className="bottom-nav" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          {items.map((i) => (
            <Link key={i.key} href={i.href} aria-current={nav === i.key ? "page" : undefined}>
              {i.icon}
              {i.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
