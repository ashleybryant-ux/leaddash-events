/**
 * /admin/e/:eventId/attendees: search, folder-tab filters, rows that expand
 * in place to edit, add by hand, cancel and restore, CSV import and export.
 */
import { useMemo, useRef, useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { Empty, ErrorNote, ExpandRow, Field, FolderTabs, KV, Modal, PageLoading, Pill, THead, confirmAction } from "../../ui/components";
import { AddAttendeeSheet } from "../network/AddAttendeeSheet";
import { NumStrip } from "../network/sponsor-ui";
import { IconSearch } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtTime, fmtWhenTime } from "@shared/format";
import { downloadCsv } from "./util";
import { usePrintBadge } from "./CheckInDesk";

type Row = RouterOutputs["ce"]["attendees"]["list"][number];
type Kind = Row["kind"];
type Tab = "all" | "in" | "out" | "unpaid" | "speakers" | "vendors" | "evals";

const KIND_LABEL: Record<Kind, string> = { attendee: "Attendee", speaker: "Speaker", vendor: "Exhibitor staff", staff: "Staff", guest: "Guest", volunteer: "Volunteer", sponsor: "Sponsor guest" };
const COLS = "minmax(0, 1.5fr) minmax(0, 0.9fr) minmax(0, 1fr) minmax(0, 1.1fr) 150px 70px 60px 96px";
const METHOD_WORD: Record<string, string> = { check: "check", cash: "cash", invoice: "invoice", other: "other" };

/** The Payment pill: how the person's ticket was paid. */
function PaymentPill({ p }: { p: Row["payment"] }) {
  if (!p) return <span className="muted">None</span>;
  switch (p.kind) {
    case "online":
      return <Pill>Paid online</Pill>;
    case "outside":
      return <Pill>{p.method === "other" ? "Paid outside the app" : `Paid by ${METHOD_WORD[p.method] ?? p.method}`}</Pill>;
    case "sponsor_pass":
      return <Pill tone="gray">Sponsor pass</Pill>;
    case "comp":
      return <Pill tone="gray">Complimentary</Pill>;
    case "free":
      return <Pill tone="gray">No charge</Pill>;
    case "unpaid":
      return <Pill tone="orange">Unpaid, link sent</Pill>;
    case "refunded":
      return <Pill tone="red">Refunded</Pill>;
  }
}

const hours = (h: number) => (Number.isInteger(h) ? h.toFixed(1) : String(h));

type Draft = {
  firstName: string;
  lastName: string;
  email: string;
  credentials: string;
  phone: string;
  city: string;
  organization: string;
  jobTitle: string;
  licenseNumber: string;
  licenseState: string;
  ticketTypeId: number | null;
  kind: Kind;
};

const toDraft = (r: Row): Draft => ({
  firstName: r.firstName,
  lastName: r.lastName,
  email: r.email,
  credentials: r.credentials,
  phone: r.phone ?? "",
  city: r.city,
  organization: r.organization,
  jobTitle: r.jobTitle,
  licenseNumber: r.licenseNumber,
  licenseState: r.licenseState,
  ticketTypeId: r.ticketTypeId,
  kind: r.kind,
});

function DetailFields({ d, setD, tickets }: { d: Draft; setD: (d: Draft) => void; tickets: { id: number; name: string }[] }) {
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <div className="grid-4">
      <Field label="First name">
        <input className="input" value={d.firstName} onChange={set("firstName")} />
      </Field>
      <Field label="Last name">
        <input className="input" value={d.lastName} onChange={set("lastName")} />
      </Field>
      <Field label="Credentials">
        <input className="input" value={d.credentials} onChange={set("credentials")} placeholder="LPC" />
      </Field>
      <Field label="City">
        <input className="input" value={d.city} onChange={set("city")} />
      </Field>
      <Field label="Email">
        <input className="input" type="email" value={d.email} onChange={set("email")} />
      </Field>
      <Field label="Mobile">
        <input className="input" type="tel" value={d.phone} onChange={set("phone")} />
      </Field>
      <Field label="Ticket">
        <select className="select" value={d.ticketTypeId ?? ""} onChange={(e) => setD({ ...d, ticketTypeId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">No ticket</option>
          {tickets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Badge type">
        <select className="select" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as Kind })}>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Organization">
        <input className="input" value={d.organization} onChange={set("organization")} />
      </Field>
      <Field label="Job title">
        <input className="input" value={d.jobTitle} onChange={set("jobTitle")} />
      </Field>
      <Field label="License number">
        <input className="input" value={d.licenseNumber} onChange={set("licenseNumber")} />
      </Field>
      <Field label="License state">
        <input className="input" value={d.licenseState} onChange={set("licenseState")} />
      </Field>
    </div>
  );
}

