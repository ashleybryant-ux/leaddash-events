/** Attendee app: alerts, More, dining, About your host, help center, lost and found. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { trpc } from "../../lib/trpc";
import { AppScreen, BrandHeader, useEventApp } from "../../shells/AttendeeShell";
import { Empty, ErrorNote, Field, PageLoading, Pill, Sheet, CloseButton } from "../../ui/components";
import { PushToggle } from "../../ui/PushToggle";
import {
  IconAward, IconBadge, IconBell, IconChevron, IconClock, IconFood, IconHelp, IconInfo, IconMap, IconMessage, IconPeople, IconPin, IconQr, IconSearch, IconStore, IconUser, IconFolder,
} from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { eachDay, fmtDayDate, fmtRange, fmtTime, fmtWhen } from "@shared/format";
import { Chip, PoweredBy, Segmented, TopBar } from "./shared";

/* ---------------- Alerts ---------------- */

function alertIcon(kind: string) {
  if (kind === "change") return { icon: <IconPin size={20} />, bg: "var(--warn-bg)", fg: "var(--warn-ink)" };
  if (kind === "reminder") return { icon: <IconClock size={20} />, bg: "var(--brand-tint)", fg: "var(--brand)" };
  if (kind.startsWith("cert") || kind.startsWith("eval")) return { icon: <IconAward size={20} />, bg: "var(--brand-tint)", fg: "var(--brand)" };
  if (kind.startsWith("help") || kind === "lost_found") return { icon: <IconHelp size={20} />, bg: "var(--brand-tint)", fg: "var(--brand)" };
  if (kind.startsWith("message")) return { icon: <IconMessage size={20} />, bg: "var(--brand-tint)", fg: "var(--brand)" };
  return { icon: <IconBell size={20} />, bg: "var(--brand-tint)", fg: "var(--brand)" };
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** /e/:slug/alerts */
export function AlertsScreen() {
  const { slug, event, me } = useEventApp();
  const utils = trpc.useUtils();
  const list = trpc.core.notifications.list.useQuery({ eventId: event.id });
  const markRead = trpc.core.notifications.markRead.useMutation();
  const prefs = trpc.program.alerts.prefs.useQuery({ slug }, { enabled: !!me.attendee });
  const setPrefs = trpc.program.alerts.setPrefs.useMutation();
  const marked = useRef(false);

  useEffect(() => {
    const unread = (list.data ?? []).filter((n) => !n.readAt).map((n) => n.id);
    if (!unread.length || marked.current) return;
    marked.current = true;
    markRead.mutateAsync({ ids: unread }).then(() => utils.core.events.me.invalidate()).catch(() => undefined);
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const today = localDay(new Date());
    const out: { label: string; items: NonNullable<typeof list.data> }[] = [];
    for (const n of list.data ?? []) {
      const d = new Date(n.createdAt);
      const label = localDay(d) === today ? "Today" : fmtDayDate(localDay(d));
      const g = out.find((o) => o.label === label);
      if (g) g.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [list.data]);

  const p = prefs.data;
  const toggle = async (key: "reminders" | "evaluations" | "changes" | "announcements", value: boolean) => {
    if (!p) return;
    try {
      await setPrefs.mutateAsync({ slug, ...p, [key]: value });
      await utils.program.alerts.prefs.invalidate({ slug });
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  const rows: { key: "reminders" | "evaluations" | "changes" | "announcements"; label: string }[] = [
    { key: "reminders", label: "Session reminders" },
    { key: "evaluations", label: "Evaluation ready" },
    { key: "changes", label: "Room and time changes" },
    { key: "announcements", label: `Announcements from ${event.orgName}` },
  ];

  return (
    <AppScreen nav={null} header={<BrandHeader title="Alerts" eyebrow={event.name} />}>
      {p ? (
        <div className="card col" style={{ padding: 14, gap: 12 }}>
          <div className="strong" style={{ fontSize: 14, fontWeight: 800 }}>Push notifications</div>
          {rows.map((r) => (
            <label key={r.key} className="row-between" style={{ fontSize: 14 }}>
              {r.label}
              <input type="checkbox" checked={p[r.key]} disabled={setPrefs.isPending} onChange={(e) => toggle(r.key, e.target.checked)} style={{ width: 22, height: 22, accentColor: "var(--brand)" }} />
            </label>
          ))}
        </div>
      ) : null}
      {list.isLoading ? <PageLoading /> : list.error ? <ErrorNote error={list.error} /> : !groups.length ? <Empty>No alerts yet.</Empty> : null}
      {groups.map((g) => (
        <div key={g.label} className="col gap-10">
          <div className="section-title" style={{ paddingTop: 6 }}>{g.label}</div>
          {g.items.map((n) => {
            const ic = alertIcon(n.kind);
            const d = new Date(n.createdAt);
            const body = (
              <>
                <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 12, background: ic.bg, color: ic.fg, display: "flex", alignItems: "center", justifyContent: "center" }}>{ic.icon}</div>
                <div className="col grow" style={{ gap: 3 }}>
                  <div className="row gap-8">
                    <span className="strong" style={{ fontSize: 14 }}>{n.title}</span>
                    {!n.readAt ? <span className="dot" aria-label="New" /> : null}
                  </div>
                  {n.body ? <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45 }}>{n.body}</div> : null}
                  <div className="small muted">{fmtTime(`${d.getHours()}:${d.getMinutes()}`)}, {fmtWhen(d)}</div>
                </div>
              </>
            );
            const style = { padding: 14, display: "flex", gap: 12, textDecoration: "none", color: "inherit", alignItems: "flex-start" } as const;
            return n.url && n.url.startsWith("/") ? (
              <Link key={n.id} href={n.url} className="card" style={style}>{body}</Link>
            ) : (
              <div key={n.id} className="card" style={style}>{body}</div>
            );
          })}
        </div>
      ))}
    </AppScreen>
  );
}

/* ---------------- More ---------------- */

function MoreRow({ href, icon, label, sub, right, last }: { href: string; icon: ReactNode; label: string; sub?: string; right?: ReactNode; last?: boolean }) {
  return (
    <Link href={href} style={{ textDecoration: "none", color: "inherit", display: "flex", alignItems: "center", gap: 14, padding: "8px 16px", minHeight: 52, borderBottom: last ? "none" : "1px solid var(--line-2)" }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: "var(--brand-tint)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</span>
      {sub ? (
        <span className="grow col" style={{ gap: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{label}</span>
          <span className="small muted">{sub}</span>
        </span>
      ) : (
        <span className="grow" style={{ fontSize: 15, fontWeight: 700 }}>{label}</span>
      )}
      {right ?? <IconChevron />}
    </Link>
  );
}

/** /e/:slug/more: every other screen the event's features allow. */
export function MoreScreen() {
  const { slug, event, me, base } = useEventApp();
  const my = trpc.program.sessions.my.useQuery({ slug }, { enabled: !!me.attendee });
  const f = event.features;
  const isBooth = me.staff.kinds.includes("booth") || me.staff.vendorIds.length > 0;
  const earned = my.data?.stats.ceEarned ?? 0;
  const rows: { href: string; icon: ReactNode; label: string; sub?: string; right?: ReactNode; show: boolean }[] = [
    { href: `${base}/credits`, icon: <IconAward size={20} />, label: "CE credits", right: <span className="strong" style={{ fontSize: 13, color: "var(--brand)" }}>{earned.toFixed(1)} earned</span>, show: !!me.attendee },
    { href: `${base}/transcript`, icon: <IconFolder size={20} />, label: "CE transcript", show: !!me.attendee },
    { href: `${base}/people`, icon: <IconPeople size={20} />, label: "People", show: f.networking },
    { href: `${base}/speakers`, icon: <IconUser size={20} />, label: "Speakers", show: true },
    { href: `${base}/exhibitors`, icon: <IconStore size={20} />, label: "Exhibitors and sponsors", show: f.exhibitors },
    { href: `${base}/map`, icon: <IconMap size={20} />, label: "Venue map", show: true },
    { href: `${base}/dining`, icon: <IconFood size={20} />, label: "Food and dining", show: f.dining },
    { href: `${base}/help`, icon: <IconHelp size={20} />, label: "Help center", show: true },
    { href: `${base}/lost-found`, icon: <IconSearch size={20} />, label: "Lost and found", show: true },
    { href: `${base}/host`, icon: <IconInfo size={20} />, label: "About your host", show: true },
    { href: `${base}/badge`, icon: <IconBadge size={20} />, label: "My badge", show: !!me.attendee },
    { href: `${base}/profile`, icon: <IconUser size={20} />, label: "My profile", show: !!me.attendee },
    { href: `${base}/leads`, icon: <IconQr size={20} />, label: "Scan leads", sub: "Booth staff only", show: isBooth },
    {
      href: `${base}/alerts`,
      icon: <IconBell size={20} />,
      label: "Alerts",
      right: me.unread ? <span style={{ minWidth: 22, height: 22, padding: "0 6px", borderRadius: 11, background: "var(--accent)", color: "var(--accent-ink)", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{me.unread}</span> : undefined,
      show: true,
    },
  ];
  const shown = rows.filter((r) => r.show);
  return (
    <AppScreen nav="more" header={<BrandHeader title="More" eyebrow={event.name} />}>
      <div className="card" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {shown.map((r, i) => (
          <MoreRow key={r.href} {...r} last={i === shown.length - 1} />
        ))}
      </div>
      <PushToggle />
      <div style={{ marginTop: "auto" }}>
        <PoweredBy />
      </div>
    </AppScreen>
  );
}

/* ---------------- Dining ---------------- */

const DIET_LEGEND = "V vegetarian · VG vegan · GF gluten free";

function DiningTabs({ on }: { on: "menu" | "nearby" }) {
  const { base } = useEventApp();
  return (
    <Segmented
      light
      items={[
        { label: "Event menu", href: `${base}/dining`, on: on === "menu" },
        { label: "Near the venue", href: `${base}/nearby`, on: on === "nearby" },
      ]}
    />
  );
}

/** /e/:slug/dining: event meals by day. */
export function DiningScreen() {
  const { slug, event } = useEventApp();
  const q = trpc.program.dining.list.useQuery({ slug });
  const days = eachDay(event.startDate, event.endDate);
  const withMeals = days.filter((d) => (q.data?.menu ?? []).some((m) => m.date === d));
  const [day, setDay] = useState<string | null>(null);
  const current = day ?? withMeals[0] ?? days[0];
  const meals = (q.data?.menu ?? []).filter((m) => m.date === current);
  return (
    <AppScreen nav="more" header={<TopBar title="Food and dining"><DiningTabs on="menu" /></TopBar>} bodyStyle={{ paddingTop: 14 }}>
      {!event.features.dining ? (
        <Empty>Dining is not part of this event's app.</Empty>
      ) : q.isLoading ? (
        <PageLoading />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : (
        <>
          <div className="row gap-8 wrap">
            {days.map((d) => (
              <Chip key={d} on={d === current} onClick={() => setDay(d)}>
                {d === current ? fmtDayDate(d) : fmtDayDate(d).slice(0, 3)}
              </Chip>
            ))}
          </div>
          {!meals.length ? <Empty>No meals listed for this day.</Empty> : null}
          {meals.map((m) => (
            <div key={m.id} className="card col" style={{ padding: 14, gap: 10 }}>
              <div className="col" style={{ gap: 2 }}>
                <span style={{ fontSize: 16, fontWeight: 800 }}>{m.meal || m.title}</span>
                <span className="muted" style={{ fontSize: 13 }}>{[m.time && m.endTime ? fmtRange(m.time, m.endTime) : fmtTime(m.time), m.location].filter(Boolean).join(" · ")}</span>
              </div>
              {m.items.length ? (
                <div className="col" style={{ gap: 6, fontSize: 14 }}>
                  {m.items.map((it, i) => (
                    <div key={i} className="row-between" style={{ alignItems: "flex-start" }}>
                      <span>{it.name}</span>
                      <span className="small strong muted nowrap">{it.dietary.join(" · ")}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {m.note ? <div className="small muted">{m.note}</div> : null}
            </div>
          ))}
          {meals.some((m) => m.items.some((i) => i.dietary.length)) ? <div className="small muted">{DIET_LEGEND}</div> : null}
        </>
      )}
    </AppScreen>
  );
}

const CATS = [
  { key: "", label: "All" },
  { key: "quick", label: "Quick bite" },
  { key: "sitdown", label: "Sit-down" },
  { key: "coffee", label: "Coffee" },
];

/** /e/:slug/nearby: places to eat near the venue. */
export function NearbyScreen() {
  const { slug, event } = useEventApp();
  const q = trpc.program.dining.list.useQuery({ slug });
  const [cat, setCat] = useState("");
  const places = (q.data?.nearby ?? []).filter((p) => !cat || p.category === cat);
  const near = event.city || event.venueAddress;
  return (
    <AppScreen nav="more" header={<TopBar title="Food and dining"><DiningTabs on="nearby" /></TopBar>} bodyStyle={{ paddingTop: 14 }}>
      {!event.features.dining ? (
        <Empty>Dining is not part of this event's app.</Empty>
      ) : q.isLoading ? (
        <PageLoading />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : (
        <>
          <div className="row gap-8 wrap">
            {CATS.map((c) => (
              <Chip key={c.key} on={cat === c.key} onClick={() => setCat(c.key)}>{c.label}</Chip>
            ))}
          </div>
          {!places.length ? <Empty>No places listed yet.</Empty> : null}
          {places.map((p) => {
            const directions = p.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.title}, ${p.address}`)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.title} ${near}`)}`;
            const buttons = [
              <a key="d" href={directions} target="_blank" rel="noreferrer" className="btn" style={{ height: 40 }}>Directions</a>,
              p.phone ? <a key="c" href={`tel:${p.phone.replace(/[^\d+]/g, "")}`} className="btn" style={{ height: 40 }}>Call</a> : p.url ? <a key="w" href={p.url} target="_blank" rel="noreferrer" className="btn" style={{ height: 40 }}>Website</a> : null,
            ].filter(Boolean);
            return (
              <div key={p.id} className="card col" style={{ padding: 14, gap: 10 }}>
                <div className="row-between" style={{ alignItems: "flex-start" }}>
                  <div className="col" style={{ gap: 3 }}>
                    <span style={{ fontSize: 16, fontWeight: 800 }}>{p.title}</span>
                    <span className="muted" style={{ fontSize: 13 }}>{[p.cuisine, p.price, p.walkMinutes !== null ? `${p.walkMinutes} min walk` : ""].filter(Boolean).join(" · ")}</span>
                    {p.description ? <span className="muted" style={{ fontSize: 13 }}>{p.description}</span> : null}
                  </div>
                  {p.note ? <Pill tone="orange">{p.note}</Pill> : null}
                </div>
                <div className={buttons.length > 1 ? "grid-2" : "col"} style={{ gap: 8 }}>{buttons}</div>
              </div>
            );
          })}
        </>
      )}
    </AppScreen>
  );
}

/* ---------------- About your host ---------------- */

function ContactRow({ icon, children, href, last }: { icon: ReactNode; children: ReactNode; href: string; last?: boolean }) {
  return (
    <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderBottom: last ? "none" : "1px solid var(--line-2)", fontSize: 14, color: "inherit", textDecoration: "none" }}>
      <span style={{ color: "var(--brand)", display: "flex" }}>{icon}</span>
      <span className="grow clip">{children}</span>
    </a>
  );
}

/** /e/:slug/host */
export function HostScreen() {
  const { slug } = useEventApp();
  const q = trpc.program.host.get.useQuery({ slug });
  if (q.isLoading) return <AppScreen nav="more" header={<TopBar title="About your host" />}><PageLoading /></AppScreen>;
  if (q.error) return <AppScreen nav="more" header={<TopBar title="About your host" />}><ErrorNote error={q.error} /></AppScreen>;
  const h = q.data!;
  const socials = [
    { label: "Instagram", url: h.instagram },
    { label: "Facebook", url: h.facebook },
    { label: "LinkedIn", url: h.linkedin },
    ...h.otherLinks.map((l) => ({ label: l.label, url: l.url })),
  ].filter((l) => l.url);
  type Contact = { key: string; icon: ReactNode; text: string; href: string };
  const contacts: Contact[] = [];
  if (h.email) contacts.push({ key: "e", icon: <IconMessage size={18} />, text: h.email, href: `mailto:${h.email}` });
  if (h.phone) contacts.push({ key: "p", icon: <IconHelp size={18} />, text: h.phone, href: `tel:${h.phone.replace(/[^\d+]/g, "")}` });
  for (const s of socials) contacts.push({ key: s.label, icon: <IconPeople size={18} />, text: s.label, href: s.url });
  const buttons = [h.joinUrl ? <a key="j" href={h.joinUrl} className="btn btn-primary" style={{ height: 46 }}>Join or renew</a> : null, h.website ? <a key="w" href={h.website} target="_blank" rel="noreferrer" className="btn" style={{ height: 46 }}>Website</a> : null].filter(Boolean);
  return (
    <AppScreen nav="more" header={<TopBar title="About your host" />} bodyStyle={{ padding: "22px 18px 24px", gap: 16 }}>
      <div className="col" style={{ alignItems: "center", gap: 10, textAlign: "center" }}>
        <div style={{ width: 88, height: 88, borderRadius: 22, background: h.imageUrl ? "#FFFFFF" : "var(--brand)", border: h.imageUrl ? "1px solid var(--line)" : "none", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {h.imageUrl ? <img src={h.imageUrl} alt={`${h.name} logo`} style={{ width: "84%", height: "84%", objectFit: "contain" }} /> : <IconInfo size={36} color="var(--on-brand)" />}
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.25 }}>{h.name}</div>
      </div>
      {buttons.length ? <div className={buttons.length > 1 ? "grid-2" : "col"}>{buttons}</div> : null}
      {h.about ? (
        <div className="card col" style={{ padding: 14, gap: 8 }}>
          <div className="strong" style={{ fontSize: 14, fontWeight: 800 }}>About</div>
          <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{h.about}</div>
        </div>
      ) : null}
      {h.mission ? (
        <div className="card col" style={{ padding: 14, gap: 8 }}>
          <div className="strong" style={{ fontSize: 14, fontWeight: 800 }}>Mission</div>
          <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{h.mission}</div>
        </div>
      ) : null}
      {contacts.length ? (
        <div className="card" style={{ overflow: "hidden" }}>
          {contacts.map((c, i) => (
            <ContactRow key={c.key} icon={c.icon} href={c.href} last={i === contacts.length - 1}>{c.text}</ContactRow>
          ))}
        </div>
      ) : null}
    </AppScreen>
  );
}

/* ---------------- Help center ---------------- */

const REQUEST_STATUS: Record<string, { label: string; tone: "orange" | "green" | "gray" }> = {
  open: { label: "Sent", tone: "orange" },
  answered: { label: "Answered", tone: "green" },
  closed: { label: "Resolved", tone: "gray" },
};

/** /e/:slug/help */
export function HelpScreen() {
  const { slug, base } = useEventApp();
  const utils = trpc.useUtils();
  const q = trpc.program.help.page.useQuery({ slug });
  const send = trpc.program.help.send.useMutation();
  const [open, setOpen] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [asking, setAsking] = useState(false);
  const [form, setForm] = useState({ topic: "", message: "" });
  if (q.isLoading) return <AppScreen nav="more" header={<TopBar title="Help center" />}><PageLoading /></AppScreen>;
  if (q.error) return <AppScreen nav="more" header={<TopBar title="Help center" />}><ErrorNote error={q.error} /></AppScreen>;
  const d = q.data!;
  const s = search.trim().toLowerCase();
  const articles = d.articles.filter((a) => !s || a.question.toLowerCase().includes(s) || a.answer.toLowerCase().includes(s));
  const deskLine = [d.desk.place, d.desk.hours].filter(Boolean).join(" · ");
  return (
    <AppScreen nav="more" header={<TopBar title="Help center" />}>
      <div className="card col" style={{ padding: 14, gap: 12 }}>
        <div className="col" style={{ gap: 3 }}>
          <span style={{ fontSize: 16, fontWeight: 800 }}>Help desk</span>
          {deskLine ? <span className="muted" style={{ fontSize: 13 }}>{deskLine}</span> : null}
        </div>
        <div className={d.desk.phone && d.registered ? "grid-2" : "col"} style={{ gap: 8 }}>
          {d.registered ? (
            <button type="button" className="btn btn-primary" style={{ height: 44 }} onClick={() => setAsking(true)}>
              Message us
            </button>
          ) : null}
          {d.desk.phone ? (
            <a href={`tel:${d.desk.phone.replace(/[^\d+]/g, "")}`} className="btn" style={{ height: 44 }}>
              Call
            </a>
          ) : null}
        </div>
      </div>
      <Link href={`${base}/lost-found`} className="tile" style={{ padding: 14, gap: 14 }}>
        <span className="tile-icon"><IconSearch size={20} /></span>
        <span className="grow col" style={{ gap: 2 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Lost and found</span>
          <span className="small muted">Report a lost item or check on one</span>
        </span>
        <IconChevron />
      </Link>

      {d.requests.length ? (
        <>
          <div className="section-title" style={{ paddingTop: 4 }}>My requests</div>
          {d.requests.map((r) => {
            const st = REQUEST_STATUS[r.status];
            return (
              <div key={r.id} className="card col" style={{ padding: "12px 14px", gap: 8 }}>
                <div className="row-between" style={{ alignItems: "flex-start" }}>
                  <span className="col" style={{ gap: 2 }}>
                    <span className="strong" style={{ fontSize: 14 }}>{r.topic}</span>
                    <span className="small muted">Sent {fmtWhen(r.createdAt)}</span>
                  </span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                </div>
                <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{r.message}</div>
                {r.reply ? (
                  <div style={{ background: "var(--brand-tint-2)", border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px", fontSize: 13, lineHeight: 1.5 }}>
                    <span className="strong">Help desk: </span>
                    {r.reply}
                  </div>
                ) : null}
              </div>
            );
          })}
        </>
      ) : null}

      <div className="section-title" style={{ paddingTop: 4 }}>Common questions</div>
      {d.articles.length > 4 ? <input className="input" placeholder="Search questions" aria-label="Search questions" value={search} onChange={(e) => setSearch(e.target.value)} /> : null}
      {articles.length ? (
        <div className="card" style={{ overflow: "hidden" }}>
          {articles.map((a, i) => {
            const isOpen = open === a.id;
            return (
              <div key={a.id} style={{ borderBottom: i === articles.length - 1 ? "none" : "1px solid var(--line-2)" }}>
                <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.id)} style={{ width: "100%", padding: 14, border: "none", background: "#FFFFFF", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 700, color: "var(--ink)", cursor: "pointer" }}>
                  {a.question}
                  <IconChevron style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0)", flexShrink: 0 }} />
                </button>
                {isOpen ? <div style={{ padding: "0 14px 14px", fontSize: 13, lineHeight: 1.5, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{a.answer}</div> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <Empty>{s ? "No questions match." : "No questions yet."}</Empty>
      )}

      <Sheet open={asking} onClose={() => setAsking(false)} label="Message the help desk">
        <div className="row-between">
          <span className="h3" style={{ fontSize: 18 }}>Message the help desk</span>
          <CloseButton onClick={() => setAsking(false)} />
        </div>
        <Field label="Topic">
          <input className="input" value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} placeholder="Badge, CE credit, room..." />
        </Field>
        <Field label="Message">
          <textarea className="textarea" rows={4} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
        </Field>
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          disabled={send.isPending || form.topic.trim().length < 2 || form.message.trim().length < 2}
          onClick={async () => {
            try {
              await send.mutateAsync({ slug, ...form });
              setForm({ topic: "", message: "" });
              setAsking(false);
              await utils.program.help.page.invalidate({ slug });
              toast("Sent. We will reply here.");
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Send
        </button>
      </Sheet>
    </AppScreen>
  );
}

/* ---------------- Lost and found ---------------- */

const LOST_CATS = ["Phone", "Keys", "Wallet", "Bag", "Clothing", "Other"] as const;
const LOST_STATUS: Record<string, { label: string; tone: "orange" | "green" | "gray" }> = {
  open: { label: "Looking", tone: "orange" },
  claimed: { label: "Ready at help desk", tone: "green" },
  returned: { label: "Picked up", tone: "gray" },
};

/** /e/:slug/lost-found */
export function LostFoundScreen() {
  const { slug, base } = useEventApp();
  const utils = trpc.useUtils();
  const q = trpc.program.help.lostFound.useQuery({ slug });
  const report = trpc.program.help.report.useMutation();
  const [cat, setCat] = useState<(typeof LOST_CATS)[number]>("Phone");
  const [item, setItem] = useState("");
  const [place, setPlace] = useState("");
  const back = `${base}/help`;
  if (q.isLoading) return <AppScreen nav="more" header={<TopBar title="Lost and found" back={back} />}><PageLoading /></AppScreen>;
  if (q.error) return <AppScreen nav="more" header={<TopBar title="Lost and found" back={back} />}><ErrorNote error={q.error} /></AppScreen>;
  const d = q.data!;
  return (
    <AppScreen nav="more" header={<TopBar title="Lost and found" back={back} />}>
      {d.note ? <div style={{ background: "var(--brand-tint)", border: "1px solid #A9CBBD", borderRadius: 14, padding: "12px 14px", fontSize: 13, lineHeight: 1.5, color: "var(--ink-2)" }}>{d.note}</div> : null}
      {d.registered ? (
        <div className="card col" style={{ padding: 14, gap: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>Report a lost item</div>
          <fieldset style={{ margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 6 }}>
            <legend className="small strong muted" style={{ padding: "0 0 6px" }}>What did you lose?</legend>
            <div className="row wrap gap-6">
              {LOST_CATS.map((c) => (
                <Chip key={c} on={cat === c} onClick={() => setCat(c)}>{c}</Chip>
              ))}
            </div>
          </fieldset>
          <Field label="Describe it">
            <input className="input" value={item} onChange={(e) => setItem(e.target.value)} placeholder="Black phone in a green case" />
          </Field>
          <Field label="Where you last had it">
            <select className="select" value={place} onChange={(e) => setPlace(e.target.value)}>
              <option value="">Not sure</option>
              {d.places.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            className="btn btn-primary btn-block"
            style={{ height: 46, borderRadius: 12, fontSize: 15 }}
            disabled={report.isPending || item.trim().length < 2}
            onClick={async () => {
              try {
                await report.mutateAsync({ slug, category: cat, item, place });
                setItem("");
                setPlace("");
                await utils.program.help.lostFound.invalidate({ slug });
                toast("Sent. We will let you know if it turns up.");
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Send report
          </button>
        </div>
      ) : null}
      {d.mine.length ? (
        <>
          <div className="section-title" style={{ paddingTop: 2 }}>My reports</div>
          {d.mine.map((r) => {
            const st = LOST_STATUS[r.status];
            return (
              <div key={r.id} className="card row-between" style={{ padding: "12px 14px" }}>
                <span className="col" style={{ gap: 2 }}>
                  <span className="strong" style={{ fontSize: 14 }}>{r.item}</span>
                  <span className="small muted">Reported {fmtWhen(r.createdAt)}{r.place ? ` · ${r.place}` : ""}</span>
                </span>
                <Pill tone={st.tone}>{st.label}</Pill>
              </div>
            );
          })}
        </>
      ) : null}
      {d.found.length ? (
        <>
          <div className="section-title" style={{ paddingTop: 2 }}>Turned in at the help desk</div>
          {d.found.map((r) => (
            <div key={r.id} className="card row" style={{ padding: "12px 14px", gap: 12 }}>
              {r.photoUrl ? <img src={r.photoUrl} alt="" style={{ width: 48, height: 48, borderRadius: 10, objectFit: "cover" }} /> : null}
              <span className="col grow" style={{ gap: 2 }}>
                <span className="strong" style={{ fontSize: 14 }}>{r.item}</span>
                <span className="small muted">Found {fmtWhen(r.createdAt)}{r.place ? ` · ${r.place}` : ""}</span>
              </span>
            </div>
          ))}
        </>
      ) : null}
    </AppScreen>
  );
}

