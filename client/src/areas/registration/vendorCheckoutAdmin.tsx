/**
 * The Sponsors and Exhibitors tabs on the admin Checkout page
 * (/admin/e/:eventId/registration?tab=checkout&for=sponsors|exhibitors), and the
 * Charge now, Send invoice and Copy pay link buttons on a sponsor's Payments section.
 */
import { useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { CopyButton, ErrorNote, Field, FolderTabs, PageLoading, Pill, confirmAction } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtDate } from "@shared/format";
import { SpSection } from "../network/sponsor-ui";
import type { VendorRow } from "../network/vendor-payments";

export type CheckoutFor = "attendees" | "sponsors" | "exhibitors";
const FOR_TABS: { key: CheckoutFor; label: string }[] = [
  { key: "attendees", label: "Attendees" },
  { key: "sponsors", label: "Sponsors" },
  { key: "exhibitors", label: "Exhibitors" },
];

/** Which checkout page the tab shows (?who=sponsors|exhibitors; attendees when absent). */
export function useCheckoutFor(): [CheckoutFor, (w: CheckoutFor) => string] {
  const search = useSearch();
  const [location] = useLocation();
  const raw = new URLSearchParams(search).get("who");
  const who: CheckoutFor = raw === "sponsors" || raw === "exhibitors" ? raw : "attendees";
  return [who, (w) => `${location}?tab=checkout${w === "attendees" ? "" : `&who=${w}`}`];
}

/** Attendees, Sponsors, Exhibitors folder tabs above the Checkout page card. */
export function CheckoutForTabs() {
  const [who, hrefFor] = useCheckoutFor();
  return <FolderTabs tabs={FOR_TABS} value={who} hrefFor={hrefFor} />;
}

/** The Checkout page card body for the chosen tab (the attendee screen is passed in unchanged). */
export function CheckoutForBody({ attendees, canEdit }: { attendees: ReactNode; canEdit: boolean }) {
  const [who] = useCheckoutFor();
  if (who === "attendees") return <>{attendees}</>;
  return <VendorCheckoutSettings key={who} kind={who === "sponsors" ? "sponsor" : "exhibitor"} canEdit={canEdit} />;
}

type Settings = RouterOutputs["registration"]["vendorCheckout"]["admin"]["settings"];
type Kind = "sponsor" | "exhibitor";
type Methods = "both" | "ach" | "card";

const METHOD_LABELS: Record<Methods, string> = { both: "Card and bank account", ach: "Bank account (ACH) only", card: "Card only" };
const PERCENTS = [10, 20, 30, 40, 50, 60, 70, 80, 90];
const HOLDS = [7, 14, 30] as const;

type Draft = {
  open: boolean;
  closesOn: string;
  title: string;
  intro: string;
  packageIds: number[];
  payFull: boolean;
  payDeposit: boolean;
  payInvoice: boolean;
  methods: Methods;
  depositPercent: number;
  balanceDueOn: string;
  invoiceHoldDays: 7 | 14 | 30;
  agreementTemplateId: number | null;
  notifyEmail: string;
};

const activeIds = (s: Settings) => s.packages.filter((p) => p.active).map((p) => p.id);

function draftOf(s: Settings): Draft {
  return {
    open: s.open,
    closesOn: s.closesOn ?? "",
    title: s.title,
    intro: s.intro,
    packageIds: s.packageIds.length ? s.packageIds : activeIds(s),
    payFull: s.payFull,
    payDeposit: s.payDeposit,
    payInvoice: s.payInvoice,
    methods: s.methods,
    depositPercent: s.depositPercent,
    balanceDueOn: s.balanceDueOn ?? "",
    invoiceHoldDays: (HOLDS as readonly number[]).includes(s.invoiceHoldDays) ? (s.invoiceHoldDays as 7 | 14 | 30) : 14,
    agreementTemplateId: s.agreementTemplateId,
    notifyEmail: s.notifyEmail,
  };
}

