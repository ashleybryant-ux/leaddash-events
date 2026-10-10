/** The Packages and Add-ons tabs on Sponsors and exhibitors. */
import { useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { Empty, ExpandRow, Field, THead, confirmAction } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtMoney } from "@shared/format";
import { toCents } from "./shared";
import { SpSection, plural } from "./sponsor-ui";

type PkgData = RouterOutputs["network"]["packages"]["list"];
type Pkg = PkgData["packages"][number];
type Addon = PkgData["addons"][number];
type Spots = Pkg["logoSpots"];

const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** "4 passes · booth · welcome screen logo" */
export function includesSummary(p: Pick<Pkg, "kind" | "passes" | "includesBooth" | "logoSpots">) {
  const parts = [p.kind === "exhibitor" ? plural(p.passes, "booth staff pass", "booth staff passes") : plural(p.passes, "pass", "passes")];
  if (p.includesBooth) parts.push("booth");
  if (p.kind === "sponsor") parts.push(p.logoSpots.welcome ? "welcome screen logo" : p.logoSpots.topOfList ? "top of sponsors list" : p.logoSpots.sessionPages ? "logo on session pages" : "sponsors list");
  return parts.join(" · ");
}

/** "Gold includes: 4 event passes, a booth, logo on the welcome screen, 5 benefits" */
export function includesSentence(p: Pick<Pkg, "name" | "kind" | "passes" | "includesBooth" | "logoSpots" | "benefits">) {
  const parts = [p.kind === "exhibitor" ? plural(p.passes, "booth staff pass", "booth staff passes") : plural(p.passes, "event pass", "event passes")];
  if (p.includesBooth) parts.push("a booth");
  if (p.logoSpots.welcome) parts.push("logo on the welcome screen");
  if (p.logoSpots.topOfList) parts.push("logo at the top of the sponsors list");
  if (p.logoSpots.sessionPages) parts.push("logo on session pages they sponsor");
  parts.push(plural(p.benefits.length, "benefit"));
  return `${p.name} includes: ${parts.join(", ")}`;
}

const spotsText = (s: Spots) => {
  const list = [s.welcome ? "Welcome screen" : "", s.topOfList ? "top of the sponsors list" : "", s.sessionPages ? "session pages they sponsor" : ""].filter(Boolean);
  return list.length ? list.join(", ").replace(/^./, (c) => c.toUpperCase()) : "Sponsors list";
};

/* ---------- Packages ---------- */

type PkgDraft = { name: string; price: string; quantity: string; kind: "sponsor" | "exhibitor"; passes: string; passTicketTypeId: number | null; logoSpots: Spots; includesBooth: boolean; benefits: string };

const pkgDraft = (p?: Pkg): PkgDraft => ({
  name: p?.name ?? "",
  price: p ? fmtMoney(p.priceCents, "") : "",
  quantity: p?.quantity ? String(p.quantity) : "",
  kind: p?.kind ?? "sponsor",
  passes: p ? String(p.passes) : "1",
  passTicketTypeId: p?.passTicketTypeId ?? null,
  logoSpots: p?.logoSpots ?? { welcome: false, topOfList: false, sessionPages: false },
  includesBooth: p?.includesBooth ?? false,
  benefits: (p?.benefits ?? []).join("\n"),
});

