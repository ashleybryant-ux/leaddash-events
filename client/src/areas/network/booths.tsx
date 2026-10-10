/** Exhibitors and sponsors, the venue map, and lead scanning for booth staff. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AppScreen, BackBar, useEventApp } from "../../shells/AttendeeShell";
import { Empty, ErrorNote, Field, PageLoading } from "../../ui/components";
import { IconSearch } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtWhen } from "@shared/format";
import { BackHeader, downloadText, LightTabs, PersonAvatar } from "./shared";

type Vendor = RouterOutputs["network"]["exhibitors"]["list"][number];

const msgBtn = { width: 92, height: 38, flexShrink: 0, padding: 0, borderRadius: 10 } as const;

function Logo({ v, size = 44 }: { v: Vendor; size?: number }) {
  if (v.logoUrl) {
    return (
      <span style={{ width: size, height: size, flexShrink: 0, borderRadius: 10, border: "1px solid var(--line)", background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        <img src={v.logoUrl} alt={`${v.company} logo`} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" style={{ width: size, height: size, flexShrink: 0, borderRadius: 10, background: "var(--brand-tint)", color: "var(--brand)", fontSize: Math.round(size * 0.36), fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {v.company.slice(0, 1).toUpperCase()}
    </span>
  );
}

const vendorLine = (v: Vendor) => [v.booth ? `Booth ${v.booth}` : "", v.category].filter(Boolean).join(" · ");

/** Opens a conversation with an exhibitor's contact. */
function useMessageVendor() {
  const { slug, base } = useEventApp();
  const [, navigate] = useLocation();
  const m = trpc.network.exhibitors.message.useMutation();
  return {
    pending: m.isPending,
    open: async (vendorId: number) => {
      try {
        const { threadId } = await m.mutateAsync({ slug, vendorId });
        navigate(`${base}/messages/${threadId}`);
      } catch (err) {
        toast(errorText(err), true);
      }
    },
  };
}

