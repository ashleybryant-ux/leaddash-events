/**
 * Welcome emails page tabs: Attendees (the existing screen), Speakers,
 * Sponsors and Exhibitors. /admin/e/:eventId/registration?tab=welcome&who=speakers
 */
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import type { useAdminEvent } from "../../shells/AdminShell";
import { ExpandRow, Field, FolderTabs, PageLoading, ErrorNote, Pill, confirmAction } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { useDebounced } from "./shared";

type AdminEvent = ReturnType<typeof useAdminEvent>;
type Group = "speakers" | "sponsors" | "exhibitors";
type Who = "attendees" | Group;
type Data = RouterOutputs["registration"]["welcomes"]["get"];
type Msg = Data["welcome"];
type Draft = { kind: Msg["kind"]; enabled: boolean; sendRule: string; fromName: string; replyTo: string; subject: string; body: string; includes: Record<string, boolean | string>; logoDueOn: string };

const LABELS: Record<Who, string> = { attendees: "Attendees", speakers: "Speakers", sponsors: "Sponsors", exhibitors: "Exhibitors" };
const NOUN: Record<Group, [string, string]> = { speakers: ["speaker", "speakers"], sponsors: ["sponsor", "sponsors"], exhibitors: ["exhibitor", "exhibitors"] };

function useWho(): [Who, (w: Who) => void] {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const raw = new URLSearchParams(search).get("who");
  const who: Who = raw === "speakers" || raw === "sponsors" || raw === "exhibitors" ? raw : "attendees";
  return [who, (w) => navigate(`${location}?tab=welcome${w === "attendees" ? "" : `&who=${w}`}`)];
}

/** Folder tabs above the card: Attendees, Speakers (n), Sponsors (n), Exhibitors (n). */
export function WelcomeTabsBar({ event }: { event: AdminEvent }) {
  const [who, setWho] = useWho();
  const counts = trpc.registration.welcomes.counts.useQuery({ eventId: event.id });
  const tabs: { key: Who; label: string }[] = [{ key: "attendees", label: LABELS.attendees }, ...(counts.data ?? []).map((c) => ({ key: c.group as Who, label: `${LABELS[c.group]} (${c.count})` }))];
  return <FolderTabs tabs={tabs} value={who} onChange={setWho} />;
}

/** The card body for the chosen tab. `attendees` is the existing Attendees screen. */
export function WelcomeTabBody({ event, attendees }: { event: AdminEvent; attendees: ReactNode }) {
  const [who] = useWho();
  if (who === "attendees") return <>{attendees}</>;
  return <GroupTab key={who} event={event} group={who} />;
}

const toDraft = (t: Msg): Draft => ({
  kind: t.kind,
  enabled: t.enabled,
  sendRule: t.sendRule,
  fromName: t.fromName,
  replyTo: t.replyTo,
  subject: t.subject,
  body: t.body,
  includes: Object.fromEntries(Object.entries(t.includes).filter((e): e is [string, boolean | string] => e[1] !== undefined)),
  logoDueOn: t.logoDueOn,
});

const card: CSSProperties = { background: "#FFFFFF", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" };
const cardHead: CSSProperties = { padding: "12px 14px", borderBottom: "1px solid var(--line-2)", minHeight: 32 };
const caps: CSSProperties = { fontSize: 11.5, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)" };
const fieldChip: CSSProperties = { border: "none", background: "#E6F0EC", color: "var(--brand)", fontSize: 13, fontWeight: 700, borderRadius: 6, padding: "4px 8px", cursor: "pointer" };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "164px minmax(0, 1fr)", gap: 12, padding: "3px 0", fontSize: 14 }}>
      <span className="muted" style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ whiteSpace: "pre-line" }}>{children || <span className="muted">Not set</span>}</span>
    </div>
  );
}