export function AdminAttendees() {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const list = trpc.ce.attendees.list.useQuery({ eventId: ev.id });
  const tickets = trpc.ce.attendees.tickets.useQuery({ eventId: ev.id });
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const canEdit = can("attendees", "edit");

  const rows = list.data ?? [];
  const searched = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) => `${r.firstName} ${r.lastName}`.toLowerCase().includes(t) || r.email.includes(t) || r.organization.toLowerCase().includes(t));
  }, [rows, q]);
  const active = (r: Row) => r.status !== "cancelled";
  const filters: Record<Tab, (r: Row) => boolean> = {
    all: () => true,
    in: (r) => active(r) && !!r.checkedInAt,
    out: (r) => active(r) && !r.checkedInAt,
    unpaid: (r) => active(r) && r.payment?.kind === "unpaid",
    speakers: (r) => r.kind === "speaker",
    vendors: (r) => r.kind === "vendor" || r.kind === "sponsor" || !!r.vendorId,
    evals: (r) => active(r) && r.evaluationsDue > 0,
  };
  const count = (t: Tab) => searched.filter(filters[t]).length;
  const shown = searched.filter(filters[tab]);
  const tabs: { key: Tab; label: string }[] = [
    { key: "all", label: `All (${count("all")})` },
    { key: "in", label: `Checked in (${count("in")})` },
    { key: "out", label: `Not checked in (${count("out")})` },
    { key: "unpaid", label: `Unpaid (${count("unpaid")})` },
    { key: "speakers", label: `Speakers (${count("speakers")})` },
    { key: "vendors", label: `Sponsors and exhibitors (${count("vendors")})` },
    { key: "evals", label: `Evaluations due (${count("evals")})` },
  ];
  const stat = (f: (r: Row) => boolean) => rows.filter(f).length;

  return (
    <AdminPage
      title="Attendees"
      actions={
        <>
          {canEdit ? (
            <button className="btn" onClick={() => setImporting(true)}>
              Import
            </button>
          ) : null}
          <button
            className="btn"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                downloadCsv(await utils.ce.attendees.exportCsv.fetch({ eventId: ev.id }));
              } catch (err) {
                toast(errorText(err), true);
              } finally {
                setExporting(false);
              }
            }}
          >
            Export
          </button>
          {canEdit ? (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              Add attendee
            </button>
          ) : null}
        </>
      }
    >
      {list.data ? (
        <NumStrip
          items={[
            { label: "Registered", value: stat((r) => r.status === "registered") },
            { label: "Checked in", value: stat((r) => active(r) && !!r.checkedInAt) },
            { label: "Unpaid", value: stat(filters.unpaid), warn: stat(filters.unpaid) > 0 },
            { label: "Sponsor passes", value: stat((r) => active(r) && r.payment?.kind === "sponsor_pass") },
          ]}
        />
      ) : null}
      <label style={{ height: 44, maxWidth: 520, borderRadius: 10, border: "1px solid #D5DEDA", background: "#FFFFFF", color: "var(--muted)", display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
        <IconSearch />
        <input aria-label="Search attendees" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 0, border: "none", outline: "none", fontSize: 14, color: "var(--ink)", background: "#FFFFFF" }} />
      </label>

      <div className="col" style={{ gap: 0 }}>
        <FolderTabs tabs={tabs} value={tab} onChange={(t) => setTab(t)} />
        <div className="table">
          {list.isLoading ? (
            <PageLoading />
          ) : list.error ? (
            <ErrorNote error={list.error} />
          ) : (
            <div className="table-inner" style={{ minWidth: 1040 }}>
              <THead cols={COLS} labels={["Name", "Type", "Ticket", "Payment", "Check-in", "Sessions", "CE", ""]} />
              {!shown.length ? (
                <Empty>{rows.length ? "No one matches." : "No attendees yet."}</Empty>
              ) : (
                shown.map((r) => (
                  <ExpandRow
                    key={r.id}
                    cols={COLS}
                    open={open === r.id}
                    onToggle={() => setOpen(open === r.id ? null : r.id)}
                    cells={[
                      <span className="col" style={{ gap: 0, minWidth: 0, alignItems: "flex-start" }}>
                        <span className="strong clip" style={{ maxWidth: "100%" }}>{r.name}</span>
                        {r.status === "cancelled" ? <Pill tone="red">Cancelled</Pill> : <span className="small muted clip" style={{ maxWidth: "100%" }}>{r.email}</span>}
                      </span>,
                      <span className="clip">{KIND_LABEL[r.kind]}</span>,
                      <span className="clip">{r.ticket || <span className="muted">No ticket</span>}</span>,
                      <PaymentPill p={r.payment} />,
                      r.checkedInAt ? <span>{fmtWhenTime(r.checkedInAt)}</span> : <span className="muted">Not yet</span>,
                      <span>{r.sessions}</span>,
                      <span>{hours(r.ceHours)}</span>,
                    ]}
                  >
                    <AttendeeEditor row={r} tickets={tickets.data ?? []} onDone={() => setOpen(null)} />
                  </ExpandRow>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <AddAttendeeSheet open={adding} onClose={() => setAdding(false)} />
      <ImportModal open={importing} onClose={() => setImporting(false)} />
    </AdminPage>
  );
}

function AttendeeEditor({ row, tickets, onDone }: { row: Row; tickets: { id: number; name: string }[]; onDone: () => void }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const update = trpc.ce.attendees.update.useMutation();
  const setStatus = trpc.ce.attendees.setStatus.useMutation();
  const printBadge = usePrintBadge(ev.id);
  const [d, setD] = useState<Draft>(() => toDraft(row));
  const canEdit = can("attendees", "edit");
  const refresh = () => Promise.all([utils.ce.attendees.list.invalidate(), utils.ce.checkin.invalidate()]);

  return (
    <>
      <div className="row-between wrap">
        <div className="editor-title">{canEdit ? "Editing attendee" : "Attendee"}</div>
        <div className="row gap-10 wrap">
          {can("checkin", "edit") && row.status !== "cancelled" ? (
            <button className="btn btn-sm btn-w-lg" onClick={() => printBadge(row.id).then(refresh)}>
              Reprint badge
            </button>
          ) : null}
          {canEdit ? (
            <button
              className={`btn btn-sm btn-w-lg${row.status === "cancelled" ? "" : " btn-danger"}`}
              disabled={setStatus.isPending}
              onClick={async () => {
                const cancel = row.status !== "cancelled";
                if (cancel && !confirmAction(`Cancel ${row.firstName} ${row.lastName}'s registration? They lose access to the app.`)) return;
                try {
                  await setStatus.mutateAsync({ eventId: ev.id, attendeeId: row.id, status: cancel ? "cancelled" : "registered" });
                  toast(cancel ? "Registration cancelled" : "Registration restored");
                  await refresh();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              {row.status === "cancelled" ? "Restore" : "Cancel"}
            </button>
          ) : null}
        </div>
      </div>

      {canEdit ? (
        <>
          <DetailFields d={d} setD={setD} tickets={tickets} />
          <div className="row gap-10">
            <button
              className="btn btn-sm btn-solid btn-w"
              disabled={update.isPending}
              onClick={async () => {
                try {
                  await update.mutateAsync({ eventId: ev.id, attendeeId: row.id, ...d });
                  toast("Saved");
                  await refresh();
                  onDone();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Save
            </button>
            <button
              className="btn btn-sm btn-w"
              onClick={() => {
                setD(toDraft(row));
                onDone();
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div>
          <KV label="Email">{row.email}</KV>
          <KV label="Mobile">{row.phone ?? ""}</KV>
          <KV label="City">{row.city}</KV>
          <KV label="Organization">{row.organization}</KV>
          <KV label="Ticket">{row.ticket}</KV>
          <KV label="Badge type">{KIND_LABEL[row.kind]}</KV>
          <KV label="License">{[row.licenseNumber, row.licenseState].filter(Boolean).join(", ")}</KV>
        </div>
      )}

      <div className="divider" />
      <SessionCheckins row={row} />
    </>
  );
}

/** Sessions this person checked in to (CE attendance), with staff add and remove. */
function SessionCheckins({ row }: { row: Row }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const mine = trpc.ce.checkin.session.forAttendee.useQuery({ eventId: ev.id, attendeeId: row.id });
  const sessions = trpc.ce.attendees.sessions.useQuery({ eventId: ev.id });
  const add = trpc.ce.checkin.session.add.useMutation();
  const remove = trpc.ce.checkin.session.remove.useMutation();
  const [pick, setPick] = useState("");
  const canEdit = can("attendees", "edit") || can("checkin", "edit");
  const refresh = () => Promise.all([mine.refetch(), utils.ce.attendees.list.invalidate()]);
  const have = new Set((mine.data ?? []).map((s) => s.sessionId));

  return (
    <div className="col gap-8">
      <span className="editor-title">Session check-ins</span>
      {mine.isLoading ? (
        <PageLoading />
      ) : mine.error ? (
        <ErrorNote error={mine.error} />
      ) : !mine.data?.length ? (
        <span className="small muted">No session check-ins yet.</span>
      ) : (
        <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
          {mine.data.map((s) => (
            <div key={s.sessionId} className="row" style={{ padding: "8px 12px", fontSize: 13 }}>
              <span className="grow col gap-4">
                <span className="strong clip">{s.title}</span>
                <span className="small muted">
                  {fmtDate(s.date)}, {fmtTime(s.startTime)}
                  {s.ceHours > 0 ? ` · ${hours(s.ceHours)} CE` : ""} · {s.method === "staff" ? "Added by staff" : s.method === "import" ? "Imported" : `Scanned ${fmtWhenTime(s.at)}`}
                </span>
              </span>
              {canEdit ? (
                <button
                  className="btn btn-sm btn-w"
                  disabled={remove.isPending}
                  onClick={async () => {
                    if (!confirmAction(`Remove the check-in for ${s.title}? Certificates already issued stay until you revoke them.`)) return;
                    try {
                      await remove.mutateAsync({ eventId: ev.id, sessionId: s.sessionId, attendeeId: row.id });
                      await refresh();
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {canEdit ? (
        <div className="row gap-10" style={{ maxWidth: 640 }}>
          <select className="select grow" aria-label="Session to add a check-in for" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Add a session check-in</option>
            {(sessions.data ?? [])
              .filter((s) => !have.has(s.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {fmtDate(s.date)}, {fmtTime(s.startTime)}: {s.title}
                  {s.ceHours > 0 ? ` (${hours(s.ceHours)} CE)` : ""}
                </option>
              ))}
          </select>
          <button
            className="btn btn-sm btn-w"
            disabled={!pick || add.isPending}
            onClick={async () => {
              try {
                await add.mutateAsync({ eventId: ev.id, sessionId: Number(pick), attendeeId: row.id });
                setPick("");
                await refresh();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const run = trpc.ce.attendees.importCsv.useMutation();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<{ added: number; skipped: number; errors: string[] } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const close = () => {
    setCsv("");
    setFileName("");
    setResult(null);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title="Import attendees">
      <p className="small muted" style={{ margin: 0, lineHeight: 1.5 }}>
        A CSV with these columns: name, email, ticket name, credentials, phone. A header row is fine. People already on the list are skipped.
      </p>
      <input
        ref={file}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setFileName(f.name);
          setCsv(await f.text());
          setResult(null);
        }}
      />
      <div className="row gap-10">
        <button className="btn btn-sm btn-w-lg" onClick={() => file.current?.click()}>
          Choose file
        </button>
        <span className="small muted clip">{fileName || "Or paste the rows below"}</span>
      </div>
      <textarea className="textarea" rows={6} aria-label="CSV rows" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="Jordan Mitchell,jordan@example.com,Member,LPC,(404) 555-0100" />
      {result ? (
        <div className="col gap-6">
          <div className={`banner ${result.errors.length ? "banner-warn" : "banner-ok"}`}>
            {result.added} added, {result.skipped} already on the list{result.errors.length ? `, ${result.errors.length} not added` : ""}
          </div>
          {result.errors.length ? (
            <ul className="small" style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflowY: "auto" }}>
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={!csv.trim() || run.isPending}
          onClick={async () => {
            try {
              const res = await run.mutateAsync({ eventId: ev.id, csv });
              setResult(res);
              await utils.ce.attendees.list.invalidate();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Import
        </button>
        <button className="btn btn-sm btn-w" onClick={close}>
          {result ? "Done" : "Cancel"}
        </button>
      </div>
    </Modal>
  );
}
