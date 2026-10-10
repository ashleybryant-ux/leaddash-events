/** /admin/e/:eventId/vendors and /vendors/:vendorId: exhibitors and sponsors, plus the venue map. */
import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { confirmAction, EditSection, Empty, ErrorNote, ExpandRow, Field, FolderTabs, KV, Kpi, Modal, PageLoading, Pill, THead, UploadButton } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtMoney, fmtWhen } from "@shared/format";
import { toCents, toDollars } from "./shared";

type ListData = RouterOutputs["network"]["vendors"]["list"];
type Vendor = ListData["vendors"][number];
type BenefitStatus = "done" | "not_started" | "waiting";
type MapRow = RouterOutputs["network"]["maps"]["adminList"][number];
type Pin = MapRow["pins"][number];
type PinKind = "room" | "booth" | "service" | "meet";
const pinKind = (k: string): PinKind => (k === "booth" || k === "service" || k === "meet" ? k : "room");

const STATUS_LABEL: Record<Vendor["status"], string> = { lead: "Lead", invited: "Invited", contract_sent: "Contract sent", confirmed: "Confirmed", paid: "Paid", cancelled: "Cancelled" };
const STATUS_TONE: Record<Vendor["status"], "green" | "orange" | "gray" | "red" | "solid"> = { lead: "gray", invited: "gray", contract_sent: "orange", confirmed: "green", paid: "green", cancelled: "red" };
const KIND_LABEL: Record<Vendor["kind"], string> = { exhibitor: "Exhibitor", sponsor: "Sponsor", both: "Sponsor and exhibitor" };
const BENEFIT_LABEL: Record<BenefitStatus, string> = { done: "Done", not_started: "Not started", waiting: "Waiting on vendor" };

const payment = (v: Vendor) => (v.amountCents === 0 ? <span className="muted">No charge</span> : v.paidCents >= v.amountCents ? <Pill>Paid</Pill> : <Pill tone="orange">Balance due</Pill>);

function draftOf(v: Vendor) {
  return {
    company: v.company,
    kind: v.kind,
    level: v.level,
    category: v.category,
    contactName: v.contactName,
    email: v.email,
    phone: v.phone,
    booth: v.booth,
    status: v.status,
    amount: toDollars(v.amountCents),
    paid: toDollars(v.paidCents),
    description: v.description,
    website: v.website,
    offer: v.offer,
    notes: v.notes,
    logoFileId: v.logoFileId,
    logoUrl: v.logoUrl,
    contractFileId: v.contractFileId,
    contractName: v.contractName,
    benefits: v.benefits.map((b) => ({ label: b.label, status: b.status as BenefitStatus })),
    boothStaff: v.boothStaff.join(", "),
    visible: v.visible,
    leadScanning: v.leadScanning,
  };
}