function useTest(eventId: number) {
  const m = trpc.registration.welcomes.sendTest.useMutation();
  return {
    pending: m.isPending,
    send: async (d: Draft) => {
      try {
        const r = await m.mutateAsync({ eventId, ...d });
        toast(`Test sent to ${r.to}`);
      } catch (err) {
        toast(errorText(err), true);
      }
    },
  };
}

function GroupTab({ event, group }: { event: AdminEvent; group: Group }) {
  const q = trpc.registration.welcomes.get.useQuery({ eventId: event.id, group });
  const [welcomeDraft, setWelcomeDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [followDraft, setFollowDraft] = useState<Draft | null>(null);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const data = q.data!;
  const shown = (open ? followDraft : null) ?? welcomeDraft ?? toDraft(data.welcome);
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div className="col" style={{ flex: "1 1 520px", minWidth: 0, gap: 14 }}>
        <WelcomeCard key={String(data.welcome.updatedAt)} event={event} group={group} data={data} draft={welcomeDraft} setDraft={setWelcomeDraft} />
        <div style={card}>
          <div style={cardHead} className="row">
            <span className="h3" style={{ fontSize: 14 }}>Follow-up messages</span>
          </div>
          <div>
            {data.followUps.map((f) => (
              <ExpandRow
                key={f.id}
                cols="minmax(0, 1fr) 200px 48px 104px"
                open={open === f.kind}
                onToggle={() => {
                  setFollowDraft(open === f.kind ? null : toDraft(f));
                  setOpen(open === f.kind ? null : f.kind);
                }}
                closedLabel={data.canEdit ? "Edit" : "Details"}
                cells={[<span className="strong">{f.label}</span>, <span className="muted">{f.ruleLabel}</span>, <Pill tone={f.enabled ? "green" : "gray"}>{f.enabled ? "On" : "Off"}</Pill>]}
              >
                <FollowUpEditor
                  key={String(f.updatedAt)}
                  event={event}
                  group={group}
                  t={f}
                  readOnly={!data.canEdit}
                  onChange={setFollowDraft}
                  onDone={() => {
                    setOpen(null);
                    setFollowDraft(null);
                  }}
                />
              </ExpandRow>
            ))}
          </div>
        </div>
      </div>
      <Preview event={event} draft={shown} />
    </div>
  );
}

