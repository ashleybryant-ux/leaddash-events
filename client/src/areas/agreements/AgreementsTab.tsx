/**
 * The Agreements tab on Sponsors and exhibitors: every agreement template for
 * the event. Rows open in place with the template (fields as green chips) and
 * its signing settings; Edit opens the editor with "Insert a field".
 */
import { useRef, useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { useAdminEvent } from "../../shells/AdminShell";
import { confirmAction, Empty, ErrorNote, ExpandRow, Field, Modal, PageLoading, RichTextEditor, THead, type RichTextApi } from "../../ui/components";
import { IconClose } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtWhen } from "@shared/format";
import { SpSection } from "../network/sponsor-ui";
import "./agreements.css";

type Data = RouterOutputs["agreements"]["templates"]["list"];
type Template = Data["templates"][number];
type Kind = Template["kind"];
type Reminders = "off" | "2x3" | "3x3" | "7x2";

const KIND_LABEL: Record<Kind, string> = { sponsor: "Sponsors", exhibitor: "Exhibitors", speaker: "Speakers" };
const REMINDER_LABEL: Record<Reminders, string> = { off: "Off", "2x3": "Every 2 days, up to 3", "3x3": "Every 3 days, up to 3", "7x2": "Every 7 days, up to 2" };
const TOKEN = /\{([^{}<>\n]{1,60})\}/g;

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Template body with each {Field} shown as a green chip. */
export function withChips(body: string, editable = false) {
  return body.replace(TOKEN, (_m, f: string) => `<span class="agr-chip"${editable ? ' contenteditable="false"' : ""}>${f}</span>`);
}

/** Editor HTML back to the stored form: each chip becomes {Field}. */
function fromEditor(html: string) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  doc.querySelectorAll("span.agr-chip").forEach((el) => el.replaceWith(doc.createTextNode(`{${el.textContent ?? ""}}`)));
  return doc.body.firstElementChild?.innerHTML ?? "";
}

const valueText = (k: string, v: string, dates: string[]) => (dates.includes(k) && /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : v);

type Draft = {
  name: string;
  kind: Kind;
  body: string;
  values: Record<string, string>;
  signWhen: "checkout" | "email";
  sendOnAccept: boolean;
  sendOnAdd: boolean;
  reminders: Reminders;
  askRecording: boolean;
  signerName: string;
  signerTitle: string;
  countersign: boolean;
};

const draftOf = (t: Template): Draft => ({
  name: t.name,
  kind: t.kind,
  body: withChips(t.body, true),
  values: { ...t.values },
  signWhen: t.signWhen,
  sendOnAccept: t.sendOnAccept,
  sendOnAdd: t.sendOnAdd,
  reminders: t.reminders as Reminders,
  askRecording: t.askRecording,
  signerName: t.signerName,
  signerTitle: t.signerTitle,
  countersign: t.countersign,
});

function PreviewModal({ html, onClose }: { html: string | null; onClose: () => void }) {
  return (
    <Modal open={html !== null} onClose={onClose} title="Preview with sample details">
      <div className="agr-paper">
        <div className="agr-doc" dangerouslySetInnerHTML={{ __html: html ?? "" }} />
      </div>
    </Modal>
  );
}

