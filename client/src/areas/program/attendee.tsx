/** Attendee app: welcome, full agenda, My agenda, session detail, speakers. */
import { useEffect, useMemo, useState } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { trpc } from "../../lib/trpc";
import { AppScreen, BackBar, BrandHeader, brandStyle, useEventApp } from "../../shells/AttendeeShell";
import { Avatar, Empty, ErrorNote, PageLoading, Pill } from "../../ui/components";
import { IconBell, IconCheck, IconChevron, IconClock, IconPin, IconPlus, IconQr, IconSearch } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { SignIn } from "../../core/SignIn";
import { eachDay, fmtDate, fmtDates, fmtDayDate, fmtRange, fmtTime } from "@shared/format";
import { dateToZoned } from "@shared/time";
import { Chip, HeaderStat, PoweredBy, Segmented, SpeakerSheet, TopBar, ceLabel } from "./shared";

/** /e/:slug: the branded welcome and sign-in. Signed-in people go straight to the agenda. */
export function WelcomeScreen({ slug }: { slug: string }) {
  const event = trpc.core.events.publicBySlug.useQuery({ slug });
  const auth = trpc.auth.me.useQuery();
  const [, navigate] = useLocation();
  useEffect(() => {
    if (event.data) document.title = event.data.shortName;
  }, [event.data]);
  if (event.isLoading || auth.isLoading) return <PageLoading />;
  if (event.error) return <div className="app"><ErrorNote error={event.error} /></div>;
  if (auth.data) return <Redirect to={`/e/${slug}/agenda`} />;
  const ev = event.data!;
  return (
    <div className="app" style={{ ...brandStyle(ev.branding), background: "var(--brand)", color: "#FFFFFF" }}>
      <div className="col" style={{ flex: 1, padding: "64px 28px 32px", alignItems: "center", gap: 18, textAlign: "center" }}>
        <div style={{ width: 112, height: 112, borderRadius: 28, background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {ev.logoUrl ? <img src={ev.logoUrl} alt={`${ev.orgName} logo`} style={{ width: "80%", height: "80%", objectFit: "contain" }} /> : <span style={{ color: "var(--brand)", fontWeight: 800, fontSize: 22 }}>{ev.shortName.slice(0, 4)}</span>}
        </div>
        <div className="col" style={{ gap: 6 }}>
          <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.2 }}>{ev.name}</div>
          <div style={{ fontSize: 14, color: "var(--side-text)" }}>
            {fmtDates(ev.startDate, ev.endDate)}
            {ev.venueName ? ` · ${ev.venueName}` : ""}
          </div>
        </div>
      </div>
      <div style={{ background: "#FFFFFF", color: "var(--ink)", borderRadius: "24px 24px 0 0", padding: "26px 22px calc(20px + env(safe-area-inset-bottom))", display: "flex", flexDirection: "column", gap: 14 }}>
        <SignIn title="Sign in" eventName={ev.shortName} onDone={() => navigate(`/e/${slug}/agenda`)} />
        <div className="muted" style={{ fontSize: 13, textAlign: "center", lineHeight: 1.5 }}>Add this app to your home screen to get session reminders.</div>
        <div className="small muted" style={{ textAlign: "center" }}>
          Not registered yet? <a href={`/r/${ev.slug}`}>Register</a>
        </div>
        <PoweredBy />
      </div>
    </div>
  );
}

