/**
 * /admin/e/:eventId/vendors and /vendors/:vendorId: Sponsors and exhibitors.
 * Folder tabs for sponsors, exhibitors, packages, add-ons and agreements, plus
 * the venue map. Rows open in place with details, payments, passes and benefits.
 */
import { useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { confirmAction, EditSection, Empty, ErrorNote, ExpandRow, Field, FolderTabs, Modal, PageLoading, Pill, THead, UploadButton } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtMoney, fmtWhen } from "@shared/format";
import { toCents } from "./shared";
import { downloadCsv } from "../ce/util";
import { AgreementsTab } from "../agreements/AgreementsTab";
import { AddAttendeeSheet, type AddPreset } from "./AddAttendeeSheet";
import { AddonsTab, PackagesTab, includesSentence } from "./admin-packages";
import { PaymentsSection, type VendorRow } from "./vendor-payments";
import { NumStrip, SpSection, companyInitials, plural } from "./sponsor-ui";

type ListData = RouterOutputs["network"]["vendors"]["list"];
type PackageRow = ListData["packages"][number];
type MapRow = RouterOutputs["network"]["maps"]["adminList"][number];
type Pin = MapRow["pins"][number];
type PinKind = "room" | "booth" | "service" | "meet";
const pinKind = (k: string): PinKind => (k === "booth" || k === "service" || k === "meet" ? k : "room");

type Tab = "sponsors" | "exhibitors" | "packages" | "addons" | "agreements" | "map";
const TABS: Tab[] = ["sponsors", "exhibitors", "packages", "addons", "agreements", "map"];
type Side = "sponsors" | "exhibitors";

const isSponsor = (v: { kind: VendorRow["kind"] }) => v.kind !== "exhibitor";
const isExhibitor = (v: { kind: VendorRow["kind"] }) => v.kind !== "sponsor";

/* ---------- Sponsor details ---------- */

function detailsDraft(v: VendorRow) {
  return {
    company: v.company,
    kind: v.kind,
    packageId: v.packageId,
    amount: fmtMoney(v.amountCents, ""),
    booth: v.booth,
    contactName: v.contactName,
    email: v.email,
    phone: v.phone,
    active: v.status !== "cancelled",
    logoFileId: v.logoFileId,
    logoUrl: v.logoUrl,
    description: v.description,
    website: v.website,
    category: v.category,
    offer: v.offer,
    notes: v.notes,
    boothStaff: v.boothStaff.join(", "),
    visible: v.visible,
    leadScanning: v.leadScanning,
  };
}

function agreementText(v: VendorRow) {
  const a = v.agreement;
  if (!a) return "No agreement";
  if (a.status === "signed") return `Signed by ${a.signerName || v.contactName || "the sponsor"}${a.signedAt ? `, ${fmtWhen(a.signedAt)}` : ""}`;
  return "Not signed";
}

