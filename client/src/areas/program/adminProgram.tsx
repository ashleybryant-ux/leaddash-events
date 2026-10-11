/** Admin: sessions (list, in-place details and edit, full edit page with speakers and door QR) and speakers. */
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import QRCode from "qrcode";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { Avatar, EditSection, Empty, ErrorNote, Field, PageLoading, Pill, QR, THead, UploadButton, confirmAction, NumStrip } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtDates, fmtRange, fmtTime, fmtWhenTime } from "@shared/format";
import { SessionSlides, SessionsTabs, SlidesActions, SlidesTab, inSessionsTab } from "./SessionSlides";
import { AgreementPill, SendAgreementsButton, SpeakerAgreementSection, SpeakerTabs, WelcomePill, inSpeakerTab, useSpeakerAgreements } from "../agreements/SpeakerAgreementBits";

/* ---------------- Shared bits ---------------- */

/** Label over value pairs inside an expanded row or a read-only section. */
export function Facts({ items, cols = 3 }: { items: { label: string; value: ReactNode; wide?: boolean }[]; cols?: 2 | 3 }) {
  return (
    <div className={cols === 2 ? "grid-2" : "grid-3"} style={cols === 2 ? { gap: "12px 16px" } : undefined}>
      {items.map((i) => (
        <div key={i.label} className={`col${i.wide ? " span-all" : ""}`} style={{ gap: 2 }}>
          <span className="small muted strong">{i.label}</span>
          <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: "pre-wrap" }}>{i.value === "" || i.value === null || i.value === undefined ? <span className="muted">Not set</span> : i.value}</span>
        </div>
      ))}
    </div>
  );
}

/** EditSection when the person may edit, otherwise just the title and values. */
export function Section(props: { canEdit: boolean; title: ReactNode; view: ReactNode; edit: ReactNode; onSave: () => Promise<unknown>; onCancel?: () => void; saving?: boolean; actions?: ReactNode; startOpen?: boolean }) {
  if (props.canEdit) return <EditSection {...props} />;
  return (
    <section className="col gap-12">
      <span className="h3" style={{ fontSize: 14 }}>{props.title}</span>
      {props.view}
    </section>
  );
}

