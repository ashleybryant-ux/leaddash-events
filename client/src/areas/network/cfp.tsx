/** /cfp/:slug: the public call for proposals. Submitters sign in first, then fill in the form. */
import { useEffect, useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { brandStyle } from "../../shells/AttendeeShell";
import { SignIn } from "../../core/SignIn";
import { Avatar, ErrorNote, Field, PageLoading, RichText, UploadButton } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtWhen } from "@shared/format";

type Info = RouterOutputs["network"]["proposals"]["info"];
type CoPresenter = { name: string; email: string; credentials: string };
type Draft = {
  name: string;
  credentials: string;
  organization: string;
  bio: string;
  headshotFileId: number | null;
  headshotUrl: string | null;
  title: string;
  abstract: string;
  objectives: string[];
  format: string;
  track: string;
  ceRequested: boolean;
  coPresenters: CoPresenter[];
  answers: Record<string, string>;
};

const STATUS: Record<string, string> = { submitted: "Submitted", in_review: "In review", accepted: "Accepted", waitlisted: "Waitlist", declined: "Not accepted", withdrawn: "Withdrawn" };

const draftKey = (slug: string, userId: number) => `ld-cfp-${slug}-${userId}`;

function emptyDraft(info: Info, name: string): Draft {
  return { name, credentials: "", organization: "", bio: "", headshotFileId: null, headshotUrl: null, title: "", abstract: "", objectives: ["", "", ""], format: info.formats[0] ?? "", track: "", ceRequested: true, coPresenters: [], answers: {} };
}

function loadDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

function Header({ info }: { info: Info }) {
  return (
    <header className="app-header">
      <div className="row" style={{ gap: 12 }}>
        {info.logoUrl ? <img src={info.logoUrl} alt={`${info.orgName} logo`} style={{ width: 48, height: 48, objectFit: "contain", borderRadius: 10, background: "#FFFFFF", border: "1px solid var(--logo-line)", padding: 4 }} /> : null}
        <div className="col" style={{ gap: 2 }}>
          <div className="eyebrow">{info.orgName}</div>
          <div className="title">Call for proposals</div>
          <div className="small" style={{ color: "var(--header-sub)" }}>
            {info.eventName}
            {info.closesOn ? ` · Due ${fmtDate(info.closesOn)}` : ""}
          </div>
        </div>
      </div>
    </header>
  );
}