function DetailsSection({ v, side, packages }: { v: VendorRow; side: Side; packages: PackageRow[] }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const save = trpc.network.vendors.saveDetails.useMutation();
  const remove = trpc.network.vendors.remove.useMutation();
  const [d, setD] = useState(() => detailsDraft(v));
  const pkg = packages.find((p) => p.id === d.packageId);
  const word = side === "sponsors" ? "sponsor" : "exhibitor";
  const sponsorPkgs = packages.filter((p) => p.kind === "sponsor");
  const boothPkgs = packages.filter((p) => p.kind === "exhibitor");
  const also = side === "sponsors" ? d.kind === "both" : d.kind === "both";

  const pickPackage = (id: number | null) => {
    const p = packages.find((x) => x.id === id);
    setD({ ...d, packageId: id, ...(p ? { amount: fmtMoney(p.priceCents, "") } : {}) });
  };

  const view = (
    <>
      <div className="sp-kv">
        <span className="k">Package</span>
        <span>{v.packageName || v.level ? <Pill>{v.packageName || v.level}</Pill> : <span className="muted">Not set</span>}</span>
        <span className="k">Price</span>
        <span>{fmtMoney(v.amountCents, "$0.00")}</span>
        {side === "sponsors" ? (
          <>
            <span className="k">Also an exhibitor</span>
            <span>{v.kind === "both" ? (v.booth ? `Yes, booth ${v.booth}` : "Yes") : "No"}</span>
          </>
        ) : (
          <>
            <span className="k">Booth</span>
            <span>{v.booth || <span className="muted">Not assigned</span>}</span>
            <span className="k">Also a sponsor</span>
            <span>{v.kind === "both" ? "Yes" : "No"}</span>
          </>
        )}
        <span className="k">Contact</span>
        <span>{v.contactName || <span className="muted">Not set</span>}</span>
        <span className="k">Email and phone</span>
        <span>{[v.email, v.phone].filter(Boolean).join(" · ") || <span className="muted">Not set</span>}</span>
        <span className="k">Status</span>
        <span>
          {v.statusLabel}
          {v.statusNote ? ` (${v.statusNote})` : ""}
        </span>
        <span className="k">Agreement</span>
        <span>{agreementText(v)}</span>
        <span className="k">In the app</span>
        <span>{v.appSummary}</span>
      </div>
      {v.agreement ? (
        <div className="sp-li">
          <span className="s2 grow">{v.agreement.templateName}</span>
          <span className="r">
            <a className="btn btn-sm btn-w" href={`/agreement/${encodeURIComponent(v.agreement.code)}`} target="_blank" rel="noopener noreferrer">
              View PDF
            </a>
          </span>
        </div>
      ) : null}
    </>
  );

  const edit = (
    <>
      <Field label="Package">
        <select className="select" value={d.packageId ?? ""} onChange={(e) => pickPackage(e.target.value ? Number(e.target.value) : null)}>
          <option value="">No package</option>
          {sponsorPkgs.length ? (
            <optgroup label="Sponsor packages">
              {sponsorPkgs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}, {fmtMoney(p.priceCents, "$0.00")}
                </option>
              ))}
            </optgroup>
          ) : null}
          {boothPkgs.length ? (
            <optgroup label="Exhibitor booths">
              {boothPkgs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}, {fmtMoney(p.priceCents, "$0.00")}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </Field>
      {pkg && d.packageId !== v.packageId ? <div className="sp-ok">{includesSentence(pkg)}. Price and benefits fill in now.</div> : null}
      <div className="grid-2">
        <Field label={`Price for this ${word}`}>
          <input className="input" inputMode="decimal" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} />
        </Field>
        {side === "sponsors" ? (
          <Field label="Also an exhibitor">
            <select className="select" value={also ? "yes" : "no"} onChange={(e) => setD({ ...d, kind: e.target.value === "yes" ? "both" : "sponsor" })}>
              <option value="no">No</option>
              <option value="yes">{d.booth ? `Yes, booth ${d.booth}` : "Yes"}</option>
            </select>
          </Field>
        ) : (
          <Field label="Also a sponsor">
            <select className="select" value={also ? "yes" : "no"} onChange={(e) => setD({ ...d, kind: e.target.value === "yes" ? "both" : "exhibitor" })}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </Field>
        )}
        {d.kind !== "sponsor" ? (
          <Field label="Booth number">
            <input className="input" value={d.booth} maxLength={20} onChange={(e) => setD({ ...d, booth: e.target.value })} />
          </Field>
        ) : null}
        <Field label="Contact">
          <input className="input" value={d.contactName} maxLength={120} onChange={(e) => setD({ ...d, contactName: e.target.value })} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={d.email} maxLength={200} onChange={(e) => setD({ ...d, email: e.target.value })} />
        </Field>
        <Field label="Phone">
          <input className="input" type="tel" value={d.phone} maxLength={40} onChange={(e) => setD({ ...d, phone: e.target.value })} />
        </Field>
        <Field label="Status">
          <select className="select" value={d.active ? "active" : "cancelled"} onChange={(e) => setD({ ...d, active: e.target.value === "active" })}>
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Field>
      </div>
      <span className="sp-caps" style={{ marginTop: 4 }}>In the app</span>
      <div className="grid-2">
        <Field label="Company">
          <input className="input" value={d.company} maxLength={160} onChange={(e) => setD({ ...d, company: e.target.value })} />
        </Field>
        <Field label="Category">
          <input className="input" value={d.category} maxLength={80} placeholder="Practice software" onChange={(e) => setD({ ...d, category: e.target.value })} />
        </Field>
        <Field label="Website">
          <input className="input" value={d.website} maxLength={300} onChange={(e) => setD({ ...d, website: e.target.value })} />
        </Field>
        <Field label="Booth offer">
          <input className="input" value={d.offer} maxLength={300} placeholder="20% off for attendees" onChange={(e) => setD({ ...d, offer: e.target.value })} />
        </Field>
        <Field label="About" className="span-all">
          <textarea className="textarea" rows={3} maxLength={2000} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </Field>
        <Field label="Booth staff emails" className="span-all" hint="Separate with commas. They can scan badges for leads.">
          <input className="input" value={d.boothStaff} onChange={(e) => setD({ ...d, boothStaff: e.target.value })} />
        </Field>
        <Field label="Notes (team only)" className="span-all">
          <textarea className="textarea" rows={2} maxLength={4000} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} />
        </Field>
      </div>
      <div className="row gap-8">
        <span className="field">Logo</span>
        {d.logoUrl ? <img src={d.logoUrl} alt="Logo" style={{ width: 64, height: 40, objectFit: "contain", border: "1px solid var(--line)", borderRadius: 6 }} /> : <span className="small muted">None</span>}
        <UploadButton eventId={ev.id} label={d.logoUrl ? "Replace" : "Upload"} onUploaded={(f) => setD({ ...d, logoFileId: f.id, logoUrl: f.url })} />
        {d.logoUrl ? (
          <button type="button" className="btn btn-sm btn-w" onClick={() => setD({ ...d, logoFileId: null, logoUrl: null })}>
            Remove
          </button>
        ) : null}
      </div>
      <label className="check">
        <input type="checkbox" checked={d.visible} onChange={(e) => setD({ ...d, visible: e.target.checked })} />
        List in the attendee app
      </label>
      <label className="check">
        <input type="checkbox" checked={d.leadScanning} onChange={(e) => setD({ ...d, leadScanning: e.target.checked })} />
        Booth staff can scan attendee badges for leads
      </label>
    </>
  );

  const title = side === "sponsors" ? "Sponsor details" : "Exhibitor details";
  if (!can("vendors", "edit")) return <SpSection title={title} view={view} />;
  return (
    <SpSection
      title={title}
      saving={save.isPending}
      onOpen={() => setD(detailsDraft(v))}
      onCancel={() => setD(detailsDraft(v))}
      onSave={async () => {
        const staff = d.boothStaff.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
        await save.mutateAsync({
          eventId: ev.id,
          vendorId: v.id,
          company: d.company.trim() || v.company,
          kind: d.kind,
          packageId: d.packageId,
          amountCents: toCents(d.amount),
          booth: d.kind === "sponsor" ? "" : d.booth,
          contactName: d.contactName,
          email: d.email.trim(),
          phone: d.phone,
          active: d.active,
          logoFileId: d.logoFileId,
          description: d.description,
          website: d.website,
          category: d.category,
          offer: d.offer,
          notes: d.notes,
          boothStaff: staff,
          visible: d.visible,
          leadScanning: d.leadScanning,
        });
        toast("Saved");
        await Promise.all([utils.network.vendors.list.invalidate(), utils.network.packages.list.invalidate(), utils.network.maps.invalidate()]);
      }}
      view={view}
      edit={edit}
      footerRight={
        <button
          type="button"
          className="btn btn-sm btn-danger btn-w"
          disabled={remove.isPending}
          onClick={async () => {
            if (!confirmAction(`Delete ${v.company}? Their payments and leads go with them. To keep the record, set Status to Cancelled instead.`)) return;
            try {
              await remove.mutateAsync({ eventId: ev.id, vendorId: v.id });
              await utils.network.vendors.list.invalidate();
              navigate(`/admin/e/${ev.id}/vendors?tab=${side}`);
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Delete
        </button>
      }
    />
  );
}

/* ---------- Event passes ---------- */

function PassesSection({ v, side, onAdd }: { v: VendorRow; side: Side; onAdd: () => void }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const remove = trpc.network.packages.removePass.useMutation();
  const left = v.passesTotal - v.passesUsed;
  const label = side === "sponsors" ? "Event passes" : "Booth staff passes";
  const pkg = v.packageName ? `the ${v.packageName} package` : "the package";
  return (
    <SpSection
      title={`${label} (${v.passesUsed} of ${v.passesTotal})`}
      view={
        <>
          {v.passPeople.map((p) => (
            <div key={p.id} className="sp-li">
              <div className="grow">
                <b>{p.name}</b>
                <span className="s2">{p.email}</span>
              </div>
              <span className="r">
                <Pill tone="gray">{p.checkedIn ? "Checked in" : "Not yet"}</Pill>
                {can("vendors", "edit") ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-w"
                    disabled={remove.isPending}
                    onClick={async () => {
                      if (!confirmAction(`Remove ${p.name}'s pass? Their registration is cancelled.`)) return;
                      try {
                        await remove.mutateAsync({ eventId: ev.id, attendeeId: p.id });
                        await Promise.all([utils.network.vendors.list.invalidate(), utils.ce.attendees.list.invalidate()]);
                      } catch (err) {
                        toast(errorText(err), true);
                      }
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </span>
            </div>
          ))}
          <div className="sp-li">
            <span className="s2 grow">{left > 0 ? `${plural(left, "pass", "passes")} left in ${pkg}` : v.passesTotal ? `No passes left in ${pkg}` : "No passes in the package"}</span>
            {can("attendees", "edit") && v.status !== "cancelled" ? (
              <span className="r">
                <button type="button" className="btn btn-sm btn-solid btn-w" onClick={onAdd}>
                  Add person
                </button>
              </span>
            ) : null}
          </div>
        </>
      }
    />
  );
}

/* ---------- Benefits ---------- */

function BenefitsSection({ v }: { v: VendorRow }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const set = trpc.network.vendors.setBenefit.useMutation();
  const canEdit = can("vendors", "edit");
  return (
    <SpSection
      title="Benefits"
      view={
        v.benefits.length ? (
          <>
            {v.benefits.map((b, i) => (
              <label key={i} className={`sp-li${canEdit ? " sp-benefit" : ""}`}>
                <input
                  type="checkbox"
                  checked={b.status === "done"}
                  disabled={!canEdit || set.isPending}
                  aria-label={`${b.label} done`}
                  onChange={async (e) => {
                    try {
                      await set.mutateAsync({ eventId: ev.id, vendorId: v.id, index: i, done: e.target.checked });
                      await utils.network.vendors.list.invalidate();
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                />
                <span className="grow">{b.label}</span>
                <span className="r">{b.status === "done" ? <Pill>Done</Pill> : b.status === "waiting" ? <Pill tone="orange">Waiting</Pill> : <Pill tone="gray">To do</Pill>}</span>
              </label>
            ))}
          </>
        ) : (
          <div className="sp-li">
            <span className="s2">No benefits yet. Pick a package to fill them in.</span>
          </div>
        )
      }
    />
  );
}

/* ---------- Sponsors and Exhibitors tabs ---------- */

function paidCell(v: VendorRow) {
  if (v.amountCents === 0) return <span className="muted">No charge</span>;
  if (v.owedCents > 0) return <span className="owed">{fmtMoney(v.owedCents)} owed</span>;
  return <span>Paid</span>;
}

function VendorList({ data, side, vendorId, onAddPerson }: { data: ListData; side: Side; vendorId?: number; onAddPerson: (p: AddPreset) => void }) {
  const ev = useAdminEvent();
  const [, navigate] = useLocation();
  const cols = "1.7fr 1fr 0.8fr 1.1fr 0.7fr 1fr 96px";
  const rows = data.vendors.filter(side === "sponsors" ? isSponsor : isExhibitor).sort((a, b) => Number(a.status === "cancelled") - Number(b.status === "cancelled"));
  return (
    <div className="table-inner" style={{ minWidth: 900 }}>
      <THead cols={cols} labels={["Company", side === "sponsors" ? "Package" : "Booth", "Price", "Paid", "Passes", "Status", ""]} />
      {!rows.length ? (
        <Empty>{side === "sponsors" ? "No sponsors yet." : "No exhibitors yet."}</Empty>
      ) : (
        rows.map((v) => (
          <ExpandRow
            key={v.id}
            cols={cols}
            open={vendorId === v.id}
            closedLabel="Open"
            onToggle={() => navigate(vendorId === v.id ? `/admin/e/${ev.id}/vendors?tab=${side}` : `/admin/e/${ev.id}/vendors/${v.id}?tab=${side}`)}
            cells={[
              <span key="c" className="sp-co">
                <span className="sp-logo">{v.logoUrl ? <img src={v.logoUrl} alt="" /> : companyInitials(v.company)}</span>
                <span className="col" style={{ gap: 0, minWidth: 0 }}>
                  <span className="strong clip">{v.company}</span>
                  <span className="small muted clip">{v.contactName || v.email}</span>
                </span>
              </span>,
              side === "sponsors" ? (
                <span key="p">{v.packageName || v.level ? <Pill>{v.packageName || v.level}</Pill> : <span className="muted">None</span>}</span>
              ) : (
                <span key="p" className="col" style={{ gap: 0 }}>
                  <span className="clip">{v.packageName || v.level || <span className="muted">No package</span>}</span>
                  <span className="small muted">{v.booth ? `Booth ${v.booth}` : "No booth yet"}</span>
                </span>
              ),
              <span key="a">{fmtMoney(v.amountCents, "$0.00")}</span>,
              <span key="d">{paidCell(v)}</span>,
              <span key="s">
                {v.passesUsed} of {v.passesTotal}
              </span>,
              <Pill key="t" tone={v.statusTone}>{v.statusLabel}</Pill>,
            ]}
          >
            <div className="sp-expand">
              <DetailsSection key={`d-${v.id}`} v={v} side={side} packages={data.packages} />
              <PaymentsSection key={`p-${v.id}`} v={v} />
              <PassesSection v={v} side={side} onAdd={() => onAddPerson({ kind: side === "sponsors" ? "sponsor" : "vendor", vendorId: v.id })} />
              <BenefitsSection v={v} />
            </div>
          </ExpandRow>
        ))
      )}
    </div>
  );
}

function AddVendor({ side, open, onClose, packages }: { side: Side; open: boolean; onClose: () => void; packages: PackageRow[] }) {
  const ev = useAdminEvent();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const create = trpc.network.vendors.create.useMutation();
  const blank = { company: "", contactName: "", email: "", packageId: null as number | null };
  const [d, setD] = useState(blank);
  const word = side === "sponsors" ? "sponsor" : "exhibitor";
  const choices = packages.filter((p) => p.kind === (side === "sponsors" ? "sponsor" : "exhibitor"));
  return (
    <Modal open={open} onClose={onClose} title={`Add ${word}`}>
      <div className="grid-2">
        <Field label="Company" className="span-all">
          <input className="input" value={d.company} maxLength={160} autoFocus onChange={(e) => setD({ ...d, company: e.target.value })} />
        </Field>
        <Field label="Contact">
          <input className="input" value={d.contactName} maxLength={120} onChange={(e) => setD({ ...d, contactName: e.target.value })} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={d.email} maxLength={200} onChange={(e) => setD({ ...d, email: e.target.value })} />
        </Field>
        <Field label="Package" className="span-all">
          <select className="select" value={d.packageId ?? ""} onChange={(e) => setD({ ...d, packageId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">No package</option>
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}, {fmtMoney(p.priceCents, "$0.00")}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={!d.company.trim() || create.isPending}
          onClick={async () => {
            try {
              const v = await create.mutateAsync({ eventId: ev.id, company: d.company.trim(), kind: side === "sponsors" ? "sponsor" : "exhibitor", contactName: d.contactName.trim(), email: d.email.trim().toLowerCase(), status: "confirmed", packageId: d.packageId });
              await Promise.all([utils.network.vendors.list.invalidate(), utils.network.packages.list.invalidate()]);
              setD(blank);
              onClose();
              navigate(`/admin/e/${ev.id}/vendors/${v.id}?tab=${side}`);
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
  const [, navigate] = useLocation();
  const search = useSearch();
  const utils = trpc.useUtils();
  const list = trpc.network.vendors.list.useQuery({ eventId: ev.id });
  const pk = trpc.network.packages.list.useQuery({ eventId: ev.id });
  const [adding, setAdding] = useState<Tab | null>(null);
  const [preset, setPreset] = useState<AddPreset | null>(null);
  const [exporting, setExporting] = useState(false);
  const data = list.data;
  const wanted = new URLSearchParams(search).get("tab") as Tab | null;
  const opened = vendorId ? data?.vendors.find((v) => v.id === vendorId) : undefined;
  const tab: Tab = wanted && TABS.includes(wanted) ? wanted : opened && !isSponsor(opened) ? "exhibitors" : "sponsors";
  const canEdit = can("vendors", "edit");
  const setTab = (t: Tab) => {
    setAdding(null);
    navigate(`/admin/e/${ev.id}/vendors?tab=${t}`);
  };

  const exportTab = async (side: Side) => {
    setExporting(true);
    try {
      downloadCsv(await utils.network.vendors.exportCsv.fetch({ eventId: ev.id, tab: side }));
    } catch (err) {
      toast(errorText(err), true);
    } finally {
      setExporting(false);
    }
  };

  const exportPackages = () => {
    const rows = pk.data?.packages ?? [];
    const cell = (x: unknown) => {
      const s = String(x ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [["Package", "Kind", "Price", "How many to sell", "Sold", "Passes", "Booth", "Benefits"], ...rows.map((p) => [p.name, p.kind === "exhibitor" ? "Exhibitor booth" : "Sponsor", (p.priceCents / 100).toFixed(2), p.quantity ?? "No limit", p.sold, p.passes, p.includesBooth ? "Yes" : "No", p.benefits.join("; ")])].map((r) => r.map(cell).join(",")).join("\n");
    downloadCsv({ filename: `${ev.slug}-packages.csv`, csv });
  };

  const addLabel: Partial<Record<Tab, string>> = { sponsors: "Add sponsor", exhibitors: "Add exhibitor", packages: "Add package", addons: "Add add-on" };
  const actions = (
    <>
      {tab === "sponsors" || tab === "exhibitors" ? (
        <button className="btn btn-w-lg" disabled={exporting} onClick={() => exportTab(tab)}>
          Export
        </button>
      ) : tab === "packages" ? (
        <button className="btn btn-w-lg" onClick={exportPackages}>
          Export
        </button>
      ) : null}
      {canEdit && addLabel[tab] ? (
        <button className="btn btn-primary" onClick={() => setAdding(tab)}>
          {addLabel[tab]}
        </button>
      ) : null}
    </>
  );

  const count = (f: (v: VendorRow) => boolean) => data?.vendors.filter((v) => v.status !== "cancelled" && f(v)).length ?? 0;
  const tabs = [
    { key: "sponsors" as Tab, label: `Sponsors (${count(isSponsor)})` },
    { key: "exhibitors" as Tab, label: `Exhibitors (${count(isExhibitor)})` },
    { key: "packages" as Tab, label: `Packages (${pk.data?.packages.length ?? data?.packages.length ?? 0})` },
    { key: "addons" as Tab, label: `Add-ons (${pk.data?.addons.length ?? data?.counts.addons ?? 0})` },
    { key: "agreements" as Tab, label: data?.counts.agreements ? `Agreements (${data.counts.agreements})` : "Agreements" },
    { key: "map" as Tab, label: "Venue map" },
  ];

  const strip = () => {
    if (!data) return null;
    if (tab === "sponsors" || tab === "exhibitors") {
      const s = data.strips[tab];
      return (
        <NumStrip
          items={[
            { label: "Sold", value: fmtMoney(s.soldCents, "$0.00") },
            { label: "Paid", value: fmtMoney(s.paidCents, "$0.00") },
            { label: "Owed", value: fmtMoney(s.owedCents, "$0.00"), warn: s.owedCents > 0 },
            { label: "Passes used", value: `${s.passesUsed} of ${s.passesTotal}` },
          ]}
        />
      );
    }
    if (tab === "packages" && pk.data) {
      const s = pk.data.strip;
      return (
        <NumStrip
          items={[
            { label: "Packages", value: s.packages },
            { label: "Sold", value: s.unlimited ? s.sold : `${s.sold} of ${s.forSale}` },
            { label: "Value sold", value: fmtMoney(s.valueSoldCents, "$0.00") },
          ]}
        />
      );
    }
    return null;
  };

  const body = () => {
    if (!data) return null;
    if (tab === "sponsors" || tab === "exhibitors") return <VendorList data={data} side={tab} vendorId={vendorId} onAddPerson={setPreset} />;
    if (tab === "packages" || tab === "addons") {
      if (pk.isLoading) return <PageLoading />;
      if (pk.error) return <ErrorNote error={pk.error} />;
      return tab === "packages" ? <PackagesTab data={pk.data!} adding={adding === "packages"} onAdded={() => setAdding(null)} /> : <AddonsTab data={pk.data!} adding={adding === "addons"} onAdded={() => setAdding(null)} />;
    }
    return null;
  };

  return (
    <AdminPage title={<>Sponsors and exhibitors</>} actions={actions}>
      {list.isLoading ? (
        <PageLoading />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : data ? (
        <>
          {strip()}
          <div className="col" style={{ gap: 0 }}>
            <FolderTabs tabs={tabs} value={tab} onChange={setTab} />
            {tab === "agreements" ? (
              <div className="folder-body">
                <AgreementsTab />
              </div>
            ) : tab === "map" ? (
              <div className="folder-body">
                <VenueMapTab />
              </div>
            ) : (
              <div className="table">{body()}</div>
            )}
          </div>
        </>
      ) : null}
      {tab === "sponsors" || tab === "exhibitors" ? <AddVendor side={tab} open={adding === tab} onClose={() => setAdding(null)} packages={data?.packages ?? []} /> : null}
      <AddAttendeeSheet open={!!preset} preset={preset ?? undefined} onClose={() => setPreset(null)} />
    </AdminPage>
  );
}
