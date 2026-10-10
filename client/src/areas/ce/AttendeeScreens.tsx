/** Attendee app screens: room check-in, evaluation, CE credits, transcript and My badge. */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "wouter";
import { trpc } from "../../lib/trpc";
import { AppScreen, BackBar, BrandHeader, useEventApp } from "../../shells/AttendeeShell";
import { Empty, ErrorNote, PageLoading, Pill, QR } from "../../ui/components";
import { IconCheck } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtDates, fmtTime, fullName } from "@shared/format";
import { dateToZoned } from "@shared/time";
import { CertificatePrintStyle, CertificateView } from "./views";
import { QrScanner, canScanQr, downloadCsv } from "./util";

/** "10:27 AM on Apr 22, 2027" in the event's time zone. */
export function atLocal(value: Date | number | string, timeZone: string) {
  const z = dateToZoned(new Date(value), timeZone);
  return `${fmtTime(z.time)} on ${fmtDate(z.date)}`;
}

const hoursText = (h: number) => (Number.isInteger(h) ? h.toFixed(1) : String(Math.round(h * 100) / 100));

// ---------- /checkin/:sessionId ----------

export function SessionCheckIn({ sessionId }: { sessionId: number }) {
  const { slug, event, base } = useEventApp();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const status = trpc.ce.checkin.session.status.useQuery({ slug, sessionId });
  const checkIn = trpc.ce.checkin.session.checkIn.useMutation();
  const [typing, setTyping] = useState(!canScanQr());
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const tried = useRef(false);

  const submit = async (code: string) => {
    setError("");
    try {
      await checkIn.mutateAsync({ slug, sessionId, code });
      await utils.ce.checkin.session.status.invalidate({ slug, sessionId });
    } catch (err) {
      setError(errorText(err));
    }
  };

  // A scanned door code opens this page with ?code=..., so check in right away.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code");
    if (code && status.data && !status.data.checkedInAt && !tried.current) {
      tried.current = true;
      submit(code);
    }
  });

  const onScan = (raw: string) => {
    const m = raw.match(/\/e\/([^/]+)\/checkin\/(\d+)/);
    if (m && (m[1] !== slug || Number(m[2]) !== sessionId)) {
      const url = new URL(raw, window.location.origin);
      navigate(`${url.pathname}${url.search}`);
      return;
    }
    if (!checkIn.isPending) submit(raw);
  };

  if (status.isLoading) return <PageLoading />;
  if (status.error) return <AppScreen header={<BackBar title="Check in" />}><ErrorNote error={status.error} /></AppScreen>;
  const d = status.data!;
  const s = d.session;

  return (
    <AppScreen header={<BackBar title="Check in" back={`${base}/session/${sessionId}`} />} bodyStyle={{ padding: "22px 18px", gap: 18 }}>
      {!d.checkedInAt ? (
        <div className="card" style={{ borderRadius: 18, padding: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div className="strong muted" style={{ fontSize: 13 }}>Scan the code posted at the door</div>
          {!typing ? <QrScanner onCode={onScan} size={240} /> : null}
          {typing ? (
            <div className="col" style={{ width: "100%", gap: 8 }}>
              <label className="field">
                Room code
                <input className="input" value={typed} autoCapitalize="characters" autoComplete="off" onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && typed.trim() && submit(typed)} />
              </label>
              <button className="btn btn-primary btn-block" disabled={!typed.trim() || checkIn.isPending} onClick={() => submit(typed)}>
                Check in
              </button>
            </div>
          ) : null}
          {canScanQr() ? (
            <button className="btn btn-sm" style={{ borderColor: "#D5DEDA", color: "var(--ink)", fontWeight: 600, height: 40 }} onClick={() => setTyping(!typing)}>
              {typing ? "Scan the code instead" : "Type the room code instead"}
            </button>
          ) : null}
          {error ? <div className="err" role="alert" style={{ textAlign: "center" }}>{error}</div> : null}
        </div>
      ) : (
        <div style={{ background: "var(--brand-tint)", border: "1px solid #A9CBBD", borderRadius: 16, padding: 16, display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 20, background: "var(--brand)", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <IconCheck />
          </div>
          <div className="col" style={{ gap: 4 }}>
            <div className="xstrong" style={{ fontSize: 16 }}>You are checked in</div>
            <div style={{ fontSize: 14, color: "var(--ink-2)" }}>{[s.title, s.room].filter(Boolean).join(", ")}</div>
            <div style={{ fontSize: 13, color: "var(--ink-2)" }}>Checked in at {atLocal(d.checkedInAt, event.timezone)}</div>
          </div>
        </div>
      )}

      {d.checkedInAt && d.evaluation ? (
        d.evaluation.submitted ? (
          <div className="card" style={{ padding: 14, fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)" }}>
            Your evaluation is in. <Link href={`${base}/credits`}>See your CE credits</Link>
          </div>
        ) : d.evaluation.state === "open" ? (
          <Link className="btn btn-primary btn-lg btn-block" href={`${base}/eval/${sessionId}`}>
            Take evaluation
          </Link>
        ) : d.evaluation.state === "upcoming" ? (
          <div className="card" style={{ padding: 14, fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)" }}>
            The evaluation opens at {fmtTime(d.evaluation.opensAtLocal)} when the session ends. We will send you a notification when it is ready.
          </div>
        ) : null
      ) : null}
      {!d.checkedInAt ? (
        <div className="small muted" style={{ textAlign: "center" }}>
          Check-in is open from {atLocal(d.opensAt, event.timezone).split(" on ")[0]} to {atLocal(d.closesAt, event.timezone).split(" on ")[0]} on {fmtDate(s.date)}.
        </div>
      ) : null}
    </AppScreen>
  );
}

// ---------- /eval/:sessionId ----------

const ratingBtn = (on: boolean) =>
  ({
    height: 44,
    borderRadius: 10,
    border: on ? "1.5px solid var(--brand)" : "1px solid #D5DEDA",
    background: on ? "var(--brand)" : "#FFFFFF",
    fontSize: 15,
    fontWeight: on ? 800 : 700,
    color: on ? "#FFFFFF" : "var(--ink)",
    cursor: "pointer",
  }) as const;

export function EvaluationScreen({ sessionId }: { sessionId: number }) {
  const { slug, base, event } = useEventApp();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const q = trpc.ce.evaluations.forSession.useQuery({ slug, sessionId });
  const submit = trpc.ce.evaluations.submit.useMutation();
  const [answers, setAnswers] = useState<Record<string, string | number>>({});

  const title = (
    <div className="col" style={{ gap: 0 }}>
      <span style={{ fontSize: 16, fontWeight: 700 }}>Evaluation</span>
      {q.data ? <span className="small muted clip" style={{ fontWeight: 500 }}>{q.data.session.title}{q.data.session.ceHours > 0 ? ` · ${q.data.session.ceHours} CE` : ""}</span> : null}
    </div>
  );
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <AppScreen header={<BackBar title={title} />}><ErrorNote error={q.error} /></AppScreen>;
  const d = q.data!;

  if (d.status !== "open" || !d.form) {
    const msg =
      d.status === "not_checked_in"
        ? "Check in to this session first. The evaluation opens for people who attended."
        : d.status === "submitted"
          ? "You already submitted this evaluation. Thank you."
          : d.status === "upcoming"
            ? `The evaluation opens at ${"opensAt" in d && d.opensAt ? atLocal(d.opensAt, event.timezone) : "the end of the session"}.`
            : d.status === "closed"
              ? "This evaluation has closed."
              : "This session has no evaluation.";
    return (
      <AppScreen header={<BackBar title={title} />}>
        <Empty>{msg}</Empty>
        {d.status === "not_checked_in" ? (
          <Link className="btn btn-primary btn-block" href={`${base}/checkin/${sessionId}`}>
            Check in
          </Link>
        ) : d.status === "submitted" ? (
          <Link className="btn btn-block" href={`${base}/credits`}>
            See CE credits
          </Link>
        ) : null}
      </AppScreen>
    );
  }

  const form = d.form;
  const set = (id: string, v: string | number) => setAnswers({ ...answers, [id]: v });
  const missing = form.questions.filter((x) => x.required && (answers[x.id] === undefined || answers[x.id] === ""));
  const hasRating = form.questions.some((x) => x.kind === "rating");

  return (
    <AppScreen
      header={<BackBar title={title} />}
      bodyStyle={{ gap: 12 }}
      footer={
        <button
          className="btn btn-primary btn-lg btn-block"
          disabled={submit.isPending}
          onClick={async () => {
            if (missing.length) return toast(`Please answer "${missing[0].label}".`, true);
            try {
              const res = await submit.mutateAsync({ slug, sessionId, answers });
              await utils.ce.certificates.credits.invalidate();
              toast(res.certificates.length ? "Submitted. Your certificate is ready." : "Thank you. Your evaluation is in.");
              navigate(`${base}/credits`);
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          {d.session.ceHours > 0 ? "Submit and get certificate" : "Submit"}
        </button>
      }
    >
      {hasRating ? <div className="muted" style={{ fontSize: 13 }}>1 = Strongly disagree, 5 = Strongly agree</div> : null}
      {form.questions.map((x) =>
        x.kind === "text" ? (
          <label key={x.id} className="col" style={{ gap: 6, fontSize: 14, fontWeight: 700 }}>
            {x.label}
            {x.required ? "" : " (optional)"}
            <textarea className="textarea" rows={3} value={String(answers[x.id] ?? "")} onChange={(e) => set(x.id, e.target.value)} style={{ resize: "none", fontWeight: 400 }} />
          </label>
        ) : (
          <fieldset key={x.id} className="card" style={{ margin: 0, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <legend style={{ padding: "0 4px", fontSize: 14, fontWeight: 700 }}>
              {x.label}
              {x.required ? "" : " (optional)"}
            </legend>
            {x.kind === "rating" ? (
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${x.scale ?? 5}, minmax(0, 1fr))`, gap: 6 }}>
                {Array.from({ length: x.scale ?? 5 }, (_, i) => i + 1).map((n) => (
                  <button key={n} type="button" aria-pressed={answers[x.id] === n} style={ratingBtn(answers[x.id] === n)} onClick={() => set(x.id, n)}>
                    {n}
                  </button>
                ))}
              </div>
            ) : x.kind === "yesno" ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
                {(["yes", "no"] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={answers[x.id] === v} style={ratingBtn(answers[x.id] === v)} onClick={() => set(x.id, v)}>
                    {v === "yes" ? "Yes" : "No"}
                  </button>
                ))}
              </div>
            ) : (
              <div className="col" style={{ gap: 6 }}>
                {(x.options ?? []).map((o) => (
                  <button key={o} type="button" aria-pressed={answers[x.id] === o} style={{ ...ratingBtn(answers[x.id] === o), textAlign: "left", padding: "0 12px" }} onClick={() => set(x.id, o)}>
                    {o}
                  </button>
                ))}
              </div>
            )}
          </fieldset>
        )
      )}
    </AppScreen>
  );
}

// ---------- /credits and /transcript ----------

function CreditTabs({ active, light }: { active: "event" | "all"; light?: boolean }) {
  const { base } = useEventApp();
  if (!light) {
    return (
      <div role="tablist" className="segmented">
        <Link href={`${base}/credits`} role="tab" aria-selected={active === "event"}>This event</Link>
        <Link href={`${base}/transcript`} role="tab" aria-selected={active === "all"}>All years</Link>
      </div>
    );
  }
  const tab = (on: boolean) => ({ height: 36, borderRadius: 9, background: on ? "#FFFFFF" : "transparent", color: on ? "var(--ink)" : "var(--muted)", fontSize: 14, fontWeight: on ? 800 : 600, textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center" }) as const;
  return (
    <div role="tablist" style={{ margin: "0 4px", padding: 4, borderRadius: 12, background: "var(--line-2)", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 4 }}>
      <Link href={`${base}/credits`} role="tab" aria-selected={active === "event"} style={tab(active === "event")}>This event</Link>
      <Link href={`${base}/transcript`} role="tab" aria-selected={active === "all"} style={tab(active === "all")}>All years</Link>
    </div>
  );
}

/** Prints certificates on their own (Letter landscape), hiding the app. */
function PrintCertificates({ views, onDone }: { views: Parameters<typeof CertificateView>[0]["c"][]; onDone: () => void }) {
  useEffect(() => {
    const done = () => onDone();
    window.addEventListener("afterprint", done);
    const t = window.setTimeout(() => window.print(), 600);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("afterprint", done);
    };
  }, [onDone]);
  return createPortal(
    <div className="ce-print-all ce-cert-page">
      <CertificatePrintStyle />
      <style>{`.ce-print-all { position: fixed; left: -20000px; top: 0; width: 1056px; } @media print { #root { display: none !important; } .ce-print-all { position: static; width: auto; } }`}</style>
      {views.map((v, i) => (
        <CertificateView key={i} c={v} />
      ))}
    </div>,
    document.body
  );
}

const cardBtn = { height: 44, borderRadius: 12 } as const;

export function CreditsScreen() {
  const { slug, base, event } = useEventApp();
  const q = trpc.ce.certificates.credits.useQuery({ slug });
  const [printing, setPrinting] = useState(false);
  const d = q.data;
  return (
    <AppScreen
      nav="more"
      header={
        <BrandHeader title="CE credits" eyebrow={event.name}>
          <CreditTabs active="event" />
          <div style={{ background: "#FFFFFF", color: "var(--ink)", borderRadius: 14, padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div className="col" style={{ gap: 2 }}>
              <span style={{ fontSize: 28, fontWeight: 800 }}>{hoursText(d?.hours ?? 0)}</span>
              <span className="strong muted" style={{ fontSize: 13, fontWeight: 600 }}>CE hours earned</span>
            </div>
            <button className="btn" style={cardBtn} disabled={!d?.views.length} onClick={() => setPrinting(true)}>
              Download all
            </button>
          </div>
        </BrandHeader>
      }
      bodyStyle={{ gap: 10 }}
    >
      {q.isLoading ? <PageLoading /> : q.error ? <ErrorNote error={q.error} /> : null}
      {d ? (
        <>
          <div className="section-title">Certificates</div>
          {d.certificates.length ? (
            d.certificates.map((c) => (
              <div key={c.code} className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="row-between" style={{ alignItems: "flex-start" }}>
                  <div className="col" style={{ gap: 4 }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{c.title}</div>
                    <div className="muted" style={{ fontSize: 13 }}>{fmtDate(c.date)} · {hoursText(c.hours)} CE hours</div>
                  </div>
                  <Pill>Issued</Pill>
                </div>
                <div className="grid-2" style={{ gap: 8 }}>
                  <a className="btn" style={cardBtn} href={`/cert/${c.code}`}>View</a>
                  <a className="btn" style={cardBtn} href={`/cert/${c.code}?print=1`} target="_blank" rel="noopener">Download</a>
                </div>
              </div>
            ))
          ) : (
            <Empty>No certificates yet. Check in at each session and take its evaluation.</Empty>
          )}
          {d.waiting.length ? (
            <>
              <div className="section-title" style={{ paddingTop: 6 }}>Waiting on you</div>
              {d.waiting.map((w) => (
                <div key={w.sessionId} className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div className="row-between" style={{ alignItems: "flex-start" }}>
                    <div className="col" style={{ gap: 4 }}>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{w.title}</div>
                      <div className="muted" style={{ fontSize: 13 }}>{fmtDate(w.date)} · {hoursText(w.ceHours)} CE hours</div>
                    </div>
                    <Pill tone="orange">{w.state === "open" ? "Evaluation due" : `Opens ${atLocal(w.opensAt, event.timezone).split(" on ")[0]}`}</Pill>
                  </div>
                  {w.state === "open" ? (
                    <Link className="btn btn-primary" style={cardBtn} href={`${base}/eval/${w.sessionId}`}>
                      Take evaluation
                    </Link>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
          {printing ? <PrintCertificates views={d.views} onDone={() => setPrinting(false)} /> : null}
        </>
      ) : null}
    </AppScreen>
  );
}

export function TranscriptScreen() {
  const { slug, base } = useEventApp();
  const q = trpc.ce.certificates.transcript.useQuery({ slug });
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const rowStyle = { padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 } as const;
  return (
    <AppScreen
      header={
        <header className="app-bar no-print" style={{ flexDirection: "column", alignItems: "stretch", gap: 10, paddingBottom: 14 }}>
          <BackBarInner title="CE transcript" back={`${base}/credits`} />
          <CreditTabs active="all" light />
        </header>
      }
    >
      {q.isLoading ? <PageLoading /> : q.error ? <ErrorNote error={q.error} /> : null}
      {d ? (
        <>
          <div className="print-only">
            <h1 className="h2">CE transcript</h1>
            <p className="muted" style={{ margin: "4px 0 12px" }}>{d.name} · {d.orgName}</p>
          </div>
          <div className="card" style={{ padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div className="col" style={{ gap: 2 }}>
              <span style={{ fontSize: 28, fontWeight: 800 }}>{hoursText(d.totalHours)}</span>
              <span className="muted" style={{ fontSize: 13, fontWeight: 600 }}>CE hours with this host</span>
            </div>
            <div className="col no-print" style={{ gap: 6 }}>
              <button
                className="btn btn-primary"
                style={cardBtn}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    downloadCsv(await utils.ce.certificates.transcriptCsv.fetch({ slug }));
                  } catch (err) {
                    toast(errorText(err), true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Download transcript
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => window.print()}>
                Print
              </button>
            </div>
          </div>
          {d.events.length || d.entries.length ? (
            <div className="card" style={{ overflow: "hidden" }}>
              <div className="list">
                {d.events.map((e) => (
                  <div key={e.eventId} style={rowStyle}>
                    <span className="col" style={{ gap: 2 }}>
                      <span className="xstrong" style={{ fontSize: 14 }}>{e.name}</span>
                      <span className="small muted">{fmtDates(e.startDate, e.endDate)} · {e.sessions} {e.sessions === 1 ? "session" : "sessions"}</span>
                    </span>
                    <span className="xstrong" style={{ fontSize: 15 }}>{hoursText(e.hours)}</span>
                  </div>
                ))}
                {d.entries.map((e) => (
                  <div key={`x${e.id}`} style={rowStyle}>
                    <span className="col" style={{ gap: 2 }}>
                      <span className="xstrong" style={{ fontSize: 14 }}>{e.title}</span>
                      <span className="small muted">{[e.provider, fmtDate(e.date)].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className="xstrong" style={{ fontSize: 15 }}>{hoursText(e.hours)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Empty>No CE hours yet.</Empty>
          )}
          <div className="small muted" style={{ lineHeight: 1.5 }}>Each certificate is still available to download from its event.</div>
        </>
      ) : null}
    </AppScreen>
  );
}

/** Back button and title row used inside a taller white header. */
function BackBarInner({ title, back }: { title: string; back: string }) {
  const [, navigate] = useLocation();
  return (
    <div className="row" style={{ gap: 8 }}>
      <button className="icon-btn" aria-label="Back" onClick={() => navigate(back)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
      <div style={{ fontSize: 18, fontWeight: 800 }}>{title}</div>
    </div>
  );
}

// ---------- /badge ----------

export function MyBadgeScreen() {
  const { slug, event } = useEventApp();
  const q = trpc.ce.checkin.myBadge.useQuery({ slug });
  const b = q.data;
  return (
    <AppScreen header={<BackBar title="My badge" />} bodyStyle={{ padding: "24px 22px", gap: 18 }}>
      {q.isLoading ? <PageLoading /> : q.error ? <ErrorNote error={q.error} /> : null}
      {b ? (
        <>
          <div className="card" style={{ borderRadius: 20, overflow: "hidden", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ width: "100%", background: "var(--brand)", color: "#FFFFFF", padding: "14px 18px", display: "flex", alignItems: "center", gap: 10 }}>
              {b.logoUrl ? <img src={b.logoUrl} alt="" style={{ width: 32, height: 32, borderRadius: 8, background: "#FFFFFF", objectFit: "contain" }} /> : null}
              <div className="xstrong" style={{ fontSize: 14 }}>{b.eventName}</div>
            </div>
            <div style={{ padding: "22px 18px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center" }}>
              <QR value={b.qr} size={210} label="Your check-in QR code" />
              <div className="col" style={{ gap: 4 }}>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{fullName({ firstName: b.firstName, lastName: b.lastName, credentials: b.credentials })}</div>
                {b.city ? <div className="muted" style={{ fontSize: 14 }}>{b.city}</div> : null}
              </div>
              {b.checkedInAt ? <Pill>Checked in at {atLocal(b.checkedInAt, event.timezone)}</Pill> : b.ribbon ? <Pill tone="gray">{b.ribbon.charAt(0) + b.ribbon.slice(1).toLowerCase()}</Pill> : null}
            </div>
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)", textAlign: "center" }}>Show this code at the registration desk to get your badge.</div>
        </>
      ) : null}
    </AppScreen>
  );
}
