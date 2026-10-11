/**
 * Import sessions or speakers from a CSV file: choose a file, check every row (nothing saved yet),
 * then import the rows that are ready.
 */
import { useRef, useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { useAdminEvent } from "../../shells/AdminShell";
import { Modal, Pill } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtRange } from "@shared/format";

type Kind = "sessions" | "speakers";
type SessionCheck = RouterOutputs["program"]["import"]["checkSessions"];
type SpeakerCheck = RouterOutputs["program"]["import"]["checkSpeakers"];
type Done = { added: number; newSpeakers?: number; updated?: number; skipped: number; notAdded: number[] };

const COLUMNS: Record<Kind, { name: string; required?: boolean }[]> = {
  sessions: [
    { name: "Title", required: true },
    { name: "Date", required: true },
    { name: "Start time", required: true },
    { name: "End time", required: true },
    { name: "Room" },
    { name: "Track" },
    { name: "Type" },
    { name: "CE hours" },
    { name: "Speakers" },
    { name: "Description" },
  ],
  speakers: [
    { name: "First name", required: true },
    { name: "Last name", required: true },
    { name: "Credentials" },
    { name: "Job title" },
    { name: "Organization" },
    { name: "City" },
    { name: "Email" },
    { name: "Website" },
    { name: "Bio" },
  ],
};