/** Opens a print window with a large QR code (room doors). */
export async function printQr(title: string, lines: string[], value: string) {
  const svg = await QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0F2A23", light: "#FFFFFF" } });
  const w = window.open("", "_blank", "width=720,height=900");
  if (!w) {
    toast("Allow pop-ups to print the QR code.", true);
    return;
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:Arial,Helvetica,sans-serif;color:#0F2A23;text-align:center;padding:40px}h1{font-size:30px;margin:0 0 8px}p{font-size:18px;margin:4px 0;color:#4B5B57}.qr{width:420px;height:420px;margin:28px auto}.qr svg{width:100%;height:100%}.big{font-size:22px;font-weight:bold;color:#0F2A23;margin-top:18px}</style></head><body><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}<div class="qr">${svg}</div><p class="big">Scan to check in for CE credit</p></body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

const KINDS = [
  { key: "session", label: "Session" },
  { key: "keynote", label: "Keynote" },
  { key: "workshop", label: "Workshop" },
  { key: "general", label: "General session" },
  { key: "break", label: "Break" },
  { key: "meal", label: "Meal" },
] as const;
type Kind = (typeof KINDS)[number]["key"];

const ROLES = [
  { key: "presenter", label: "Presenter" },
  { key: "co-presenter", label: "Co-presenter" },
  { key: "moderator", label: "Moderator" },
  { key: "panelist", label: "Panelist" },
] as const;
type Role = (typeof ROLES)[number]["key"];
const roleLabel = (r: string) => ROLES.find((x) => x.key === r)?.label ?? r;

/* ---------------- Session form ---------------- */

type SessionRow = RouterOutputs["program"]["sessions"]["adminList"]["sessions"][number];
type Forms = RouterOutputs["program"]["sessions"]["adminList"]["forms"];
type Templates = RouterOutputs["program"]["sessions"]["adminList"]["templates"];

type SessionForm = {
  title: string;
  description: string;
  kind: Kind;
  date: string;
  startTime: string;
  endTime: string;
  room: string;
  track: string;
  ceHours: string;
  capacity: string;
  requiresSignup: boolean;
  published: boolean;
  evaluationId: number | null;
  evaluationOpens: "end" | "checkin";
  certificateTemplateId: number | null;
  certificateAfter: "evaluation" | "checkin" | null;
};

const blankSession = (date: string): SessionForm => ({
  title: "",
  description: "",
  kind: "session",
  date,
  startTime: "09:00",
  endTime: "10:00",
  room: "",
  track: "",
  ceHours: "0",
  capacity: "",
  requiresSignup: false,
  published: true,
  evaluationId: null,
  evaluationOpens: "end",
  certificateTemplateId: null,
  certificateAfter: null,
});

const toForm = (s: Omit<SessionForm, "ceHours" | "capacity"> & { ceHours: number; capacity: number | null }): SessionForm => ({
  title: s.title,
  description: s.description,
  kind: s.kind,
  date: s.date,
  startTime: s.startTime,
  endTime: s.endTime,
  room: s.room,
  track: s.track,
  ceHours: String(s.ceHours),
  capacity: s.capacity ? String(s.capacity) : "",
  requiresSignup: s.requiresSignup,
  published: s.published,
  evaluationId: s.evaluationId,
  evaluationOpens: s.evaluationOpens,
  certificateTemplateId: s.certificateTemplateId,
  certificateAfter: s.certificateAfter,
});

const toInput = (f: SessionForm) => ({
  ...f,
  ceHours: Number(f.ceHours) || 0,
  capacity: f.capacity.trim() ? Math.max(1, Math.round(Number(f.capacity)) || 1) : null,
});

function SessionFields({ f, set, forms, templates, startDate, endDate }: { f: SessionForm; set: (f: SessionForm) => void; forms: Forms; templates: Templates; startDate: string; endDate: string }) {
  const on = <K extends keyof SessionForm>(k: K) => (v: SessionForm[K]) => set({ ...f, [k]: v });
  const text = (k: "title" | "room" | "track" | "date" | "startTime" | "endTime" | "ceHours" | "capacity" | "description") => (e: { target: { value: string } }) => set({ ...f, [k]: e.target.value });
  const defaultForm = forms.find((x) => x.isDefault)?.name;
  const defaultTemplate = templates.find((x) => x.isDefault)?.name;
  return (
    <div className="col gap-12">
      <div className="grid-3">
        <Field label="Title" className="span-2">
          <input className="input" value={f.title} onChange={text("title")} />
        </Field>
        <Field label="Kind">
          <select className="select" value={f.kind} onChange={(e) => on("kind")(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k.key} value={k.key}>{k.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input className="input" type="date" min={startDate} max={endDate} value={f.date} onChange={text("date")} />
        </Field>
        <Field label="Start">
          <input className="input" type="time" value={f.startTime} onChange={text("startTime")} />
        </Field>
        <Field label="End">
          <input className="input" type="time" value={f.endTime} onChange={text("endTime")} />
        </Field>
        <Field label="Room">
          <input className="input" value={f.room} onChange={text("room")} />
        </Field>
        <Field label="Track">
          <input className="input" value={f.track} onChange={text("track")} />
        </Field>
        <Field label="CE hours">
          <input className="input" inputMode="decimal" value={f.ceHours} onChange={text("ceHours")} />
        </Field>
        <Field label="Evaluation form">
          <select className="select" value={f.evaluationId ?? ""} onChange={(e) => on("evaluationId")(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{defaultForm ? `Event default (${defaultForm})` : "Event default"}</option>
            {forms.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Certificate template">
          <select className="select" value={f.certificateTemplateId ?? ""} onChange={(e) => on("certificateTemplateId")(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{defaultTemplate ? `Event default (${defaultTemplate})` : "Event default"}</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Evaluation opens">
          <select className="select" value={f.evaluationOpens} onChange={(e) => on("evaluationOpens")(e.target.value as "end" | "checkin")}>
            <option value="end">When the session ends</option>
            <option value="checkin">At check-in</option>
          </select>
        </Field>
        <Field label="Certificate issued">
          <select className="select" value={f.certificateAfter ?? ""} onChange={(e) => on("certificateAfter")((e.target.value || null) as "evaluation" | "checkin" | null)}>
            <option value="">Template rule</option>
            <option value="evaluation">After evaluation</option>
            <option value="checkin">After check-in</option>
          </select>
        </Field>
        <Field label="Seats">
          <input className="input" inputMode="numeric" placeholder="No limit" value={f.capacity} onChange={text("capacity")} />
        </Field>
        <div className="col span-2" style={{ gap: 8, justifyContent: "flex-end" }}>
          <label className="check">
            <input type="checkbox" checked={f.requiresSignup} onChange={(e) => on("requiresSignup")(e.target.checked)} />
            Attendees sign up (seats are limited)
          </label>
          <label className="check">
            <input type="checkbox" checked={f.published} onChange={(e) => on("published")(e.target.checked)} />
            Show on the agenda
          </label>
        </div>
      </div>
      {f.requiresSignup && !f.capacity.trim() ? <div className="small strong" style={{ color: "var(--warn-ink)" }}>Add the number of seats so sign-ups stop when it is full.</div> : null}
      <Field label="Description">
        <textarea className="textarea" rows={3} value={f.description} onChange={text("description")} />
      </Field>
    </div>
  );
}

/* ---------------- Sessions list ---------------- */

const COLS = "120px minmax(0, 2.4fr) minmax(0, 1fr) 50px 90px 96px 96px 96px";

/** /admin/e/:eventId/sessions */
export function AdminSessionsScreen() {
  const event = useAdminEvent();
  const { can } = useAdmin();
  const q = trpc.program.sessions.adminList.useQuery({ eventId: event.id });
  const create = trpc.program.sessions.create.useMutation();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState<SessionForm | null>(null);
  const [tab, setTab] = useState("all");
  const canEdit = can("sessions", "edit");

  return (
    <AdminPage
      title={event.name}
      sub={fmtDates(event.startDate, event.endDate)}
      actions={
        <>
          {tab === "slides" ? <SlidesActions eventId={event.id} canEdit={canEdit} /> : can("announcements", "edit") ? <Link href={`/admin/e/${event.id}/announcements`} className="btn">Send announcement</Link> : null}
          {canEdit ? (
            <button className="btn btn-primary" onClick={() => setAdding(blankSession(event.startDate))}>
              Add session
            </button>
          ) : null}
        </>
      }
    >
      {q.isLoading ? (
        <PageLoading />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : (
        <>
          <NumStrip
            items={[
              { label: "Attendees", value: q.data!.kpis.attendees.toLocaleString() },
              { label: "Sessions", value: q.data!.kpis.sessions.toLocaleString() },
              { label: "Check-ins", value: q.data!.kpis.checkins.toLocaleString() },
              { label: "Certificates issued", value: q.data!.kpis.certificates.toLocaleString() },
            ]}
          />
          {adding ? (
            <div className="card card-pad col gap-14">
              <span className="editor-title">New session</span>
              <SessionFields f={adding} set={setAdding} forms={q.data!.forms} templates={q.data!.templates} startDate={event.startDate} endDate={event.endDate} />
              <div className="row gap-10">
                <button
                  className="btn btn-sm btn-solid btn-w"
                  disabled={create.isPending}
                  onClick={async () => {
                    try {
                      const row = await create.mutateAsync({ eventId: event.id, ...toInput(adding) });
                      setAdding(null);
                      await utils.program.sessions.adminList.invalidate({ eventId: event.id });
                      setOpen(row.id);
                      toast("Session added");
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  Save
                </button>
                <button className="btn btn-sm btn-w" onClick={() => setAdding(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <SessionsTabs eventId={event.id} startDate={event.startDate} endDate={event.endDate} total={q.data!.sessions.length} value={tab} onChange={setTab} />
          {tab === "slides" ? (
            <SlidesTab eventId={event.id} canEdit={canEdit} />
          ) : !q.data!.sessions.length ? (
            <Empty>No sessions yet. Click Add session to build the agenda.</Empty>
          ) : (
            <div className="table">
              <div className="table-inner" style={{ minWidth: 900 }}>
                <THead cols={COLS} labels={["When", "Session", "Room", "CE", "Scheduled", "Checked in", "Evaluations", ""]} />
                {q.data!.sessions.filter((s) => inSessionsTab(tab, s.date)).map((s) => (
                  <SessionListRow key={s.id} s={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </AdminPage>
  );
}

function SessionListRow({ s, open, onToggle }: { s: SessionRow; open: boolean; onToggle: () => void }) {
  const ended = Date.now() >= s.endsAt;
  return (
    <div className={open ? "trow-open" : ""} style={{ borderBottom: "1px solid var(--line)" }}>
      <div className="trow" style={{ gridTemplateColumns: COLS, borderBottom: "none" }}>
        <div className="col" style={{ gap: 0 }}>
          <span className="strong">{fmtDate(s.date)}</span>
          <span className="small muted">{fmtTime(s.startTime)}</span>
        </div>
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <span className="strong">{s.title}</span>
          {!s.published ? <span><Pill tone="gray">Hidden</Pill></span> : null}
        </div>
        <div className="clip">{s.room || <span className="muted">Not set</span>}</div>
        <div>{s.ceHours > 0 ? s.ceHours : <span className="muted">0</span>}</div>
        <div>{s.scheduled.toLocaleString()}{s.requiresSignup && s.capacity ? <span className="small muted"> of {s.capacity}</span> : null}</div>
        <div>{s.checkedIn.toLocaleString()}</div>
        <div>{s.ceHours > 0 && !ended && s.evaluationOpens === "end" ? <span className="small muted">Opens {fmtTime(s.endTime)}</span> : s.evaluations.toLocaleString()}</div>
        <button type="button" className={`btn btn-sm btn-w${open ? " btn-solid" : ""}`} onClick={onToggle}>
          {open ? "Close" : "Details"}
        </button>
      </div>
      {open ? (
        <div className="editor">
          <SessionPanel sessionId={s.id} inRow />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Session details with Edit, and its speakers. Used in the expanded list row
 * and on the session's own page.
 */
function SessionPanel({ sessionId, inRow }: { sessionId: number; inRow?: boolean }) {
  const event = useAdminEvent();
  const { can } = useAdmin();
  const canEdit = can("sessions", "edit");
  const utils = trpc.useUtils();
  const q = trpc.program.sessions.adminGet.useQuery({ eventId: event.id, sessionId });
  const update = trpc.program.sessions.update.useMutation();
  const [f, setF] = useState<SessionForm | null>(null);
  const [showList, setShowList] = useState(false);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data!;
  const s = d.session;
  const form = f ?? toForm(s);
  const ended = Date.now() >= s.endsAt;
  const evalForm = s.evaluationId ? d.forms.find((x) => x.id === s.evaluationId)?.name : d.forms.find((x) => x.isDefault)?.name;
  const template = s.certificateTemplateId ? d.templates.find((x) => x.id === s.certificateTemplateId) : d.templates.find((x) => x.isDefault);
  const certRule = s.certificateAfter === "checkin" ? "Issued after check-in" : s.certificateAfter === "evaluation" ? "Issued after evaluation" : template ? (template.requireEvaluation ? "Issued after evaluation" : "Issued after check-in") : "";
  const refresh = () => Promise.all([utils.program.sessions.adminGet.invalidate({ eventId: event.id, sessionId }), utils.program.sessions.adminList.invalidate({ eventId: event.id })]);
  const checkinUrl = `${window.location.origin}/e/${d.slug}/checkin/${s.id}?code=${s.checkInCode}`;

  const details = (
      <Section
        canEdit={canEdit}
        title="Session details"
        saving={update.isPending}
        actions={inRow ? <Link href={`/admin/e/${event.id}/sessions/${s.id}`} className="btn btn-sm btn-w">Full page</Link> : undefined}
        onCancel={() => setF(null)}
        onSave={async () => {
          await update.mutateAsync({ eventId: event.id, sessionId: s.id, ...toInput(form) });
          setF(null);
          await refresh();
          toast("Session saved");
        }}
        view={
          <Facts
            cols={inRow ? 3 : 2}
            items={[
              { label: d.speakers.length > 1 ? "Speakers" : "Presenter", value: d.speakers.map((p) => (p.role === "presenter" || d.speakers.length === 1 ? p.name : `${p.name} (${roleLabel(p.role)})`)).join(", ") },
              { label: "Time", value: `${fmtDate(s.date)}, ${fmtRange(s.startTime, s.endTime)}` },
              { label: "Room", value: s.room },
              { label: "Kind", value: KINDS.find((k) => k.key === s.kind)?.label ?? s.kind },
              { label: "Track", value: s.track },
              { label: "CE hours", value: s.ceHours > 0 ? String(s.ceHours) : "None" },
              { label: "Room code", value: s.checkInCode },
              { label: "Evaluation opens", value: s.evaluationOpens === "checkin" ? "At check-in" : "When the session ends" },
              { label: "Evaluation form", value: evalForm ?? "" },
              { label: "Certificate template", value: template?.name ?? "" },
              { label: "Certificate", value: certRule },
              { label: "Evaluations in", value: s.ceHours > 0 && !ended && s.evaluationOpens === "end" ? `Opens ${fmtTime(s.endTime)}` : `${s.evaluations} of ${s.checkedIn}` },
              { label: "Seats", value: s.capacity ? `${s.scheduled} of ${s.capacity}${s.requiresSignup ? ", sign-up required" : ""}` : "No limit" },
              { label: "On the agenda", value: s.published ? "Shown" : "Hidden" },
              ...(s.description ? [{ label: "Description", value: s.description, wide: true }] : []),
            ]}
          />
        }
        edit={<SessionFields f={form} set={setF} forms={d.forms} templates={d.templates} startDate={event.startDate} endDate={event.endDate} />}
      />
  );
  const speakers = <SessionSpeakers sessionId={s.id} speakers={d.speakers} all={d.allSpeakers} canEdit={canEdit} onSaved={refresh} />;
  const slides = s.kind !== "break" && s.kind !== "meal" ? <SessionSlides eventId={event.id} sessionId={s.id} canEdit={canEdit} /> : null;

  // The session's own page: details and speakers on the left, slides and handouts on the right.
  if (!inRow) {
    return (
      <div className="session-split">
        <div className="card card-pad col gap-16">
          {details}
          <div className="divider" />
          {speakers}
        </div>
        {slides ? <div className="card card-pad col gap-16">{slides}</div> : null}
      </div>
    );
  }

  return (
    <div className="col gap-16">
      {details}
      <div className="divider" />
      {speakers}
      {slides ? (
        <>
          <div className="divider" />
          {slides}
        </>
      ) : null}
      {inRow ? (
        <>
          <div className="row gap-10 wrap">
            <button type="button" className="btn btn-sm btn-w-lg" onClick={() => printQr(s.title, [`${fmtDate(s.date)}, ${fmtRange(s.startTime, s.endTime)}`, s.room].filter(Boolean), checkinUrl)}>
              Print door QR
            </button>
            <button type="button" className={`btn btn-sm btn-w-lg${showList ? " btn-solid" : ""}`} onClick={() => setShowList(!showList)}>
              Attendance list
            </button>
          </div>
          {showList ? <AttendanceList sessionId={s.id} /> : null}
        </>
      ) : null}
    </div>
  );
}

function SessionSpeakers({ sessionId, speakers, all, canEdit, onSaved }: { sessionId: number; speakers: { speakerId: number; name: string; role: string; headshotUrl: string | null }[]; all: { id: number; name: string }[]; canEdit: boolean; onSaved: () => Promise<unknown> }) {
  const event = useAdminEvent();
  const save = trpc.program.sessions.setSpeakers.useMutation();
  const [list, setList] = useState<{ speakerId: number; role: Role }[] | null>(null);
  const cur = list ?? speakers.map((p) => ({ speakerId: p.speakerId, role: p.role as Role }));
  const name = (id: number) => all.find((a) => a.id === id)?.name ?? speakers.find((p) => p.speakerId === id)?.name ?? "";
  const left = all.filter((a) => !cur.some((c) => c.speakerId === a.id));
  return (
    <Section
      canEdit={canEdit}
      title="Speakers"
      saving={save.isPending}
      onCancel={() => setList(null)}
      onSave={async () => {
        await save.mutateAsync({ eventId: event.id, sessionId, speakers: cur });
        setList(null);
        await onSaved();
        toast("Speakers saved");
      }}
      view={
        speakers.length ? (
          <div className="col gap-8">
            {speakers.map((p) => (
              <div key={p.speakerId} className="row gap-10">
                <Avatar url={p.headshotUrl} name={p.name} size={32} />
                <span className="strong grow">{p.name}</span>
                <Pill tone="gray">{roleLabel(p.role)}</Pill>
              </div>
            ))}
          </div>
        ) : (
          <span className="muted" style={{ fontSize: 14 }}>No speakers yet.</span>
        )
      }
      edit={
        <div className="col gap-8">
          {cur.map((c) => (
            <div key={c.speakerId} className="row gap-10">
              <span className="strong grow clip">{name(c.speakerId)}</span>
              <select className="select" style={{ width: 160 }} aria-label={`Role for ${name(c.speakerId)}`} value={c.role} onChange={(e) => setList(cur.map((x) => (x.speakerId === c.speakerId ? { ...x, role: e.target.value as Role } : x)))}>
                {ROLES.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
              <button type="button" className="btn btn-sm btn-w" onClick={() => setList(cur.filter((x) => x.speakerId !== c.speakerId))}>
                Remove
              </button>
            </div>
          ))}
          {left.length ? (
            <select className="select" style={{ maxWidth: 320 }} aria-label="Add a speaker" value="" onChange={(e) => e.target.value && setList([...cur, { speakerId: Number(e.target.value), role: cur.length ? "co-presenter" : "presenter" }])}>
              <option value="">Add a speaker</option>
              {left.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          ) : !all.length ? (
            <span className="small muted">Add speakers on the Speakers page first.</span>
          ) : null}
        </div>
      }
    />
  );
}

function AttendanceList({ sessionId }: { sessionId: number }) {
  const event = useAdminEvent();
  const q = trpc.program.sessions.attendance.useQuery({ eventId: event.id, sessionId });
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const rows = q.data!;
  if (!rows.length) return <Empty>No one has this session on their agenda yet.</Empty>;
  const csv = () => {
    const lines = [["Name", "Email", "License number", "On agenda", "Checked in"], ...rows.map((r) => [r.name, r.email, r.licenseNumber, r.scheduled ? "Yes" : "No", r.checkedInAt ? fmtWhenTime(r.checkedInAt) : ""])];
    const blob = new Blob([lines.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "attendance.csv";
    a.click();
  };
  const cols = "minmax(0, 1.6fr) minmax(0, 1.6fr) minmax(0, 1fr) 90px minmax(0, 1.2fr)";
  return (
    <div className="col gap-8">
      <div className="row-between">
        <span className="small strong muted">{rows.filter((r) => r.checkedInAt).length} checked in of {rows.length}</span>
        <button type="button" className="btn btn-sm btn-w" onClick={csv}>Download</button>
      </div>
      <div className="table">
        <div className="table-inner" style={{ minWidth: 640 }}>
          <THead cols={cols} labels={["Name", "Email", "License", "Agenda", "Checked in"]} />
          {rows.map((r) => (
            <div key={r.id} className="trow" style={{ gridTemplateColumns: cols }}>
              <div className="strong clip">{r.name}</div>
              <div className="clip">{r.email}</div>
              <div className="clip">{r.licenseNumber || <span className="muted">None</span>}</div>
              <div>{r.scheduled ? "Yes" : "No"}</div>
              <div>{r.checkedInAt ? fmtWhenTime(r.checkedInAt) : <span className="muted">Not yet</span>}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** /admin/e/:eventId/sessions/:sessionId */
export function AdminSessionEditScreen({ sessionId }: { sessionId: number }) {
  const event = useAdminEvent();
  const { can } = useAdmin();
  const canEdit = can("sessions", "edit");
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const q = trpc.program.sessions.adminGet.useQuery({ eventId: event.id, sessionId });
  const del = trpc.program.sessions.delete.useMutation();
  const newCode = trpc.program.sessions.newCode.useMutation();
  const back = `/admin/e/${event.id}/sessions`;
  if (q.isLoading) return <AdminPage title="Session"><PageLoading /></AdminPage>;
  if (q.error) return <AdminPage title="Session"><ErrorNote error={q.error} /></AdminPage>;
  const s = q.data!.session;
  const checkinUrl = `${window.location.origin}/e/${q.data!.slug}/checkin/${s.id}?code=${s.checkInCode}`;
  return (
    <AdminPage
      title={s.title}
      actions={
        <>
          <Link href={back} className="btn">All sessions</Link>
          {canEdit ? (
            <button
              className="btn btn-danger"
              disabled={del.isPending}
              onClick={async () => {
                if (!confirmAction(`Delete ${s.title}? It comes off every attendee's agenda, and its check-ins go with it.`)) return;
                try {
                  await del.mutateAsync({ eventId: event.id, sessionId: s.id });
                  await utils.program.sessions.adminList.invalidate({ eventId: event.id });
                  navigate(back);
                  toast("Session deleted");
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Delete
            </button>
          ) : null}
        </>
      }
    >
      <NumStrip
        items={[
          { label: "Scheduled", value: s.scheduled.toLocaleString() },
          { label: "Checked in", value: s.checkedIn.toLocaleString() },
          { label: "Evaluations", value: s.evaluations.toLocaleString() },
          { label: "Seats left", value: s.capacity ? Math.max(0, s.capacity - s.scheduled).toLocaleString() : "No limit", warn: !!s.capacity && s.capacity - s.scheduled <= 0 },
        ]}
      />
      <SessionPanel sessionId={sessionId} />
      <div className="card card-pad col gap-12">
        <div className="row-between">
          <span className="h3" style={{ fontSize: 14 }}>Room check-in QR</span>
          <div className="row gap-8">
            {canEdit ? (
              <button
                type="button"
                className="btn btn-sm btn-w"
                disabled={newCode.isPending}
                onClick={async () => {
                  if (!confirmAction("Make a new code? QR codes already printed for this room stop working.")) return;
                  try {
                    await newCode.mutateAsync({ eventId: event.id, sessionId: s.id });
                    await utils.program.sessions.adminGet.invalidate({ eventId: event.id, sessionId });
                    toast("New code made. Print the QR again.");
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                New code
              </button>
            ) : null}
            <button type="button" className="btn btn-sm btn-solid btn-w" onClick={() => printQr(s.title, [`${fmtDate(s.date)}, ${fmtRange(s.startTime, s.endTime)}`, s.room].filter(Boolean), checkinUrl)}>
              Print
            </button>
          </div>
        </div>
        <div className="row gap-20 wrap" style={{ alignItems: "flex-start" }}>
          <div style={{ padding: 12, border: "1px solid var(--line)", borderRadius: 12, background: "#FFFFFF" }}>
            <QR value={checkinUrl} size={180} label={`Check-in QR code for ${s.title}`} />
          </div>
          <div className="col gap-6 grow" style={{ minWidth: 220 }}>
            <span className="small muted strong">Room code</span>
            <span className="strong" style={{ fontSize: 22, letterSpacing: "0.08em" }}>{s.checkInCode}</span>
            <span className="small muted">Post this at the door. Attendees scan it with their phone camera to check in for CE credit.</span>
          </div>
        </div>
      </div>
      <div className="card card-pad col gap-12">
        <span className="h3" style={{ fontSize: 14 }}>Attendance</span>
        <AttendanceList sessionId={sessionId} />
      </div>
    </AdminPage>
  );
}

/* ---------------- Speakers ---------------- */

type SpeakerForm = {
  firstName: string;
  lastName: string;
  credentials: string;
  jobTitle: string;
  organization: string;
  city: string;
  bio: string;
  headshotFileId: number | null;
  headshotUrl: string | null;
  website: string;
  email: string;
  featured: boolean;
  allowMessages: boolean;
  sort: string;
};

const blankSpeaker: SpeakerForm = { firstName: "", lastName: "", credentials: "", jobTitle: "", organization: "", city: "", bio: "", headshotFileId: null, headshotUrl: null, website: "", email: "", featured: false, allowMessages: true, sort: "0" };

const speakerInput = ({ headshotUrl, sort, ...f }: SpeakerForm) => {
  void headshotUrl;
  return { ...f, sort: Math.max(0, Math.round(Number(sort)) || 0) };
};

function SpeakerFields({ f, set }: { f: SpeakerForm; set: (f: SpeakerForm) => void }) {
  const event = useAdminEvent();
  const text = (k: "firstName" | "lastName" | "credentials" | "jobTitle" | "organization" | "city" | "website" | "email" | "bio" | "sort") => (e: { target: { value: string } }) => set({ ...f, [k]: e.target.value });
  return (
    <div className="col gap-12">
      <div className="row gap-12">
        <Avatar url={f.headshotUrl} name={`${f.firstName} ${f.lastName}`} size={56} />
        <UploadButton label={f.headshotFileId ? "Replace headshot" : "Upload headshot"} className="btn btn-sm btn-w-lg" eventId={event.id} onUploaded={(file) => set({ ...f, headshotFileId: file.id, headshotUrl: file.url })} />
        {f.headshotFileId ? (
          <button type="button" className="btn btn-sm btn-w" onClick={() => set({ ...f, headshotFileId: null, headshotUrl: null })}>
            Remove
          </button>
        ) : null}
      </div>
      <div className="grid-3">
        <Field label="First name">
          <input className="input" value={f.firstName} onChange={text("firstName")} />
        </Field>
        <Field label="Last name">
          <input className="input" value={f.lastName} onChange={text("lastName")} />
        </Field>
        <Field label="Credentials">
          <input className="input" value={f.credentials} onChange={text("credentials")} placeholder="PhD, LPC" />
        </Field>
        <Field label="Title">
          <input className="input" value={f.jobTitle} onChange={text("jobTitle")} />
        </Field>
        <Field label="Organization">
          <input className="input" value={f.organization} onChange={text("organization")} />
        </Field>
        <Field label="City">
          <input className="input" value={f.city} onChange={text("city")} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={f.email} onChange={text("email")} />
        </Field>
        <Field label="Website">
          <input className="input" value={f.website} onChange={text("website")} placeholder="https://" />
        </Field>
        <Field label="Order">
          <input className="input" inputMode="numeric" value={f.sort} onChange={text("sort")} />
        </Field>
      </div>
      <Field label="Bio">
        <textarea className="textarea" rows={5} value={f.bio} onChange={text("bio")} />
      </Field>
      <div className="row gap-20 wrap">
        <label className="check">
          <input type="checkbox" checked={f.allowMessages} onChange={(e) => set({ ...f, allowMessages: e.target.checked })} />
          Attendees can message this speaker
        </label>
        <label className="check">
          <input type="checkbox" checked={f.featured} onChange={(e) => set({ ...f, featured: e.target.checked })} />
          Featured (shown first)
        </label>
      </div>
    </div>
  );
}

const SP_COLS = "minmax(0, 1.6fr) minmax(0, 2fr) 170px 150px 96px";

/** /admin/e/:eventId/speakers */
export function AdminSpeakersScreen() {
  const event = useAdminEvent();
  const { can } = useAdmin();
  const canEdit = can("speakers", "edit");
  const utils = trpc.useUtils();
  const q = trpc.program.speakers.adminList.useQuery({ eventId: event.id });
  const create = trpc.program.speakers.create.useMutation();
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState<SpeakerForm | null>(null);
  const agr = useSpeakerAgreements(event.id);
  const slides = trpc.program.slides.overview.useQuery({ eventId: event.id });
  const noSlides = new Set((slides.data?.rows ?? []).filter((r) => !r.files.length).map((r) => r.id));
  const slideFiles = slides.data ? new Map(slides.data.rows.map((r) => [r.id, r.files.length])) : null;
  const [editing, setEditing] = useState(false);
  const missingSlides = (s: { sessions: { id: number }[] }) => s.sessions.some((x) => noSlides.has(x.id));
  const [spTab, setSpTab] = useState<string>("all");
  return (
    <AdminPage
      title={event.name}
      sub={fmtDates(event.startDate, event.endDate)}
      actions={
        canEdit ? (
          <>
            <Link href={`/admin/e/${event.id}/agreements?open=speaker`} className="btn">
              Edit agreement
            </Link>
            <SendAgreementsButton eventId={event.id} />
            <button className="btn btn-primary" onClick={() => setAdding(blankSpeaker)}>
              Add speaker
            </button>
          </>
        ) : undefined
      }
    >
      {adding ? (
        <div className="card card-pad col gap-14">
          <span className="editor-title">New speaker</span>
          <SpeakerFields f={adding} set={setAdding} />
          <div className="row gap-10">
            <button
              className="btn btn-sm btn-solid btn-w"
              disabled={create.isPending}
              onClick={async () => {
                try {
                  const row = await create.mutateAsync({ eventId: event.id, ...speakerInput(adding) });
                  setAdding(null);
                  await utils.program.speakers.adminList.invalidate({ eventId: event.id });
                  setOpen(row.id);
                  toast("Speaker added");
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Save
            </button>
            <button className="btn btn-sm btn-w" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {q.isLoading ? (
        <PageLoading />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : !q.data!.length ? (
        <Empty>No speakers yet. Click Add speaker, or accept proposals to add their presenters.</Empty>
      ) : (
        <div className="col" style={{ gap: 0 }}>
        <SpeakerTabs value={spTab} onChange={setSpTab} ids={q.data!.map((s) => s.id)} rows={agr.byId} extra={[{ key: "slides", label: `Slides missing (${q.data!.filter(missingSlides).length})` }]} />
        <div className="table">
          <div className="table-inner">
            <THead cols={SP_COLS} labels={["Speaker", "Session", "Agreement", "Welcome email", ""]} />
            {q.data!.filter((s) => (spTab === "slides" ? missingSlides(s) : inSpeakerTab(spTab, agr.byId.get(s.id)))).map((s) => {
              const isOpen = open === s.id;
              return (
                <div key={s.id} className={isOpen ? "trow-open" : ""} style={{ borderBottom: "1px solid var(--line)" }}>
                  <div className="trow" style={{ gridTemplateColumns: SP_COLS, borderBottom: "none" }}>
                    <div className="row gap-10" style={{ minWidth: 0 }}>
                      <Avatar url={s.headshotUrl} name={s.fullName} size={36} />
                      <span className="strong clip">{s.fullName}</span>
                      {s.featured ? <Pill tone="solid">Featured</Pill> : null}
                    </div>
                    <div className="clip">{s.sessions[0]?.title || <span className="muted">No session</span>}</div>
                    <div><AgreementPill row={agr.byId.get(s.id)} /></div>
                    <div><WelcomePill row={agr.byId.get(s.id)} /></div>
                    <button
                      type="button"
                      className="btn btn-sm btn-w"
                      onClick={() => {
                        setOpen(isOpen ? null : s.id);
                        setEditing(false);
                      }}
                    >
                      {isOpen ? "Close" : "Open"}
                    </button>
                  </div>
                  {isOpen ? (
                    <div className="editor">
                      {editing ? (
                        <div className="sp-expand one">
                          <section className="sp-sec" style={{ padding: "16px 18px" }}>
                            <SpeakerPanel speakerId={s.id} inRow startEditing onDone={() => setEditing(false)} onDeleted={() => setOpen(null)} />
                          </section>
                        </div>
                      ) : (
                        <div className="sp-expand">
                          <SpeakerSummary s={s} slideFiles={slideFiles} canEdit={canEdit} onEdit={() => setEditing(true)} />
                          <SpeakerAgreementSection eventId={event.id} speakerId={s.id} email={s.email} />
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        </div>
      )}
    </AdminPage>
  );
}

type SpeakerListRow = RouterOutputs["program"]["speakers"]["adminList"][number];

/** The Speaker card in an open speaker row: a short summary, and Edit opens the full speaker editor in place. */
function SpeakerSummary({ s, slideFiles, canEdit, onEdit }: { s: SpeakerListRow; slideFiles: Map<number, number> | null; canEdit: boolean; onEdit: () => void }) {
  const first = s.sessions[0];
  const photo = !!s.headshotFileId;
  const bio = !!s.bio.trim();
  const files = slideFiles ? s.sessions.reduce((n, x) => n + (slideFiles.get(x.id) ?? 0), 0) : null;
  return (
    <section className="sp-sec">
      <div className="sp-sh">
        <b>Speaker</b>
        {canEdit ? (
          <button type="button" className="btn btn-sm btn-w" onClick={onEdit}>
            Edit
          </button>
        ) : null}
      </div>
      <div className="sp-kv">
        <span className="k">Email</span>
        <span className="clip">{s.email || <span className="muted">Not set</span>}</span>
        <span className="k">{s.sessions.length > 1 ? "Sessions" : "Session"}</span>
        <span>
          {first ? (
            <>
              {fmtDate(first.date)} at {fmtTime(first.startTime)}
              {first.room ? ` · ${first.room}` : ""}
              {s.sessions.length > 1 ? <span className="muted"> and {s.sessions.length - 1} more</span> : null}
            </>
          ) : (
            <span className="muted">No session</span>
          )}
        </span>
        <span className="k">Bio and photo</span>
        <span>{photo && bio ? "Added" : photo ? "Bio missing" : bio ? "Photo missing" : "Missing"}</span>
        {files !== null && s.sessions.length ? (
          <>
            <span className="k">Slides</span>
            <span>{files ? `${files} ${files === 1 ? "file" : "files"}` : "Not uploaded"}</span>
          </>
        ) : null}
      </div>
    </section>
  );
}

function SpeakerPanel({ speakerId, inRow, onDeleted, startEditing, onDone }: { speakerId: number; inRow?: boolean; onDeleted: () => void; startEditing?: boolean; onDone?: () => void }) {
  const event = useAdminEvent();
  const { can } = useAdmin();
  const canEdit = can("speakers", "edit");
  const utils = trpc.useUtils();
  const q = trpc.program.speakers.adminGet.useQuery({ eventId: event.id, speakerId });
  const update = trpc.program.speakers.update.useMutation();
  const del = trpc.program.speakers.delete.useMutation();
  const ask = trpc.program.speakers.requestUpdate.useMutation();
  const addSession = trpc.program.speakers.addSession.useMutation();
  const removeSession = trpc.program.speakers.removeSession.useMutation();
  const [f, setF] = useState<SpeakerForm | null>(null);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { speaker: s, sessions, allSessions } = q.data!;
  const form: SpeakerForm = f ?? { firstName: s.firstName, lastName: s.lastName, credentials: s.credentials, jobTitle: s.jobTitle, organization: s.organization, city: s.city, bio: s.bio, headshotFileId: s.headshotFileId, headshotUrl: s.headshotUrl, website: s.website, email: s.email, featured: s.featured, allowMessages: s.allowMessages, sort: String(s.sort) };
  const refresh = () => Promise.all([utils.program.speakers.adminGet.invalidate({ eventId: event.id, speakerId }), utils.program.speakers.adminList.invalidate({ eventId: event.id })]);
  const notOn = allSessions.filter((x) => !sessions.some((y) => y.id === x.id));
  const sessionLine = (x: { title: string; date: string; startTime: string }) => `${x.title} (${fmtDate(x.date)}, ${fmtTime(x.startTime)})`;

  return (
    <div className="col gap-14">
      <Section
        canEdit={canEdit}
        title="Speaker profile"
        saving={update.isPending}
        startOpen={startEditing}
        onCancel={() => {
          setF(null);
          onDone?.();
        }}
        actions={
          <>
            {inRow ? <Link href={`/admin/e/${event.id}/speakers/${s.id}`} className="btn btn-sm btn-w">Full page</Link> : null}
            {s.email ? (
              <button
                type="button"
                className="btn btn-sm btn-w-lg"
                disabled={ask.isPending}
                onClick={async () => {
                  try {
                    await ask.mutateAsync({ eventId: event.id, speakerId: s.id });
                    toast(`Sent to ${s.email}`);
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Request update
              </button>
            ) : null}
          </>
        }
        onSave={async () => {
          await update.mutateAsync({ eventId: event.id, speakerId: s.id, ...speakerInput(form) });
          setF(null);
          await refresh();
          toast("Speaker saved");
          onDone?.();
        }}
        view={
          <div className="row gap-16" style={{ alignItems: "flex-start" }}>
            <Avatar url={s.headshotUrl} name={s.fullName} size={72} />
            <div className="grow">
              <Facts
                items={[
                  { label: "Name", value: s.fullName },
                  { label: "Title", value: s.jobTitle },
                  { label: "Organization", value: s.organization },
                  { label: "City", value: s.city },
                  { label: "Email", value: s.email },
                  { label: "Website", value: s.website },
                  { label: "Messages", value: s.allowMessages ? "Attendees can message" : "Off" },
                  { label: "Featured", value: s.featured ? "Yes" : "No" },
                  { label: "Order", value: String(s.sort) },
                  { label: "Bio", value: s.bio, wide: true },
                  { label: "Sessions", value: sessions.length ? sessions.map(sessionLine).join(" · ") : "None yet", wide: true },
                ]}
              />
            </div>
          </div>
        }
        edit={
          <div className="col gap-14">
            <SpeakerFields f={form} set={setF} />
            <div className="col gap-8">
              <span className="small muted strong">Sessions</span>
              {sessions.map((x) => (
                <div key={x.id} className="row gap-10">
                  <span className="grow" style={{ fontSize: 14, fontWeight: 600 }}>
                    {x.title} · {fmtDate(x.date)}, {fmtTime(x.startTime)}
                    <span className="muted"> ({roleLabel(x.role)})</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-w"
                    disabled={removeSession.isPending}
                    onClick={async () => {
                      try {
                        await removeSession.mutateAsync({ eventId: event.id, speakerId: s.id, sessionId: x.id });
                        await refresh();
                      } catch (err) {
                        toast(errorText(err), true);
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {notOn.length ? (
                <select
                  className="select"
                  style={{ maxWidth: 360 }}
                  aria-label="Add a session"
                  value=""
                  onChange={async (e) => {
                    const id = Number(e.target.value);
                    if (!id) return;
                    try {
                      await addSession.mutateAsync({ eventId: event.id, speakerId: s.id, sessionId: id, role: "presenter" });
                      await refresh();
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  <option value="">Add a session</option>
                  {notOn.map((x) => (
                    <option key={x.id} value={x.id}>{sessionLine(x)}</option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>
        }
      />
      {canEdit && !f ? (
        <div className="row">
          <button
            type="button"
            className="btn btn-sm btn-danger btn-w"
            disabled={del.isPending}
            onClick={async () => {
              if (!confirmAction(`Delete ${s.fullName}? They come off every session they are on.`)) return;
              try {
                await del.mutateAsync({ eventId: event.id, speakerId: s.id });
                await utils.program.speakers.adminList.invalidate({ eventId: event.id });
                onDeleted();
                toast("Speaker deleted");
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** /admin/e/:eventId/speakers/:speakerId */
export function AdminSpeakerEditScreen({ speakerId }: { speakerId: number }) {
  const event = useAdminEvent();
  const [, navigate] = useLocation();
  const q = trpc.program.speakers.adminGet.useQuery({ eventId: event.id, speakerId });
  const back = `/admin/e/${event.id}/speakers`;
  return (
    <AdminPage title={q.data?.speaker.fullName ?? "Speaker"} actions={<Link href={back} className="btn">All speakers</Link>}>
      {q.error ? (
        <ErrorNote error={q.error} />
      ) : (
        <div className="card card-pad">
          <SpeakerPanel speakerId={speakerId} onDeleted={() => navigate(back)} />
        </div>
      )}
    </AdminPage>
  );
}