/** /exhibitors */
export function ExhibitorsScreen() {
  const { slug, base, event } = useEventApp();
  const [tab, setTab] = useState<"all" | "sponsors" | "exhibitors">("all");
  const list = trpc.network.exhibitors.list.useQuery({ slug }, { enabled: event.features.exhibitors });
  const msg = useMessageVendor();
  const all = list.data ?? [];
  const sponsors = all.filter((v) => v.sponsor);
  const exhibitors = all.filter((v) => v.kind !== "sponsor");
  const levels = Array.from(new Set(sponsors.map((v) => v.level || "Sponsors")));
  const canMessage = (v: Vendor) => event.features.messaging && v.canMessage;

  return (
    <AppScreen
      header={
        <BackHeader title="Exhibitors and sponsors" back={`${base}/more`}>
          <LightTabs
            label="Show"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "all", label: "All" },
              { key: "sponsors", label: "Sponsors" },
              { key: "exhibitors", label: "Exhibitors" },
            ]}
          />
        </BackHeader>
      }
      bodyStyle={{ gap: 10, paddingTop: 14 }}
    >
      {!event.features.exhibitors ? (
        <Empty>Exhibitors are not listed for this event.</Empty>
      ) : list.isLoading ? (
        <PageLoading />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : !all.length ? (
        <Empty>Exhibitors will be listed here soon.</Empty>
      ) : (
        <>
          {tab !== "exhibitors"
            ? levels.map((level) => (
                <div key={level} className="col" style={{ gap: 10 }}>
                  <div className="label-caps" style={{ fontWeight: 800 }}>{level}</div>
                  {sponsors
                    .filter((v) => (v.level || "Sponsors") === level)
                    .map((v) => (
                      <div key={v.id} className="card col" style={{ padding: 14, gap: 10 }}>
                        <Link href={`${base}/exhibitors/${v.id}`} style={{ height: 70, borderRadius: 10, background: v.logoUrl ? "#FFFFFF" : "var(--brand-tint)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", textDecoration: "none", color: "var(--brand)", fontWeight: 800, fontSize: 18 }}>
                          {v.logoUrl ? <img src={v.logoUrl} alt={`${v.company} logo`} style={{ maxHeight: 62, maxWidth: "90%", objectFit: "contain" }} /> : v.company}
                        </Link>
                        <div className="row-between">
                          <Link href={`${base}/exhibitors/${v.id}`} className="col grow" style={{ gap: 2, textDecoration: "none", color: "inherit" }}>
                            <span style={{ fontSize: 15, fontWeight: 800 }}>{v.company}</span>
                            {vendorLine(v) ? <span className="small muted">{vendorLine(v)}</span> : null}
                          </Link>
                          {canMessage(v) ? (
                            <button className="btn btn-sm" style={msgBtn} disabled={msg.pending} onClick={() => msg.open(v.id)}>
                              Message
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                </div>
              ))
            : null}
          {tab !== "sponsors" && exhibitors.length ? (
            <>
              <div className="label-caps" style={{ fontWeight: 800, paddingTop: 4 }}>Exhibitors</div>
              <div className="card list" style={{ overflow: "hidden" }}>
                {exhibitors.map((v) => (
                  <div key={v.id} className="row" style={{ padding: "12px 14px", gap: 12 }}>
                    <Link href={`${base}/exhibitors/${v.id}`} className="row grow" style={{ gap: 12, textDecoration: "none", color: "inherit" }}>
                      <Logo v={v} />
                      <span className="grow col" style={{ gap: 2 }}>
                        <span style={{ fontSize: 14, fontWeight: 700 }}>{v.company}</span>
                        {vendorLine(v) ? <span className="small muted">{vendorLine(v)}</span> : null}
                      </span>
                    </Link>
                    {canMessage(v) ? (
                      <button className="btn btn-sm" style={msgBtn} disabled={msg.pending} onClick={() => msg.open(v.id)}>
                        Message
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {tab === "sponsors" && !sponsors.length ? <Empty>No sponsors listed yet.</Empty> : null}
          {tab === "exhibitors" && !exhibitors.length ? <Empty>No exhibitors listed yet.</Empty> : null}
        </>
      )}
    </AppScreen>
  );
}

/** /exhibitors/:vendorId */
export function ExhibitorScreen({ vendorId }: { vendorId: number }) {
  const { slug, base, event } = useEventApp();
  const v = trpc.network.exhibitors.get.useQuery({ slug, vendorId });
  const msg = useMessageVendor();
  const d = v.data;
  const site = d?.website ? (/^https?:\/\//i.test(d.website) ? d.website : `https://${d.website}`) : "";

  return (
    <AppScreen header={<BackBar title={d?.company ?? ""} back={`${base}/exhibitors`} />} bodyStyle={{ gap: 14 }}>
      {v.isLoading ? (
        <PageLoading />
      ) : v.error ? (
        <ErrorNote error={v.error} />
      ) : d ? (
        <>
          <div className="col" style={{ alignItems: "center", gap: 8, textAlign: "center" }}>
            <Logo v={d} size={88} />
            <div style={{ fontSize: 21, fontWeight: 800 }}>{d.company}</div>
            {vendorLine(d) ? <div className="muted" style={{ fontSize: 14 }}>{vendorLine(d)}</div> : null}
            {d.sponsor && d.level ? <span className="pill">{d.level}</span> : null}
          </div>
          <div className="grid-2">
            {event.features.messaging && d.canMessage ? (
              <button className="btn btn-primary btn-lg" style={{ height: 48 }} disabled={msg.pending} onClick={() => msg.open(d.id)}>
                Message
              </button>
            ) : null}
            {d.booth ? (
              <Link href={`${base}/map?q=${encodeURIComponent(`Booth ${d.booth}`)}`} className="btn btn-lg" style={{ height: 48 }}>
                Find booth
              </Link>
            ) : null}
          </div>
          {d.offer ? (
            <div className="banner banner-ok" style={{ justifyContent: "flex-start" }}>
              {d.offer}
            </div>
          ) : null}
          {d.description ? (
            <div className="card col gap-8" style={{ padding: 14 }}>
              <div className="strong" style={{ fontSize: 14, fontWeight: 800 }}>About</div>
              <div style={{ fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{d.description}</div>
            </div>
          ) : null}
          {site ? (
            <a className="btn btn-block" href={site} target="_blank" rel="noopener noreferrer">
              Visit website
            </a>
          ) : null}
        </>
      ) : null}
    </AppScreen>
  );
}

const PIN_COLORS: Record<string, string> = { room: "var(--brand)", booth: "#3B5B8C", service: "#8A5A00", meet: "#6B4A9C" };

/** /map */
export function FloorMapScreen() {
  const { slug, base } = useEventApp();
  const maps = trpc.network.maps.list.useQuery({ slug });
  const [mapId, setMapId] = useState<number | null>(null);
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const all = maps.data ?? [];
  const query = q.trim().toLowerCase();
  const matches = useMemo(
    () =>
      query
        ? all.flatMap((m) => m.pins.map((p, i) => ({ map: m, pin: p, i }))).filter(({ pin }) => pin.label.toLowerCase().includes(query) || pin.vendor.toLowerCase().includes(query))
        : [],
    [all, query]
  );
  // Jump to the level of the first match.
  const current = all.find((m) => m.id === (mapId ?? (matches[0]?.map.id ?? all[0]?.id))) ?? all[0];
  const hits = new Set(matches.filter((x) => x.map.id === current?.id).map((x) => x.i));

  return (
    <AppScreen
      header={
        <BackHeader title="Venue map" back={`${base}/more`}>
          {all.length > 1 ? <LightTabs label="Level" value={current?.id ?? 0} onChange={(id) => setMapId(id)} tabs={all.map((m) => ({ key: m.id, label: m.name }))} /> : null}
        </BackHeader>
      }
      bodyStyle={{ gap: 12 }}
    >
      {maps.isLoading ? (
        <PageLoading />
      ) : maps.error ? (
        <ErrorNote error={maps.error} />
      ) : !current ? (
        <Empty>The venue map will be posted here soon.</Empty>
      ) : (
        <>
          <div role="img" aria-label={`${current.name} map`} style={{ position: "relative", background: "#FFFFFF", border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden" }}>
            {current.imageUrl ? <img src={current.imageUrl} alt="" style={{ display: "block", width: "100%", height: "auto" }} /> : <div style={{ height: 300 }} />}
            {current.pins.map((p, i) => {
              const hit = hits.has(i);
              return (
                <span
                  key={i}
                  title={p.vendor ? `${p.label} · ${p.vendor}` : p.label}
                  style={{
                    position: "absolute",
                    left: `${p.x}%`,
                    top: `${p.y}%`,
                    transform: "translate(-50%, -50%)",
                    maxWidth: "40%",
                    padding: hit ? "4px 8px" : "2px 6px",
                    borderRadius: 6,
                    background: hit ? "var(--accent)" : PIN_COLORS[p.kind] ?? "var(--brand)",
                    color: hit ? "var(--accent-ink)" : "#FFFFFF",
                    fontSize: hit ? 12 : 10,
                    fontWeight: 800,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    boxShadow: hit ? "0 0 0 3px rgba(232,138,58,0.35)" : "0 1px 2px rgba(15,42,35,0.25)",
                    zIndex: hit ? 2 : 1,
                  }}
                >
                  {p.label}
                </span>
              );
            })}
          </div>
          <label style={{ height: 44, borderRadius: 12, border: "1px solid #D5DEDA", background: "#FFFFFF", color: "var(--muted)", display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
            <IconSearch />
            <input aria-label="Find a room or booth" placeholder="Find a room or booth" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, border: "none", outline: "none", fontSize: 14, color: "var(--ink)", background: "#FFFFFF", minWidth: 0 }} />
          </label>
          {query && !matches.length ? <Empty>Nothing on the map matches that.</Empty> : null}
          {matches.slice(0, 12).map(({ map, pin, i }) => (
            <button
              key={`${map.id}-${i}`}
              type="button"
              onClick={() => setMapId(map.id)}
              style={{ background: "#FFFFFF", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, textAlign: "left", cursor: "pointer" }}
            >
              <span className="col" style={{ gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{pin.vendor ? `${pin.label} · ${pin.vendor}` : pin.label}</span>
                <span className="small muted">{map.name}</span>
              </span>
              <span style={{ width: 12, height: 12, flexShrink: 0, borderRadius: 3, background: "var(--accent)" }} />
            </button>
          ))}
          {query && matches.length && matches[0].pin.vendorId ? (
            <Link href={`${base}/exhibitors/${matches[0].pin.vendorId}`} className="btn btn-block">
              See {matches[0].pin.vendor}
            </Link>
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

type DetectorLike = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };

/** Camera scanning with the browser's BarcodeDetector, when the device has one. */
function useBadgeScanner(onCode: (code: string) => void, paused: boolean) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"starting" | "on" | "unsupported" | "denied">("starting");
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const Ctor = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => DetectorLike }).BarcodeDetector;
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
      setState("unsupported");
      return;
    }
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let last = "";
    const detector = new Ctor({ formats: ["qr_code"] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(async (s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => undefined);
        }
        setState("on");
        timer = setInterval(async () => {
          if (pausedRef.current || !video.current || video.current.readyState < 2) return;
          try {
            const codes = await detector.detect(video.current);
            const value = codes[0]?.rawValue;
            if (value && value !== last) {
              last = value;
              onCodeRef.current(value);
              setTimeout(() => (last = ""), 4000);
            }
          } catch {
            /* a frame that could not be read */
          }
        }, 400);
      })
      .catch(() => setState("denied"));
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return { video, state };
}

/** /leads */
export function LeadScanScreen() {
  const { slug, base } = useEventApp();
  const utils = trpc.useUtils();
  const ctx = trpc.network.leads.context.useQuery({ slug });
  const [vendorId, setVendorId] = useState<number | null>(null);
  const vendor = ctx.data?.find((v) => v.id === vendorId) ?? ctx.data?.[0];
  const lookup = trpc.network.leads.lookup.useMutation();
  const save = trpc.network.leads.save.useMutation();
  const exportCsv = trpc.network.leads.exportCsv.useMutation();
  const leads = trpc.network.leads.list.useQuery({ slug, vendorId: vendor?.id ?? 0 }, { enabled: !!vendor });
  type Found = RouterOutputs["network"]["leads"]["lookup"];
  const [found, setFound] = useState<Found | null>(null);
  const [rating, setRating] = useState<"hot" | "warm" | "cold">("warm");
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");

  const look = async (code: string) => {
    if (!vendor) return;
    try {
      const res = await lookup.mutateAsync({ slug, vendorId: vendor.id, code });
      setFound(res);
      setRating(res.existing?.rating ?? "warm");
      setNote(res.existing?.note ?? "");
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  const scanner = useBadgeScanner((code) => void look(code), !!found || !vendor);

  return (
    <AppScreen
      header={
        <BackBar
          back={`${base}/more`}
          title={
            <span className="col" style={{ gap: 0 }}>
              <span style={{ fontSize: 16, fontWeight: 800 }}>Scan leads</span>
              {vendor ? <span className="small muted clip" style={{ fontWeight: 500 }}>{[vendor.booth ? `Booth ${vendor.booth}` : "", vendor.company].filter(Boolean).join(" · ")}</span> : null}
            </span>
          }
          right={leads.data ? <span style={{ fontSize: 13, fontWeight: 800, color: "var(--brand)", paddingRight: 6 }}>{leads.data.length} lead{leads.data.length === 1 ? "" : "s"}</span> : null}
        />
      }
      bodyStyle={{ gap: 12 }}
    >
      {ctx.isLoading ? (
        <PageLoading />
      ) : ctx.error ? (
        <ErrorNote error={ctx.error} />
      ) : !vendor ? (
        <Empty>Lead scanning is for booth staff. Ask the event team to add your email to your booth.</Empty>
      ) : (
        <>
          {ctx.data && ctx.data.length > 1 ? (
            <Field label="Booth">
              <select className="select" value={vendor.id} onChange={(e) => { setVendorId(Number(e.target.value)); setFound(null); }}>
                {ctx.data.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.company}
                    {v.booth ? ` (Booth ${v.booth})` : ""}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <div style={{ position: "relative", height: 200, borderRadius: 16, background: "var(--side)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            <video ref={scanner.video} muted playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: scanner.state === "on" ? 1 : 0 }} />
            <div style={{ position: "relative", width: 140, height: 140, border: "3px solid #FFFFFF", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--side-text)", fontSize: 12, fontWeight: 700, textAlign: "center", padding: 10 }}>
              {scanner.state === "on" ? "" : scanner.state === "starting" ? "Starting camera" : scanner.state === "denied" ? "Allow the camera, or type the code below" : "Type the badge code below"}
            </div>
            {scanner.state === "on" && !found ? <span style={{ position: "absolute", bottom: 10, left: 0, right: 0, textAlign: "center", color: "#FFFFFF", fontSize: 12, fontWeight: 700 }}>Point at the QR code on a badge</span> : null}
          </div>
          <form
            className="row gap-8"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) void look(typed.trim()).then(() => setTyped(""));
            }}
          >
            <input className="input grow" aria-label="Badge code" placeholder="Or type the badge code" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button className="btn" style={{ width: 92, padding: 0, height: 40 }} disabled={!typed.trim() || lookup.isPending}>
              Look up
            </button>
          </form>
          {found ? (
            <div className="card col" style={{ padding: 14, gap: 12, borderColor: "#A9CBBD" }}>
              <div className="row" style={{ gap: 12 }}>
                <PersonAvatar person={found.person} size={44} />
                <span className="grow col" style={{ gap: 2 }}>
                  <span style={{ fontSize: 15, fontWeight: 800 }}>{found.person.name}</span>
                  <span className="small muted">{[found.person.jobTitle || found.person.organization, found.person.city, found.person.email].filter(Boolean).join(" · ")}</span>
                </span>
              </div>
              {found.existing ? <div className="small strong" style={{ color: "var(--brand)" }}>Already a lead. Saving updates it.</div> : null}
              <fieldset style={{ margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 6 }}>
                <legend style={{ padding: "0 0 6px", fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>Interest</legend>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
                  {(["hot", "warm", "cold"] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={rating === r}
                      onClick={() => setRating(r)}
                      style={{ height: 38, borderRadius: 9, border: rating === r ? "1.5px solid var(--brand)" : "1px solid #D5DEDA", background: rating === r ? "var(--brand)" : "#FFFFFF", color: rating === r ? "#FFFFFF" : "var(--ink)", fontSize: 13, fontWeight: rating === r ? 800 : 700, cursor: "pointer" }}
                    >
                      {r[0].toUpperCase() + r.slice(1)}
                    </button>
                  ))}
                </div>
              </fieldset>
              <Field label="Note">
                <input className="input" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <div className="grid-2">
                <button className="btn" style={{ height: 46 }} onClick={() => setFound(null)}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  style={{ height: 46, fontSize: 15 }}
                  disabled={save.isPending}
                  onClick={async () => {
                    try {
                      await save.mutateAsync({ slug, vendorId: vendor.id, attendeeId: found.person.id, rating, note: note.trim() });
                      await utils.network.leads.invalidate();
                      setFound(null);
                      toast("Lead saved");
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  Save lead
                </button>
              </div>
            </div>
          ) : null}
          <button
            className="btn btn-block"
            style={{ height: 44 }}
            disabled={exportCsv.isPending || !leads.data?.length}
            onClick={async () => {
              try {
                const res = await exportCsv.mutateAsync({ slug, vendorId: vendor.id });
                downloadText(res.filename, res.csv);
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Export my leads
          </button>
          {leads.data?.length ? (
            <div className="card list" style={{ overflow: "hidden" }}>
              {leads.data.slice(0, 50).map((l) => (
                <div key={l.id} className="row" style={{ padding: "10px 14px", gap: 10 }}>
                  <PersonAvatar person={l.person} size={36} />
                  <span className="grow col" style={{ gap: 0 }}>
                    <span className="strong clip" style={{ fontSize: 14 }}>{l.person.name}</span>
                    <span className="small muted clip">{l.note || fmtWhen(l.at)}</span>
                  </span>
                  <span className={`pill${l.rating === "hot" ? " pill-orange" : l.rating === "cold" ? " pill-gray" : ""}`}>{l.rating[0].toUpperCase() + l.rating.slice(1)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </AppScreen>
  );
}