function todayIn(tz: string) {
  try {
    return dateToZoned(new Date(), tz).date;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

const headerBtn = { position: "relative" as const, width: 44, height: 44, borderRadius: 12, border: "1px solid rgba(255,255,255,0.28)", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" };

function useAddToAgenda() {
  const { slug } = useEventApp();
  const utils = trpc.useUtils();
  const add = trpc.program.sessions.add.useMutation();
  const remove = trpc.program.sessions.remove.useMutation();
  const refresh = () => Promise.all([utils.program.sessions.agenda.invalidate(), utils.program.sessions.my.invalidate(), utils.program.sessions.get.invalidate()]);
  return {
    pending: add.isPending || remove.isPending,
    add: async (sessionId: number) => {
      try {
        const res = await add.mutateAsync({ slug, sessionId });
        await refresh();
        if (res.conflicts.length) toast(`Added. This overlaps with ${res.conflicts[0].title} at ${fmtTime(res.conflicts[0].startTime)}.`);
        else toast("Added to My agenda");
      } catch (err) {
        toast(errorText(err), true);
      }
    },
    remove: async (sessionId: number) => {
      try {
        await remove.mutateAsync({ slug, sessionId });
        await refresh();
        toast("Removed from My agenda");
      } catch (err) {
        toast(errorText(err), true);
      }
    },
  };
}

/** /e/:slug/agenda: the full agenda by day with filters. */
export function AgendaScreen() {
  const { slug, event, me, base } = useEventApp();
  const q = trpc.program.sessions.agenda.useQuery({ slug });
  const days = eachDay(event.startDate, event.endDate);
  const today = todayIn(event.timezone);
  const [day, setDay] = useState(days.includes(today) ? today : days[0]);
  const [filter, setFilter] = useState<"all" | "ce" | "track">("all");
  const [track, setTrack] = useState("");
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const agenda = useAddToAgenda();

  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.sessions ?? []).filter(
      (x) =>
        x.date === day &&
        (filter !== "ce" || x.ceHours > 0) &&
        (filter !== "track" || !track || x.track === track) &&
        (!s || x.title.toLowerCase().includes(s) || x.speakers.some((n) => n.toLowerCase().includes(s)) || x.room.toLowerCase().includes(s))
    );
  }, [q.data, day, filter, track, search]);
  const groups = useMemo(() => {
    const out: { time: string; items: typeof list }[] = [];
    for (const s of list) {
      const g = out.find((o) => o.time === s.startTime);
      if (g) g.items.push(s);
      else out.push({ time: s.startTime, items: [s] });
    }
    return out;
  }, [list]);

  const header = (
    <header className="app-header" style={{ paddingBottom: 16 }}>
      <div className="row-between">
        <div className="row" style={{ gap: 10, minWidth: 0 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "#FFFFFF", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            {event.logoUrl ? <img src={event.logoUrl} alt={`${event.orgName} logo`} style={{ width: "84%", height: "84%", objectFit: "contain" }} /> : <span style={{ color: "var(--brand)", fontSize: 10, fontWeight: 800 }}>{event.shortName.slice(0, 4)}</span>}
          </div>
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <div className="eyebrow" style={{ letterSpacing: "0.06em" }}>{fmtDates(event.startDate, event.endDate)}</div>
            <div className="clip" style={{ fontSize: 18, fontWeight: 800 }}>{event.name}</div>
          </div>
        </div>
        <div className="row gap-8">
          <Link href={`${base}/alerts`} aria-label={me.unread ? `Alerts, ${me.unread} new` : "Alerts"} style={headerBtn}>
            <IconBell size={20} />
            {me.unread ? <span style={{ position: "absolute", top: 8, right: 9, width: 9, height: 9, borderRadius: 5, background: "var(--accent)" }} /> : null}
          </Link>
          {me.attendee ? (
            <Link href={`${base}/badge`} aria-label="My badge" style={headerBtn}>
              <IconQr size={20} />
            </Link>
          ) : null}
        </div>
      </div>
      <Segmented items={[{ label: "Full agenda", href: `${base}/agenda`, on: true }, { label: "My agenda", href: `${base}/my`, on: false }]} />
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(days.length, 4)}, minmax(0, 1fr))`, gap: 8 }}>
        {days.map((d) => {
          const on = d === day;
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              onClick={() => setDay(d)}
              style={{ height: 52, borderRadius: 12, border: on ? "none" : "1px solid rgba(255,255,255,0.28)", background: on ? "#FFFFFF" : "transparent", color: on ? "var(--ink)" : "#FFFFFF", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, cursor: "pointer" }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: on ? "var(--muted)" : "var(--side-text)" }}>{fmtDayDate(d).slice(0, 3)}</span>
              <span style={{ fontSize: days.length > 3 ? 13 : 15, fontWeight: on ? 800 : 700 }}>{fmtDate(d)}</span>
            </button>
          );
        })}
      </div>
    </header>
  );

  return (
    <AppScreen nav="agenda" header={header} bodyStyle={{ gap: 10, paddingTop: 14 }}>
      <div className="row gap-8" style={{ flexWrap: "wrap" }}>
        <Chip on={filter === "all"} onClick={() => setFilter("all")}>All sessions</Chip>
        <Chip on={filter === "ce"} onClick={() => setFilter("ce")}>CE eligible</Chip>
        {q.data?.tracks.length ? (
          <Chip on={filter === "track"} onClick={() => setFilter(filter === "track" ? "all" : "track")}>
            {filter === "track" && track ? track : "Tracks"}
          </Chip>
        ) : null}
        <button type="button" className="chip" aria-label="Search sessions" aria-pressed={searching} onClick={() => setSearching(!searching)} style={{ width: 36, padding: 0, justifyContent: "center", marginLeft: "auto" }}>
          <IconSearch size={16} />
        </button>
      </div>
      {filter === "track" && q.data?.tracks.length ? (
        <select className="select" aria-label="Track" value={track} onChange={(e) => setTrack(e.target.value)}>
          <option value="">Every track</option>
          {q.data.tracks.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      ) : null}
      {searching ? <input className="input" autoFocus placeholder="Search sessions, speakers or rooms" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search sessions" /> : null}

      {q.isLoading ? <PageLoading /> : q.error ? <ErrorNote error={q.error} /> : !groups.length ? <Empty>No sessions match on {fmtDate(day)}.</Empty> : null}
      {groups.map((g) => (
        <div key={g.time} className="col gap-10">
          <div className="label-caps" style={{ letterSpacing: "0.06em", paddingTop: 4 }}>{fmtTime(g.time)}</div>
          {g.items.map((s) => (
            <div key={s.id} className="card" style={{ padding: 14, display: "flex", gap: 12, alignItems: "flex-start" }}>
              <Link href={`${base}/session/${s.id}`} className="grow col" style={{ gap: 6, textDecoration: "none", color: "inherit" }}>
                <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>{s.title}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {fmtRange(s.startTime, s.endTime)}
                  {s.room ? ` · ${s.room}` : ""}
                </div>
                {s.speakers.length ? <div className="muted" style={{ fontSize: 13 }}>{s.speakers.join(", ")}</div> : null}
                {s.ceHours > 0 || s.track || s.seatsLeft !== null ? (
                  <div className="row gap-6 wrap">
                    {s.ceHours > 0 ? <Pill>{ceLabel(s.ceHours)}</Pill> : null}
                    {s.track ? <Pill tone="gray">{s.track}</Pill> : null}
                    {s.seatsLeft !== null && !s.onMy ? <Pill tone={s.seatsLeft ? "orange" : "red"}>{s.seatsLeft ? `${s.seatsLeft} seat${s.seatsLeft === 1 ? "" : "s"} left` : "Full"}</Pill> : null}
                  </div>
                ) : null}
              </Link>
              {!me.attendee ? null : s.onMy ? (
                <div role="img" aria-label="On My agenda" style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, background: "var(--brand)", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <IconCheck size={20} />
                </div>
              ) : (
                <button
                  type="button"
                  aria-label={`Add ${s.title} to My agenda`}
                  disabled={agenda.pending || s.seatsLeft === 0}
                  onClick={() => agenda.add(s.id)}
                  style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, border: "1.5px solid var(--brand)", background: "#FFFFFF", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <IconPlus size={20} />
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </AppScreen>
  );
}

const STATUS: Record<string, { label: string; tone: "green" | "gray" | "orange" }> = {
  certified: { label: "CE issued", tone: "green" },
  attended: { label: "Attended", tone: "green" },
  upcoming: { label: "Upcoming", tone: "gray" },
  missed: { label: "Ended", tone: "gray" },
};

/** /e/:slug/my: the person's own agenda with check-in, evaluation and certificate status. */
export function MyAgendaScreen() {
  const { slug, event, me, base } = useEventApp();
  const q = trpc.program.sessions.my.useQuery({ slug }, { enabled: !!me.attendee });
  const stats = q.data?.stats;
  const byDay = useMemo(() => {
    const out: { date: string; items: NonNullable<typeof q.data>["items"] }[] = [];
    for (const i of q.data?.items ?? []) {
      const g = out.find((o) => o.date === i.date);
      if (g) g.items.push(i);
      else out.push({ date: i.date, items: [i] });
    }
    return out;
  }, [q.data]);

  return (
    <AppScreen
      nav="my"
      header={
        <BrandHeader title="My agenda" eyebrow={event.name}>
          <Segmented items={[{ label: "Full agenda", href: `${base}/agenda`, on: false }, { label: "My agenda", href: `${base}/my`, on: true }]} />
          {me.attendee ? (
            <div className="grid-3" style={{ gap: 8 }}>
              <HeaderStat value={stats?.sessions ?? "0"} label="Sessions" />
              <HeaderStat value={stats?.attended ?? "0"} label="Attended" />
              <HeaderStat value={(stats?.ceEarned ?? 0).toFixed(1)} label="CE earned" />
            </div>
          ) : null}
        </BrandHeader>
      }
    >
      {!me.attendee ? (
        <Empty>My agenda is for registered attendees.</Empty>
      ) : q.isLoading ? (
        <PageLoading />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : !byDay.length ? (
        <div className="col gap-12">
          <Empty>Nothing on My agenda yet.</Empty>
          <Link href={`${base}/agenda`} className="btn btn-primary btn-lg btn-block">
            Browse the agenda
          </Link>
        </div>
      ) : (
        byDay.map((g) => (
          <div key={g.date} className="col gap-10">
            <div className="section-title" style={{ paddingTop: 4 }}>{fmtDayDate(g.date)}</div>
            {g.items.map((i) => {
              const st = STATUS[i.status];
              return (
                <div key={i.id} className="card col" style={{ padding: 14, gap: 10 }}>
                  <div className="row-between" style={{ alignItems: "flex-start" }}>
                    <Link href={`${base}/session/${i.id}`} className="col" style={{ gap: 4, textDecoration: "none", color: "inherit" }}>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{i.title}</div>
                      <div className="muted" style={{ fontSize: 13 }}>
                        {fmtRange(i.startTime, i.endTime)}
                        {i.room ? ` · ${i.room}` : ""}
                      </div>
                    </Link>
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </div>
                  {i.conflicts.length && i.status === "upcoming" ? (
                    <div className="banner-warn" style={{ borderRadius: 10, padding: "8px 10px", fontSize: 12, fontWeight: 600 }}>
                      This overlaps with {i.conflicts[0].title} at {fmtTime(i.conflicts[0].startTime)}.
                    </div>
                  ) : null}
                  {i.evaluationOpen ? (
                    <Link href={`${base}/eval/${i.id}`} className="btn btn-primary btn-block" style={{ height: 44, borderRadius: 12 }}>
                      Take evaluation
                    </Link>
                  ) : null}
                  {i.canCheckIn ? (
                    <Link href={`${base}/checkin/${i.id}`} className="btn btn-block" style={{ height: 44, borderRadius: 12 }}>
                      Check in
                    </Link>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))
      )}
    </AppScreen>
  );
}

const ROLE_LABEL: Record<string, string> = { presenter: "Presenter", "co-presenter": "Co-presenter", moderator: "Moderator", panelist: "Panelist" };

/** /e/:slug/session/:sessionId */
export function SessionScreen({ sessionId }: { sessionId: number }) {
  const { slug, event, base } = useEventApp();
  const utils = trpc.useUtils();
  const q = trpc.program.sessions.get.useQuery({ slug, sessionId });
  const remind = trpc.program.sessions.setRemind.useMutation();
  const agenda = useAddToAgenda();
  const [bio, setBio] = useState<number | null>(null);
  const [, navigate] = useLocation();

  if (q.isLoading) return <AppScreen header={<BackBar title="Session" back={`${base}/agenda`} />}><PageLoading /></AppScreen>;
  if (q.error) return <AppScreen header={<BackBar title="Session" back={`${base}/agenda`} />}><ErrorNote error={q.error} /></AppScreen>;
  const d = q.data!;
  const s = d.session;
  const now = Date.now();
  const checkInOpen = now >= s.startsAt - 30 * 60_000 && now <= s.endsAt;
  const steps = [
    { label: "Scan the QR code at the door to check in", done: d.checkedIn },
    { label: "Take the evaluation after the session", done: d.evaluated },
    { label: "Get your certificate in CE credits", done: d.certified },
  ];
  const evalReady = d.checkedIn && !d.evaluated && s.ceHours > 0;

  return (
    <AppScreen
      header={<BackBar title="Session" back={`${base}/agenda`} />}
      bodyStyle={{ padding: "18px 18px 24px", gap: 14 }}
      footer={
        d.registered ? (
          <div className="grid-2">
            {d.onMy ? (
              <button type="button" className="btn btn-lg" style={{ background: "var(--brand-tint)" }} disabled={agenda.pending} onClick={() => agenda.remove(s.id)} aria-label="On my schedule. Tap to remove.">
                On my schedule
              </button>
            ) : (
              <button type="button" className="btn btn-lg" disabled={agenda.pending || s.seatsLeft === 0} onClick={() => agenda.add(s.id)}>
                {s.seatsLeft === 0 ? "Full" : s.requiresSignup ? "Sign up" : "Add to agenda"}
              </button>
            )}
            {evalReady ? (
              <Link href={`${base}/eval/${s.id}`} className="btn btn-primary btn-lg">Take evaluation</Link>
            ) : d.checkedIn ? (
              <button type="button" className="btn btn-primary btn-lg" disabled>Checked in</button>
            ) : (
              <button type="button" className="btn btn-primary btn-lg" onClick={() => (checkInOpen ? navigate(`${base}/checkin/${s.id}`) : toast(`Check-in opens 30 minutes before ${fmtTime(s.startTime)}.`))}>
                Check in
              </button>
            )}
          </div>
        ) : undefined
      }
    >
      {s.ceHours > 0 || s.track ? (
        <div className="row gap-6">
          {s.ceHours > 0 ? <Pill>{ceLabel(s.ceHours)}</Pill> : null}
          {s.track ? <Pill tone="gray">{s.track}</Pill> : null}
          {s.seatsLeft !== null && !d.onMy ? <Pill tone={s.seatsLeft ? "orange" : "red"}>{s.seatsLeft ? `${s.seatsLeft} seat${s.seatsLeft === 1 ? "" : "s"} left` : "Full"}</Pill> : null}
        </div>
      ) : null}
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, lineHeight: 1.25 }}>{s.title}</h1>
      <div className="col muted" style={{ gap: 6, fontSize: 14 }}>
        <div className="row gap-8">
          <IconClock />
          {fmtDayDate(s.date)} · {fmtRange(s.startTime, s.endTime)}
        </div>
        {s.room ? (
          <div className="row gap-8">
            <IconPin />
            {s.room}
          </div>
        ) : null}
      </div>
      {s.description ? <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{s.description}</div> : null}
      {d.speakers.map((p) => (
        <div key={p.id} className="card row" style={{ padding: 12, gap: 12 }}>
          <Avatar url={p.headshotUrl} name={p.name} size={44} />
          <div className="grow col" style={{ gap: 2 }}>
            <div className="strong" style={{ fontSize: 14 }}>{p.name}</div>
            <div className="muted" style={{ fontSize: 13 }}>{ROLE_LABEL[p.role] ?? p.role}</div>
          </div>
          <button type="button" className="btn btn-sm" style={{ width: 84, height: 36, borderRadius: 10 }} onClick={() => setBio(p.id)}>
            Bio
          </button>
        </div>
      ))}
      {s.ceHours > 0 && d.registered ? (
        <div className="card col" style={{ padding: 14, gap: 12 }}>
          <div className="strong" style={{ fontSize: 14, fontWeight: 800 }}>Earning CE for this session</div>
          {steps.map((st, i) => {
            const current = !st.done && steps.slice(0, i).every((x) => x.done);
            return (
              <div key={i} className="row" style={{ gap: 10 }}>
                <div style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 14, fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", ...(st.done || current ? { background: "var(--brand)", color: "#FFFFFF" } : { border: "1.5px solid #9DB3AB", color: "var(--muted)" }) }}>
                  {st.done ? <IconCheck size={14} /> : i + 1}
                </div>
                <div style={{ fontSize: 14, color: st.done || current ? "var(--ink)" : "var(--muted)" }}>{st.label}</div>
              </div>
            );
          })}
        </div>
      ) : null}
      {event.features.polls ? (
        <Link href={`${base}/poll/${s.id}`} className="tile" style={{ justifyContent: "space-between" }}>
          <span className="row strong" style={{ gap: 10, fontSize: 14 }}>
            <span className="dot" />
            Live poll and Q&amp;A
          </span>
          <IconChevron />
        </Link>
      ) : null}
      {d.onMy ? (
        <label className="tile" style={{ justifyContent: "space-between", fontSize: 14, fontWeight: 600 }}>
          Remind me 15 minutes before
          <input
            type="checkbox"
            checked={d.remind}
            disabled={remind.isPending}
            style={{ width: 22, height: 22, accentColor: "var(--brand)" }}
            onChange={async (e) => {
              try {
                await remind.mutateAsync({ slug, sessionId: s.id, remind: e.target.checked });
                await utils.program.sessions.get.invalidate({ slug, sessionId });
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          />
        </label>
      ) : null}
      <SpeakerSheet speakerId={bio} onClose={() => setBio(null)} showSessions={false} />
    </AppScreen>
  );
}

const TILE_COLORS = ["#CFE3DA", "#FBE3CC", "#DCE6F5", "#E8E1F3"];

/** /e/:slug/speakers: the directory. Tapping a speaker pops the bio sheet in place. */
export function SpeakersScreen() {
  const { slug } = useEventApp();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const q = trpc.program.speakers.list.useQuery({ slug, q: "" });
  const s = search.trim().toLowerCase();
  const list = (q.data ?? []).filter((x) => !s || [x.name, x.jobTitle, x.organization, x.city, ...x.sessions.map((y) => y.title)].some((t) => t.toLowerCase().includes(s)));
  return (
    <AppScreen
      nav="more"
      header={
        <TopBar title="Speakers">
          <label className="row" style={{ margin: "0 4px", height: 42, borderRadius: 12, border: "1px solid #D5DEDA", padding: "0 12px", gap: 8, color: "var(--muted)" }}>
            <IconSearch />
            <input aria-label="Search speakers" placeholder="Search speakers or topics" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, border: "none", outline: "none", fontSize: 14, background: "#FFFFFF", minWidth: 0 }} />
          </label>
        </TopBar>
      }
    >
      {q.isLoading ? <PageLoading /> : q.error ? <ErrorNote error={q.error} /> : !list.length ? <Empty>{s ? "No speakers match." : "Speakers will show here soon."}</Empty> : null}
      <div className="grid-2" style={{ gap: 12, alignContent: "start" }}>
        {list.map((x, i) => (
          <button
            key={x.id}
            type="button"
            aria-label={`Open bio for ${x.name}`}
            onClick={() => setOpen(x.id)}
            className="card"
            style={{ padding: 0, textAlign: "left", cursor: "pointer", color: "var(--ink)", overflow: "hidden", display: "flex", flexDirection: "column" }}
          >
            <span style={{ width: "100%", height: 150, background: TILE_COLORS[i % TILE_COLORS.length], display: "flex", alignItems: "flex-end", justifyContent: "center", overflow: "hidden" }}>
              {x.headshotUrl ? (
                <img src={x.headshotUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <svg width="110" height="110" viewBox="0 0 100 100" aria-hidden="true">
                  <circle cx="50" cy="40" r="19" fill="rgba(15,42,35,0.18)" />
                  <path d="M12 100c4-22 19-36 38-36s34 14 38 36z" fill="rgba(15,42,35,0.18)" />
                </svg>
              )}
            </span>
            <span className="col" style={{ padding: "10px 12px 12px", gap: 3 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>{x.name}</span>
              {x.jobTitle ? <span className="small muted" style={{ lineHeight: 1.35 }}>{x.jobTitle}</span> : null}
              <span className="small strong" style={{ color: "var(--brand)" }}>{x.sessions.length === 1 ? "1 session" : `${x.sessions.length} sessions`}</span>
            </span>
          </button>
        ))}
      </div>
      <SpeakerSheet speakerId={open} onClose={() => setOpen(null)} />
    </AppScreen>
  );
}