function SigningView({ t, data }: { t: Template; data: Data }) {
  const signer = t.signerName ? `${t.signerName}${t.signerTitle ? `, ${t.signerTitle}` : ""}` : "Not set";
  const notify = t.kind === "speaker" ? "" : data.notify[t.kind] ?? "";
  const rows: [string, string][] = [];
  if (t.kind === "speaker") {
    rows.push(["Send to sign", [t.sendOnAccept ? "When a proposal is accepted" : "", t.sendOnAdd ? "When a speaker is added by hand" : ""].filter(Boolean).join(", ") || "Sent by hand"]);
    rows.push(["Reminders", REMINDER_LABEL[t.reminders as Reminders]]);
    rows.push(["Recording", t.askRecording ? "Asks for permission (Yes or No)" : "Not asked"]);
  } else {
    rows.push(["When they sign", t.signWhen === "checkout" ? "On the checkout page, before paying" : "By email after paying"]);
    rows.push(["Reminders", REMINDER_LABEL[t.reminders as Reminders]]);
  }
  for (const k of data.orgValues[t.kind]) rows.push([k, valueText(k, t.values[k] ?? "", data.dateValues) || "Not set"]);
  rows.push(["Organization signer", signer]);
  rows.push(["Countersign", t.countersign ? "Added automatically" : "Off"]);
  rows.push(["Signed copy", notify ? `Emailed to the signer and to ${notify}` : "Emailed to the signer"]);
  return (
    <SpSection
      title="Signing"
      view={
        <div className="sp-kv" style={{ gridTemplateColumns: "150px minmax(0, 1fr)" }}>
          {rows.map(([k, v]) => (
            <span key={k} style={{ display: "contents" }}>
              <span className="k">{k}</span>
              <span>{v}</span>
            </span>
          ))}
        </div>
      }
    />
  );
}