function Form({ slug, info, me }: { slug: string; info: Info; me: { id: number; name: string; email: string } }) {
  const utils = trpc.useUtils();
  const submit = trpc.network.proposals.submit.useMutation();
  const key = draftKey(slug, me.id);
  const [d, setD] = useState<Draft>(() => loadDraft(key) ?? emptyDraft(info, me.name));
  const [done, setDone] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const objectives = d.objectives.map((o) => o.trim()).filter(Boolean);
  const missing = [
    d.name.trim().length < 2 ? "your name" : "",
    d.title.trim().length < 3 ? "a session title" : "",
    d.abstract.trim().length < 20 ? "an abstract" : "",
    !objectives.length ? "a learning objective" : "",
    info.formats.length && !d.format ? "a format" : "",
    ...info.questions.filter((q) => q.required && !d.answers[q.key]?.trim()).map((q) => q.label.toLowerCase()),
  ].filter(Boolean);

  if (done) {
    return (
      <div className="card col" style={{ padding: 18, gap: 10 }}>
        <div className="h2">Thank you</div>
        <p className="muted" style={{ margin: 0 }}>
          We received "{done}". We sent a confirmation to {me.email} and will email you when decisions are made.
        </p>
        <button className="btn btn-block" onClick={() => setDone(null)}>
          Submit another
        </button>
      </div>
    );
  }

  return (
    <form
      className="col gap-14"
      onSubmit={async (e) => {
        e.preventDefault();
        if (missing.length) {
          toast(`Add ${missing[0]}.`, true);
          return;
        }
        try {
          await submit.mutateAsync({
            slug,
            name: d.name.trim(),
            credentials: d.credentials.trim(),
            organization: d.organization.trim(),
            bio: d.bio.trim(),
            headshotFileId: d.headshotFileId,
            title: d.title.trim(),
            abstract: d.abstract.trim(),
            objectives,
            format: d.format,
            track: d.track,
            ceRequested: d.ceRequested,
            coPresenters: d.coPresenters.filter((c) => c.name.trim() && c.email.trim()).map((c) => ({ name: c.name.trim(), email: c.email.trim(), credentials: c.credentials.trim() })),
            answers: d.answers,
          });
          try {
            localStorage.removeItem(key);
          } catch {
            /* private window */
          }
          setDone(d.title.trim());
          setD(emptyDraft(info, d.name));
          await utils.network.proposals.mine.invalidate();
          window.scrollTo(0, 0);
        } catch (err) {
          toast(errorText(err), true);
        }
      }}
    >
      <Field label="Session title">
        <input className="input" value={d.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      {info.formats.length || info.tracks.length ? (
        <div className="grid-2">
          {info.formats.length ? (
            <Field label="Format">
              <select className="select" value={d.format} onChange={(e) => set({ format: e.target.value })}>
                {info.formats.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {info.tracks.length ? (
            <Field label="Track">
              <select className="select" value={d.track} onChange={(e) => set({ track: e.target.value })}>
                <option value="">Pick a track</option>
                {info.tracks.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      ) : null}
      <Field label="Abstract" hint="Up to 300 words">
        <textarea className="textarea" rows={7} maxLength={3000} value={d.abstract} onChange={(e) => set({ abstract: e.target.value })} />
      </Field>
      <div className="col gap-6">
        <span className="field">Learning objectives</span>
        {d.objectives.map((o, i) => (
          <input key={i} className="input" aria-label={`Objective ${i + 1}`} placeholder={`Objective ${i + 1}`} value={o} maxLength={300} onChange={(e) => set({ objectives: d.objectives.map((x, j) => (j === i ? e.target.value : x)) })} />
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={d.ceRequested} onChange={(e) => set({ ceRequested: e.target.checked })} />
        Request CE credit for this session
      </label>
      {info.questions.map((q) => (
        <Field key={q.key} label={q.required ? q.label : `${q.label} (optional)`}>
          {q.kind === "select" ? (
            <select className="select" value={d.answers[q.key] ?? ""} onChange={(e) => set({ answers: { ...d.answers, [q.key]: e.target.value } })}>
              <option value="">Pick one</option>
              {(q.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : q.kind === "textarea" ? (
            <textarea className="textarea" rows={3} maxLength={2000} value={d.answers[q.key] ?? ""} onChange={(e) => set({ answers: { ...d.answers, [q.key]: e.target.value } })} />
          ) : (
            <input className="input" maxLength={2000} value={d.answers[q.key] ?? ""} onChange={(e) => set({ answers: { ...d.answers, [q.key]: e.target.value } })} />
          )}
        </Field>
      ))}

      <div className="card col" style={{ padding: 14, gap: 12 }}>
        <div className="row-between">
          <span className="col" style={{ gap: 2 }}>
            <span className="h3" style={{ fontSize: 14 }}>Presenters</span>
            <span className="small muted">
              {d.name || me.email}
              {d.credentials ? `, ${d.credentials}` : ""} (you)
              {d.coPresenters.length ? ` and ${d.coPresenters.length} more` : ""}
            </span>
          </span>
          {d.coPresenters.length < 6 ? (
            <button type="button" className="btn btn-sm" style={{ width: 120, padding: 0 }} onClick={() => set({ coPresenters: [...d.coPresenters, { name: "", email: "", credentials: "" }] })}>
              Add presenter
            </button>
          ) : null}
        </div>
        <div className="grid-2">
          <Field label="Your name">
            <input className="input" value={d.name} maxLength={120} autoComplete="name" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Credentials">
            <input className="input" value={d.credentials} maxLength={60} placeholder="PhD, LPC" onChange={(e) => set({ credentials: e.target.value })} />
          </Field>
        </div>
        <Field label="Organization">
          <input className="input" value={d.organization} maxLength={160} onChange={(e) => set({ organization: e.target.value })} />
        </Field>
        <Field label="Short bio">
          <textarea className="textarea" rows={4} maxLength={2000} value={d.bio} onChange={(e) => set({ bio: e.target.value })} />
        </Field>
        <div className="row gap-8">
          <Avatar url={d.headshotUrl} name={d.name} size={48} />
          <UploadButton label={d.headshotUrl ? "Replace headshot" : "Add headshot"} className="btn btn-sm" onUploaded={(f) => set({ headshotFileId: f.id, headshotUrl: f.url })} />
          {d.headshotUrl ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ headshotFileId: null, headshotUrl: null })}>
              Remove
            </button>
          ) : null}
        </div>
        {d.coPresenters.map((c, i) => (
          <div key={i} className="col gap-8" style={{ borderTop: "1px solid var(--line-2)", paddingTop: 12 }}>
            <div className="row-between">
              <span className="strong small">Co-presenter {i + 1}</span>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => set({ coPresenters: d.coPresenters.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
            <div className="grid-2">
              <Field label="Name">
                <input className="input" value={c.name} maxLength={120} onChange={(e) => set({ coPresenters: d.coPresenters.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              </Field>
              <Field label="Credentials">
                <input className="input" value={c.credentials} maxLength={60} onChange={(e) => set({ coPresenters: d.coPresenters.map((x, j) => (j === i ? { ...x, credentials: e.target.value } : x)) })} />
              </Field>
            </div>
            <Field label="Email">
              <input className="input" type="email" value={c.email} maxLength={200} onChange={(e) => set({ coPresenters: d.coPresenters.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)) })} />
            </Field>
          </div>
        ))}
      </div>

      <div className="grid-2">
        <button
          type="button"
          className="btn btn-lg"
          onClick={() => {
            try {
              localStorage.setItem(key, JSON.stringify(d));
              toast("Draft saved on this device");
            } catch {
              toast("This browser cannot save drafts.", true);
            }
          }}
        >
          Save draft
        </button>
        <button type="submit" className="btn btn-primary btn-lg" disabled={submit.isPending}>
          Submit
        </button>
      </div>
    </form>
  );
}

/** /cfp/:slug */
export function ProposalSubmitPage({ slug }: { slug: string }) {
  const info = trpc.network.proposals.info.useQuery({ slug });
  const auth = trpc.auth.me.useQuery();
  const mine = trpc.network.proposals.mine.useQuery({ slug }, { enabled: !!auth.data });
  const signOut = trpc.auth.signOut.useMutation();
  const utils = trpc.useUtils();
  useEffect(() => {
    if (info.data) document.title = `Call for proposals · ${info.data.shortName}`;
  }, [info.data]);

  if (info.isLoading || auth.isLoading) return <PageLoading />;
  if (info.error) return <div className="app app-wide"><ErrorNote error={info.error} /></div>;
  const i = info.data!;
  const opens = i.opensOn && new Date().toISOString().slice(0, 10) < i.opensOn;

  return (
    <div className="app app-wide" style={brandStyle(i.branding, i.coverUrl)}>
      <Header info={i} />
      <main className="app-body" style={{ gap: 14 }}>
        {i.intro ? <div className="card" style={{ padding: 16 }}><RichText html={i.intro} /></div> : null}
        {!auth.data ? (
          <SignIn title="Sign in to submit" subtitle="Enter your email. We will send you a six-digit code so we can reach you about your proposal." eventName={i.shortName} />
        ) : (
          <>
            {mine.data?.length ? (
              <div className="card col" style={{ padding: 14, gap: 8 }}>
                <span className="h3" style={{ fontSize: 14 }}>Your proposals</span>
                {mine.data.map((p) => (
                  <div key={p.id} className="row-between" style={{ gap: 10 }}>
                    <span className="col grow" style={{ gap: 0 }}>
                      <span className="strong clip">{p.title}</span>
                      <span className="small muted">Sent {fmtWhen(p.createdAt)}</span>
                    </span>
                    <span className={`pill${p.status === "accepted" ? "" : p.status === "declined" || p.status === "withdrawn" ? " pill-gray" : " pill-orange"}`}>{STATUS[p.status] ?? p.status}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {i.open ? (
              <Form slug={slug} info={i} me={auth.data} />
            ) : (
              <div className="banner banner-warn">{opens ? `Proposals open ${fmtDate(i.opensOn)}.` : i.opensOn || i.closesOn ? "The call for proposals is closed." : "The call for proposals is not open yet."}</div>
            )}
            <button
              className="btn btn-ghost"
              onClick={async () => {
                await signOut.mutateAsync();
                await utils.invalidate();
              }}
            >
              Not {auth.data.email}? Sign out
            </button>
          </>
        )}
      </main>
    </div>
  );
}
