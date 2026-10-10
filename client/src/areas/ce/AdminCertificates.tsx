/**
 * /admin/e/:eventId/certificates: the CE certificate template with a preview,
 * issued certificates (view, resend, revoke, restore), issuing by hand, and
 * the CE records export.
 * /admin/e/:eventId/certificates/:templateId: editing a template.
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { Empty, ErrorNote, Field, KV, Modal, PageLoading, Pill, THead, UploadButton, confirmAction } from "../../ui/components";
import { IconSearch } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtTime, fmtWhen } from "@shared/format";
import { CertificateView, type CertData } from "./views";
import { downloadCsv } from "./util";

type Template = RouterOutputs["ce"]["certificates"]["templates"][number];
type Show = Template["show"];

const certsPath = (eventId: number) => `/admin/e/${eventId}/certificates`;
const ISSUED_COLS = "minmax(0, 1.2fr) minmax(0, 1.6fr) 130px 60px 96px 96px 96px";
const hours = (h: number) => (Number.isInteger(h) ? h.toFixed(1) : String(h));
const issuedWhen = (t: Pick<Template, "requireEvaluation">) => (t.requireEvaluation ? "Checked in and evaluation submitted" : "Checked in");

/** Sample certificate for a template (or a draft of one). */
function sampleCert(t: Pick<Template, "title" | "providerName" | "providerNumber" | "approvalText" | "signerName" | "signerTitle" | "signatureStyle" | "show" | "preview">, signatureUrl: string | null): CertData {
  const p = t.preview;
  return {
    certificateTitle: t.title || "Certificate of Completion",
    name: t.show.credentials ? "Jordan Mitchell, LPC" : "Jordan Mitchell",
    sessionTitle: t.show.sessionTitle ? p.sample.title : "",
    date: t.show.sessionDate ? p.sample.date : "",
    hours: t.show.hours ? p.sample.hours : null,
    presenters: t.show.presenter ? ["Presenter Name, PhD"] : [],
    approvalText: t.approvalText,
    providerName: t.providerName || p.providerName,
    providerNumber: t.providerNumber,
    signerName: t.signerName,
    signerTitle: t.signerTitle,
    signatureStyle: t.signatureStyle,
    signatureUrl: t.signatureStyle === "image" ? signatureUrl : null,
    logoUrl: p.logoUrl,
    colorPrimary: p.colorPrimary,
    code: t.show.code ? "SAMPLE2027" : null,
    eventName: p.eventName,
  };
}

function Preview({ c }: { c: CertData }) {
  return (
    <div className="card card-pad col gap-12" style={{ flex: "1 1 380px", minWidth: 0 }}>
      <div className="h3">Preview</div>
      <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
        <CertificateView c={c} />
      </div>
    </div>
  );
}