/** "In full, 50% deposit (rest Mar 1, 2027), or invoice held 14 days" */
function howTheyPay(s: Pick<Settings, "payFull" | "payDeposit" | "payInvoice" | "depositPercent" | "balanceDueOn" | "invoiceHoldDays">) {
  const parts = [s.payFull ? "In full" : "", s.payDeposit ? `${s.depositPercent}% deposit${s.balanceDueOn ? ` (rest ${fmtDate(s.balanceDueOn)})` : ""}` : "", s.payInvoice ? `invoice held ${s.invoiceHoldDays} days` : ""].filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const text = `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`;
  return text[0].toUpperCase() + text.slice(1);
}

const shortLink = (url: string) => url.replace(/^https?:\/\//, "");

/** The Sponsors or Exhibitors tab: the checkout link and the page settings. */
export function VendorCheckoutSettings({ kind, canEdit }: { kind: Kind; canEdit: boolean }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const q = trpc.registration.vendorCheckout.admin.settings.useQuery({ eventId: ev.id, kind });
  const save = trpc.registration.vendorCheckout.admin.saveSettings.useMutation();
  const [d, setD] = useState<Draft | null>(null);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const s = q.data!;
  const word = kind === "sponsor" ? "Sponsor" : "Exhibitor";
  const plural = kind === "sponsor" ? "sponsors" : "exhibitors";
  const draft = d ?? draftOf(s);
  const set = (patch: Partial<Draft>) => setD({ ...draft, ...patch });
  const allActive = activeIds(s);
  const shown = s.packageIds.length ? s.packages.filter((p) => s.packageIds.includes(p.id)) : s.packages.filter((p) => p.active);
  const template = s.templates.find((t) => t.id === s.agreementTemplateId);
  const bankOn = (m: Methods) => m !== "card";
  const achNote = (m: Methods) =>
    bankOn(m) && !s.achActive ? <div className="sp-warn">{s.stripeConnected ? "Bank payments are not on in your Stripe account yet. Turn on ACH Direct Debit in Stripe (Settings, Payment methods)." : "Connect Stripe to take bank payments."}</div> : null;

  const linkView = (
    <div className="sp-kv">
      <span className="k">Link</span>
      <span>{shortLink(s.link)}</span>
      <span className="k">Page</span>
      <span className="row gap-8">
        <Pill tone={s.live ? "green" : "gray"}>{s.live ? "Open" : "Closed"}</Pill>
        {s.closesOn ? <span>{s.live ? "closes" : "closed"} {fmtDate(s.closesOn)}</span> : null}
      </span>
    </div>
  );

  const view = (
    <>
      <div className="sp-kv">
        <span className="k">Title</span>
        <span>{s.title}</span>
        <span className="k">Intro</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.intro || <span className="muted">Not set</span>}</span>
        <span className="k">{kind === "sponsor" ? "Packages shown" : "Booths shown"}</span>
        <span>{shown.map((p) => p.name).join(", ") || <span className="muted">None yet. Add them on Sponsors and exhibitors.</span>}</span>
        <span className="k">How they can pay</span>
        <span>{howTheyPay(s)}</span>
        <span className="k">Payment methods</span>
        <span>{METHOD_LABELS[s.methods]}</span>
        <span className="k">Agreement to sign</span>
        <span className="row gap-10" style={{ flexWrap: "wrap" }}>
          {template ? `${template.name}, signed before paying` : "None"}
          <Link href={`/admin/e/${ev.id}/agreements?open=${template ? template.id : kind}`} className="btn btn-sm" style={{ padding: "0 12px" }}>
            {template ? "Edit agreement" : "Agreements"}
          </Link>
        </span>
        <span className="k">Email new {plural} to</span>
        <span>{s.notifyEmail || <span className="muted">Organization owners</span>}</span>
      </div>
      {achNote(s.methods) ? <div style={{ padding: "0 14px 12px" }}>{achNote(s.methods)}</div> : null}
    </>
  );

  const edit = (
    <>
      <div className="grid-2">
        <Field label="Page">
          <select className="select" value={draft.open ? "open" : "closed"} onChange={(e) => set({ open: e.target.value === "open" })}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </Field>
        <Field label="Closes on">
          <input className="input" type="date" value={draft.closesOn} onChange={(e) => set({ closesOn: e.target.value })} />
        </Field>
      </div>
      <Field label="Title">
        <input className="input" maxLength={160} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field label="Intro">
        <textarea className="textarea" rows={3} maxLength={2000} value={draft.intro} onChange={(e) => set({ intro: e.target.value })} />
      </Field>
      <span className="sp-caps">{kind === "sponsor" ? "Packages on the page" : "Booths on the page"}</span>
      {s.packages.length ? (
        <div className="sp-checks">
          {s.packages.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={draft.packageIds.includes(p.id)} disabled={!p.active} onChange={(e) => set({ packageIds: e.target.checked ? [...draft.packageIds, p.id] : draft.packageIds.filter((x) => x !== p.id) })} />
              {p.name}
              {p.active ? "" : " (off)"}
            </label>
          ))}
        </div>
      ) : (
        <span className="small muted">Add {kind === "sponsor" ? "packages" : "booths"} on Sponsors and exhibitors first.</span>
      )}
      <span className="sp-caps">How {plural} can pay</span>
      <div className="sp-checks">
        <label className="check">
          <input type="checkbox" checked={draft.payFull} onChange={(e) => set({ payFull: e.target.checked })} />
          Pay in full
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.payDeposit} onChange={(e) => set({ payDeposit: e.target.checked })} />
          Pay a deposit
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.payInvoice} onChange={(e) => set({ payInvoice: e.target.checked })} />
          Pay by invoice
        </label>
      </div>
      <div className="grid-2" style={{ alignItems: "end" }}>
        <Field label="Payment methods">
          <select className="select" value={draft.methods} onChange={(e) => set({ methods: e.target.value as Methods })}>
            {(Object.keys(METHOD_LABELS) as Methods[]).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <div>{achNote(draft.methods)}</div>
      </div>
      {draft.payDeposit || draft.payInvoice ? (
        <div className="grid-3" style={{ gap: 10 }}>
          {draft.payDeposit ? (
            <>
              <Field label="Deposit">
                <select className="select" value={draft.depositPercent} onChange={(e) => set({ depositPercent: Number(e.target.value) })}>
                  {PERCENTS.map((n) => (
                    <option key={n} value={n}>
                      {n}%
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Rest charged on">
                <input className="input" type="date" min={s.today} value={draft.balanceDueOn} onChange={(e) => set({ balanceDueOn: e.target.value })} />
              </Field>
            </>
          ) : null}
          {draft.payInvoice ? (
            <Field label="Hold for invoices">
              <select className="select" value={draft.invoiceHoldDays} onChange={(e) => set({ invoiceHoldDays: Number(e.target.value) as 7 | 14 | 30 })}>
                {HOLDS.map((n) => (
                  <option key={n} value={n}>
                    {n} days
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      ) : null}
      <div className="grid-2">
        <Field label="Agreement to sign">
          <select className="select" value={draft.agreementTemplateId ?? ""} onChange={(e) => set({ agreementTemplateId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">None</option>
            {s.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Email new ${plural} to`}>
          <input className="input" type="email" value={draft.notifyEmail} onChange={(e) => set({ notifyEmail: e.target.value })} />
        </Field>
      </div>
    </>
  );

  const preview = `/r/${ev.slug}/${kind === "sponsor" ? "sponsor" : "exhibit"}`;
  return (
    <>
      <SpSection
        title={`${word} checkout link`}
        actions={
          <>
            <CopyButton text={s.link} label="Copy link" className="btn btn-sm btn-w-lg" />
            <CopyButton text={s.embedCode} label="Embed code" className="btn btn-sm btn-w-lg" />
            <a className="btn btn-sm btn-w-lg" href={preview} target="_blank" rel="noreferrer">
              Preview
            </a>
          </>
        }
        view={linkView}
      />
      {canEdit ? (
        <SpSection
          title={`${word} page`}
          view={view}
          edit={edit}
          saving={save.isPending}
          onCancel={() => setD(null)}
          onSave={async () => {
            if (!draft.title.trim()) throw new Error("Add a title.");
            if (draft.payDeposit && !draft.balanceDueOn) throw new Error("Set the date the rest is charged.");
            const all = allActive.length > 0 && allActive.every((x) => draft.packageIds.includes(x)) && draft.packageIds.every((x) => allActive.includes(x));
            await save.mutateAsync({
              eventId: ev.id,
              kind,
              open: draft.open,
              closesOn: draft.closesOn || null,
              title: draft.title.trim(),
              intro: draft.intro.trim(),
              packageIds: all ? [] : draft.packageIds,
              payFull: draft.payFull,
              payDeposit: draft.payDeposit,
              payInvoice: draft.payInvoice,
              methods: draft.methods,
              depositPercent: draft.depositPercent,
              balanceDueOn: draft.payDeposit ? draft.balanceDueOn || null : null,
              invoiceHoldDays: draft.invoiceHoldDays,
              agreementTemplateId: draft.agreementTemplateId,
              notifyEmail: draft.notifyEmail.trim(),
            });
            await utils.registration.vendorCheckout.admin.settings.invalidate({ eventId: ev.id, kind });
            setD(null);
            toast(`${word} page saved`);
          }}
        />
      ) : (
        <SpSection title={`${word} page`} view={view} />
      )}
    </>
  );
}

/* ---------- Payments section buttons on a sponsor or exhibitor ---------- */

/** Charge now on the next charge row (asks first). */
export function ChargeNowButton({ v }: { v: VendorRow }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const charge = trpc.registration.vendorCheckout.admin.chargeNow.useMutation();
  return (
    <button
      type="button"
      className="btn btn-sm btn-w-lg"
      disabled={charge.isPending}
      onClick={async () => {
        const amount = (v.nextChargeCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
        if (!confirmAction(`Charge ${amount} to ${v.payMethodLabel || "the saved payment method"} now?`)) return;
        try {
          const r = await charge.mutateAsync({ eventId: ev.id, vendorId: v.id });
          toast(r.status === "pending" ? "Charged. The bank payment takes a few days to clear." : r.status === "paid" ? "Charged" : "Nothing to charge");
        } catch (err) {
          toast(errorText(err), true);
        }
        await utils.network.vendors.list.invalidate();
      }}
    >
      {charge.isPending ? "Charging" : "Charge now"}
    </button>
  );
}

/** Send invoice and Copy pay link, under the payments when something is owed. */
export function PayLinkButtons({ v }: { v: VendorRow }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const send = trpc.registration.vendorCheckout.admin.sendPayLink.useMutation();
  const link = trpc.registration.vendorCheckout.admin.payLink.useMutation();
  if (!can("vendors", "edit")) return null;
  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-w-lg"
        disabled={send.isPending}
        onClick={async () => {
          try {
            const r = await send.mutateAsync({ eventId: ev.id, vendorId: v.id });
            toast(`Invoice sent to ${r.to}`);
          } catch (err) {
            toast(errorText(err), true);
          }
        }}
      >
        Send invoice
      </button>
      <button
        type="button"
        className="btn btn-sm btn-w-lg"
        disabled={link.isPending}
        onClick={async () => {
          try {
            const { url } = await link.mutateAsync({ eventId: ev.id, vendorId: v.id });
            try {
              await navigator.clipboard.writeText(url);
              toast("Pay link copied");
            } catch {
              window.prompt("Copy the pay link", url);
            }
          } catch (err) {
            toast(errorText(err), true);
          }
        }}
      >
        Copy pay link
      </button>
    </>
  );
}