const SAMPLE: Record<Kind, string[]> = {
  sessions: ["Opening Keynote", "", "9:00 AM", "10:15 AM", "Grand Ballroom", "", "Keynote", "1.5", "Jordan Ellis, LPC", "A short description of the session."],
  speakers: ["Jordan", "Ellis", "LPC", "Clinical Director", "Sample Counseling Group", "Dallas, TX", "jordan@example.com", "https://example.com", "A short bio."],
};

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function downloadTemplate(kind: Kind, firstDay: string) {
  const sample = SAMPLE[kind].map((v, i) => (kind === "sessions" && i === 1 ? fmtDate(firstDay) : v));
  const text = [COLUMNS[kind].map((c) => c.name), sample].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${kind}-template.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StatusPill({ status }: { status: "ready" | "update" | "exists" | "fix" }) {
  if (status === "ready") return <Pill tone="green">Ready</Pill>;
  if (status === "update") return <Pill tone="orange">Adds details</Pill>;
  if (status === "exists") return <Pill tone="gray">{"Already added"}</Pill>;
  return <Pill tone="red">Needs a fix</Pill>;
}

export function ImportProgramModal({ kind, open, onClose, onOpenSpeakers }: { kind: Kind; open: boolean; onClose: () => void; onOpenSpeakers?: () => void }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const checkSessions = trpc.program.import.checkSessions.useMutation();
  const runSessions = trpc.program.import.runSessions.useMutation();
  const checkSpeakers = trpc.program.import.checkSpeakers.useMutation();
  const runSpeakers = trpc.program.import.runSpeakers.useMutation();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [checked, setChecked] = useState<SessionCheck | SpeakerCheck | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const busy = checkSessions.isPending || runSessions.isPending || checkSpeakers.isPending || runSpeakers.isPending;
  const noun = kind === "sessions" ? "session" : "speaker";
  const close = () => {
    setCsv("");
    setFileName("");
    setChecked(null);
    setDone(null);
    onClose();
  };
  const take = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name) && f.type !== "text/csv") return toast("Choose a CSV file. In Excel or Google Sheets, save or download the sheet as CSV.", true);
    setFileName(f.name);
    setCsv(await f.text());
  };
  const check = async () => {
    try {
      setChecked(kind === "sessions" ? await checkSessions.mutateAsync({ eventId: ev.id, csv }) : await checkSpeakers.mutateAsync({ eventId: ev.id, csv }));
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  const run = async () => {
    try {
      const res = kind === "sessions" ? await runSessions.mutateAsync({ eventId: ev.id, csv }) : await runSpeakers.mutateAsync({ eventId: ev.id, csv });
      setDone(res);
      await Promise.all([utils.program.sessions.adminList.invalidate(), utils.program.speakers.adminList.invalidate()]);
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  const title = kind === "sessions" ? "Import sessions" : "Import speakers";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  if (done) {
    return (
      <Modal open={open} onClose={close} title={title}>
        <div className="banner banner-ok">{kind === "sessions" ? `${plural(done.added, "session")} added to the agenda` : `${plural(done.added, "speaker")} added to Speakers`}</div>
        <div className="import-sum-list">
          {kind === "sessions" ? (
            <div>
              <span>New speakers added to Speakers</span>
              <b>{done.newSpeakers ?? 0}</b>
            </div>
          ) : null}
          {done.updated ? (
            <div>
              <span>Speakers already on the list, details added</span>
              <b>{done.updated}</b>
            </div>
          ) : null}
          <div>
            <span>Already added, skipped</span>
            <b>{done.skipped}</b>
          </div>
          {done.notAdded.length ? (
            <div>
              <span>Not added ({done.notAdded.length === 1 ? "row" : "rows"} {done.notAdded.join(", ")})</span>
              <b>{done.notAdded.length}</b>
            </div>
          ) : null}
        </div>
        <p className="small muted import-note">
          {kind === "sessions"
            ? "Imported sessions are published, get their own check-in code, and use the event's default evaluation and certificate, the same as a session added by hand."
            : "Add headshots on each speaker's page, or speakers upload their own from their speaker page link."}
        </p>
        <div className="row gap-10" style={{ justifyContent: "flex-end" }}>
          {kind === "sessions" && (done.newSpeakers ?? 0) > 0 && onOpenSpeakers ? (
            <button className="btn btn-sm btn-import" onClick={() => { close(); onOpenSpeakers(); }}>
              Open Speakers
            </button>
          ) : null}
          <button className="btn btn-sm btn-solid btn-w" onClick={close}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} title={title} wide={!!checked}>
      <div className="import-steps">
        <span className={checked ? "" : "on"}>1. Choose a file</span>
        <span className={checked ? "on" : ""}>2. Check the rows</span>
      </div>
      {!checked ? (
        <>
          <p className="small muted import-note">One row per {noun}. Green columns are required.</p>
          <div className="import-cols">
            {COLUMNS[kind].map((c) => (
              <span key={c.name} className={c.required ? "req" : ""}>
                {c.name}
              </span>
            ))}
          </div>
          {kind === "sessions" ? (
            <p className="small muted import-note">Dates like {fmtDate(ev.startDate)} or a short date like 3/11/2027. Times like 10:30 AM. Separate more than one speaker with a semicolon. Type is Session, Keynote, Workshop, Break, Meal or General.</p>
          ) : (
            <p className="small muted import-note">A single Name column works too. Speakers already on the list (same email, or same name when there is no email) are skipped.</p>
          )}
          <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" onChange={async (e) => { await take(e.target.files?.[0]); e.target.value = ""; }} />
          <div
            className={`import-drop${dragging ? " on" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={async (e) => { e.preventDefault(); setDragging(false); await take(e.dataTransfer.files?.[0]); }}
          >
            {fileName ? <b>{fileName}</b> : <b>Drop a CSV file here</b>}
            <span>{fileName ? "Ready to check" : "or"}</span>
            <button className="btn btn-sm btn-import" onClick={() => file.current?.click()}>
              {fileName ? "Choose another" : "Choose file"}
            </button>
          </div>
          <div className="row gap-10" style={{ justifyContent: "space-between" }}>
            <button className="btn btn-sm btn-import" onClick={() => downloadTemplate(kind, ev.startDate)}>
              Download template
            </button>
            <div className="row gap-10">
              <button className="btn btn-sm btn-w" onClick={close}>
                Cancel
              </button>
              <button className="btn btn-sm btn-solid btn-w" disabled={!csv.trim() || busy} onClick={check}>
                Next
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="import-sum">
            <div>
              <b>{checked.counts.ready}</b>
              <span>{kind === "sessions" ? "Sessions ready" : "Speakers ready"}</span>
            </div>
            {"newSpeakers" in checked.counts ? (
              <div>
                <b>{checked.counts.newSpeakers}</b>
                <span>New speakers</span>
              </div>
            ) : null}
            {"update" in checked.counts && checked.counts.update ? (
              <div>
                <b>{checked.counts.update}</b>
                <span>Details added</span>
              </div>
            ) : null}
            <div>
              <b>{checked.counts.exists}</b>
              <span>{kind === "sessions" ? "Already on the agenda" : "Already on the list"}</span>
            </div>
            <div>
              <b>{checked.counts.fix}</b>
              <span>{checked.counts.fix === 1 ? "Needs a fix" : "Need a fix"}</span>
            </div>
          </div>
          {checked.rows.length ? (
            <div className="import-rows">
              {kind === "sessions"
                ? (checked as SessionCheck).rows.map((r) => (
                    <div key={r.line} className="import-row import-row-s">
                      <span className="muted">{r.line}</span>
                      <div className="col" style={{ gap: 2, minWidth: 0 }}>
                        <span className="strong">{r.title || "No title"}</span>
                        <span className="small muted">{[r.kind !== "session" ? r.kind[0].toUpperCase() + r.kind.slice(1) : "", r.room, r.ceHours ? `${r.ceHours} CE` : ""].filter(Boolean).join(" · ")}</span>
                        {r.problem ? <span className="import-fix">{r.problem}</span> : null}
                      </div>
                      <div className="col small" style={{ gap: 2 }}>
                        <span>{r.date ? fmtDate(r.date) : ""}</span>
                        <span className="muted">{r.startTime && r.endTime ? fmtRange(r.startTime, r.endTime) : ""}</span>
                      </div>
                      <div className="col small" style={{ gap: 4, minWidth: 0 }}>
                        {r.speakers.map((s) => (
                          <span key={s.name} className="row gap-6" style={{ flexWrap: "wrap" }}>
                            {s.name}
                            {s.isNew && r.status === "ready" ? <Pill tone="orange">New speaker</Pill> : null}
                          </span>
                        ))}
                      </div>
                      <div>
                        <StatusPill status={r.status} />
                      </div>
                    </div>
                  ))
                : (checked as SpeakerCheck).rows.map((r) => (
                    <div key={r.line} className="import-row import-row-p">
                      <span className="muted">{r.line}</span>
                      <div className="col" style={{ gap: 2, minWidth: 0 }}>
                        <span className="strong">{[`${r.firstName} ${r.lastName}`.trim(), r.credentials].filter(Boolean).join(", ") || "No name"}</span>
                        <span className="small muted">{r.city}</span>
                        {r.problem ? <span className="import-fix">{r.problem}</span> : null}
                      </div>
                      <div className="col small" style={{ gap: 2, minWidth: 0 }}>
                        <span>{r.jobTitle}</span>
                        <span className="muted">{r.organization}</span>
                      </div>
                      <span className="small clip">{r.email}</span>
                      <div>
                        <StatusPill status={r.status} />
                      </div>
                    </div>
                  ))}
            </div>
          ) : (
            <div className="banner banner-warn">The file has a header row but no {noun}s under it.</div>
          )}
          <p className="small muted import-note">
            {kind === "sessions" ? "Sessions already on the agenda (same title, date and start time) are skipped." : "Speakers already on the list are skipped. When one is on the list by name only, the file fills in what is missing (email, bio and so on) and never changes what is already there."}
            {checked.counts.fix ? ` Fix the ${checked.counts.fix === 1 ? "row" : "rows"} marked Needs a fix in your file and import again, or add ${checked.counts.fix === 1 ? "it" : "them"} by hand later.` : ""}
          </p>
          <div className="row gap-10" style={{ justifyContent: "space-between" }}>
            <button className="btn btn-sm btn-w" onClick={() => setChecked(null)}>
              Back
            </button>
            <div className="row gap-10">
              <button className="btn btn-sm btn-w" onClick={close}>
                Cancel
              </button>
              <button className="btn btn-sm btn-solid btn-import" disabled={!(checked.counts.ready + ("update" in checked.counts ? checked.counts.update : 0)) || busy} onClick={run}>
                {checked.counts.ready || !("update" in checked.counts) ? `Import ${plural(checked.counts.ready, noun)}` : `Update ${plural(checked.counts.update, noun)}`}
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
