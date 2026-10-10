/**
 * /speak/:token: the speaker's own page, branded with the event. Their
 * sessions, slides and handouts (streamed upload up to 100 MB), when
 * attendees may download them, bio and photo, the speaker agreement, and
 * their registration. The token in the link is the only key.
 */
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { brandStyle } from "../../shells/AttendeeShell";
import { Avatar, ErrorNote, Field, PageLoading, Pill, readFileBase64 } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtDates, fmtTime, fmtWhen } from "@shared/format";
import { FileBadge, PickFiles, SHARE_HINT, UploadProgress, fmtSize, useUploader, type Share } from "./SessionSlides";

type Page = RouterOutputs["program"]["slides"]["page"];
type SessionItem = Page["sessions"][number];

const ROLE: Record<string, string> = { presenter: "Presenter", "co-presenter": "Co-presenter", moderator: "Moderator", panelist: "Panelist" };
const SPEAKER_SHARE: Record<Share, string> = { after_start: "After my session starts", now: "Right away", hidden: "Do not share" };

const cardHead: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--line-2)", minHeight: 34 };
const kvRow: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 10, padding: "9px 14px", borderBottom: "1px solid var(--line-2)", fontSize: 13.5 };

function Card({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card" style={{ padding: 0 }}>
      <div style={cardHead}>
        <span className="strong grow" style={{ fontSize: 15, fontWeight: 800 }}>{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

export function SpeakerPageScreen({ token }: { token: string }) {
  const q = trpc.program.slides.page.useQuery({ token }, { retry: false });
  useEffect(() => {
    if (q.data) document.title = `Your speaker page: ${q.data.event.shortName}`;
  }, [q.data]);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <div className="app"><main className="app-body"><ErrorNote error={q.error} /></main></div>;
  const d = q.data!;
  const ev = d.event;
  return (
    <div className="app" style={brandStyle(ev.branding, ev.coverUrl)}>
      <div style={{ height: 150, flexShrink: 0, backgroundColor: "var(--header-bg)", backgroundImage: "var(--header-image)", backgroundSize: "cover", backgroundPosition: "center", borderBottom: "3px solid var(--header-border)" }} />
      <div style={{ width: 52, height: 52, borderRadius: 12, background: "#FFFFFF", border: "1px solid var(--line)", margin: "-26px 0 0 18px", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", padding: ev.logoUrl ? 4 : 0, position: "relative" }}>
        {ev.logoUrl ? <img src={ev.logoUrl} alt={`${ev.orgName} logo`} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /> : <span style={{ color: "var(--brand)", fontWeight: 800, fontSize: 13 }}>{ev.shortName.slice(0, 4)}</span>}
      </div>
      <main className="app-body" style={{ padding: "12px 18px 24px", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, lineHeight: 1.2 }}>Your speaker page</h1>
        <div className="muted" style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.5 }}>
          {ev.name} · {fmtDates(ev.startDate, ev.endDate)}
        </div>
        {!d.sessions.length ? <div className="card" style={{ padding: 14, fontSize: 14 }}>Your session is not on the program yet. Check back soon.</div> : null}
        {d.sessions.map((s) => (
          <SessionBlock key={s.id} token={token} s={s} />
        ))}
        <BioCard token={token} d={d} />
        {d.agreement ? (
          <Card
            title="Speaker agreement"
            right={
              d.agreement.status === "signed" ? (
                <a className="btn btn-sm" style={{ width: 90 }} href={`/agreement/${d.agreement.code}`} target="_blank" rel="noreferrer">View PDF</a>
              ) : (
                <a className="btn btn-sm btn-primary" style={{ width: 90 }} href={`/sign/${d.agreement.code}`}>Sign now</a>
              )
            }
          >
            <div className="col" style={{ padding: "10px 14px 12px", gap: 1 }}>
              {d.agreement.status === "signed" ? (
                <>
                  <span className="strong" style={{ fontSize: 14 }}>Signed {fmtWhen(d.agreement.signedAt)}</span>
                  {d.agreement.recordingAllowed !== null ? <span className="small muted">{d.agreement.recordingAllowed ? "Recording allowed" : "Recording not allowed"}</span> : null}
                </>
              ) : (
                <span className="strong" style={{ fontSize: 14, color: "var(--warn-ink)" }}>Not signed yet</span>
              )}
            </div>
          </Card>
        ) : null}
        {d.registration ? (
          <Card title="Your registration" right={<a className="btn btn-sm" style={{ width: 104 }} href={`/get/${ev.slug}`}>Get the app</a>}>
            <div className="col" style={{ padding: "10px 14px 12px", gap: 1 }}>
              <span className="strong" style={{ fontSize: 14 }}>{d.registration.ticket || "Registered"}</span>
              <span className="small muted">{d.registration.checkedIn ? "Checked in" : `Check in with the QR code in the app${ev.venueName ? ` at ${ev.venueName}` : ""}`}</span>
            </div>
          </Card>
        ) : null}
      </main>
    </div>
  );
}

function SessionBlock({ token, s }: { token: string; s: SessionItem }) {
  const utils = trpc.useUtils();
  const setShare = trpc.program.slides.setShare.useMutation();
  const removeFile = trpc.program.slides.removeFile.useMutation();
  const up = useUploader(s.id, token);
  const [pick, setPick] = useState<"replace" | "remove" | null>(null);
  const [drag, setDrag] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replaceId, setReplaceId] = useState<number | null>(null);
  const refresh = () => utils.program.slides.page.invalidate({ token });
  const mine = s.files.filter((f) => f.mine);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (!up.busy) up.run(Array.from(e.dataTransfer.files), refresh);
  };
  const startReplace = (id: number) => {
    setReplaceId(id);
    replaceInput.current?.click();
  };
  const remove = async (id: number, name: string) => {
    if (!window.confirm(`Remove ${name}? Attendees can no longer download it.`)) return;
    try {
      await removeFile.mutateAsync({ token, sessionFileId: id });
      setPick(null);
      await refresh();
      toast("File removed");
    } catch (err) {
      toast(errorText(err), true);
    }
  };

  return (
    <>
      <div className="card" style={{ padding: 0 }}>
        <div style={kvRow}>
          <span className="muted">Session</span>
          <b style={{ textAlign: "right" }}>{s.title}</b>
        </div>
        <div style={kvRow}>
          <span className="muted">When</span>
          <b>{fmtDate(s.date)} at {fmtTime(s.startTime)}</b>
        </div>
        {s.room ? (
          <div style={kvRow}>
            <span className="muted">Room</span>
            <b>{s.room}</b>
          </div>
        ) : null}
        {s.others.map((o) => (
          <div key={o.name} style={kvRow}>
            <span className="muted">{ROLE[o.role] ?? o.role}</span>
            <b style={{ textAlign: "right" }}>{o.name}</b>
          </div>
        ))}
      </div>

      <Card title="Slides and handouts" right={s.files.length ? <Pill>Received</Pill> : null}>
        <input
          ref={replaceInput}
          type="file"
          className="sr-only"
          accept=".pdf,.ppt,.pptx,.doc,.docx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file && replaceId) up.run([file], refresh, replaceId).then(() => setPick(null));
          }}
        />
        {s.files.length ? (
          <>
            {s.files.map((f) => (
              <div key={f.id} className="row" style={{ gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--line-2)" }}>
                <FileBadge badge={f.badge} />
                <a href={f.url} className="col grow" style={{ gap: 1, minWidth: 0, color: "inherit", textDecoration: "none" }}>
                  <span className="strong" style={{ fontSize: 13.5, overflowWrap: "anywhere" }}>{f.name}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>{fmtSize(f.size)} · uploaded {fmtWhen(f.at)}</span>
                </a>
                {pick && f.mine ? (
                  <button type="button" className="btn btn-sm" style={{ width: 84 }} disabled={up.busy || removeFile.isPending} onClick={() => (pick === "replace" ? startReplace(f.id) : remove(f.id, f.name))}>
                    {pick === "replace" ? "Replace" : "Remove"}
                  </button>
                ) : null}
              </div>
            ))}
            <div className="col" style={{ padding: "12px 14px 0", gap: 10 }}>
              <UploadProgress pct={up.pct} label={up.label} />
              {pick ? (
                <div className="row-between">
                  <span className="small strong muted">Pick the file to {pick === "replace" ? "replace" : "remove"}.</span>
                  <button type="button" className="btn btn-sm" style={{ width: 84 }} onClick={() => setPick(null)}>Cancel</button>
                </div>
              ) : (
                <div className="row gap-8">
                  <PickFiles label="Add a file" className="btn btn-sm" disabled={up.busy} onPick={(list) => up.run(list, refresh)} />
                  {mine.length ? (
                    <>
                      <button type="button" className="btn btn-sm" disabled={up.busy} onClick={() => (mine.length === 1 ? startReplace(mine[0].id) : setPick("replace"))}>
                        Replace
                      </button>
                      <button type="button" className="btn btn-sm" disabled={up.busy || removeFile.isPending} onClick={() => (mine.length === 1 ? remove(mine[0].id, mine[0].name) : setPick("remove"))}>
                        Remove
                      </button>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {s.slidesDueOn ? (
              <div style={{ padding: "12px 14px 0" }}>
                <div className="banner banner-warn" style={{ fontSize: 13, fontWeight: 600, padding: "9px 12px", borderRadius: 10 }}>Due {fmtDate(s.slidesDueOn)}</div>
              </div>
            ) : null}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
              style={{ margin: "12px 14px", border: `1.5px dashed ${drag ? "var(--brand)" : "#9AA9A4"}`, background: drag ? "var(--brand-tint-2)" : "transparent", borderRadius: 12, padding: 18, textAlign: "center", fontSize: 13, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}
            >
              <b style={{ color: "var(--ink)", fontSize: 14 }}>Upload your slides</b>
              <span>PowerPoint, Keynote exported to PDF, or PDF. Up to 100 MB each.</span>
              <PickFiles label={up.busy ? "Uploading" : "Choose files"} className="btn btn-primary" disabled={up.busy} onPick={(list) => up.run(list, refresh)} />
              {up.busy ? <div style={{ alignSelf: "stretch" }}><UploadProgress pct={up.pct} label={up.label} /></div> : null}
            </div>
          </>
        )}
        <fieldset style={{ margin: 0, padding: s.files.length ? "12px 14px 14px" : "0 14px 14px", border: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          <legend className="sr-only">Share with attendees</legend>
          <div aria-hidden style={{ fontSize: 13, fontWeight: 800 }}>Share with attendees</div>
          {(Object.keys(SPEAKER_SHARE) as Share[]).map((k) => (
            <label key={k} className={`option${s.slidesShare === k ? " selected" : ""}`} style={{ alignItems: "flex-start" }}>
              <input
                type="radio"
                name={`share-${s.id}`}
                checked={s.slidesShare === k}
                disabled={setShare.isPending}
                style={{ marginTop: 2, flexShrink: 0 }}
                onChange={async () => {
                  try {
                    await setShare.mutateAsync({ token, sessionId: s.id, slidesShare: k });
                    await refresh();
                    toast("Saved");
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              />
              <span className="col" style={{ gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{SPEAKER_SHARE[k]}</span>
                <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.45 }}>{SHARE_HINT[k]}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </Card>
    </>
  );
}

type BioForm = { credentials: string; jobTitle: string; organization: string; bio: string; headshotFileId: number | null; headshotUrl: string | null };

function BioCard({ token, d }: { token: string; d: Page }) {
  const utils = trpc.useUtils();
  const save = trpc.program.slides.updateBio.useMutation();
  const photo = trpc.program.slides.uploadPhoto.useMutation();
  const sp = d.speaker;
  const [f, setF] = useState<BioForm | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const line = [sp.jobTitle, sp.organization].filter(Boolean).join(", ");
  const text = (k: "credentials" | "jobTitle" | "organization" | "bio") => (e: { target: { value: string } }) => f && setF({ ...f, [k]: e.target.value });

  return (
    <Card
      title="Bio and photo"
      right={
        f ? (
          <Pill tone="orange">Editing</Pill>
        ) : (
          <button type="button" className="btn btn-sm" style={{ width: 72 }} onClick={() => setF({ credentials: sp.credentials, jobTitle: sp.jobTitle, organization: sp.organization, bio: sp.bio, headshotFileId: sp.headshotFileId, headshotUrl: sp.headshotUrl })}>
            Edit
          </button>
        )
      }
    >
      {f ? (
        <div className="col" style={{ padding: "12px 14px 14px", gap: 10 }}>
          <div className="row" style={{ gap: 12 }}>
            <Avatar url={f.headshotUrl} name={sp.name} size={46} />
            <input
              ref={photoInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                try {
                  const base64 = await readFileBase64(file);
                  const res = await photo.mutateAsync({ token, name: file.name, mime: file.type as "image/png" | "image/jpeg" | "image/webp", base64 });
                  setF((cur) => (cur ? { ...cur, headshotFileId: res.id, headshotUrl: res.url } : cur));
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            />
            <button type="button" className="btn btn-sm" style={{ width: 120 }} disabled={photo.isPending} onClick={() => photoInput.current?.click()}>
              {photo.isPending ? "Uploading" : "Upload photo"}
            </button>
          </div>
          <Field label="Credentials">
            <input className="input" value={f.credentials} placeholder="PhD, LPC" onChange={text("credentials")} />
          </Field>
          <div className="grid-2" style={{ gap: 10 }}>
            <Field label="Job title">
              <input className="input" value={f.jobTitle} onChange={text("jobTitle")} />
            </Field>
            <Field label="Organization">
              <input className="input" value={f.organization} onChange={text("organization")} />
            </Field>
          </div>
          <Field label="Bio">
            <textarea className="textarea" rows={4} value={f.bio} onChange={text("bio")} />
          </Field>
          <div className="row gap-8">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              style={{ width: 84 }}
              disabled={save.isPending}
              onClick={async () => {
                try {
                  await save.mutateAsync({ token, credentials: f.credentials, jobTitle: f.jobTitle, organization: f.organization, bio: f.bio, headshotFileId: f.headshotFileId });
                  await utils.program.slides.page.invalidate({ token });
                  setF(null);
                  toast("Bio saved");
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Save
            </button>
            <button type="button" className="btn btn-sm" style={{ width: 84 }} onClick={() => setF(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--line-2)" }}>
            <Avatar url={sp.headshotUrl} name={sp.name} size={46} />
            <div className="col" style={{ gap: 1 }}>
              <span className="strong" style={{ fontSize: 13.5 }}>{sp.fullName}</span>
              {line ? <span className="muted" style={{ fontSize: 12.5 }}>{line}</span> : null}
            </div>
          </div>
          <div style={{ padding: "10px 14px 14px", fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>
            {sp.bio || <span className="muted">Add a short bio. Attendees see it when they open your session.</span>}
          </div>
        </>
      )}
    </Card>
  );
}
