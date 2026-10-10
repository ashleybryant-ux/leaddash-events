/** People directory, profiles, your own profile, and meeting requests. */
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "../../lib/trpc";
import { AppScreen, BackBar, BrandHeader, useEventApp } from "../../shells/AttendeeShell";
import { EditSection, Empty, ErrorNote, Field, KV, PageLoading, Sheet, UploadButton } from "../../ui/components";
import { IconSearch } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { eachDay, fmtDate, fmtDayDate, fmtTime } from "@shared/format";
import { ChoiceChip, PersonAvatar } from "./shared";

type Filter = "all" | "speakers" | "exhibitors" | "mine";

/** Starts or reuses a conversation and opens it. */
export function useStartChat() {
  const { slug, base } = useEventApp();
  const [, navigate] = useLocation();
  const start = trpc.network.messages.start.useMutation();
  return {
    pending: start.isPending,
    open: async (attendeeId: number) => {
      try {
        const { threadId } = await start.mutateAsync({ slug, attendeeId });
        navigate(`${base}/messages/${threadId}`);
      } catch (err) {
        toast(errorText(err), true);
      }
    },
  };
}

/** /people */
export function PeopleScreen() {
  const { slug, base, event } = useEventApp();
  const params = new URLSearchParams(window.location.search);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [interest, setInterest] = useState(params.get("interest") ?? "");
  const [organization, setOrganization] = useState("");
  const utils = trpc.useUtils();
  const list = trpc.network.people.list.useQuery({ slug, q, filter, interest: interest || undefined, organization: organization || undefined }, { placeholderData: (prev) => prev });
  const setVisible = trpc.network.people.setVisible.useMutation();
  const chat = useStartChat();
  const data = list.data;

  return (
    <AppScreen
      nav="more"
      header={
        <BrandHeader title="People">
          <label style={{ height: 44, borderRadius: 12, background: "#FFFFFF", color: "var(--muted)", display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
            <IconSearch />
            <input aria-label="Search people" placeholder="Search by name, city or specialty" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, border: "none", outline: "none", fontSize: 14, color: "var(--ink)", background: "#FFFFFF", minWidth: 0 }} />
          </label>
        </BrandHeader>
      }
    >
      <div className="chips">
        {(
          [
            ["all", "Everyone"],
            ["speakers", "Speakers"],
            ["exhibitors", "Exhibitors"],
            ["mine", "In my sessions"],
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <ChoiceChip key={k} selected={filter === k} onClick={() => setFilter(k)}>
            {label}
          </ChoiceChip>
        ))}
      </div>
      {data && (data.interests.length > 0 || data.organizations.length > 0) ? (
        <div className="grid-2">
          {data.interests.length ? (
            <select className="select" aria-label="Interest" value={interest} onChange={(e) => setInterest(e.target.value)}>
              <option value="">Any interest</option>
              {data.interests.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          ) : null}
          {data.organizations.length ? (
            <select className="select" aria-label="Organization" value={organization} onChange={(e) => setOrganization(e.target.value)}>
              <option value="">Any organization</option>
              {data.organizations.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}
      {list.isLoading ? (
        <PageLoading />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : !data?.people.length ? (
        <Empty>{q || filter !== "all" || interest || organization ? "No one matches that search." : "No one is listed yet."}</Empty>
      ) : (
        data.people.map((p) => (
          <div key={p.id} className="tile" style={{ padding: 12 }}>
            <Link href={`${base}/people/${p.id}`} className="row grow" style={{ textDecoration: "none", color: "inherit", gap: 12 }}>
              <PersonAvatar person={p} />
              <span className="grow col" style={{ gap: 2 }}>
                <span className="row gap-6" style={{ flexWrap: "wrap" }}>
                  <span className="strong" style={{ fontSize: 15 }}>{p.name}</span>
                  {p.kind === "speaker" ? <span className="pill pill-orange" style={{ fontSize: 11, padding: "2px 6px" }}>Speaker</span> : null}
                  {p.kind === "vendor" ? <span className="pill" style={{ fontSize: 11, padding: "2px 6px" }}>Exhibitor</span> : null}
                </span>
                {p.line ? <span className="small muted" style={{ fontSize: 13 }}>{p.line}</span> : null}
              </span>
            </Link>
            {event.features.messaging && !p.blockedByMe ? (
              <button className="btn btn-sm" style={{ width: 92, height: 38, padding: 0, flexShrink: 0 }} disabled={chat.pending} onClick={() => chat.open(p.id)}>
                Message
              </button>
            ) : null}
          </div>
        ))
      )}
      {data ? (
        <label className="row-between" style={{ background: "var(--line-2)", borderRadius: 12, padding: "12px 14px", fontSize: 13, fontWeight: 600, color: "var(--ink-2)" }}>
          Show me in People so others can message me
          <input
            type="checkbox"
            checked={data.meVisible}
            style={{ width: 22, height: 22, flexShrink: 0, accentColor: "var(--brand)" }}
            onChange={async (e) => {
              try {
                await setVisible.mutateAsync({ slug, visible: e.target.checked });
                await utils.network.people.list.invalidate();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          />
        </label>
      ) : null}
      <Link href={`${base}/profile`} className="btn btn-block">
        Edit my profile
      </Link>
    </AppScreen>
  );
}

/** /people/:attendeeId */
export function ProfileScreen({ attendeeId }: { attendeeId: number }) {
  const { slug, base } = useEventApp();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const p = trpc.network.people.get.useQuery({ slug, attendeeId });
  const block = trpc.network.people.block.useMutation();
  const unblock = trpc.network.people.unblock.useMutation();
  const chat = useStartChat();
  const [menu, setMenu] = useState(false);
  const d = p.data;

  return (
    <AppScreen
      header={
        <BackBar
          title=""
          back={`${base}/people`}
          right={
            d && !d.self ? (
              <button className="icon-btn" aria-label="More options" onClick={() => setMenu(true)}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
            ) : d?.self ? (
              <Link href={`${base}/profile`} className="btn btn-sm btn-w">
                Edit
              </Link>
            ) : null
          }
        />
      }
      bodyStyle={{ padding: "22px 18px 24px", gap: 16 }}
    >
      {p.isLoading ? (
        <PageLoading />
      ) : p.error ? (
        <ErrorNote error={p.error} />
      ) : d ? (
        <>
          <div className="col" style={{ alignItems: "center", gap: 8, textAlign: "center" }}>
            <PersonAvatar person={d} size={88} />
            <div style={{ fontSize: 21, fontWeight: 800 }}>{d.name}</div>
            {d.line ? <div className="muted" style={{ fontSize: 14 }}>{d.line}</div> : null}
          </div>
          {d.canMessage || d.canMeet ? (
            <div className="grid-2">
              {d.canMessage ? (
                <button className="btn btn-primary btn-lg" style={{ height: 48 }} disabled={chat.pending} onClick={() => chat.open(d.id)}>
                  Message
                </button>
              ) : null}
              {d.canMeet ? (
                <Link href={`${base}/meet/${d.id}`} className="btn btn-lg" style={{ height: 48 }}>
                  Request meeting
                </Link>
              ) : null}
            </div>
          ) : null}
          {d.blockedByMe ? <div className="banner banner-warn">You blocked this person.</div> : null}
          {d.bio ? (
            <div className="card card-pad col gap-8" style={{ padding: 14 }}>
              <div className="strong" style={{ fontSize: 14, fontWeight: 800 }}>About</div>
              <div style={{ fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{d.bio}</div>
            </div>
          ) : null}
          {d.interests.length ? (
            <div className="card card-pad col gap-8" style={{ padding: 14 }}>
              <div className="strong" style={{ fontSize: 14, fontWeight: 800 }}>Interests</div>
              <div className="row wrap gap-8">
                {d.interests.map((i) => (
                  <Link key={i} href={`${base}/people?interest=${encodeURIComponent(i)}`} className="chip">
                    {i}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
          {d.sharedSessions.length ? (
            <div className="card card-pad col" style={{ padding: 14, gap: 10 }}>
              <div className="strong" style={{ fontSize: 14, fontWeight: 800 }}>Sessions you both picked</div>
              {d.sharedSessions.map((s) => (
                <Link key={s.id} href={`${base}/session/${s.id}`} className="col" style={{ gap: 2, textDecoration: "none", color: "inherit" }}>
                  <span className="strong" style={{ fontSize: 14 }}>{s.title}</span>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {fmtDate(s.date)} · {fmtTime(s.startTime)}
                  </span>
                </Link>
              ))}
            </div>
          ) : null}
          <Sheet open={menu} onClose={() => setMenu(false)} label="Options">
            <div className="h3">{d.name}</div>
            {d.blockedByMe ? (
              <button
                className="btn btn-block"
                onClick={async () => {
                  await unblock.mutateAsync({ slug, attendeeId: d.id }).catch((err) => toast(errorText(err), true));
                  await utils.network.people.invalidate();
                  setMenu(false);
                }}
              >
                Unblock
              </button>
            ) : (
              <button
                className="btn btn-block btn-danger"
                onClick={async () => {
                  if (!window.confirm(`Block ${d.firstName}? You will not be able to message each other.`)) return;
                  try {
                    await block.mutateAsync({ slug, attendeeId: d.id });
                    await utils.network.invalidate();
                    setMenu(false);
                    toast("Blocked");
                    navigate(`${base}/people`);
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Block
              </button>
            )}
            <button className="btn btn-ghost btn-block" onClick={() => setMenu(false)}>
              Cancel
            </button>
          </Sheet>
        </>
      ) : null}
    </AppScreen>
  );
}

/** /profile: your own profile. */
export function EditProfileScreen() {
  const { slug, base, event } = useEventApp();
  const utils = trpc.useUtils();
  const me = trpc.network.people.me.useQuery({ slug });
  const blocked = trpc.network.people.blocked.useQuery({ slug });
  const update = trpc.network.people.updateMe.useMutation();
  const unblock = trpc.network.people.unblock.useMutation();
  type Draft = { jobTitle: string; organization: string; city: string; bio: string; credentials: string; interests: string; photoFileId: number | null; photoUrl: string | null; visible: boolean };
  const [d, setD] = useState<Draft | null>(null);
  const m = me.data;
  useEffect(() => {
    if (m && !d) setD({ ...m, interests: m.interests.join(", ") });
  }, [m, d]);
  const reset = () => m && setD({ ...m, interests: m.interests.join(", ") });

  return (
    <AppScreen header={<BackBar title="My profile" back={`${base}/people`} />}>
      {me.isLoading || !d ? (
        me.error ? <ErrorNote error={me.error} /> : <PageLoading />
      ) : m ? (
        <>
          <div className="col" style={{ alignItems: "center", gap: 8, textAlign: "center" }}>
            <PersonAvatar person={{ ...m, photoUrl: d.photoUrl }} size={88} />
            <div style={{ fontSize: 21, fontWeight: 800 }}>
              {m.firstName} {m.lastName}
              {m.credentials ? `, ${m.credentials}` : ""}
            </div>
          </div>
          <div className="card card-pad">
            <EditSection
              title="Profile"
              saving={update.isPending}
              onCancel={reset}
              onSave={async () => {
                await update.mutateAsync({
                  slug,
                  jobTitle: d.jobTitle,
                  organization: d.organization,
                  city: d.city,
                  bio: d.bio,
                  credentials: d.credentials,
                  interests: d.interests.split(",").map((s) => s.trim()).filter(Boolean),
                  photoFileId: d.photoFileId,
                  visible: d.visible,
                });
                await utils.network.people.invalidate();
                await utils.core.events.me.invalidate();
                setD(null);
                toast("Saved");
              }}
              view={
                <div className="col" style={{ gap: 0 }}>
                  <KV label="Credentials">{m.credentials}</KV>
                  <KV label="Job title">{m.jobTitle}</KV>
                  <KV label="Organization">{m.organization}</KV>
                  <KV label="City">{m.city}</KV>
                  <KV label="Interests">{m.interests.join(", ")}</KV>
                  <KV label="About">{m.bio}</KV>
                  <KV label="Show me in People">{m.visible ? "Yes" : "No"}</KV>
                </div>
              }
              edit={
                <div className="col gap-12">
                  <div className="row gap-8">
                    <PersonAvatar person={{ ...m, photoUrl: d.photoUrl }} size={48} />
                    <UploadButton eventId={event.id} label={d.photoUrl ? "Replace photo" : "Add photo"} className="btn btn-sm" onUploaded={(f) => setD({ ...d, photoFileId: f.id, photoUrl: f.url })} />
                    {d.photoUrl ? (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setD({ ...d, photoFileId: null, photoUrl: null })}>
                        Remove
                      </button>
                    ) : null}
                  </div>
                  <div className="grid-2">
                    <Field label="Credentials">
                      <input className="input" value={d.credentials} maxLength={60} placeholder="LPC" onChange={(e) => setD({ ...d, credentials: e.target.value })} />
                    </Field>
                    <Field label="Job title">
                      <input className="input" value={d.jobTitle} maxLength={120} onChange={(e) => setD({ ...d, jobTitle: e.target.value })} />
                    </Field>
                    <Field label="Organization">
                      <input className="input" value={d.organization} maxLength={160} onChange={(e) => setD({ ...d, organization: e.target.value })} />
                    </Field>
                    <Field label="City">
                      <input className="input" value={d.city} maxLength={120} placeholder="Atlanta, GA" onChange={(e) => setD({ ...d, city: e.target.value })} />
                    </Field>
                  </div>
                  <Field label="Interests" hint="Separate with commas">
                    <input className="input" value={d.interests} onChange={(e) => setD({ ...d, interests: e.target.value })} placeholder="Trauma, Group practice" />
                  </Field>
                  <Field label="About">
                    <textarea className="textarea" rows={4} maxLength={1500} value={d.bio} onChange={(e) => setD({ ...d, bio: e.target.value })} />
                  </Field>
                  <label className="check">
                    <input type="checkbox" checked={d.visible} onChange={(e) => setD({ ...d, visible: e.target.checked })} />
                    Show me in People so others can message me
                  </label>
                </div>
              }
            />
          </div>
          {blocked.data?.length ? (
            <div className="card card-pad col gap-8">
              <span className="h3" style={{ fontSize: 14 }}>People you blocked</span>
              <div className="list">
                {blocked.data.map((b) => (
                  <div key={b.id} className="row" style={{ padding: "10px 0" }}>
                    <PersonAvatar person={b} size={36} />
                    <span className="grow strong">{b.name}</span>
                    <button
                      className="btn btn-sm btn-w"
                      onClick={async () => {
                        await unblock.mutateAsync({ slug, attendeeId: b.id }).catch((err) => toast(errorText(err), true));
                        await utils.network.people.invalidate();
                      }}
                    >
                      Unblock
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </AppScreen>
  );
}

/** /meet/:attendeeId */
export function MeetingRequestScreen({ attendeeId }: { attendeeId: number }) {
  const { slug, base, event } = useEventApp();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const person = trpc.network.people.get.useQuery({ slug, attendeeId });
  const maps = trpc.network.maps.list.useQuery({ slug });
  const days = eachDay(event.startDate, event.endDate);
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(days.find((d) => d >= today) ?? days[0]);
  const [minutes, setMinutes] = useState(30);
  const [time, setTime] = useState<string | null>(null);
  const [place, setPlace] = useState("");
  const [otherPlace, setOtherPlace] = useState("");
  const [note, setNote] = useState("");
  const free = trpc.network.meetings.freeTimes.useQuery({ slug, attendeeId, date, minutes });
  const request = trpc.network.meetings.request.useMutation();
  const places = Array.from(
    new Set(
      (maps.data ?? [])
        .flatMap((m) => m.pins)
        .sort((a, b) => Number(b.kind === "meet") - Number(a.kind === "meet"))
        .filter((p) => p.kind === "meet" || p.kind === "room")
        .map((p) => p.label)
    )
  );
  const where = places.length && place !== "__other" ? place || places[0] : otherPlace;

  return (
    <AppScreen
      header={<BackBar title={<span className="col" style={{ gap: 0 }}><span style={{ fontSize: 16, fontWeight: 800 }}>Request a meeting</span>{person.data ? <span className="small muted" style={{ fontWeight: 500 }}>With {person.data.name}</span> : null}</span>} back={`${base}/people/${attendeeId}`} />}
      footer={
        <button
          className="btn btn-primary btn-lg btn-block"
          disabled={!time || request.isPending}
          onClick={async () => {
            if (!time) return;
            try {
              await request.mutateAsync({ slug, attendeeId, date, startTime: time, minutes, place: where.trim(), note: note.trim() });
              await utils.network.meetings.mine.invalidate();
              toast("Request sent");
              navigate(`${base}/messages`);
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Send request
        </button>
      }
      bodyStyle={{ gap: 14 }}
    >
      {person.error ? <ErrorNote error={person.error} /> : null}
      <div className="chips">
        {days.map((d) => (
          <ChoiceChip key={d} selected={d === date} onClick={() => { setDate(d); setTime(null); }}>
            {d === date ? fmtDayDate(d) : fmtDayDate(d).slice(0, 3)}
          </ChoiceChip>
        ))}
      </div>
      <div className="sub" style={{ fontWeight: 700 }}>Times you are both free</div>
      {free.isLoading ? (
        <PageLoading />
      ) : !free.data?.length ? (
        <Empty>No shared free time that day.</Empty>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          {free.data.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={t === time}
              onClick={() => setTime(t)}
              style={{ height: 44, borderRadius: 10, border: t === time ? "1.5px solid var(--brand)" : "1px solid #D5DEDA", background: t === time ? "var(--brand)" : "#FFFFFF", color: t === time ? "#FFFFFF" : "var(--ink)", fontSize: 14, fontWeight: t === time ? 800 : 700, cursor: "pointer" }}
            >
              {fmtTime(t)}
            </button>
          ))}
        </div>
      )}
      <Field label="Length">
        <select className="select" value={minutes} onChange={(e) => { setMinutes(Number(e.target.value)); setTime(null); }}>
          {[15, 30, 45, 60].map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </select>
      </Field>
      {places.length ? (
        <Field label="Where">
          <select className="select" value={place || places[0]} onChange={(e) => setPlace(e.target.value)}>
            {places.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value="__other">Somewhere else</option>
          </select>
        </Field>
      ) : null}
      {!places.length || place === "__other" ? (
        <Field label={places.length ? "Place" : "Where"}>
          <input className="input" value={otherPlace} maxLength={120} placeholder="Networking lounge" onChange={(e) => setOtherPlace(e.target.value)} />
        </Field>
      ) : null}
      <Field label="Note (optional)">
        <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </AppScreen>
  );
}
