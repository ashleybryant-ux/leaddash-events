/**
 * Slides and handouts: the streamed upload helper, the file rows, the
 * staff section on a session, the Slides tab on the sessions list, and the
 * attendee app card. Big files go to /api/upload/session-file as the raw
 * body (never base64) so decks up to 100 MB work.
 */
import { useRef, useState, type ReactNode } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { EditSection, Empty, ErrorNote, Field, FolderTabs, PageLoading, Pill, THead, confirmAction } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { eachDay, fmtDate, fmtTime, fmtWhen } from "@shared/format";

export type Share = "after_start" | "now" | "hidden";
export const MAX_UPLOAD = 100 * 1024 * 1024;
export const ACCEPT = ".pdf,.ppt,.pptx,.doc,.docx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const SHARE_LABEL: Record<Share, string> = { after_start: "After the session starts", now: "Right away", hidden: "Do not share" };
export const SHARE_SHORT: Record<Share, string> = { after_start: "After it starts", now: "Right away", hidden: "Do not share" };
export const SHARE_HINT: Record<Share, string> = {
  after_start: "Attendees can download them in the app once the session begins.",
  now: "Attendees can download them now.",
  hidden: "Only event staff can see them.",
};

/** "12.4 MB", "0.8 MB", "24 KB" */
export function fmtSize(bytes: number) {
  if (bytes < 50 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Streams one file to the server with progress. `token` is the speaker page
 * token (speakers); staff are signed in by their cookie.
 */
export function uploadSessionFile(file: File, opts: { sessionId: number; token?: string; replace?: number; onProgress?: (pct: number) => void }) {
  return new Promise<{ fileId: number; sessionFileId: number; name: string; size: number }>((resolve, reject) => {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!["pdf", "ppt", "pptx", "doc", "docx"].includes(ext)) return reject(new Error("Upload a PDF, PowerPoint or Word file."));
    if (file.size > MAX_UPLOAD) return reject(new Error(`${file.name} is over 100 MB.`));
    const q = new URLSearchParams({ sessionId: String(opts.sessionId), name: file.name });
    if (opts.token) q.set("token", opts.token);
    if (opts.replace) q.set("replace", String(opts.replace));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload/session-file?${q.toString()}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: { error?: string } & Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch {
        body = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as never);
      else reject(new Error(body.error || (xhr.status === 413 ? "Files can be up to 100 MB." : "The upload did not finish. Try again.")));
    };
    xhr.onerror = () => reject(new Error("The upload did not finish. Check your connection and try again."));
    xhr.send(file);
  });
}

/** Uploads several files one after another, with one progress bar. */
export function useUploader(sessionId: number, token?: string) {
  const [pct, setPct] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const run = async (files: File[], onDone: () => Promise<unknown> | void, replace?: number) => {
    if (!files.length) return;
    let ok = 0;
    for (const [i, f] of files.entries()) {
      setLabel(files.length > 1 ? `${f.name} (${i + 1} of ${files.length})` : f.name);
      setPct(0);
      try {
        await uploadSessionFile(f, { sessionId, token, replace: i === 0 ? replace : undefined, onProgress: setPct });
        ok++;
      } catch (err) {
        toast(errorText(err), true);
      }
    }
    setPct(null);
    setLabel("");
    await onDone();
    if (ok) toast(ok === 1 ? "File uploaded" : `${ok} files uploaded`);
  };
  return { pct, label, busy: pct !== null, run };
}

export function UploadProgress({ pct, label }: { pct: number | null; label: string }) {
  if (pct === null) return null;
  return (
    <div className="col" style={{ gap: 6 }} role="status" aria-live="polite">
      <div className="row-between small strong">
        <span className="clip">Uploading {label}</span>
        <span>{pct}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: "var(--line-2)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--brand)", transition: "width 0.2s" }} />
      </div>
    </div>
  );
}