function WelcomeCard({ event, group, data, draft, setDraft }: { event: AdminEvent; group: Group; data: Data; draft: Draft | null; setDraft: (d: Draft | null) => void }) {
  const utils = trpc.useUtils();
  const save = trpc.registration.welcomes.save.useMutation();
  const sendNew = trpc.registration.welcomes.sendToNew.useMutation();
  const test = useTest(event.id);
  const body = useRef<HTMLTextAreaElement>(null);
  const t = data.welcome;
  const d = draft;
  const choice = data.choices.find((c) => c.value === (d?.sendRule ?? t.sendRule));

  function insertField(name: string) {
    if (!d) return;
    const token = `{{${name}}}`;
    const el = body.current;
    const at = el ? el.selectionStart : d.body.length;
    const end = el ? el.selectionEnd : d.body.length;
    setDraft({ ...d, body: d.body.slice(0, at) + token + d.body.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  }

  async function submit() {
    if (!d) return;
    try {
      await save.mutateAsync({ eventId: event.id, ...d });
      await utils.registration.welcomes.get.invalidate({ eventId: event.id, group });
      setDraft(null);
      toast("Welcome email saved");
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  async function sendToNew() {
    const n = data.summary.ready;
    if (!t.enabled) return toast("Turn the welcome email on first.", true);
    if (!n) return toast("Everyone who qualifies already has it.");
    const [one, many] = NOUN[group];
    if (!confirmAction(`Send the welcome email to ${n} ${n === 1 ? one : many} who ${n === 1 ? "has" : "have"} not gotten it?`)) return;
    try {
      const r = await sendNew.mutateAsync({ eventId: event.id, group });
      await Promise.all([utils.registration.welcomes.get.invalidate({ eventId: event.id, group }), utils.registration.welcomes.counts.invalidate()]);
      toast(`Sent to ${r.sent} ${r.sent === 1 ? one : many}`);
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  return (
    <div style={{ ...card, borderColor: d ? "var(--brand)" : "var(--line)", boxShadow: d ? "0 0 0 1px var(--brand)" : undefined }}>
      <div style={cardHead} className="row-between">
        <span className="h3" style={{ fontSize: 14 }}>Welcome email</span>
        {d ? null : (
          <div className="row gap-8">
            <button type="button" className="btn btn-sm" disabled={test.pending} onClick={() => test.send(toDraft(t))}>
              Send me a test
            </button>
            {data.canEdit ? (
              <>
                <button type="button" className="btn btn-sm" disabled={sendNew.isPending} onClick={sendToNew}>
                  Send to new
                </button>
                <button type="button" className="btn btn-sm btn-w" onClick={() => setDraft(toDraft(t))}>
                  Edit
                </button>
              </>
            ) : null}
          </div>
        )}
      </div>
      {!d ? (
        <div style={{ padding: "10px 14px 12px" }}>
          <Row label="Send">{t.ruleLabel}</Row>
          <Row label="From name">{t.fromName}</Row>
          <Row label="Reply-to">{t.replyTo}</Row>
          <Row label="Subject">{t.subject}</Row>
          <Row label="Message">{t.body}</Row>
          <Row label="Include in the email">{t.includesLabel}</Row>
          <Row label="Status">{t.enabled ? "On" : "Off"}</Row>
          <Row label="Sent so far">{data.summary.sentLabel}</Row>
        </div>
      ) : (
        <div className="col" style={{ padding: "12px 14px 14px", gap: 12 }}>
          <div className="grid-2" style={{ alignItems: "end" }}>
            <Field label="Send">
              <select className="select" value={d.sendRule} onChange={(e) => setDraft({ ...d, sendRule: e.target.value })}>
                {data.choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <div style={{ background: "#E6F0EC", color: "var(--brand)", borderRadius: 8, padding: "7px 10px", fontSize: 12.5, fontWeight: 700, lineHeight: 1.35 }}>{choice?.hint}</div>
            <Field label="From name">
              <input className="input" value={d.fromName} onChange={(e) => setDraft({ ...d, fromName: e.target.value })} />
            </Field>
            <Field label="Reply-to">
              <input className="input" type="email" value={d.replyTo} onChange={(e) => setDraft({ ...d, replyTo: e.target.value })} placeholder="conference@example.org" />
            </Field>
            <Field label="Subject" className="span-2">
              <input className="input" value={d.subject} onChange={(e) => setDraft({ ...d, subject: e.target.value })} />
            </Field>
            <Field label="Message" className="span-2">
              <textarea ref={body} className="textarea" rows={3} value={d.body} onChange={(e) => setDraft({ ...d, body: e.target.value })} />
            </Field>
          </div>
          <div className="col gap-8">
            <span style={caps}>Insert a field</span>
            <div className="row wrap gap-8">
              {data.fields.map((f) => (
                <button key={f} type="button" style={fieldChip} onClick={() => insertField(f)}>
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div className="col gap-8" style={{ fontSize: 14 }}>
            <span style={caps}>Include in the email</span>
            {data.includeOptions.map((o) => (
              <label key={o.key} className="check">
                <input type="checkbox" checked={d.includes[o.key] === true} onChange={(e) => setDraft({ ...d, includes: { ...d.includes, [o.key]: e.target.checked } })} />
                {o.label}
              </label>
            ))}
            <label className="check">
              <input type="checkbox" checked={d.enabled} onChange={(e) => setDraft({ ...d, enabled: e.target.checked })} />
              Send the welcome email
            </label>
          </div>
          <div className="row gap-10">
            <button type="button" className="btn btn-sm btn-solid btn-w" disabled={save.isPending} onClick={submit}>
              Save
            </button>
            <button type="button" className="btn btn-sm btn-w" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function daysLabel(kind: string) {
  if (kind === "speaker_slides_reminder") return "Days before slides are due";
  if (kind === "speaker_thanks") return "Days after the event";
  if (kind === "sponsor_logo_reminder") return "Days before the due date";
  return "Days before the event";
}

function FollowUpEditor({ event, group, t, readOnly, onChange, onDone }: { event: AdminEvent; group: Group; t: Msg; readOnly: boolean; onChange: (d: Draft) => void; onDone: () => void }) {
  const utils = trpc.useUtils();
  const save = trpc.registration.welcomes.save.useMutation();
  const test = useTest(event.id);
  const [d, setDState] = useState<Draft>(toDraft(t));
  const setD = (next: Draft) => {
    setDState(next);
    onChange(next);
  };
  const m = d.sendRule.match(/^days_(before|after):(\d+)$/);

  async function submit() {
    try {
      await save.mutateAsync({ eventId: event.id, ...d });
      await utils.registration.welcomes.get.invalidate({ eventId: event.id, group });
      toast(`${t.label} saved`);
      onDone();
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  return (
    <fieldset disabled={readOnly} style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="grid-3">
        <Field label="Status">
          <select className="select" value={d.enabled ? "on" : "off"} onChange={(e) => setD({ ...d, enabled: e.target.value === "on" })}>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </Field>
        {m ? (
          <Field label={daysLabel(t.kind)} hint="Sends at 9:00 AM event time">
            <input className="input" type="number" min={1} max={120} value={m[2]} onChange={(e) => setD({ ...d, sendRule: `days_${m[1]}:${Math.max(1, Math.min(120, Number(e.target.value) || 1))}` })} />
          </Field>
        ) : (
          <Field label="Send">
            <span style={{ fontWeight: 600, padding: "8px 0" }}>{t.ruleLabel}</span>
          </Field>
        )}
        {t.kind === "sponsor_logo_reminder" ? (
          <Field label="Logo and ad due">
            <input className="input" type="date" value={d.logoDueOn} onChange={(e) => setD({ ...d, logoDueOn: e.target.value })} />
          </Field>
        ) : null}
        <Field label="Subject" className="span-3">
          <input className="input" value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
        </Field>
        <Field label="Message" className="span-3">
          <textarea className="textarea" rows={3} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
        </Field>
      </div>
      {!readOnly ? (
        <div className="row gap-10">
          <button type="button" className="btn btn-sm btn-solid btn-w" disabled={save.isPending} onClick={submit}>
            Save
          </button>
          <button type="button" className="btn btn-sm btn-w" onClick={onDone}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm" disabled={test.pending} onClick={() => test.send(d)}>
            Send me a test
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}

function Preview({ event, draft }: { event: AdminEvent; draft: Draft }) {
  const debounced = useDebounced(draft, 450);
  const preview = trpc.registration.welcomes.preview.useQuery({ eventId: event.id, ...debounced }, { placeholderData: (prev) => prev, retry: false });
  const [height, setHeight] = useState(640);
  return (
    <div className="col gap-8" style={{ flex: "0 0 350px", maxWidth: "100%", background: "#F8FAFB", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 4px 4px" }}>
      <span className="small muted strong" style={{ paddingLeft: 8 }}>Preview</span>
      {preview.error ? (
        <div className="small err">{errorText(preview.error)}</div>
      ) : preview.data?.html ? (
        <iframe
          title="Email preview"
          sandbox="allow-same-origin"
          srcDoc={preview.data.html}
          onLoad={(e) => {
            const doc = e.currentTarget.contentDocument;
            if (doc?.body) setHeight(Math.max(200, doc.body.offsetHeight + 4));
          }}
          style={{ width: "100%", height, border: 0, display: "block", background: "transparent" }}
        />
      ) : (
        <PageLoading />
      )}
    </div>
  );
}