export function AdminCertificates() {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const templates = trpc.ce.certificates.templates.useQuery({ eventId: ev.id });
  const createTemplate = trpc.ce.certificates.createTemplate.useMutation();
  const [exporting, setExporting] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const canEdit = can("certificates", "edit");
  const list = templates.data ?? [];
  const main = list.find((t) => t.isDefault) ?? list[0];
  const others = list.filter((t) => t !== main);

  return (
    <AdminPage
      title="Certificates"
      actions={
        <>
          {canEdit && can("attendees") ? (
            <button className="btn" onClick={() => setIssuing(true)}>
              Issue certificate
            </button>
          ) : null}
          <button
            className="btn btn-primary"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                downloadCsv(await utils.ce.certificates.exportCsv.fetch({ eventId: ev.id }));
              } catch (err) {
                toast(errorText(err), true);
              } finally {
                setExporting(false);
              }
            }}
          >
            Export CE records
          </button>
        </>
      }
    >
      {templates.isLoading ? (
        <PageLoading />
      ) : templates.error ? (
        <ErrorNote error={templates.error} />
      ) : !main ? (
        <div className="card card-pad col gap-12">
          <Empty>No certificate template yet. Certificates are issued with the default template.</Empty>
          {canEdit ? (
            <button
              className="btn btn-sm btn-w-lg"
              style={{ alignSelf: "center" }}
              onClick={async () => {
                const row = await createTemplate.mutateAsync({ eventId: ev.id }).catch((err) => void toast(errorText(err), true));
                if (row) navigate(`${certsPath(ev.id)}/${row.id}`);
              }}
            >
              Add template
            </button>
          ) : null}
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 18, alignItems: "stretch" }}>
          <div className="card card-pad col gap-12" style={{ flex: "999 1 360px", minWidth: 0 }}>
            <div className="row-between">
              <div className="h3">Certificate template: {main.name}</div>
              {canEdit ? (
                <Link className="btn btn-sm btn-w" href={`${certsPath(ev.id)}/${main.id}`}>
                  Edit
                </Link>
              ) : null}
            </div>
            <div>
              <KV label="CE provider">{main.providerName}</KV>
              <KV label="Provider number">{main.providerNumber}</KV>
              <KV label="Approval statement">{main.approvalText}</KV>
              <KV label="Signed by">{[main.signerName, main.signerTitle].filter(Boolean).join(", ")}</KV>
              <KV label="Issued when">{issuedWhen(main)}</KV>
              <KV label="One certificate per">{main.scope === "event" ? "Event (all sessions together)" : "Session"}</KV>
              <KV label="Minimum time in the room">{main.minMinutes ? `${main.minMinutes} minutes` : "None"}</KV>
            </div>
            {others.length || canEdit ? (
              <div className="col gap-8">
                {others.length ? <span className="label-caps">Other templates</span> : null}
                {others.map((t) => (
                  <div key={t.id} className="row-between" style={{ fontSize: 13 }}>
                    <span className="strong">{t.name}</span>
                    {canEdit ? (
                      <Link className="btn btn-sm btn-w" href={`${certsPath(ev.id)}/${t.id}`}>
                        Edit
                      </Link>
                    ) : null}
                  </div>
                ))}
                {canEdit ? (
                  <button
                    className="btn btn-sm btn-w-lg"
                    disabled={createTemplate.isPending}
                    onClick={async () => {
                      const row = await createTemplate.mutateAsync({ eventId: ev.id }).catch((err) => void toast(errorText(err), true));
                      if (row) navigate(`${certsPath(ev.id)}/${row.id}`);
                    }}
                  >
                    Add template
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <Preview c={sampleCert(main, main.signatureUrl)} />
        </div>
      )}

      <Issued />
      <IssueModal open={issuing} onClose={() => setIssuing(false)} />
    </AdminPage>
  );
}