/** A hidden file input with a visible button. */
export function PickFiles({ label, multiple = true, disabled, className = "btn btn-sm btn-w", onPick }: { label: string; multiple?: boolean; disabled?: boolean; className?: string; onPick: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple={multiple}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          onPick(files);
        }}
      />
      <button type="button" className={className} disabled={disabled} onClick={() => input.current?.click()}>
        {label}
      </button>
    </>
  );
}

/** "PPTX" tile. */
export function FileBadge({ badge }: { badge: string }) {
  return (
    <span aria-hidden style={{ width: 38, height: 38, borderRadius: 8, background: "var(--brand-tint)", color: "var(--brand)", fontWeight: 800, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      {badge}
    </span>
  );
}

/* ---------------- Staff: the session's Slides and handouts ---------------- */

type StaffData = RouterOutputs["program"]["slides"]["forSession"];

/** Section on the session page and in the expanded session row. */
export function SessionSlides({ eventId, sessionId, canEdit }: { eventId: number; sessionId: number; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const q = trpc.program.slides.forSession.useQuery({ eventId, sessionId });
  const update = trpc.program.slides.update.useMutation();
  const remove = trpc.program.slides.remove.useMutation();
  const up = useUploader(sessionId);
  const [f, setF] = useState<{ share: Share; due: string } | null>(null);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data!;
  const form = f ?? { share: d.slidesShare, due: d.slidesDueOn ?? "" };
  const refresh = () => Promise.all([utils.program.slides.forSession.invalidate({ eventId, sessionId }), utils.program.slides.overview.invalidate({ eventId })]);
  const files = <StaffFiles d={d} canEdit={canEdit} onRemove={async (id, name) => {
    if (!confirmAction(`Remove ${name}? Attendees and speakers can no longer download it.`)) return;
    try {
      await remove.mutateAsync({ eventId, sessionFileId: id });
      await refresh();
      toast("File removed");
    } catch (err) {
      toast(errorText(err), true);
    }
  }} />;
  const view = (
    <div className="col gap-12">
      {files}
      <div className="col" style={{ gap: 6, fontSize: 14 }}>
        <ReadRow label="Share with attendees" value={SHARE_LABEL[d.slidesShare]} />
        <ReadRow label="Due date for speakers" value={d.slidesDueOn ? fmtDate(d.slidesDueOn) : <span className="muted">Not set</span>} />
        <ReadRow label="Downloads" value={`${d.downloads.toLocaleString()} download${d.downloads === 1 ? "" : "s"}`} />
      </div>
    </div>
  );
  if (!canEdit) {
    return (
      <section className="col gap-12">
        <span className="h3" style={{ fontSize: 14 }}>Slides and handouts</span>
        {view}
      </section>
    );
  }
  return (
    <EditSection
      title="Slides and handouts"
      saving={update.isPending}
      onCancel={() => setF(null)}
      onSave={async () => {
        await update.mutateAsync({ eventId, sessionId, slidesShare: form.share, slidesDueOn: form.due || null });
        setF(null);
        await refresh();
        toast("Slides settings saved");
      }}
      view={view}
      edit={
        <div className="col gap-12">
          {files}
          <div className="grid-2" style={{ alignItems: "end" }}>
            <Field label="Share with attendees">
              <select className="select" value={form.share} onChange={(e) => setF({ ...form, share: e.target.value as Share })}>
                {(Object.keys(SHARE_LABEL) as Share[]).map((k) => (
                  <option key={k} value={k}>{SHARE_LABEL[k]}</option>
                ))}
              </select>
            </Field>
            <div className="small strong" style={{ background: "var(--brand-tint)", color: "var(--brand)", borderRadius: 8, padding: "8px 10px", alignSelf: "stretch", display: "flex", alignItems: "center" }}>
              {SHARE_HINT[form.share]}
            </div>
            <Field label="Due date for speakers">
              <input className="input" type="date" value={form.due} onChange={(e) => setF({ ...form, due: e.target.value })} />
            </Field>
            <div>
              <PickFiles label={up.busy ? "Uploading" : "Upload file"} disabled={up.busy} className="btn btn-sm btn-w-lg" onPick={(list) => up.run(list, refresh)} />
            </div>
          </div>
          <UploadProgress pct={up.pct} label={up.label} />
        </div>
      }
    />
  );
}

function ReadRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="row" style={{ gap: 16 }}>
      <span className="muted" style={{ width: 164, flexShrink: 0 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function StaffFiles({ d, canEdit, onRemove }: { d: StaffData; canEdit: boolean; onRemove: (id: number, name: string) => void }) {
  if (!d.files.length) return <span className="muted" style={{ fontSize: 14 }}>No files yet.</span>;
  return (
    <div className="col" style={{ border: "1px solid var(--line)", borderRadius: 10 }}>
      {d.files.map((x, i) => (
        <div key={x.id} className="row" style={{ gap: 10, padding: "10px 12px", borderTop: i ? "1px solid var(--line)" : "none" }}>
          <FileBadge badge={x.badge} />
          <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
            <span className="strong clip">{x.name}</span>
            <span className="small muted clip">{[fmtSize(x.size), x.by, fmtWhen(x.at)].filter(Boolean).join(" · ")}</span>
          </div>
          <a className="btn btn-sm btn-w" href={x.url}>Download</a>
          {canEdit ? (
            <button type="button" className="btn btn-sm btn-w" onClick={() => onRemove(x.id, x.name)}>
              Remove
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Staff: Slides tab on the sessions list ---------------- */

export type SessionsTab = string; // "all", "day-YYYY-MM-DD", "slides"

/** The folder tabs over the sessions list: All, each day, and Slides (N missing). */
export function SessionsTabs({ eventId, startDate, endDate, total, value, onChange }: { eventId: number; startDate: string; endDate: string; total: number; value: SessionsTab; onChange: (t: SessionsTab) => void }) {
  const ov = trpc.program.slides.overview.useQuery({ eventId });
  const days = eachDay(startDate, endDate);
  const tabs = [
    { key: "all", label: `All (${total})` },
    ...(days.length > 1 ? days.map((d, i) => ({ key: `day-${d}`, label: `Day ${i + 1}` })) : []),
    { key: "slides", label: ov.data ? `Slides (${ov.data.missing} missing)` : "Slides" },
  ];
  return <FolderTabs tabs={tabs} value={value} onChange={onChange} />;
}

/** Whether a session shows on a day tab. */
export const inSessionsTab = (tab: SessionsTab, date: string) => tab === "all" || tab === `day-${date}`;

const zipUrl = (eventId: number, sessionId?: number) => `/api/slides/${eventId}/slides.zip${sessionId ? `?sessionId=${sessionId}` : ""}`;

/** Header buttons on the Slides tab: Download all slides and Remind missing. */
export function SlidesActions({ eventId, canEdit }: { eventId: number; canEdit: boolean }) {
  const ov = trpc.program.slides.overview.useQuery({ eventId });
  const remind = useRemind(eventId);
  const missing = ov.data?.rows.filter((r) => !r.files.length) ?? [];
  return (
    <>
      {ov.data?.withFiles ? (
        <a className="btn" href={zipUrl(eventId)}>Download all slides</a>
      ) : (
        <button type="button" className="btn" disabled>Download all slides</button>
      )}
      {canEdit ? (
        <button type="button" className="btn" disabled={!missing.length || remind.isPending} onClick={() => remind.ask(missing)}>
          Remind missing
        </button>
      ) : null}
    </>
  );
}

function useRemind(eventId: number) {
  const m = trpc.program.slides.remind.useMutation();
  const ask = async (rows: { id: number; title: string; speakers: string[] }[]) => {
    const people = new Set(rows.flatMap((r) => r.speakers));
    if (!people.size) {
      toast(rows.length === 1 ? "Add a speaker to this session first." : "These sessions have no speakers yet.", true);
      return;
    }
    const msg =
      rows.length === 1
        ? `Email ${rows[0].speakers.join(", ")} a reminder to upload slides for ${rows[0].title}?`
        : `Email ${people.size} speaker${people.size === 1 ? "" : "s"} of ${rows.length} sessions with no slides a reminder with their speaker page link?`;
    if (!confirmAction(msg)) return;
    try {
      const r = await m.mutateAsync({ eventId, sessionIds: rows.map((x) => x.id) });
      toast(`Reminder sent to ${r.sent} speaker${r.sent === 1 ? "" : "s"}${r.noEmail ? `. ${r.noEmail} had no email address.` : ""}`, !r.sent);
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  return { ask, isPending: m.isPending };
}

const SLIDE_COLS = "minmax(0, 2.2fr) minmax(0, 1.2fr) 110px 130px 96px";

/** The Slides tab: each session, its speaker, files and sharing, with Download or Remind. */
export function SlidesTab({ eventId, canEdit }: { eventId: number; canEdit: boolean }) {
  const ov = trpc.program.slides.overview.useQuery({ eventId });
  const remind = useRemind(eventId);
  if (ov.isLoading) return <PageLoading />;
  if (ov.error) return <ErrorNote error={ov.error} />;
  const rows = ov.data!.rows;
  if (!rows.length) return <Empty>No sessions take slides yet.</Empty>;
  return (
    <div className="table">
      <div className="table-inner" style={{ minWidth: 760 }}>
        <THead cols={SLIDE_COLS} labels={["Session", "Speaker", "Slides", "Shared", ""]} />
        {rows.map((r) => (
          <div key={r.id} className="trow" style={{ gridTemplateColumns: SLIDE_COLS }}>
            <div className="col" style={{ gap: 0, minWidth: 0 }}>
              <span className="strong clip">{r.title}</span>
              <span className="small muted">{fmtDate(r.date)}, {fmtTime(r.startTime)}</span>
            </div>
            <div className="clip" title={r.speakers.join(", ")}>{r.speakers.length ? (r.speakers.length > 1 ? `${r.speakers[0]} +${r.speakers.length - 1}` : r.speakers[0]) : <span className="muted">None yet</span>}</div>
            <div>{r.files.length ? <Pill>{r.files.length === 1 ? "1 file" : `${r.files.length} files`}</Pill> : <Pill tone="orange">Missing</Pill>}</div>
            <div>{SHARE_SHORT[r.slidesShare]}</div>
            {r.files.length ? (
              <a className="btn btn-sm btn-w" href={r.files.length === 1 ? r.files[0].url : zipUrl(eventId, r.id)}>Download</a>
            ) : canEdit ? (
              <button type="button" className="btn btn-sm btn-w" disabled={remind.isPending} onClick={() => remind.ask([r])}>
                Remind
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Attendee app: the session's files ---------------- */

/** "Slides and handouts" card on the attendee session screen. Hidden until sharing allows it. */
export function AttendeeSlides({ slug, sessionId }: { slug: string; sessionId: number }) {
  const q = trpc.program.slides.forAttendee.useQuery({ slug, sessionId });
  const files = q.data?.files ?? [];
  if (!files.length) return null;
  return (
    <div className="card col" style={{ padding: 0 }}>
      <div className="strong" style={{ padding: "12px 14px", fontSize: 15, fontWeight: 800, borderBottom: "1px solid var(--line-2)" }}>Slides and handouts</div>
      {files.map((f, i) => (
        <div key={f.id} className="row" style={{ gap: 12, padding: "10px 14px", borderTop: i ? "1px solid var(--line-2)" : "none" }}>
          <FileBadge badge={f.badge} />
          <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
            <span className="strong" style={{ fontSize: 14 }}>{f.label}</span>
            <span className="small muted">{fmtSize(f.size)}</span>
          </div>
          <a className="btn btn-sm" style={{ width: 90, height: 36 }} href={f.url}>
            Download
          </a>
        </div>
      ))}
    </div>
  );
}