function VendorEditor({ v, data, startOpen }: { v: Vendor; data: ListData; startOpen: boolean }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const update = trpc.network.vendors.update.useMutation();
  const remove = trpc.network.vendors.remove.useMutation();
  const invoice = trpc.network.vendors.sendInvoice.useMutation();
  const [d, setD] = useState(() => draftOf(v));
  const levels = Array.from(new Set(["Exhibitor booth", "Presenting sponsor", "Session sponsor", ...data.vendors.map((x) => x.level).filter(Boolean)]));
  const booths = Array.from(new Set([v.booth, ...data.openBooths].filter(Boolean)));
  const canEdit = can("vendors", "edit");
  const due = v.amountCents - v.paidCents;

  const view = (
    <div className="col gap-16">
      <div>
        <KV label="Type">{KIND_LABEL[v.kind]}</KV>
        <KV label="Package">{v.level}</KV>
        <KV label="Status">{STATUS_LABEL[v.status]}</KV>
        <KV label="Package price">{v.amountCents ? fmtMoney(v.amountCents) : ""}</KV>
        <KV label="Paid so far">{v.paidCents ? fmtMoney(v.paidCents) : ""}</KV>
        <KV label="Contract">
          {v.contractUrl ? (
            <a href={v.contractUrl} target="_blank" rel="noopener noreferrer">
              {v.contractName || "Contract"}
              {v.contractAt ? ` (added ${fmtWhen(v.contractAt)})` : ""}
            </a>
          ) : (
            ""
          )}
        </KV>
        <KV label="Leads scanned">{String(v.leads)}</KV>
        <KV label="Contact">{v.contactName}</KV>
        <KV label="Email">{v.email}</KV>
        <KV label="Phone">{v.phone}</KV>
        <KV label="Booth staff badges">{v.staffNames.join(", ")}</KV>
        <KV label="Category in app">{v.category}</KV>
        <KV label="Listed in the app">{v.visible ? (v.status === "confirmed" || v.status === "paid" ? "Yes" : "Once confirmed") : "No"}</KV>
        <KV label="Lead scanning">{v.leadScanning ? "On" : "Off"}</KV>
        <KV label="Offer">{v.offer}</KV>
        <KV label="Website">{v.website}</KV>
        <KV label="Description">{v.description}</KV>
        <KV label="Notes">{v.notes}</KV>
      </div>
      {v.benefits.length ? (
        <div className="col gap-6">
          <span className="editor-title">Package benefits</span>
          {v.benefits.map((b, i) => (
            <div key={i} className="row-between" style={{ padding: "6px 0", borderBottom: "1px solid var(--line-2)" }}>
              <span className="strong">{b.label}</span>
              <Pill tone={b.status === "done" ? "green" : b.status === "waiting" ? "orange" : "gray"}>{BENEFIT_LABEL[b.status as BenefitStatus]}</Pill>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );

  const edit = (
    <div className="col gap-12">
      <div className="grid-4">
        <Field label="Company" className="span-2">
          <input className="input" value={d.company} maxLength={160} onChange={(e) => setD({ ...d, company: e.target.value })} />
        </Field>
        <Field label="Type">
          <select className="select" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as Vendor["kind"] })}>
            <option value="exhibitor">Exhibitor</option>
            <option value="sponsor">Sponsor</option>
            <option value="both">Sponsor and exhibitor</option>
          </select>
        </Field>
        <Field label="Status">
          <select className="select" value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as Vendor["status"] })}>
            {(Object.keys(STATUS_LABEL) as Vendor["status"][]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Package">
          <input className="input" list={`levels-${v.id}`} value={d.level} maxLength={80} onChange={(e) => setD({ ...d, level: e.target.value })} />
          <datalist id={`levels-${v.id}`}>
            {levels.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </Field>
        <Field label="Booth">
          <input className="input" list={`booths-${v.id}`} value={d.booth} maxLength={20} onChange={(e) => setD({ ...d, booth: e.target.value })} />
          <datalist id={`booths-${v.id}`}>
            {booths.map((b) => (
              <option key={b} value={b}>
                {b === v.booth ? b : `${b} (open)`}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Package price">
          <input className="input" inputMode="decimal" value={d.amount} placeholder="0" onChange={(e) => setD({ ...d, amount: e.target.value })} />
        </Field>
        <Field label="Paid so far">
          <input className="input" inputMode="decimal" value={d.paid} placeholder="0" onChange={(e) => setD({ ...d, paid: e.target.value })} />
        </Field>
        <Field label="Contact">
          <input className="input" value={d.contactName} maxLength={120} onChange={(e) => setD({ ...d, contactName: e.target.value })} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={d.email} maxLength={200} onChange={(e) => setD({ ...d, email: e.target.value })} />
        </Field>
        <Field label="Phone">
          <input className="input" value={d.phone} maxLength={40} onChange={(e) => setD({ ...d, phone: e.target.value })} />
        </Field>
        <Field label="Category in app">
          <input className="input" value={d.category} maxLength={80} placeholder="Practice software" onChange={(e) => setD({ ...d, category: e.target.value })} />
        </Field>
        <Field label="Booth staff emails" className="span-2" hint="Separate with commas. They can scan badges for leads.">
          <input className="input" value={d.boothStaff} onChange={(e) => setD({ ...d, boothStaff: e.target.value })} />
        </Field>
        <Field label="Website">
          <input className="input" value={d.website} maxLength={300} onChange={(e) => setD({ ...d, website: e.target.value })} />
        </Field>
        <Field label="Offer for attendees">
          <input className="input" value={d.offer} maxLength={300} placeholder="20% off for attendees" onChange={(e) => setD({ ...d, offer: e.target.value })} />
        </Field>
        <Field label="Description in app" className="span-2">
          <textarea className="textarea" rows={3} maxLength={2000} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </Field>
        <Field label="Notes (team only)" className="span-2">
          <textarea className="textarea" rows={3} maxLength={4000} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} />
        </Field>
      </div>
      <div className="grid-2">
        <div className="col gap-6">
          <span className="field">Logo</span>
          <div className="row gap-8">
            {d.logoUrl ? <img src={d.logoUrl} alt="Logo" style={{ width: 64, height: 40, objectFit: "contain", border: "1px solid var(--line)", borderRadius: 6 }} /> : <span className="small muted">None</span>}
            <UploadButton eventId={ev.id} label={d.logoUrl ? "Replace" : "Upload"} onUploaded={(f) => setD({ ...d, logoFileId: f.id, logoUrl: f.url })} />
            {d.logoUrl ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setD({ ...d, logoFileId: null, logoUrl: null })}>
                Remove
              </button>
            ) : null}
          </div>
        </div>
        <div className="col gap-6">
          <span className="field">Contract</span>
          <div className="row gap-8">
            <span className="small clip" style={{ maxWidth: 180 }}>{d.contractFileId ? d.contractName || "Contract" : <span className="muted">None</span>}</span>
            <UploadButton eventId={ev.id} isPublic={false} accept=".pdf,.doc,.docx,application/pdf" label={d.contractFileId ? "Replace" : "Upload"} onUploaded={(f) => setD({ ...d, contractFileId: f.id, contractName: f.name })} />
            {d.contractFileId ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setD({ ...d, contractFileId: null, contractName: "" })}>
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="col gap-6">
        <span className="field">Package benefits</span>
        {d.benefits.map((b, i) => (
          <div key={i} className="row gap-8">
            <input className="input grow" aria-label={`Benefit ${i + 1}`} value={b.label} maxLength={160} onChange={(e) => setD({ ...d, benefits: d.benefits.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <select className="select" style={{ width: 170 }} aria-label={`Status for ${b.label || `benefit ${i + 1}`}`} value={b.status} onChange={(e) => setD({ ...d, benefits: d.benefits.map((x, j) => (j === i ? { ...x, status: e.target.value as BenefitStatus } : x)) })}>
              <option value="done">Done</option>
              <option value="not_started">Not started</option>
              <option value="waiting">Waiting on vendor</option>
            </select>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setD({ ...d, benefits: d.benefits.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setD({ ...d, benefits: [...d.benefits, { label: "", status: "not_started" }] })}>
          Add benefit
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={d.leadScanning} onChange={(e) => setD({ ...d, leadScanning: e.target.checked })} />
        Booth staff can scan attendee badges for leads
      </label>
      <label className="check">
        <input type="checkbox" checked={d.visible} onChange={(e) => setD({ ...d, visible: e.target.checked })} />
        List in the attendee app once confirmed
      </label>
    </div>
  );

  return (
    <div className="col gap-14">
      {canEdit ? (
        <EditSection
          title="Vendor details"
          startOpen={startOpen}
          saving={update.isPending}
          onCancel={() => setD(draftOf(v))}
          actions={
            due > 0 && v.email ? (
              <button
                type="button"
                className="btn btn-sm btn-w-lg"
                disabled={invoice.isPending}
                onClick={async () => {
                  try {
                    await invoice.mutateAsync({ eventId: ev.id, vendorId: v.id });
                    toast(`Invoice sent to ${v.email}`);
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Send invoice
              </button>
            ) : null
          }
          onSave={async () => {
            const staff = d.boothStaff.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
            await update.mutateAsync({
              eventId: ev.id,
              vendorId: v.id,
              company: d.company,
              kind: d.kind,
              level: d.level,
              category: d.category,
              contactName: d.contactName,
              email: d.email,
              phone: d.phone,
              booth: d.booth,
              status: d.status,
              amountCents: toCents(d.amount),
              paidCents: toCents(d.paid),
              description: d.description,
              website: d.website,
              offer: d.offer,
              notes: d.notes,
              logoFileId: d.logoFileId,
              contractFileId: d.contractFileId,
              benefits: d.benefits.filter((b) => b.label.trim()),
              boothStaff: staff,
              visible: d.visible,
              leadScanning: d.leadScanning,
            });
            await utils.network.vendors.list.invalidate();
            await utils.network.maps.invalidate();
            toast("Saved");
          }}
          view={view}
          edit={edit}
        />
      ) : (
        <section className="col gap-12">
          <span className="h3" style={{ fontSize: 14 }}>Vendor details</span>
          {view}
        </section>
      )}
      {canEdit ? (
        <div>
          <button
            className="btn btn-sm btn-danger btn-w-lg"
            disabled={remove.isPending}
            onClick={async () => {
              if (!confirmAction(`Delete ${v.company}? Their leads go with them.`)) return;
              try {
                await remove.mutateAsync({ eventId: ev.id, vendorId: v.id });
                await utils.network.vendors.list.invalidate();
                navigate(`/admin/e/${ev.id}/vendors`);
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Delete vendor
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AddVendor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ev = useAdminEvent();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const create = trpc.network.vendors.create.useMutation();
  const [d, setD] = useState({ company: "", kind: "exhibitor" as Vendor["kind"], contactName: "", email: "" });
  return (
    <Modal open={open} onClose={onClose} title="Add vendor">
      <div className="grid-2">
        <Field label="Company" className="span-all">
          <input className="input" value={d.company} maxLength={160} autoFocus onChange={(e) => setD({ ...d, company: e.target.value })} />
        </Field>
        <Field label="Type">
          <select className="select" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as Vendor["kind"] })}>
            <option value="exhibitor">Exhibitor</option>
            <option value="sponsor">Sponsor</option>
            <option value="both">Sponsor and exhibitor</option>
          </select>
        </Field>
        <Field label="Contact">
          <input className="input" value={d.contactName} maxLength={120} onChange={(e) => setD({ ...d, contactName: e.target.value })} />
        </Field>
        <Field label="Email" className="span-all">
          <input className="input" type="email" value={d.email} maxLength={200} onChange={(e) => setD({ ...d, email: e.target.value })} />
        </Field>
      </div>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={!d.company.trim() || create.isPending}
          onClick={async () => {
            try {
              const v = await create.mutateAsync({ eventId: ev.id, company: d.company.trim(), kind: d.kind, contactName: d.contactName.trim(), email: d.email.trim().toLowerCase() });
              await utils.network.vendors.list.invalidate();
              setD({ company: "", kind: "exhibitor", contactName: "", email: "" });
              onClose();
              navigate(`/admin/e/${ev.id}/vendors/${v.id}`);
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Add
        </button>
        <button className="btn btn-sm btn-w" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function VendorsTab({ data, vendorId }: { data: ListData; vendorId?: number }) {
  const ev = useAdminEvent();
  const [, navigate] = useLocation();
  const cols = "2.2fr 0.6fr 1.4fr 1.1fr 1fr 96px";
  const rows = [...data.vendors].sort((a, b) => Number(a.status === "cancelled") - Number(b.status === "cancelled"));
  return (
    <div className="col gap-10">
      <div className="table" style={{ borderRadius: 10 }}>
        <div className="table-inner">
          <THead cols={cols} labels={["Vendor", "Booth", "Contact", "Status", "Payment", ""]} />
          {!rows.length ? (
            <Empty>No vendors yet. Add your first exhibitor or sponsor.</Empty>
          ) : (
            rows.map((v) => (
              <ExpandRow
                key={v.id}
                cols={cols}
                open={vendorId === v.id}
                onToggle={() => navigate(vendorId === v.id ? `/admin/e/${ev.id}/vendors` : `/admin/e/${ev.id}/vendors/${v.id}`)}
                cells={[
                  <span key="c" className="col" style={{ gap: 0 }}>
                    <span className="strong">{v.company}</span>
                    <span className="small muted">{v.level || KIND_LABEL[v.kind]}</span>
                  </span>,
                  <span key="b">{v.booth}</span>,
                  <span key="p" className="clip">{v.contactName || v.email}</span>,
                  <Pill key="s" tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Pill>,
                  <span key="m">{payment(v)}</span>,
                ]}
              >
                <VendorEditor key={v.id} v={v} data={data} startOpen={!v.email && !v.level && !v.booth} />
              </ExpandRow>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const PIN_KINDS: { key: PinKind; label: string }[] = [
  { key: "room", label: "Room" },
  { key: "booth", label: "Booth" },
  { key: "service", label: "Service" },
  { key: "meet", label: "Meeting spot" },
];
const PIN_COLORS: Record<string, string> = { room: "#1F5F4A", booth: "#3B5B8C", service: "#8A5A00", meet: "#6B4A9C" };

function MapPicture({ url, pins, onPlace, highlight }: { url: string | null; pins: Pin[]; onPlace?: (x: number, y: number) => void; highlight?: number }) {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={box}
      onClick={(e) => {
        if (!onPlace || !box.current) return;
        const r = box.current.getBoundingClientRect();
        const x = Math.round(((e.clientX - r.left) / r.width) * 1000) / 10;
        const y = Math.round(((e.clientY - r.top) / r.height) * 1000) / 10;
        onPlace(Math.min(100, Math.max(0, x)), Math.min(100, Math.max(0, y)));
      }}
      style={{ position: "relative", maxWidth: 720, border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", background: "#FFFFFF", cursor: onPlace ? "crosshair" : "default" }}
    >
      {url ? <img src={url} alt="Floor plan" style={{ display: "block", width: "100%", height: "auto" }} /> : <div style={{ height: 240 }} />}
      {pins.map((p, i) => (
        <span
          key={i}
          style={{ position: "absolute", left: `${p.x}%`, top: `${p.y}%`, transform: "translate(-50%, -50%)", padding: "2px 6px", borderRadius: 6, background: i === highlight ? "#e88a3a" : PIN_COLORS[p.kind] ?? "#1F5F4A", color: i === highlight ? "#1A1206" : "#FFFFFF", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap", pointerEvents: "none" }}
        >
          {p.label || "New pin"}
        </span>
      ))}
    </div>
  );
}

function MapEditor({ m }: { m: MapRow }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const update = trpc.network.maps.update.useMutation();
  const remove = trpc.network.maps.remove.useMutation();
  const blank = () => ({ name: m.name, sort: m.sort, fileId: m.fileId, imageUrl: m.imageUrl, pins: m.pins.map((p) => ({ ...p })) });
  const [d, setD] = useState(blank);
  const [kind, setKind] = useState<PinKind>("booth");
  const [last, setLast] = useState<number | undefined>(undefined);
  const setPin = (i: number, patch: Partial<Pin>) => setD({ ...d, pins: d.pins.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const view = (
    <div className="col gap-10">
      <MapPicture url={m.imageUrl} pins={m.pins} />
      <span className="small muted">
        {m.pins.length} pin{m.pins.length === 1 ? "" : "s"}
        {m.pins.length ? `: ${m.pins.map((p) => p.label).join(", ")}` : ""}
      </span>
    </div>
  );
  if (!can("vendors", "edit")) {
    return (
      <div className="card card-pad col gap-12">
        <span className="h3" style={{ fontSize: 14 }}>{m.name}</span>
        {view}
      </div>
    );
  }
  return (
    <div className="card card-pad col gap-12">
      <EditSection
        title={m.name}
        saving={update.isPending}
        onCancel={() => setD(blank())}
        onSave={async () => {
          await update.mutateAsync({ eventId: ev.id, mapId: m.id, name: d.name.trim() || m.name, fileId: d.fileId, sort: d.sort, pins: d.pins.filter((p) => p.label.trim()).map((p) => ({ label: p.label.trim(), x: p.x, y: p.y, kind: pinKind(p.kind) })) });
          await utils.network.maps.invalidate();
          await utils.network.vendors.list.invalidate();
          toast("Saved");
        }}
        view={view}
        edit={
          <div className="col gap-12">
            <div className="grid-4">
              <Field label="Name" className="span-2">
                <input className="input" value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} />
              </Field>
              <Field label="Order">
                <input className="input" inputMode="numeric" value={d.sort} onChange={(e) => setD({ ...d, sort: Math.min(100, Number(e.target.value.replace(/\D/g, "")) || 0) })} />
              </Field>
              <div className="col gap-4">
                <span className="field">Image</span>
                <UploadButton eventId={ev.id} label="Replace" onUploaded={(f) => setD({ ...d, fileId: f.id, imageUrl: f.url })} />
              </div>
            </div>
            <div className="row gap-8">
              <span className="small strong">Click the map to add a</span>
              <select className="select" style={{ width: 150 }} aria-label="Kind of pin to add" value={kind} onChange={(e) => setKind(pinKind(e.target.value))}>
                {PIN_KINDS.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label.toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <MapPicture
              url={d.imageUrl}
              pins={d.pins}
              highlight={last}
              onPlace={(x, y) => {
                if (d.pins.length >= 300) return;
                setD({ ...d, pins: [...d.pins, { label: kind === "booth" ? "Booth " : "", x, y, kind }] });
                setLast(d.pins.length);
              }}
            />
            {d.pins.length ? (
              <div className="col gap-6">
                <div className="row gap-8 small muted strong">
                  <span className="grow">Label</span>
                  <span style={{ width: 130 }}>Kind</span>
                  <span style={{ width: 64 }}>Across %</span>
                  <span style={{ width: 64 }}>Down %</span>
                  <span style={{ width: 80 }} />
                </div>
                {d.pins.map((p, i) => (
                  <div key={i} className="row gap-8">
                    <input className="input grow" aria-label={`Pin ${i + 1} label`} value={p.label} maxLength={80} autoFocus={i === last} onFocus={() => setLast(i)} onChange={(e) => setPin(i, { label: e.target.value })} />
                    <select className="select" style={{ width: 130 }} aria-label={`Pin ${i + 1} kind`} value={p.kind} onChange={(e) => setPin(i, { kind: pinKind(e.target.value) })}>
                      {PIN_KINDS.map((k) => (
                        <option key={k.key} value={k.key}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                    <input className="input" style={{ width: 64 }} aria-label={`Pin ${i + 1} across`} inputMode="decimal" value={p.x} onChange={(e) => setPin(i, { x: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
                    <input className="input" style={{ width: 64 }} aria-label={`Pin ${i + 1} down`} inputMode="decimal" value={p.y} onChange={(e) => setPin(i, { y: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
                    <button type="button" className="btn btn-sm btn-ghost" style={{ width: 80, padding: 0 }} onClick={() => setD({ ...d, pins: d.pins.filter((_, j) => j !== i) })}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <span className="small muted">Booth pins named like "Booth 14" link to the exhibitor at booth 14.</span>
          </div>
        }
      />
      <div>
        <button
          className="btn btn-sm btn-danger btn-w-lg"
          disabled={remove.isPending}
          onClick={async () => {
            if (!confirmAction(`Delete the ${m.name} map?`)) return;
            try {
              await remove.mutateAsync({ eventId: ev.id, mapId: m.id });
              await utils.network.maps.invalidate();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Delete map
        </button>
      </div>
    </div>
  );
}

function VenueMapTab() {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const maps = trpc.network.maps.adminList.useQuery({ eventId: ev.id });
  const create = trpc.network.maps.create.useMutation();
  const [name, setName] = useState("");
  if (maps.isLoading) return <PageLoading />;
  if (maps.error) return <ErrorNote error={maps.error} />;
  return (
    <div className="col gap-14">
      {can("vendors", "edit") ? (
        <div className="card card-pad col gap-10">
          <span className="h3" style={{ fontSize: 14 }}>Add a floor</span>
          <div className="row gap-10 wrap">
            <input className="input" style={{ width: 240 }} aria-label="Floor name" placeholder={maps.data?.length ? `Level ${maps.data.length + 1}` : "Level 1"} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            <UploadButton
              eventId={ev.id}
              label="Upload map"
              className="btn btn-sm btn-solid btn-w-lg"
              onUploaded={async (f) => {
                try {
                  await create.mutateAsync({ eventId: ev.id, name: name.trim() || `Level ${(maps.data?.length ?? 0) + 1}`, fileId: f.id });
                  setName("");
                  await utils.network.maps.invalidate();
                  await utils.network.vendors.list.invalidate();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            />
          </div>
          <span className="small muted">Upload an image of each floor plan, then add pins for rooms, booths and meeting spots.</span>
        </div>
      ) : null}
      {!maps.data?.length ? <Empty>No venue maps yet.</Empty> : maps.data.map((m) => <MapEditor key={`${m.id}-${m.fileId}-${m.pins.length}`} m={m} />)}
    </div>
  );
}

/** /admin/e/:eventId/vendors and /admin/e/:eventId/vendors/:vendorId */
export function AdminVendorsScreen({ vendorId }: { vendorId?: number }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const list = trpc.network.vendors.list.useQuery({ eventId: ev.id });
  const [tab, setTab] = useState<"vendors" | "map">(() => (new URLSearchParams(window.location.search).get("tab") === "map" ? "map" : "vendors"));
  const [adding, setAdding] = useState(false);
  const data = list.data;
  return (
    <AdminPage
      title="Vendors"
      actions={
        can("vendors", "edit") && tab === "vendors" ? (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            Add vendor
          </button>
        ) : null
      }
    >
      {list.isLoading ? (
        <PageLoading />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : data ? (
        <>
          <div className="grid-4">
            <Kpi label="Vendors" value={data.stats.vendors} />
            <Kpi label="Booths open" value={data.stats.boothsOpen} />
            <Kpi label="Balance due" value={data.stats.balanceDue} />
            <Kpi label="Leads scanned" value={data.stats.leads} />
          </div>
          <div>
            <FolderTabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: "vendors", label: "Vendors" },
                { key: "map", label: "Venue map" },
              ]}
            />
            <div className="folder-body">{tab === "vendors" ? <VendorsTab data={data} vendorId={vendorId} /> : <VenueMapTab />}</div>
          </div>
        </>
      ) : null}
      <AddVendor open={adding} onClose={() => setAdding(false)} />
    </AdminPage>
  );
}