function Issued() {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const q = trpc.ce.certificates.issued.useQuery({ eventId: ev.id });
  const resend = trpc.ce.certificates.resend.useMutation();
  const revoke = trpc.ce.certificates.revoke.useMutation();
  const issue = trpc.ce.certificates.issue.useMutation();
  const [term, setTerm] = useState("");
  const canEdit = can("certificates", "edit");
  const rows = useMemo(() => {
    const t = term.trim().toLowerCase();
    const all = q.data ?? [];
    return t ? all.filter((r) => r.name.toLowerCase().includes(t) || r.email.includes(t) || r.title.toLowerCase().includes(t) || r.code.toLowerCase() === t) : all;
  }, [q.data, term]);
  const refresh = () => utils.ce.certificates.issued.invalidate();

  return (
    <div className="col gap-12">
      <div className="row-between wrap">
        <div className="h3">Issued ({(q.data ?? []).filter((c) => !c.revokedAt).length.toLocaleString()})</div>
        <label style={{ height: 36, width: 320, maxWidth: "100%", borderRadius: 8, border: "1px solid #D5DEDA", background: "#FFFFFF", color: "var(--muted)", display: "flex", alignItems: "center", gap: 8, padding: "0 10px" }}>
          <IconSearch size={16} />
          <input aria-label="Search certificates" placeholder="Search by name, session or ID" value={term} onChange={(e) => setTerm(e.target.value)} style={{ flex: 1, minWidth: 0, border: "none", outline: "none", fontSize: 13, background: "#FFFFFF" }} />
        </label>
      </div>
      <div className="table">
        {q.isLoading ? (
          <PageLoading />
        ) : q.error ? (
          <ErrorNote error={q.error} />
        ) : (
          <div className="table-inner" style={{ minWidth: 960 }}>
            <THead cols={ISSUED_COLS} labels={["Attendee", "Session", "Issued", "CE", "", "", ""]} />
            {!rows.length ? (
              <Empty>{q.data?.length ? "No certificates match." : "No certificates yet. They are issued when people check in to CE sessions and submit the evaluation."}</Empty>
            ) : (
              rows.map((c) => (
                <div key={c.id} className="trow" style={{ gridTemplateColumns: ISSUED_COLS }}>
                  <span className="col gap-4" style={{ minWidth: 0 }}>
                    <span className="strong clip">{c.name}</span>
                    {c.revokedAt ? <Pill tone="red">Revoked {fmtWhen(c.revokedAt)}</Pill> : null}
                  </span>
                  <span className="clip">{c.title}</span>
                  <span>{fmtWhen(c.issuedAt)}</span>
                  <span>{hours(c.hours)}</span>
                  <a className="btn btn-sm btn-w" href={`/cert/${c.code}`} target="_blank" rel="noopener">
                    View
                  </a>
                  {canEdit && !c.revokedAt ? (
                    <button
                      className="btn btn-sm btn-w"
                      disabled={resend.isPending}
                      onClick={async () => {
                        try {
                          await resend.mutateAsync({ eventId: ev.id, certificateId: c.id });
                          toast(`Sent to ${c.email}`);
                        } catch (err) {
                          toast(errorText(err), true);
                        }
                      }}
                    >
                      Resend
                    </button>
                  ) : (
                    <span />
                  )}
                  {canEdit ? (
                    c.revokedAt ? (
                      <button
                        className="btn btn-sm btn-w"
                        disabled={issue.isPending}
                        onClick={async () => {
                          try {
                            await issue.mutateAsync({ eventId: ev.id, attendeeId: c.attendeeId, sessionId: c.sessionId, hours: c.hours });
                            toast("Certificate restored and emailed");
                            await refresh();
                          } catch (err) {
                            toast(errorText(err), true);
                          }
                        }}
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm btn-w btn-danger"
                        disabled={revoke.isPending}
                        onClick={async () => {
                          if (!confirmAction(`Revoke ${c.name}'s certificate for ${c.title}? The certificate page will say it is no longer valid.`)) return;
                          try {
                            await revoke.mutateAsync({ eventId: ev.id, certificateId: c.id });
                            await refresh();
                          } catch (err) {
                            toast(errorText(err), true);
                          }
                        }}
                      >
                        Revoke
                      </button>
                    )
                  ) : (
                    <span />
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Issue a certificate by hand, for a session or for the whole event. */
function IssueModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const people = trpc.ce.attendees.list.useQuery({ eventId: ev.id }, { enabled: open });
  const sessions = trpc.ce.attendees.sessions.useQuery({ eventId: ev.id }, { enabled: open });
  const issue = trpc.ce.certificates.issue.useMutation();
  const [term, setTerm] = useState("");
  const [attendeeId, setAttendeeId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [hrs, setHrs] = useState("");
  const session = (sessions.data ?? []).find((s) => String(s.id) === sessionId);
  const matches = (people.data ?? []).filter((p) => p.status !== "cancelled" && (!term.trim() || `${p.firstName} ${p.lastName} ${p.email}`.toLowerCase().includes(term.trim().toLowerCase()))).slice(0, 200);
  const close = () => {
    setTerm("");
    setAttendeeId("");
    setSessionId("");
    setHrs("");
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title="Issue certificate">
      {people.error ? <ErrorNote error={people.error} /> : null}
      <div className="grid-2">
        <Field label="Find attendee" className="span-2">
          <input className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name or email" />
        </Field>
        <Field label="Attendee" className="span-2">
          <select className="select" value={attendeeId} onChange={(e) => setAttendeeId(e.target.value)}>
            <option value="">Pick a person</option>
            {matches.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.email})
              </option>
            ))}
          </select>
        </Field>
        <Field label="For" className="span-2">
          <select
            className="select"
            value={sessionId}
            onChange={(e) => {
              setSessionId(e.target.value);
              const s = (sessions.data ?? []).find((x) => String(x.id) === e.target.value);
              setHrs(s && s.ceHours > 0 ? String(s.ceHours) : "");
            }}
          >
            <option value="">The whole event</option>
            {(sessions.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {fmtDate(s.date)}, {fmtTime(s.startTime)}: {s.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="CE hours">
          <input className="input" inputMode="decimal" value={hrs} onChange={(e) => setHrs(e.target.value.replace(/[^\d.]/g, ""))} placeholder={session ? hours(session.ceHours) : "3.0"} />
        </Field>
      </div>
      <p className="small muted" style={{ margin: 0 }}>We email the certificate to them right away.</p>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={!attendeeId || issue.isPending}
          onClick={async () => {
            try {
              await issue.mutateAsync({ eventId: ev.id, attendeeId: Number(attendeeId), sessionId: sessionId ? Number(sessionId) : null, hours: hrs ? Number(hrs) : undefined });
              toast("Certificate issued and emailed");
              await utils.ce.certificates.issued.invalidate();
              close();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Issue
        </button>
        <button className="btn btn-sm btn-w" onClick={close}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

// ---------- /certificates/:templateId ----------

export function AdminCertificateEdit({ templateId }: { templateId: number }) {
  const ev = useAdminEvent();
  const q = trpc.ce.certificates.template.useQuery({ eventId: ev.id, templateId });
  if (q.isLoading) return <AdminPage title="Certificates"><PageLoading /></AdminPage>;
  if (q.error) return <AdminPage title="Certificates"><ErrorNote error={q.error} /></AdminPage>;
  return <TemplateEditor key={q.dataUpdatedAt} t={q.data!} />;
}

const SHOW_LABELS: { key: keyof Show; label: string }[] = [
  { key: "credentials", label: "Credentials" },
  { key: "sessionTitle", label: "Session title" },
  { key: "sessionDate", label: "Session date" },
  { key: "hours", label: "CE hours" },
  { key: "code", label: "Certificate ID" },
  { key: "presenter", label: "Presenter name" },
];

function TemplateEditor({ t }: { t: RouterOutputs["ce"]["certificates"]["template"] }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const save = trpc.ce.certificates.updateTemplate.useMutation();
  const remove = trpc.ce.certificates.removeTemplate.useMutation();
  const [d, setD] = useState({
    name: t.name,
    title: t.title,
    providerName: t.providerName,
    providerNumber: t.providerNumber,
    approvalText: t.approvalText,
    signerName: t.signerName,
    signerTitle: t.signerTitle,
    signatureStyle: t.signatureStyle,
    signatureFileId: t.signatureFileId,
    scope: t.scope,
    requireEvaluation: t.requireEvaluation,
    minMinutes: t.minMinutes,
    isDefault: t.isDefault,
    show: t.show,
  });
  const [sigUrl, setSigUrl] = useState<string | null>(t.signatureUrl);
  const set = (k: "name" | "title" | "providerName" | "providerNumber" | "approvalText" | "signerName" | "signerTitle") => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const back = certsPath(ev.id);
  const canEdit = can("certificates", "edit");

  return (
    <AdminPage title="Certificates">
      <div className="row wrap" style={{ gap: 18, alignItems: "flex-start" }}>
        <div className="card card-pad col gap-14" style={{ flex: "999 1 400px", minWidth: 0 }}>
          <div className="row-between">
            <div className="h3">Editing certificate template</div>
            {canEdit && !t.isDefault ? (
              <button
                className="btn btn-sm btn-w btn-danger"
                disabled={remove.isPending}
                onClick={async () => {
                  if (!confirmAction(`Delete ${t.name}? Certificates already issued keep their details.`)) return;
                  try {
                    await remove.mutateAsync({ eventId: ev.id, templateId: t.id });
                    await utils.ce.certificates.invalidate();
                    navigate(back);
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Delete
              </button>
            ) : null}
          </div>
          <div className="grid-2" style={{ gap: "12px 16px" }}>
            <Field label="Template name">
              <input className="input" value={d.name} onChange={set("name")} />
            </Field>
            <Field label="Certificate title">
              <input className="input" value={d.title} onChange={set("title")} />
            </Field>
            <Field label="CE provider">
              <input className="input" value={d.providerName} onChange={set("providerName")} />
            </Field>
            <Field label="Provider number">
              <input className="input" value={d.providerNumber} onChange={set("providerNumber")} />
            </Field>
            <Field label="Approval statement" className="span-2">
              <textarea className="textarea" rows={2} value={d.approvalText} onChange={set("approvalText")} />
            </Field>
            <Field label="Signer name">
              <input className="input" value={d.signerName} onChange={set("signerName")} />
            </Field>
            <Field label="Signer title">
              <input className="input" value={d.signerTitle} onChange={set("signerTitle")} />
            </Field>
            <Field label="Signature">
              <select className="select" value={d.signatureStyle} onChange={(e) => setD({ ...d, signatureStyle: e.target.value as typeof d.signatureStyle })}>
                <option value="script">Typed in script</option>
                <option value="image">Uploaded image</option>
              </select>
            </Field>
            {d.signatureStyle === "image" ? (
              <Field label="Signature image">
                <span className="row gap-8">
                  <UploadButton
                    label={sigUrl ? "Replace" : "Upload"}
                    eventId={ev.id}
                    onUploaded={(f) => {
                      setD({ ...d, signatureFileId: f.id });
                      setSigUrl(f.url);
                    }}
                  />
                  {sigUrl ? <img src={sigUrl} alt="Signature" style={{ height: 30, maxWidth: 140, objectFit: "contain" }} /> : <span className="small muted">None yet</span>}
                </span>
              </Field>
            ) : (
              <span />
            )}
            <Field label="Issued when">
              <select className="select" value={d.requireEvaluation ? "eval" : "checkin"} onChange={(e) => setD({ ...d, requireEvaluation: e.target.value === "eval" })}>
                <option value="eval">Checked in and evaluation submitted</option>
                <option value="checkin">Checked in</option>
              </select>
            </Field>
            <Field label="One certificate per">
              <select className="select" value={d.scope} onChange={(e) => setD({ ...d, scope: e.target.value as typeof d.scope })}>
                <option value="session">Session</option>
                <option value="event">Event (all sessions together)</option>
              </select>
            </Field>
            <Field label="Minimum minutes in the room" hint="From check-in to the end of the session. 0 for none.">
              <input className="input" inputMode="numeric" value={d.minMinutes} onChange={(e) => setD({ ...d, minMinutes: Math.min(600, Number(e.target.value.replace(/\D/g, "") || 0)) })} />
            </Field>
            <label className="check" style={{ alignSelf: "start", marginTop: 22 }}>
              <input type="checkbox" checked={d.isDefault} disabled={t.isDefault} onChange={(e) => setD({ ...d, isDefault: e.target.checked })} />
              Issue certificates with this template
            </label>
            <fieldset className="span-2" style={{ margin: 0, border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px" }}>
              <legend className="small strong muted" style={{ padding: "0 4px" }}>Show on certificate</legend>
              <div className="grid-3" style={{ gap: 8 }}>
                {SHOW_LABELS.map((s) => (
                  <label key={s.key} className="check">
                    <input type="checkbox" checked={d.show[s.key]} onChange={(e) => setD({ ...d, show: { ...d.show, [s.key]: e.target.checked } })} />
                    {s.label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <div className="row gap-10">
            <button
              className="btn btn-sm btn-solid btn-w"
              disabled={!canEdit || save.isPending}
              onClick={async () => {
                try {
                  await save.mutateAsync({ eventId: ev.id, templateId: t.id, ...d });
                  toast("Saved");
                  await utils.ce.certificates.invalidate();
                  navigate(back);
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Save
            </button>
            <Link className="btn btn-sm btn-w" href={back}>
              Cancel
            </Link>
          </div>
        </div>
        <Preview c={sampleCert({ ...d, preview: t.preview }, sigUrl)} />
      </div>
    </AdminPage>
  );
}