function TemplateEditor({ t, data, onClose }: { t: Template; data: Data; onClose: () => void }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const save = trpc.agreements.templates.save.useMutation();
  const remove = trpc.agreements.templates.delete.useMutation();
  const preview = trpc.agreements.templates.preview.useMutation();
  const [d, setD] = useState<Draft>(() => draftOf(t));
  const [shown, setShown] = useState<string | null>(null);
  const api = useRef<RichTextApi | null>(null);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  const kinds = (["sponsor", "exhibitor", "speaker"] as Kind[]).filter((k) => data.editKinds.includes(k));
  const speaker = d.kind === "speaker";
  const val = (k: string) => d.values[k] ?? "";
  const setVal = (k: string, v: string) => set({ values: { ...d.values, [k]: v } });
  const valueField = (k: string) =>
    data.dateValues.includes(k) ? (
      <Field key={k} label={k}>
        <input className="input" type="date" value={val(k)} onChange={(e) => setVal(k, e.target.value)} />
      </Field>
    ) : k === "Speaker benefits" ? (
      <Field key={k} label={k} className="span-2">
        <textarea className="textarea" rows={3} maxLength={500} value={val(k)} onChange={(e) => setVal(k, e.target.value)} />
      </Field>
    ) : (
      <Field key={k} label={k}>
        <input className="input" value={val(k)} maxLength={500} placeholder={k === "Cancel fee" ? "$500.00" : k === "Setup time" ? "Apr 21, 2027 from 2:00 PM to 6:00 PM" : k === "Teardown time" ? "Apr 24, 2027 by 5:00 PM" : ""} onChange={(e) => setVal(k, e.target.value)} />
      </Field>
    );

  const doSave = async () => {
    try {
      await save.mutateAsync({ eventId: ev.id, templateId: t.id, ...d, name: d.name.trim(), body: fromEditor(d.body) });
      toast("Saved");
      await utils.agreements.templates.list.invalidate();
      onClose();
    } catch (err) {
      toast(errorText(err), true);
    }
  };

  return (
    <section className="sp-sec editing">
      <div className="sp-sh">
        <b>Edit agreement</b>
      </div>
      <div className="agr-edit">
        <div>
          <div className="grid-2">
            <Field label="Name">
              <input className="input" value={d.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Used for">
              <select className="select" value={d.kind} onChange={(e) => set({ kind: e.target.value as Kind })}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <RichTextEditor label="Agreement" value={d.body} onChange={(html) => set({ body: html })} minHeight={360} apiRef={api} />
        </div>
        <div>
          <span className="sp-caps">Insert a field</span>
          <div className="agr-fields">
            {data.fields[d.kind].map((f) => (
              <button key={f} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => api.current?.insertHtml(`${withChips(`{${escapeText(f)}}`, true)}&nbsp;`)}>
                {f}
              </button>
            ))}
          </div>
          <div className="grid-2">{data.orgValues[d.kind].map(valueField)}</div>
          {speaker ? (
            <>
              <span className="sp-caps">Send to sign</span>
              <label className="check">
                <input type="checkbox" checked={d.sendOnAccept} onChange={(e) => set({ sendOnAccept: e.target.checked })} />
                When a proposal is accepted
              </label>
              <label className="check">
                <input type="checkbox" checked={d.sendOnAdd} onChange={(e) => set({ sendOnAdd: e.target.checked })} />
                When a speaker is added by hand
              </label>
            </>
          ) : (
            <>
              <span className="sp-caps">When they sign</span>
              <label className={`pay-choice${d.signWhen === "checkout" ? " on" : ""}`}>
                <input type="radio" name={`sign-when-${t.id}`} checked={d.signWhen === "checkout"} onChange={() => set({ signWhen: "checkout" })} />
                <span>
                  <b>On the checkout page</b>
                  <span>Before paying. Recommended.</span>
                </span>
              </label>
              <label className={`pay-choice${d.signWhen === "email" ? " on" : ""}`}>
                <input type="radio" name={`sign-when-${t.id}`} checked={d.signWhen === "email"} onChange={() => set({ signWhen: "email" })} />
                <span>
                  <b>By email after paying</b>
                  <span>We email a link to sign.</span>
                </span>
              </label>
            </>
          )}
          {(() => {
            const reminders = (
              <Field label="Reminders">
                <select className="select" value={d.reminders} onChange={(e) => set({ reminders: e.target.value as Reminders })}>
                  {(Object.keys(REMINDER_LABEL) as Reminders[]).map((k) => (
                    <option key={k} value={k}>
                      {REMINDER_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>
            );
            const signer = (
              <Field label="Organization signer">
                <input className="input" value={d.signerName} maxLength={120} onChange={(e) => set({ signerName: e.target.value })} />
              </Field>
            );
            const title = (
              <Field label="Title">
                <input className="input" value={d.signerTitle} maxLength={120} onChange={(e) => set({ signerTitle: e.target.value })} />
              </Field>
            );
            // Speakers: Reminders beside the signer (as on the board). Sponsors and exhibitors: signer beside the title.
            return speaker ? (
              <div className="grid-2">
                {reminders}
                {signer}
                {title}
              </div>
            ) : (
              <>
                <div className="grid-2">{reminders}</div>
                <div className="grid-2">
                  {signer}
                  {title}
                </div>
              </>
            );
          })()}
          {speaker ? (
            <label className="check">
              <input type="checkbox" checked={d.askRecording} onChange={(e) => set({ askRecording: e.target.checked })} />
              Ask for recording permission (Yes or No)
            </label>
          ) : null}
          <label className="check">
            <input type="checkbox" checked={d.countersign} onChange={(e) => set({ countersign: e.target.checked })} />
            Countersign automatically
          </label>
        </div>
      </div>
      <div className="agr-save">
        <button type="button" className="btn btn-sm btn-solid btn-w" disabled={save.isPending} onClick={doSave}>
          Save
        </button>
        <button type="button" className="btn btn-sm btn-w" onClick={onClose}>
          Cancel
        </button>
        <div className="right">
          <button
            type="button"
            className="btn btn-sm btn-danger btn-w"
            disabled={remove.isPending}
            onClick={async () => {
              if (!confirmAction(`Delete ${t.name}? Agreements already sent or signed keep their text.`)) return;
              try {
                await remove.mutateAsync({ eventId: ev.id, templateId: t.id });
                await utils.agreements.templates.list.invalidate();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className="btn btn-sm btn-w"
            disabled={preview.isPending}
            onClick={async () => {
              try {
                const r = await preview.mutateAsync({ eventId: ev.id, kind: d.kind, body: fromEditor(d.body), values: d.values });
                setShown(r.html);
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Preview
          </button>
        </div>
      </div>
      <PreviewModal html={shown} onClose={() => setShown(null)} />
    </section>
  );
}

function TemplateDetail({ t, data, startEditing }: { t: Template; data: Data; startEditing: boolean }) {
  const [editing, setEditing] = useState(startEditing);
  const canEdit = data.editKinds.includes(t.kind);
  if (editing && canEdit) {
    return (
      <div className="sp-expand one">
        <TemplateEditor t={t} data={data} onClose={() => setEditing(false)} />
      </div>
    );
  }
  return (
    <div className="sp-expand one">
      <div className="agr-exp">
        <SpSection
          title="Agreement"
          actions={
            canEdit ? (
              <button type="button" className="btn btn-sm btn-w" onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : null
          }
          view={<div className="agr-read agr-doc">{t.body ? <div dangerouslySetInnerHTML={{ __html: withChips(t.body) }} /> : <span className="muted">No text yet. Edit to write it.</span>}</div>}
        />
        <SigningView t={t} data={data} />
      </div>
    </div>
  );
}

function StartSheet({ open, data, onClose, onCreated }: { open: boolean; data: Data | undefined; onClose: () => void; onCreated: (id: number) => void }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const create = trpc.agreements.templates.create.useMutation();
  if (!open || !data) return null;
  return (
    <div className="side-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Start from a template" className="side-sheet">
        <div className="side-sheet-head">
          <span className="h3">Start from a template</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose} style={{ width: 36, height: 36 }}>
            <IconClose />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {data.starters.map((s) => (
            <div key={s.key} className="agr-starter">
              <b>{s.name}</b>
              <span>{s.summary}</span>
              <button
                type="button"
                className="btn btn-sm btn-w"
                disabled={create.isPending}
                onClick={async () => {
                  try {
                    const row = await create.mutateAsync({ eventId: ev.id, starter: s.key });
                    await utils.agreements.templates.list.invalidate();
                    onCreated(row.id);
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Use
              </button>
            </div>
          ))}
          <div className="small muted" style={{ padding: "14px 18px", fontSize: 13 }}>
            Templates are a starting point. Have your attorney review your agreement before you use it.
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgreementsTab({ adding = false, onAdded }: { adding?: boolean; onAdded?: () => void }) {
  const ev = useAdminEvent();
  const list = trpc.agreements.templates.list.useQuery({ eventId: ev.id });
  const [open, setOpen] = useState<number | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const cols = "1.5fr 1.3fr 1fr 1fr 96px";
  if (list.isLoading) return <PageLoading />;
  if (list.error) return <ErrorNote error={list.error} />;
  const data = list.data!;
  return (
    <div className="table-inner">
      <THead cols={cols} labels={["Agreement", "Used on", "Signed", "Last edited", ""]} />
      {!data.templates.length ? <Empty>No agreements yet. Use New agreement to start from a template.</Empty> : null}
      {data.templates.map((t) => (
        <ExpandRow
          key={t.id}
          cols={cols}
          open={open === t.id}
          onToggle={() => {
            setOpen(open === t.id ? null : t.id);
            setFresh(null);
          }}
          closedLabel="Open"
          cells={[
            <span key="n" className="strong">{t.name}</span>,
            <span key="u">{t.usedOn}</span>,
            <span key="s">{t.total ? `${t.signed} of ${t.total} signed` : "None sent yet"}</span>,
            <span key="e">{fmtWhen(t.lastEdited)}</span>,
          ]}
        >
          <TemplateDetail key={t.id} t={t} data={data} startEditing={fresh === t.id} />
        </ExpandRow>
      ))}
      <StartSheet
        open={adding}
        data={data}
        onClose={() => onAdded?.()}
        onCreated={(newId) => {
          setOpen(newId);
          setFresh(newId);
          onAdded?.();
        }}
      />
    </div>
  );
}