function PackageEditor({ p, data, onDone, startOpen = false }: { p?: Pkg; data: PkgData; onDone?: () => void; startOpen?: boolean }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const save = trpc.network.packages.save.useMutation();
  const remove = trpc.network.packages.remove.useMutation();
  const [d, setD] = useState(() => pkgDraft(p));
  const ticket = data.tickets.find((t) => t.id === p?.passTicketTypeId);
  const refresh = () => Promise.all([utils.network.packages.list.invalidate(), utils.network.vendors.list.invalidate()]);
  const spot = (k: keyof Spots, label: string) => (
    <label className="check">
      <input type="checkbox" checked={d.logoSpots[k]} onChange={(e) => setD({ ...d, logoSpots: { ...d.logoSpots, [k]: e.target.checked } })} />
      {label}
    </label>
  );

  const view = p ? (
    <div className="sp-kv">
      <span className="k">Price</span>
      <span>{fmtMoney(p.priceCents, "$0.00")}</span>
      <span className="k">How many to sell</span>
      <span>{p.quantity ? `${p.quantity} (${p.sold} sold, ${Math.max(0, p.quantity - p.sold)} left)` : `No limit (${p.sold} sold)`}</span>
      <span className="k">Kind</span>
      <span>{p.kind === "exhibitor" ? "Exhibitor booth" : "Sponsor"}</span>
      <span className="k">{p.kind === "exhibitor" ? "Booth staff passes" : "Event passes"}</span>
      <span>
        {p.passes} per {p.kind === "exhibitor" ? "exhibitor" : "sponsor"}
        {ticket ? `, ${ticket.name} ticket` : ""}
      </span>
      {p.kind === "sponsor" ? (
        <>
          <span className="k">Logo shows on</span>
          <span>{spotsText(p.logoSpots)}</span>
        </>
      ) : null}
      <span className="k">Booth</span>
      <span>{p.includesBooth ? "Included" : "Not included"}</span>
      <span className="k">Benefits</span>
      <span>{p.benefits.length ? p.benefits.map((b, i) => (i ? lower(b) : b)).join(", ") : <span className="muted">None</span>}</span>
    </div>
  ) : null;

  const edit = (
    <>
      <div className="grid-3" style={{ gap: 10 }}>
        <Field label="Name">
          <input className="input" value={d.name} maxLength={80} placeholder="Gold" onChange={(e) => setD({ ...d, name: e.target.value })} />
        </Field>
        <Field label="Price">
          <input className="input" inputMode="decimal" value={d.price} placeholder="$0.00" onChange={(e) => setD({ ...d, price: e.target.value })} />
        </Field>
        <Field label="How many to sell">
          <input className="input" inputMode="numeric" value={d.quantity} placeholder="No limit" onChange={(e) => setD({ ...d, quantity: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <Field label="Kind">
          <select className="select" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as PkgDraft["kind"] })}>
            <option value="sponsor">Sponsor</option>
            <option value="exhibitor">Exhibitor booth</option>
          </select>
        </Field>
        <Field label={d.kind === "exhibitor" ? "Booth staff passes included" : "Event passes included"}>
          <input className="input" inputMode="numeric" value={d.passes} onChange={(e) => setD({ ...d, passes: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <Field label="Passes use ticket">
          <select className="select" value={d.passTicketTypeId ?? ""} onChange={(e) => setD({ ...d, passTicketTypeId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">First active ticket</option>
            {data.tickets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <span className="sp-caps">Where the logo shows in the app</span>
      <div className="sp-checks">
        {spot("welcome", "Welcome screen")}
        {spot("topOfList", "Top of the sponsors list")}
        {spot("sessionPages", "Session pages they sponsor")}
        <label className="check">
          <input type="checkbox" checked={d.includesBooth} onChange={(e) => setD({ ...d, includesBooth: e.target.checked })} />
          Includes a booth
        </label>
      </div>
      <span className="sp-caps">Benefits (one per line, each becomes a checklist item on the sponsor)</span>
      <textarea className="textarea" rows={5} aria-label="Benefits" value={d.benefits} onChange={(e) => setD({ ...d, benefits: e.target.value })} />
    </>
  );

  if (!can("vendors", "edit")) return <SpSection title={`${p?.name} package`} view={view} />;
  return (
    <SpSection
      title={p ? `${p.name} package` : "New package"}
      startOpen={startOpen}
      saving={save.isPending}
      onOpen={() => setD(pkgDraft(p))}
      onCancel={() => {
        setD(pkgDraft(p));
        onDone?.();
      }}
      onSave={async () => {
        if (!d.name.trim()) throw new Error("Name the package.");
        await save.mutateAsync({
          eventId: ev.id,
          packageId: p?.id,
          name: d.name.trim(),
          kind: d.kind,
          priceCents: toCents(d.price),
          quantity: d.quantity ? Number(d.quantity) : null,
          passes: Number(d.passes) || 0,
          passTicketTypeId: d.passTicketTypeId,
          includesBooth: d.includesBooth,
          logoSpots: d.logoSpots,
          benefits: d.benefits.split("\n").map((b) => b.trim()).filter(Boolean),
        });
        toast("Saved");
        await refresh();
        onDone?.();
      }}
      view={view}
      edit={edit}
      footerRight={
        p ? (
          <button
            type="button"
            className="btn btn-sm btn-danger btn-w"
            disabled={remove.isPending}
            onClick={async () => {
              if (!confirmAction(`Delete the ${p.name} package?`)) return;
              try {
                await remove.mutateAsync({ eventId: ev.id, packageId: p.id });
                await refresh();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Delete
          </button>
        ) : null
      }
    />
  );
}

export function PackagesTab({ data, adding, onAdded }: { data: PkgData; adding: boolean; onAdded: () => void }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const move = trpc.network.packages.moveUp.useMutation();
  const [open, setOpen] = useState<number | null>(null);
  const cols = "1.3fr 0.9fr 0.9fr 2fr 96px 96px";
  return (
    <div className="table-inner">
      <THead cols={cols} labels={["Package", "Price", "Sold", "Includes", "", ""]} />
      {adding ? (
        <div className="trow-open" style={{ borderBottom: "1px solid var(--line)", paddingTop: 14 }}>
          <div className="editor">
            <PackageEditor data={data} startOpen onDone={onAdded} />
          </div>
        </div>
      ) : null}
      {!data.packages.length && !adding ? <Empty>No packages yet. Add your sponsorship levels and booths.</Empty> : null}
      {data.packages.map((p, i) => (
        <ExpandRow
          key={p.id}
          cols={cols}
          open={open === p.id}
          onToggle={() => setOpen(open === p.id ? null : p.id)}
          closedLabel="Open"
          cells={[
            <span key="n" className="strong">{p.name}</span>,
            <span key="p">{fmtMoney(p.priceCents, "$0.00")}</span>,
            <span key="s">{p.quantity ? `${p.sold} of ${p.quantity} sold` : p.sold ? `${p.sold} sold, no limit` : "No limit"}</span>,
            <span key="i" className="clip">{includesSummary(p)}</span>,
            i > 0 && can("vendors", "edit") ? (
              <button
                key="m"
                type="button"
                className="btn btn-sm btn-w"
                disabled={move.isPending}
                onClick={async () => {
                  try {
                    await move.mutateAsync({ eventId: ev.id, packageId: p.id });
                    await utils.network.packages.list.invalidate();
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Move up
              </button>
            ) : (
              <span key="m" />
            ),
          ]}
        >
          <PackageEditor key={`${p.id}-${p.sort}`} p={p} data={data} />
        </ExpandRow>
      ))}
    </div>
  );
}

/* ---------- Add-ons ---------- */

type AddonDraft = { name: string; price: string; quantity: string; packageIds: number[]; addsPass: boolean };
/** An empty list means every exhibitor booth, so those boxes show checked. */
const addonDraft = (a: Addon | undefined, packages: Pkg[]): AddonDraft => ({
  name: a?.name ?? "",
  price: a ? fmtMoney(a.priceCents, "") : "",
  quantity: a?.quantity ? String(a.quantity) : "",
  packageIds: a?.packageIds.length ? a.packageIds : packages.filter((p) => p.kind === "exhibitor").map((p) => p.id),
  addsPass: a?.addsPass ?? false,
});

/** "Standard, Corner" or "All booths". */
function offeredWith(a: Pick<Addon, "packageIds">, packages: Pkg[]) {
  const booths = packages.filter((p) => p.kind === "exhibitor");
  const chosen = packages.filter((p) => a.packageIds.includes(p.id));
  if (!chosen.length) return "All booths";
  const sponsorsAll = packages.some((p) => p.kind === "sponsor") && packages.filter((p) => p.kind === "sponsor").every((p) => a.packageIds.includes(p.id));
  const boothNames = chosen.filter((p) => p.kind === "exhibitor");
  const parts = boothNames.length && boothNames.length === booths.length ? ["All booths"] : boothNames.map((p) => p.name.replace(/\s+booth$/i, ""));
  if (sponsorsAll) parts.push("Sponsor packages");
  else parts.push(...chosen.filter((p) => p.kind === "sponsor").map((p) => p.name));
  return parts.join(", ");
}

function AddonEditor({ a, data, onDone, startOpen = false }: { a?: Addon; data: PkgData; onDone?: () => void; startOpen?: boolean }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const save = trpc.network.packages.saveAddon.useMutation();
  const remove = trpc.network.packages.removeAddon.useMutation();
  const [d, setD] = useState(() => addonDraft(a, data.packages));
  const booths = data.packages.filter((p) => p.kind === "exhibitor");
  const sponsorIds = data.packages.filter((p) => p.kind === "sponsor").map((p) => p.id);
  const sponsorsOn = sponsorIds.length > 0 && sponsorIds.every((x) => d.packageIds.includes(x));
  const toggle = (ids: number[], on: boolean) => setD({ ...d, packageIds: on ? Array.from(new Set([...d.packageIds, ...ids])) : d.packageIds.filter((x) => !ids.includes(x)) });
  const refresh = () => Promise.all([utils.network.packages.list.invalidate(), utils.network.vendors.list.invalidate()]);

  const view = a ? (
    <div className="sp-kv">
      <span className="k">Price</span>
      <span>{fmtMoney(a.priceCents, "$0.00")}</span>
      <span className="k">How many to sell</span>
      <span>{a.quantity ? `${a.quantity} (${a.sold} sold)` : "No limit"}</span>
      <span className="k">Offered with</span>
      <span>{offeredWith(a, data.packages)}</span>
      <span className="k">Booth staff pass</span>
      <span>{a.addsPass ? "Each one adds a pass" : "No"}</span>
    </div>
  ) : null;

  const edit = (
    <>
      <div className="grid-3" style={{ gap: 10 }}>
        <Field label="Name">
          <input className="input" value={d.name} maxLength={80} placeholder="Electricity" onChange={(e) => setD({ ...d, name: e.target.value })} />
        </Field>
        <Field label="Price">
          <input className="input" inputMode="decimal" value={d.price} placeholder="$0.00" onChange={(e) => setD({ ...d, price: e.target.value })} />
        </Field>
        <Field label="How many to sell">
          <input className="input" inputMode="numeric" value={d.quantity} placeholder="No limit" onChange={(e) => setD({ ...d, quantity: e.target.value.replace(/\D/g, "") })} />
        </Field>
      </div>
      <span className="sp-caps">Offered with</span>
      <div className="sp-checks">
        {booths.map((p) => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={d.packageIds.includes(p.id)} onChange={(e) => toggle([p.id], e.target.checked)} />
            {p.name}
          </label>
        ))}
        {sponsorIds.length ? (
          <label className="check">
            <input type="checkbox" checked={sponsorsOn} onChange={(e) => toggle(sponsorIds, e.target.checked)} />
            Sponsor packages
          </label>
        ) : null}
      </div>
      <span className="small muted">All booths checked also covers booths you add later.</span>
      <label className="check">
        <input type="checkbox" checked={d.addsPass} onChange={(e) => setD({ ...d, addsPass: e.target.checked })} />
        Adds a booth staff pass
      </label>
    </>
  );

  if (!can("vendors", "edit")) return <SpSection title={a?.name ?? ""} view={view} />;
  return (
    <SpSection
      title={a ? a.name : "New add-on"}
      startOpen={startOpen}
      saving={save.isPending}
      onOpen={() => setD(addonDraft(a, data.packages))}
      onCancel={() => {
        setD(addonDraft(a, data.packages));
        onDone?.();
      }}
      onSave={async () => {
        if (!d.name.trim()) throw new Error("Name the add-on.");
        const allBooths = booths.length > 0 && booths.every((p) => d.packageIds.includes(p.id)) && !d.packageIds.some((x) => sponsorIds.includes(x));
        await save.mutateAsync({ eventId: ev.id, addonId: a?.id, name: d.name.trim(), priceCents: toCents(d.price), quantity: d.quantity ? Number(d.quantity) : null, packageIds: allBooths ? [] : d.packageIds, addsPass: d.addsPass });
        toast("Saved");
        await refresh();
        onDone?.();
      }}
      view={view}
      edit={edit}
      footerRight={
        a ? (
          <button
            type="button"
            className="btn btn-sm btn-danger btn-w"
            disabled={remove.isPending}
            onClick={async () => {
              if (!confirmAction(`Delete ${a.name}?`)) return;
              try {
                await remove.mutateAsync({ eventId: ev.id, addonId: a.id });
                await refresh();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Delete
          </button>
        ) : null
      }
    />
  );
}

export function AddonsTab({ data, adding, onAdded }: { data: PkgData; adding: boolean; onAdded: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const cols = "1.6fr 0.8fr 0.9fr 1.6fr 96px";
  return (
    <div className="table-inner">
      <THead cols={cols} labels={["Add-on", "Price", "Available", "Offered with", ""]} />
      {adding ? (
        <div className="trow-open" style={{ borderBottom: "1px solid var(--line)", paddingTop: 14 }}>
          <div className="editor">
            <AddonEditor data={data} startOpen onDone={onAdded} />
          </div>
        </div>
      ) : null}
      {!data.addons.length && !adding ? <Empty>No add-ons yet. Add extras like electricity or an extra staff pass.</Empty> : null}
      {data.addons.map((a) => (
        <ExpandRow
          key={a.id}
          cols={cols}
          open={open === a.id}
          onToggle={() => setOpen(open === a.id ? null : a.id)}
          closedLabel="Open"
          cells={[
            <span key="n" className="strong">{a.name}</span>,
            <span key="p">{fmtMoney(a.priceCents, "$0.00")}</span>,
            <span key="q">{a.quantity ? `${Math.max(0, a.quantity - a.sold)} left` : "No limit"}</span>,
            <span key="o" className="clip">{offeredWith(a, data.packages)}</span>,
          ]}
        >
          <AddonEditor key={a.id} a={a} data={data} />
        </ExpandRow>
      ))}
    </div>
  );
}
