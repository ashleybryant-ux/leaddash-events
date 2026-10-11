/**
 * Registration admin: /admin/e/:eventId/registration?tab=tickets|checkout|welcome|payments
 * and the organization's Stripe page /admin/payments.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { CopyButton, EditSection, Empty, ErrorNote, ExpandRow, Field, KV, PageLoading, Pill, THead, UploadButton, confirmAction, NumStrip } from "../../ui/components";
import { IconCard } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtDates, fmtMoney, fmtTime, fmtWhen, slugify } from "@shared/format";
import { centsToInput, parseMoney, StepNumber, useDebounced, type Question } from "./shared";
import { PHASE_LABEL, addDays, priceView, type PriceSet } from "@shared/pricing";
import { WelcomeTabBody, WelcomeTabsBar } from "./welcomeTabs";
import { CheckoutForBody, CheckoutForTabs } from "./vendorCheckoutAdmin";

type AdminEvent = ReturnType<typeof useAdminEvent>;
type StripeStatus = RouterOutputs["registration"]["stripe"]["status"];
type Ticket = RouterOutputs["registration"]["tickets"]["list"][number];
type Coupon = RouterOutputs["registration"]["coupons"]["list"][number];
type Template = RouterOutputs["registration"]["templates"]["list"][number];
type Payment = RouterOutputs["registration"]["payments"]["list"][number] & { eventName?: string };

const TABS = [
  { key: "tickets", label: "Tickets" },
  { key: "checkout", label: "Checkout page" },
  { key: "welcome", label: "Welcome emails" },
  { key: "payments", label: "Sales and payments" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/* ---------- Stripe status bar (every tab) ---------- */

function StripeBar({ status, onSettings }: { status: StripeStatus | undefined; onSettings?: () => void }) {
  if (!status) return null;
  if (!status.connected) {
    return (
      <div className="banner banner-warn">
        <span>Connect Stripe before the checkout page can take payments</span>
        {onSettings ? <a href="#" onClick={(e) => (e.preventDefault(), onSettings())} style={{ fontSize: 13, color: "var(--warn-ink)" }}>Payments settings</a> : null}
      </div>
    );
  }
  if (!status.chargesEnabled) {
    return (
      <div className="banner banner-warn">
        <span>Stripe needs more details before the checkout page can take payments</span>
        {onSettings ? <a href="#" onClick={(e) => (e.preventDefault(), onSettings())} style={{ fontSize: 13, color: "var(--warn-ink)" }}>Payments settings</a> : null}
      </div>
    );
  }
  const payouts = status.bankLast4 ? `payouts to bank ending ${status.bankLast4}` : status.payoutsEnabled ? "payouts on" : "payouts not on yet";
  return (
    <div className="banner banner-ok">
      <span className="row gap-10">
        <span style={{ width: 10, height: 10, borderRadius: 5, background: "var(--brand)" }} />
        Stripe connected: {status.businessName || "your account"} · {payouts}
      </span>
      {onSettings ? <a href="#" onClick={(e) => (e.preventDefault(), onSettings())} style={{ fontSize: 13 }}>Payments settings</a> : null}
    </div>
  );
}

/* ---------- /admin/e/:eventId/registration ---------- */

export function RegistrationScreen() {
  const event = useAdminEvent();
  const { can } = useAdmin();
  const search = useSearch();
  const [location, navigate] = useLocation();
  const raw = new URLSearchParams(search).get("tab");
  const tab: Tab = TABS.some((t) => t.key === raw) ? (raw as Tab) : "tickets";
  const status = trpc.registration.stripe.forEvent.useQuery({ eventId: event.id });
  const canEdit = can("registration", "edit");
  const go = (t: Tab) => navigate(`${location}?tab=${t}`);
  const link = `${window.location.origin}/r/${event.slug}`;
  const title = TABS.find((t) => t.key === tab)!.label;
  if (!can("registration")) return <AdminPage title={title}><Empty>Your role does not include tickets and sales.</Empty></AdminPage>;
  return (
    <AdminPage
      title={title}
      actions={
        <>
          <a className="btn" href={`/r/${event.slug}`} target="_blank" rel="noreferrer">
            View checkout page
          </a>
          <CopyButton text={link} label="Copy link" className="btn btn-primary" />
        </>
      }
      banner={<StripeBar status={status.data} onSettings={tab === "payments" ? undefined : () => go("payments")} />}
    >
      <div className="col" style={{ gap: 0 }}>
        {tab === "welcome" ? <WelcomeTabsBar event={event} /> : null}
        {tab === "checkout" ? <CheckoutForTabs /> : null}
        <div className="folder-body">
          {tab === "tickets" ? <TicketsTab event={event} canEdit={canEdit} /> : null}
          {tab === "checkout" ? <CheckoutForBody canEdit={canEdit} attendees={<CheckoutTab event={event} canEdit={canEdit} />} /> : null}
          {tab === "welcome" ? <WelcomeTabBody event={event} attendees={<WelcomeTab event={event} canEdit={canEdit} />} /> : null}
          {tab === "payments" ? (
            status.isLoading ? (
              <PageLoading />
            ) : status.error ? (
              <ErrorNote error={status.error} />
            ) : (
              <PaymentsTab event={event} status={status.data!} canManage={status.data!.canManage} canEdit={canEdit} />
            )
          ) : null}
        </div>
      </div>
    </AdminPage>
  );
}

/* ---------- Tickets tab ---------- */

const TICKET_COLS = "minmax(0, 1.5fr) minmax(0, 1.2fr) 190px 110px 96px";
const COUPON_COLS = "minmax(0, 1fr) 120px 110px 150px 96px";

function eventDays(ev: AdminEvent) {
  return Math.round((Date.parse(`${ev.endDate}T12:00:00Z`) - Date.parse(`${ev.startDate}T12:00:00Z`)) / 86400_000) + 1;
}

function TicketsTab({ event, canEdit }: { event: AdminEvent; canEdit: boolean }) {
  const summary = trpc.registration.summary.useQuery({ eventId: event.id });
  const tickets = trpc.registration.tickets.list.useQuery({ eventId: event.id });
  const coupons = trpc.registration.coupons.list.useQuery({ eventId: event.id });
  const page = trpc.registration.checkout.get.useQuery({ eventId: event.id });
  const buyerTypes = page.data?.buyerTypes ?? [];
  const typeName = (id: string) => buyerTypes.find((b) => b.id === id)?.name ?? id;
  const earlyEnds = (tickets.data ?? []).filter((t) => t.active && t.phase === "early" && t.earlyEndsOn).map((t) => t.earlyEndsOn!).sort()[0];
  const [openTicket, setOpenTicket] = useState<number | "new" | null>(null);
  const [openCoupon, setOpenCoupon] = useState<number | "new" | null>(null);
  const s = summary.data;
  return (
    <>
      <NumStrip
        items={[
          { label: "Registered", value: s ? s.registered : "" },
          { label: "Capacity", value: s ? (s.capacity ?? "No limit") : "" },
          { label: "Revenue", value: s ? fmtMoney(s.revenueCents, "$0.00") : "" },
          ...(earlyEnds ? [{ label: "Early bird ends", value: fmtDate(earlyEnds), warn: true }] : []),
        ]}
      />

      <div className="card card-pad col gap-8">
        <div className="row-between">
          <span className="h3">Ticket types</span>
          {canEdit ? (
            <button className="btn btn-sm btn-w-lg" onClick={() => setOpenTicket("new")}>
              Add ticket
            </button>
          ) : null}
        </div>
        {tickets.isLoading ? (
          <PageLoading />
        ) : tickets.error ? (
          <ErrorNote error={tickets.error} />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 760 }}>
              <THead cols={TICKET_COLS} labels={["Ticket", "Who can buy", "Price today", "Sold", ""]} />
              {openTicket === "new" ? (
                <div className="editor" style={{ margin: "10px 0" }}>
                  <TicketEditor event={event} buyerTypes={buyerTypes} onDone={() => setOpenTicket(null)} />
                </div>
              ) : null}
              {!tickets.data!.length && openTicket !== "new" ? <Empty>No tickets yet. Click Add ticket.</Empty> : null}
              {tickets.data!.map((t) => (
                <ExpandRow
                  key={t.id}
                  cols={TICKET_COLS}
                  open={openTicket === t.id}
                  onToggle={() => setOpenTicket(openTicket === t.id ? null : t.id)}
                  closedLabel={canEdit ? "Edit" : "Details"}
                  cells={[
                    <span className="row gap-8 wrap">
                      <span className="strong">{t.name}</span>
                      {!t.active ? <Pill tone="gray">Off</Pill> : null}
                      {t.audience === "members" && !t.buyerTypes.length ? <Pill>Members only</Pill> : null}
                    </span>,
                    <span className="small">{t.buyerTypes.length ? t.buyerTypes.map(typeName).join(", ") : "Everyone"}</span>,
                    <span className="row gap-6 wrap">
                      {fmtMoney(t.todayCents, "$0.00")}
                      {t.phase !== "regular" ? <Pill tone={t.phase === "early" ? "orange" : "gray"}>{PHASE_LABEL[t.phase]}</Pill> : null}
                    </span>,
                    t.quantity ? `${t.sold} of ${t.quantity}` : String(t.sold),
                  ]}
                >
                  <TicketEditor event={event} ticket={t} buyerTypes={buyerTypes} readOnly={!canEdit} onDone={() => setOpenTicket(null)} />
                </ExpandRow>
              ))}
            </div>
          </div>
        )}
        {tickets.data?.some((t) => !t.active) ? <span className="small muted">Tickets marked Off do not show on the checkout page. Set a price and turn them on.</span> : null}
      </div>

      <BuyerTypesCard eventId={event.id} types={buyerTypes} canEdit={canEdit} />

      <div className="card card-pad col gap-8">
        <div className="row-between">
          <span className="h3">Coupons</span>
          {canEdit ? (
            <button className="btn btn-sm btn-w-lg" onClick={() => setOpenCoupon("new")}>
              Add coupon
            </button>
          ) : null}
        </div>
        {coupons.isLoading ? (
          <PageLoading />
        ) : coupons.error ? (
          <ErrorNote error={coupons.error} />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 760 }}>
              {openCoupon === "new" ? (
                <div className="editor" style={{ margin: "10px 0" }}>
                  <CouponEditor eventId={event.id} onDone={() => setOpenCoupon(null)} />
                </div>
              ) : null}
              {!coupons.data!.length && openCoupon !== "new" ? <Empty>No coupons yet.</Empty> : null}
              {coupons.data!.map((c) => (
                <ExpandRow
                  key={c.id}
                  cols={COUPON_COLS}
                  open={openCoupon === c.id}
                  onToggle={() => setOpenCoupon(openCoupon === c.id ? null : c.id)}
                  closedLabel={canEdit ? "Edit" : "Details"}
                  cells={[
                    <span className="row gap-8">
                      <span className="strong">{c.code}</span>
                      {!c.active ? <Pill tone="gray">Off</Pill> : null}
                    </span>,
                    c.percentOff ? `${c.percentOff}% off` : `${fmtMoney(c.amountOffCents)} off`,
                    c.maxUses ? `Used ${c.used} of ${c.maxUses}` : `Used ${c.used}`,
                    c.endsOn ? `Ends ${fmtDate(c.endsOn)}` : "No end date",
                  ]}
                >
                  <CouponEditor eventId={event.id} coupon={c} readOnly={!canEdit} onDone={() => setOpenCoupon(null)} />
                </ExpandRow>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

type BuyerTypeRow = { id: string; name: string; memberId: boolean; school: boolean; code: string };
type PriceInputs = { early: string; regular: string; late: string };

/** "Who is registering?" choices on the checkout page: read view with Edit. */
function BuyerTypesCard({ eventId, types, canEdit }: { eventId: number; types: BuyerTypeRow[]; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const save = trpc.registration.buyerTypes.save.useMutation();
  const [rows, setRows] = useState<BuyerTypeRow[] | null>(null);
  const list = rows ?? types;
  const setRow = (i: number, patch: Partial<BuyerTypeRow>) => setRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const asks = (b: BuyerTypeRow) => [b.memberId ? "Asks for a member ID" : "", b.school ? "Asks for school" : "", b.code ? "Needs a code from the event team" : ""].filter(Boolean).join(" · ");
  const view = types.length ? (
    <div className="col">
      {types.map((b) => (
        <div key={b.id} className="row gap-10" style={{ padding: "9px 0", borderBottom: "1px solid var(--line-2)" }}>
          <span className="strong">{b.name}</span>
          <span className="small muted grow">{asks(b)}</span>
          {b.memberId ? <Pill>Asks ID</Pill> : null}
          {b.code ? <Pill tone="orange">Code</Pill> : null}
        </div>
      ))}
    </div>
  ) : (
    <span className="muted">The checkout page does not ask who is registering. Every ticket shows to everyone.</span>
  );
  if (!canEdit) {
    return (
      <div className="card card-pad col gap-8">
        <span className="h3">Who is registering (buyer choices)</span>
        {view}
      </div>
    );
  }
  return (
    <div className="card card-pad">
      <EditSection
        title="Who is registering (buyer choices)"
        saving={save.isPending}
        onCancel={() => setRows(null)}
        onSave={async () => {
          await save.mutateAsync({ eventId, list: list.filter((r) => r.name.trim()) });
          setRows(null);
          await Promise.all([utils.registration.checkout.get.invalidate(), utils.registration.tickets.list.invalidate(), utils.registration.page.invalidate()]);
          toast("Saved");
        }}
        view={view}
        edit={
          <div className="col gap-8">
            {list.map((b, i) => (
              <div key={i} className="row gap-10 wrap" style={{ alignItems: "flex-end" }}>
                <Field label="Name">
                  <input className="input" value={b.name} onChange={(e) => setRow(i, { name: e.target.value })} placeholder="Member" />
                </Field>
                <label className="check"><input type="checkbox" checked={b.memberId} onChange={(e) => setRow(i, { memberId: e.target.checked })} />Asks for a member ID</label>
                <label className="check"><input type="checkbox" checked={b.school} onChange={(e) => setRow(i, { school: e.target.checked })} />Asks for school</label>
                <Field label="Code (optional)">
                  <input className="input" value={b.code} onChange={(e) => setRow(i, { code: e.target.value })} placeholder="SPEAKER27" />
                </Field>
                <button type="button" className="btn btn-sm btn-w" onClick={() => setRows(list.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <div>
              <button type="button" className="btn btn-sm btn-w" onClick={() => setRows([...list, { id: "", name: "", memberId: false, school: false, code: "" }])}>Add choice</button>
            </div>
            <span className="small muted">Buyers pick one of these first, then see only the tickets and prices for that choice. A code keeps a choice (like Speaker) to people the event team gives it to.</span>
          </div>
        }
      />
    </div>
  );
}

const moneyIn = (c: number | null | undefined) => (c == null ? "" : centsToInput(c));

function TicketEditor({ event, ticket, buyerTypes, readOnly, onDone }: { event: AdminEvent; ticket?: Ticket; buyerTypes: BuyerTypeRow[]; readOnly?: boolean; onDone: () => void }) {
  const utils = trpc.useUtils();
  const save = trpc.registration.tickets.save.useMutation();
  const remove = trpc.registration.tickets.remove.useMutation();
  const days = eventDays(event);
  const allDays = days > 1 ? `All ${days} days` : "All days";
  const base: PriceInputs = { early: moneyIn(ticket?.earlyPriceCents), regular: moneyIn(ticket?.priceCents), late: moneyIn(ticket?.latePriceCents) };
  const [f, setF] = useState({
    name: ticket?.name ?? "",
    description: ticket?.description ?? "",
    quantity: ticket?.quantity ? String(ticket.quantity) : "",
    saleEndsOn: ticket?.saleEndsOn ?? "",
    includes: ticket?.includes ?? allDays,
    audience: ticket?.audience ?? "anyone",
    ribbon: ticket?.ribbon ?? "",
    active: ticket?.active ?? true,
    early: !!ticket?.earlyEndsOn,
    earlyEndsOn: ticket?.earlyEndsOn ?? "",
    late: !!ticket?.lateStartsOn,
    lateStartsOn: ticket?.lateStartsOn ?? "",
    who: ticket?.buyerTypes ?? ([] as string[]),
  });
  const [prices, setPrices] = useState<Record<string, PriceInputs>>(() => {
    const out: Record<string, PriceInputs> = { "": base };
    for (const b of buyerTypes) {
      const own = ticket?.buyerPrices?.[b.id];
      out[b.id] = own ? { early: moneyIn(own.early), regular: moneyIn(own.regular), late: moneyIn(own.late) } : { ...base };
    }
    return out;
  });
  const set = (k: "name" | "description" | "quantity" | "saleEndsOn" | "includes" | "audience" | "ribbon" | "earlyEndsOn" | "lateStartsOn") => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const includeOptions = Array.from(new Set([allDays, "One day", "Workshop only", f.includes]));
  const cols = f.who.length ? buyerTypes.filter((b) => f.who.includes(b.id)).map((b) => ({ key: b.id, label: b.name })) : [{ key: "", label: "Price" }];
  const setPrice = (key: string, phase: keyof PriceInputs, v: string) => setPrices({ ...prices, [key]: { ...(prices[key] ?? base), [phase]: v } });
  const today = ticket?.today ?? new Date().toISOString().slice(0, 10);

  // What a buyer of each column sees today, worked out the same way the checkout page does.
  const preview = cols.map((c) => {
    const p = prices[c.key] ?? base;
    const reg = parseMoney(p.regular);
    if (reg === null || Number.isNaN(reg)) return null;
    const e = f.early ? parseMoney(p.early) : null;
    const l = f.late ? parseMoney(p.late) : null;
    const v = priceView({ earlyEndsOn: f.early ? f.earlyEndsOn || null : null, lateStartsOn: f.late ? f.lateStartsOn || null : null }, { early: e != null && !Number.isNaN(e) ? e : null, regular: reg, late: l != null && !Number.isNaN(l) ? l : null }, today);
    const label = f.who.length ? `${c.label}: ` : "";
    return `${label}${fmtMoney(v.cents, "$0.00")}${v.saveCents > 0 ? `, crossed out ${fmtMoney(v.regularCents)}, "Early bird · save ${fmtMoney(v.saveCents)}"` : v.phase === "late" ? " (late price)" : ""}`;
  });

  async function submit() {
    const quantity = f.quantity.trim() ? Number(f.quantity) : null;
    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1)) return toast("Quantity is a whole number, or leave it blank for no limit.", true);
    if (f.early && !f.earlyEndsOn) return toast("Pick the date early bird ends.", true);
    if (f.late && !f.lateStartsOn) return toast("Pick the date late pricing starts.", true);
    const sets: Record<string, PriceSet> = {};
    for (const c of cols) {
      const p = prices[c.key] ?? base;
      const reg = parseMoney(p.regular);
      if (reg === null || Number.isNaN(reg)) return toast(`Enter the regular price${f.who.length ? ` for ${c.label}` : ""}, like 249.00.`, true);
      const e = f.early ? parseMoney(p.early) : null;
      const l = f.late ? parseMoney(p.late) : null;
      if (f.early && (e === null || Number.isNaN(e))) return toast(`Enter the early bird price${f.who.length ? ` for ${c.label}` : ""}.`, true);
      if (f.late && (l === null || Number.isNaN(l))) return toast(`Enter the late price${f.who.length ? ` for ${c.label}` : ""}.`, true);
      sets[c.key] = { early: f.early ? e : null, regular: reg, late: f.late ? l : null };
    }
    const first = sets[cols[0].key];
    try {
      await save.mutateAsync({
        eventId: event.id,
        id: ticket?.id,
        name: f.name,
        description: f.description,
        priceCents: first.regular,
        earlyPriceCents: first.early,
        latePriceCents: first.late,
        earlyEndsOn: f.early ? f.earlyEndsOn : null,
        lateStartsOn: f.late ? f.lateStartsOn : null,
        buyerTypes: f.who,
        buyerPrices: f.who.length ? sets : {},
        quantity,
        saleEndsOn: f.saleEndsOn || null,
        afterSale: "close",
        switchToTicketId: null,
        includes: f.includes,
        audience: f.audience as "anyone" | "members",
        ribbon: f.ribbon,
        active: f.active,
        sort: ticket?.sort ?? 0,
      });
      await Promise.all([utils.registration.tickets.list.invalidate(), utils.registration.summary.invalidate()]);
      toast("Ticket saved");
      onDone();
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  const phaseRow = (phase: keyof PriceInputs, label: string, on: boolean, toggle: ((v: boolean) => void) | null, date: ReactNode) => (
    <div className="price-row" style={{ gridTemplateColumns: `150px repeat(${cols.length}, minmax(0, 1fr)) 210px`, opacity: on ? 1 : 0.6 }}>
      <span className="row gap-8 strong">
        {toggle ? <input type="checkbox" checked={on} aria-label={`Use ${label} pricing`} onChange={(e) => toggle(e.target.checked)} /> : null}
        {label}
      </span>
      {cols.map((c) => (
        <input key={c.key} className="input" inputMode="decimal" aria-label={`${label} price${f.who.length ? ` for ${c.label}` : ""}`} disabled={!on} value={(prices[c.key] ?? base)[phase]} onChange={(e) => setPrice(c.key, phase, e.target.value)} placeholder="0.00" />
      ))}
      <span>{date}</span>
    </div>
  );

  return (
    <>
      <div className="editor-title">{ticket ? (readOnly ? ticket.name : "Editing ticket") : "New ticket"}</div>
      <fieldset disabled={readOnly} style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "10px 14px" }}>
          <Field label="Ticket name" className="span-2">
            <input className="input" value={f.name} onChange={set("name")} placeholder="Conference only" />
          </Field>
          <Field label="Includes">
            <select className="select" value={f.includes} onChange={set("includes")}>
              {includeOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field label="How many">
            <input className="input" inputMode="numeric" value={f.quantity} onChange={set("quantity")} placeholder="No limit" />
          </Field>
          <Field label="On sale">
            <select className="select" value={f.active ? "on" : "off"} onChange={(e) => setF({ ...f, active: e.target.value === "on" })}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </Field>
          <Field label="Details (buyers tap Details)" className="span-all">
            <textarea className="textarea" rows={2} value={f.description} onChange={set("description")} placeholder="What the ticket includes" />
          </Field>
          <Field label="Badge ribbon">
            <input className="input" value={f.ribbon} onChange={set("ribbon")} placeholder="Student" />
          </Field>
          <Field label="Stop selling after">
            <input className="input" type="date" value={f.saleEndsOn} onChange={set("saleEndsOn")} />
          </Field>
          {!buyerTypes.length ? (
            <Field label="Who can buy it">
              <select className="select" value={f.audience} onChange={set("audience")}>
                <option value="anyone">Anyone</option>
                <option value="members">Members only (asks for member ID)</option>
              </select>
            </Field>
          ) : null}
        </div>
        {buyerTypes.length ? (
          <div className="col gap-6">
            <span className="label-caps">Who can buy it</span>
            <div className="row gap-8 wrap">
              {buyerTypes.map((b) => {
                const on = f.who.includes(b.id);
                return (
                  <label key={b.id} className={`chip-check${on ? " on" : ""}`}>
                    <input type="checkbox" checked={on} onChange={(e) => setF({ ...f, who: e.target.checked ? [...f.who, b.id] : f.who.filter((x) => x !== b.id) })} />
                    {b.name}
                  </label>
                );
              })}
            </div>
            {!f.who.length ? <span className="small muted">None picked: everyone can buy it at the same price.</span> : null}
          </div>
        ) : null}
        <div className="col gap-6">
          <span className="label-caps">Price by date</span>
          <div className="price-row price-head" style={{ gridTemplateColumns: `150px repeat(${cols.length}, minmax(0, 1fr)) 210px` }}>
            <span />
            {cols.map((c) => (
              <span key={c.key}>{c.label}</span>
            ))}
            <span>Dates</span>
          </div>
          {phaseRow("early", "Early bird", f.early, (v) => setF({ ...f, early: v }), f.early ? (
            <label className="row gap-6 small">Ends <input className="input" type="date" value={f.earlyEndsOn} onChange={set("earlyEndsOn")} /></label>
          ) : <span className="small muted">Off</span>)}
          {phaseRow("regular", "Regular", true, null, (
            <span className="small muted">
              {f.early && f.earlyEndsOn ? `From ${fmtDate(addDays(f.earlyEndsOn, 1))}` : "From now"}
              {f.late && f.lateStartsOn ? ` to ${fmtDate(addDays(f.lateStartsOn, -1))}` : ""}
            </span>
          ))}
          {phaseRow("late", "Late", f.late, (v) => setF({ ...f, late: v }), f.late ? (
            <label className="row gap-6 small">Starts <input className="input" type="date" value={f.lateStartsOn} onChange={set("lateStartsOn")} /></label>
          ) : <span className="small muted">Off</span>)}
        </div>
        <div className="price-preview">
          <b>What buyers see today ({fmtDate(today)})</b>
          {preview.filter(Boolean).map((line, i) => (
            <span key={i}>{line}</span>
          ))}
          {f.early && f.earlyEndsOn ? <span>On {fmtDate(addDays(f.earlyEndsOn, 1))} the price moves to Regular by itself. Nothing to switch by hand.</span> : null}
        </div>
      </fieldset>
      {!readOnly ? (
        <div className="row gap-10">
          <button className="btn btn-sm btn-solid btn-w" disabled={save.isPending} onClick={submit}>
            Save
          </button>
          <button className="btn btn-sm btn-w" onClick={onDone}>
            Cancel
          </button>
          {ticket && ticket.sold === 0 ? (
            <button
              className="btn btn-sm btn-w btn-danger"
              style={{ marginLeft: "auto" }}
              disabled={remove.isPending}
              onClick={async () => {
                if (!confirmAction(`Delete the ${ticket.name} ticket?`)) return;
                try {
                  await remove.mutateAsync({ eventId: event.id, id: ticket.id });
                  await utils.registration.tickets.list.invalidate();
                  onDone();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function CouponEditor({ eventId, coupon, readOnly, onDone }: { eventId: number; coupon?: Coupon; readOnly?: boolean; onDone: () => void }) {
  const utils = trpc.useUtils();
  const save = trpc.registration.coupons.save.useMutation();
  const remove = trpc.registration.coupons.remove.useMutation();
  const [f, setF] = useState({
    code: coupon?.code ?? "",
    kind: coupon?.amountOffCents ? "amount" : "percent",
    value: coupon?.amountOffCents ? centsToInput(coupon.amountOffCents) : coupon?.percentOff ? String(coupon.percentOff) : "",
    maxUses: coupon?.maxUses ? String(coupon.maxUses) : "",
    endsOn: coupon?.endsOn ?? "",
    active: coupon?.active ?? true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit() {
    let percentOff: number | null = null;
    let amountOffCents: number | null = null;
    if (f.kind === "percent") {
      percentOff = Number(f.value);
      if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) return toast("Percent off is a whole number from 1 to 100.", true);
    } else {
      amountOffCents = parseMoney(f.value);
      if (!amountOffCents || Number.isNaN(amountOffCents)) return toast("Enter the amount off, like 50.00.", true);
    }
    const maxUses = f.maxUses.trim() ? Number(f.maxUses) : null;
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) return toast("Max uses is a whole number, or leave it blank.", true);
    try {
      await save.mutateAsync({ eventId, id: coupon?.id, code: f.code, percentOff, amountOffCents, maxUses, endsOn: f.endsOn || null, active: f.active });
      await utils.registration.coupons.list.invalidate();
      toast("Coupon saved");
      onDone();
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  return (
    <>
      <div className="editor-title">{coupon ? (readOnly ? coupon.code : "Editing coupon") : "New coupon"}</div>
      <fieldset disabled={readOnly} style={{ border: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "10px 14px" }}>
        <Field label="Code">
          <input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="SPEAKER27" />
        </Field>
        <Field label="Discount">
          <select className="select" value={f.kind} onChange={set("kind")}>
            <option value="percent">Percent off</option>
            <option value="amount">Amount off</option>
          </select>
        </Field>
        <Field label={f.kind === "percent" ? "Percent" : "Amount"}>
          <input className="input" inputMode="decimal" value={f.value} onChange={set("value")} placeholder={f.kind === "percent" ? "10" : "50.00"} />
        </Field>
        <Field label="Max uses">
          <input className="input" inputMode="numeric" value={f.maxUses} onChange={set("maxUses")} placeholder="No limit" />
        </Field>
        <Field label="Ends">
          <input className="input" type="date" value={f.endsOn} onChange={set("endsOn")} />
        </Field>
        <label className="check span-all">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          Coupon is on
        </label>
      </fieldset>
      {!readOnly ? (
        <div className="row gap-10">
          <button className="btn btn-sm btn-solid btn-w" disabled={save.isPending} onClick={submit}>
            Save
          </button>
          <button className="btn btn-sm btn-w" onClick={onDone}>
            Cancel
          </button>
          {coupon && coupon.used === 0 ? (
            <button
              className="btn btn-sm btn-w btn-danger"
              style={{ marginLeft: "auto" }}
              disabled={remove.isPending}
              onClick={async () => {
                if (!confirmAction(`Delete the coupon ${coupon.code}?`)) return;
                try {
                  await remove.mutateAsync({ eventId, id: coupon.id });
                  await utils.registration.coupons.list.invalidate();
                  onDone();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/* ---------- Checkout page tab ---------- */

const PRESET_QUESTIONS: Question[] = [
  { key: "mobile", label: "Mobile number", kind: "phone", required: true },
  { key: "credentials", label: "Credentials", kind: "text", required: false },
  { key: "license", label: "License number and state (for CE)", kind: "license", required: true },
  { key: "dietary", label: "Dietary needs", kind: "text", required: false },
  { key: "accessibility", label: "Accessibility needs", kind: "textarea", required: false },
  { key: "organization", label: "Organization", kind: "text", required: false },
  { key: "job_title", label: "Job title", kind: "text", required: false },
];

type PageDraft = {
  coverFileId: number | null;
  coverUrl: string | null;
  headline: string;
  description: string;
  buttonLabel: string;
  pick: boolean;
  ticketIds: number[];
  questions: Question[];
  showConfirmation: boolean;
  sendWelcome: boolean;
  tagOn: boolean;
  platformTag: string;
  embedStyle: "inline" | "popup";
  payOverTime: boolean;
};

function CheckoutTab({ event, canEdit }: { event: AdminEvent; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const page = trpc.registration.checkout.get.useQuery({ eventId: event.id });
  const tickets = trpc.registration.tickets.list.useQuery({ eventId: event.id });
  const save = trpc.registration.checkout.save.useMutation();
  const [draft, setDraft] = useState<PageDraft | null>(null);
  const [embedStyle, setEmbedStyle] = useState<"inline" | "popup" | null>(null);
  if (page.isLoading || tickets.isLoading) return <PageLoading />;
  if (page.error) return <ErrorNote error={page.error} />;
  if (tickets.error) return <ErrorNote error={tickets.error} />;
  const p = page.data!;
  const all = tickets.data!;
  const saved: PageDraft = {
    coverFileId: p.coverFileId,
    coverUrl: p.coverUrl,
    headline: p.headline,
    description: p.description,
    buttonLabel: p.buttonLabel,
    pick: p.ticketIds.length > 0,
    ticketIds: p.ticketIds,
    questions: p.questions,
    showConfirmation: p.showConfirmation,
    sendWelcome: p.sendWelcome,
    tagOn: !!p.platformTag,
    platformTag: p.platformTag,
    embedStyle: p.embedStyle,
    payOverTime: p.payOverTime,
  };
  const d = draft ?? saved;
  const set = (patch: Partial<PageDraft>) => setDraft({ ...d, ...patch });
  const defaultTag = `${event.shortName || event.name} registered`;
  const ticketNames = (ids: number[]) => all.filter((t) => ids.includes(t.id)).map((t) => t.name).join(", ");
  const style = embedStyle ?? p.embedStyle;
  const origin = window.location.origin;
  const code =
    style === "popup"
      ? `<div id="leaddash-checkout"></div>\n<script src="${origin}/embed.js" data-event="${event.slug}" data-style="popup" data-label="${d.buttonLabel.replace(/"/g, "")}" data-color="${event.branding.colorAccent}"></script>`
      : `<div id="leaddash-checkout"></div>\n<script src="${origin}/embed.js" data-event="${event.slug}"></script>`;

  const view = (
    <div>
      <KV label="Cover image">{p.coverUrl ? <img src={p.coverUrl} alt="Cover" style={{ height: 56, borderRadius: 6, display: "block" }} /> : null}</KV>
      <KV label="Headline">{p.headline}</KV>
      <KV label="Short description">{p.description ? <span style={{ whiteSpace: "pre-line" }}>{p.description}</span> : null}</KV>
      <KV label="Button label">{p.buttonLabel}</KV>
      <KV label="Tickets on the page">{p.ticketIds.length ? ticketNames(p.ticketIds) : "Every ticket that is on sale"}</KV>
      <KV label="Questions at sign-up">{p.questions.map((q) => `${q.label}${q.required ? "" : " (optional)"}`).join(", ")}</KV>
      <KV label="Pay over time">{p.payOverTime ? "Klarna and Afterpay offered when they are on in Stripe" : "Not offered"}</KV>
      <KV label="After payment">
        {[p.showConfirmation ? "Confirmation page with Get the app" : "", p.sendWelcome ? "Welcome email" : "", p.platformTag ? `LeadDash platform tag "${p.platformTag}"` : ""].filter(Boolean).join(", ") || "Nothing"}
      </KV>
    </div>
  );

  const edit = (
    <div className="col gap-16">
      <div className="col gap-6">
        <span className="field">Cover image</span>
        <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0, 1fr)", gap: 14, alignItems: "center" }}>
          <div role="img" aria-label="Current cover image" className="cover" style={{ height: 110, borderRadius: 8, ...(d.coverUrl ? { backgroundImage: `url(${d.coverUrl})` } : {}) }} />
          <div className="col gap-8">
            <div className="row gap-8">
              <UploadButton label={d.coverUrl ? "Replace" : "Upload"} accept="image/png,image/jpeg,image/webp" eventId={event.id} onUploaded={(f) => set({ coverFileId: f.id, coverUrl: f.url })} />
              {d.coverUrl ? (
                <button type="button" className="btn btn-sm btn-w" onClick={() => set({ coverFileId: null, coverUrl: null })}>
                  Remove
                </button>
              ) : null}
            </div>
            <span className="small muted">JPG or PNG, 1600 x 900 or larger</span>
          </div>
        </div>
      </div>
      <div className="grid-2" style={{ gap: "12px 16px" }}>
        <Field label="Headline" className="span-2">
          <input className="input" value={d.headline} onChange={(e) => set({ headline: e.target.value })} />
        </Field>
        <Field label="Short description" className="span-2">
          <textarea className="textarea" rows={3} value={d.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label="Button label">
          <input className="input" maxLength={30} value={d.buttonLabel} onChange={(e) => set({ buttonLabel: e.target.value })} />
        </Field>
        <Field label="Tickets on the page">
          <select className="select" value={d.pick ? "pick" : "all"} onChange={(e) => set({ pick: e.target.value === "pick", ticketIds: e.target.value === "pick" ? d.ticketIds : [] })}>
            <option value="all">All {all.length} ticket types</option>
            <option value="pick">Pick ticket types</option>
          </select>
        </Field>
        {d.pick ? (
          <div className="span-2 row wrap gap-16">
            {all.map((t) => (
              <label key={t.id} className="check">
                <input type="checkbox" checked={d.ticketIds.includes(t.id)} onChange={(e) => set({ ticketIds: e.target.checked ? [...d.ticketIds, t.id] : d.ticketIds.filter((id) => id !== t.id) })} />
                {t.name}
              </label>
            ))}
          </div>
        ) : null}
      </div>
      <QuestionsEditor questions={d.questions} onChange={(questions) => set({ questions })} />
      <div className="col gap-8" style={{ fontSize: 13 }}>
        <span className="field">Pay over time</span>
        <label className="check">
          <input type="checkbox" checked={d.payOverTime} onChange={(e) => set({ payOverTime: e.target.checked })} />
          Offer Klarna and Afterpay at checkout
        </label>
      </div>
      <div className="col gap-8" style={{ fontSize: 13 }}>
        <span className="field">After payment</span>
        <label className="check">
          <input type="checkbox" checked={d.showConfirmation} onChange={(e) => set({ showConfirmation: e.target.checked })} />
          Show the confirmation page with the Get the app button
        </label>
        <label className="check">
          <input type="checkbox" checked={d.sendWelcome} onChange={(e) => set({ sendWelcome: e.target.checked })} />
          Send the welcome email
        </label>
        <label className="check">
          <input type="checkbox" checked={d.tagOn} onChange={(e) => set({ tagOn: e.target.checked, platformTag: e.target.checked ? d.platformTag || defaultTag : d.platformTag })} />
          Add the person to the LeadDash platform with the tag "{d.platformTag || defaultTag}"
        </label>
        {d.tagOn ? (
          <Field label="Tag" className="" hint="Contacts go to the organization's LeadDash platform account.">
            <input className="input" style={{ maxWidth: 320 }} maxLength={60} value={d.platformTag} onChange={(e) => set({ platformTag: e.target.value })} />
          </Field>
        ) : null}
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div className="col" style={{ flex: "1 1 520px", minWidth: 0, gap: 18 }}>
        {canEdit ? (
          <EditSection
            title="Page"
            view={view}
            edit={edit}
            saving={save.isPending}
            onCancel={() => setDraft(null)}
            onSave={async () => {
              if (!d.buttonLabel.trim()) throw new Error("Add a button label.");
              await save.mutateAsync({
                eventId: event.id,
                coverFileId: d.coverFileId,
                headline: d.headline,
                description: d.description,
                buttonLabel: d.buttonLabel,
                ticketIds: d.pick ? d.ticketIds : [],
                questions: d.questions,
                showConfirmation: d.showConfirmation,
                sendWelcome: d.sendWelcome,
                platformTag: d.tagOn ? d.platformTag.trim() : "",
                embedStyle: d.embedStyle,
                payOverTime: d.payOverTime,
              });
              await Promise.all([utils.registration.checkout.get.invalidate(), utils.registration.page.invalidate()]);
              setDraft(null);
              toast("Checkout page saved");
            }}
          />
        ) : (
          <section className="col gap-12">
            <span className="h3" style={{ fontSize: 14 }}>Page</span>
            {view}
          </section>
        )}
        <div className="col gap-12" style={{ borderTop: "1px solid var(--line)", paddingTop: 18 }}>
          <span className="h3" style={{ fontSize: 14 }}>Share</span>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 96px", gap: 10, alignItems: "end" }}>
            <Field label="Direct link">
              <input className="input" readOnly value={p.link} />
            </Field>
            <CopyButton text={p.link} />
          </div>
          <div className="col gap-6">
            <span className="field">Embed on your website</span>
            <div role="radiogroup" aria-label="Embed style" className="row wrap" style={{ gap: 18, fontSize: 13 }}>
              <label className="check">
                <input type="radio" name="embed-style" checked={style === "inline"} onChange={() => setEmbedStyle("inline")} />
                Checkout form on the page
              </label>
              <label className="check">
                <input type="radio" name="embed-style" checked={style === "popup"} onChange={() => setEmbedStyle("popup")} />
                Register button that opens a popup
              </label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 96px", gap: 10, alignItems: "start" }}>
              <pre className="code-box">{code}</pre>
              <CopyButton text={code} label="Copy code" />
            </div>
            <span className="small muted">Paste into a custom code block on any website or LeadDash platform page.</span>
          </div>
        </div>
      </div>
      <div className="col gap-8" style={{ flex: "0 0 300px", maxWidth: "100%" }}>
        <span className="field">Preview</span>
        <CheckoutPreview event={event} d={d} tickets={onSaleNow(all, d.pick ? d.ticketIds : [])} />
      </div>
    </div>
  );
}

function QuestionsEditor({ questions, onChange }: { questions: Question[]; onChange: (q: Question[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const [custom, setCustom] = useState({ label: "", kind: "text" as Question["kind"], options: "" });
  const missing = PRESET_QUESTIONS.filter((p) => !questions.some((q) => q.key === p.key));
  const choice = pick || missing[0]?.key || "custom";

  function add() {
    if (choice !== "custom") {
      const preset = PRESET_QUESTIONS.find((p) => p.key === choice);
      if (preset) onChange([...questions, preset]);
    } else {
      const label = custom.label.trim();
      if (!label) return toast("Write the question.", true);
      let key = `q_${slugify(label).replace(/-/g, "_").slice(0, 30) || "custom"}`;
      while (questions.some((q) => q.key === key)) key = `${key.slice(0, 36)}_${Math.floor(Math.random() * 90 + 10)}`;
      const options = custom.options.split(",").map((o) => o.trim()).filter(Boolean);
      if (custom.kind === "select" && options.length < 2) return toast("List at least two choices, separated by commas.", true);
      onChange([...questions, { key, label, kind: custom.kind, required: false, ...(custom.kind === "select" ? { options } : {}) }]);
    }
    setAdding(false);
    setPick("");
    setCustom({ label: "", kind: "text", options: "" });
  }

  return (
    <div className="col gap-4">
      <div className="row-between">
        <span className="field">Questions at sign-up</span>
        <button type="button" className="btn btn-xs btn-w-lg" onClick={() => setAdding(true)}>
          Add question
        </button>
      </div>
      {questions.map((q, i) => (
        <div key={q.key} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 110px 96px", gap: 10, alignItems: "center", fontSize: 13, padding: "6px 0", borderBottom: "1px solid var(--line-2)" }}>
          <span className="strong" style={{ fontWeight: 600 }}>
            {q.label}
            {q.kind === "select" && q.options?.length ? <span className="muted" style={{ fontWeight: 500 }}> ({q.options.join(", ")})</span> : null}
          </span>
          <label className="check" style={{ fontSize: 12, color: "var(--muted)" }}>
            <input type="checkbox" checked={q.locked ? true : q.required} disabled={q.locked} onChange={(e) => onChange(questions.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
            Required
          </label>
          {q.locked ? (
            <span className="small muted">Always asked</span>
          ) : (
            <button type="button" className="btn btn-xs btn-w" onClick={() => onChange(questions.filter((_, j) => j !== i))}>
              Remove
            </button>
          )}
        </div>
      ))}
      {adding ? (
        <div className="row wrap gap-10" style={{ paddingTop: 8, alignItems: "flex-end" }}>
          <Field label="Question">
            <select className="select" value={choice} onChange={(e) => setPick(e.target.value)}>
              {missing.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Your own question</option>
            </select>
          </Field>
          {choice === "custom" ? (
            <>
              <Field label="Question text">
                <input className="input" style={{ width: 220 }} value={custom.label} onChange={(e) => setCustom({ ...custom, label: e.target.value })} />
              </Field>
              <Field label="Answer">
                <select className="select" value={custom.kind} onChange={(e) => setCustom({ ...custom, kind: e.target.value as Question["kind"] })}>
                  <option value="text">Short answer</option>
                  <option value="textarea">Long answer</option>
                  <option value="select">Pick from a list</option>
                </select>
              </Field>
              {custom.kind === "select" ? (
                <Field label="Choices (commas between)">
                  <input className="input" style={{ width: 220 }} value={custom.options} onChange={(e) => setCustom({ ...custom, options: e.target.value })} />
                </Field>
              ) : null}
            </>
          ) : null}
          <button type="button" className="btn btn-sm btn-solid btn-w" onClick={add}>
            Add
          </button>
          <button type="button" className="btn btn-sm btn-w" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The tickets a buyer sees today, by the same rules as the public page (sale end, switch to another ticket). */
function onSaleNow(all: Ticket[], onlyIds: number[]) {
  const today = new Date().toLocaleDateString("en-CA");
  const pool = onlyIds.length ? all.filter((t) => onlyIds.includes(t.id)) : all;
  const ended = (t: Ticket) => !!t.saleEndsOn && t.saleEndsOn < today;
  const waiting = new Set<number>();
  const switched = new Set<number>();
  for (const t of pool) {
    if (!t.active || t.afterSale !== "switch" || !t.switchToTicketId) continue;
    (ended(t) ? switched : waiting).add(t.switchToTicketId);
  }
  return all.filter((t) => (pool.includes(t) || switched.has(t.id)) && !ended(t) && !waiting.has(t.id) && (t.active || switched.has(t.id)));
}

function CheckoutPreview({ event, d, tickets }: { event: AdminEvent; d: PageDraft; tickets: Ticket[] }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden", background: "var(--ground)", ["--brand" as string]: event.branding.colorPrimary, ["--accent" as string]: event.branding.colorAccent }}>
      <div role="img" aria-label="Cover image preview" className="cover" style={{ height: 130, ...(d.coverUrl ? { backgroundImage: `url(${d.coverUrl})` } : {}) }} />
      <div className="col gap-8" style={{ padding: 14 }}>
        <span style={{ fontSize: 16, fontWeight: 800 }}>{d.headline || event.name}</span>
        <span className="small muted">
          {fmtDates(event.startDate, event.endDate)}
          {event.venueName ? ` · ${event.venueName}` : ""}
        </span>
        {d.description ? <span className="small" style={{ lineHeight: 1.5, whiteSpace: "pre-line" }}>{d.description}</span> : null}
        <div className="col gap-6" style={{ paddingTop: 4 }}>
          {tickets.length ? (
            tickets.map((t) => (
              <div key={t.id} className="row-between small" style={{ background: "#FFFFFF", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px" }}>
                <span className="strong">{t.name}</span>
                <span className="xstrong">{fmtMoney(t.priceCents)}</span>
              </div>
            ))
          ) : (
            <span className="small muted">No tickets on sale yet.</span>
          )}
        </div>
        <div className="center" style={{ height: 38, borderRadius: 10, background: "var(--accent)", color: "var(--accent-ink)", fontSize: 13, fontWeight: 800 }}>
          {d.buttonLabel || "Register"}
        </div>
      </div>
    </div>
  );
}

/* ---------- Welcome email tab ---------- */

type MsgDraft = Pick<Template, "kind" | "enabled" | "sendRule" | "onlyIfNoApp" | "fromName" | "replyTo" | "subject" | "body"> & { includes: Template["includes"] };

const toDraft = (t: Template): MsgDraft => ({ kind: t.kind, enabled: t.enabled, sendRule: t.sendRule, onlyIfNoApp: t.onlyIfNoApp, fromName: t.fromName, replyTo: t.replyTo, subject: t.subject, body: t.body, includes: { ...t.includes, hotelUrl: t.includes.hotelUrl ?? "" } });

const FIELDS = [
  { label: "First name", token: "{{first name}}" },
  { label: "Ticket name", token: "{{ticket name}}" },
  { label: "Amount paid", token: "{{amount paid}}" },
  { label: "Event dates", token: "{{event dates}}" },
  { label: "Venue", token: "{{venue}}" },
  { label: "App link", token: "{{app link}}" },
];

function ruleLabel(rule: string, onlyIfNoApp: boolean) {
  const tail = onlyIfNoApp ? ", if no app yet" : "";
  if (rule === "after_payment") return `Right after payment${tail}`;
  if (rule === "after_payment_1h") return `1 hour after payment${tail}`;
  const days = rule.match(/^days_before:(\d+)$/);
  if (days) return `${days[1]} day${days[1] === "1" ? "" : "s"} before${tail}`;
  const at = rule.match(/^at:(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  if (at) return `${fmtDate(at[1])}, ${fmtTime(at[2])}${tail}`;
  return rule;
}

function includesList(inc: Template["includes"]) {
  return [inc.receipt ? "Ticket and receipt summary" : "", inc.getApp ? "Get the app button" : "", inc.qr ? "Check-in QR code" : "", inc.calendar ? "Add to calendar link" : "", inc.hotel ? "Hotel block link" : ""].filter(Boolean).join(", ") || "Nothing extra";
}

function useSendTest(eventId: number) {
  const sendTest = trpc.registration.templates.sendTest.useMutation();
  return {
    pending: sendTest.isPending,
    send: async (d: MsgDraft) => {
      try {
        const r = await sendTest.mutateAsync({ eventId, ...d, includes: { ...d.includes, hotelUrl: d.includes.hotelUrl ?? "" } });
        toast(`Test sent to ${r.to}`);
      } catch (err) {
        toast(errorText(err), true);
      }
    },
  };
}

function WelcomeTab({ event, canEdit }: { event: AdminEvent; canEdit: boolean }) {
  const list = trpc.registration.templates.list.useQuery({ eventId: event.id });
  const [open, setOpen] = useState<string | null>(null);
  if (list.isLoading) return <PageLoading />;
  if (list.error) return <ErrorNote error={list.error} />;
  const welcome = list.data!.find((t) => t.kind === "welcome");
  const followUps = list.data!.filter((t) => t.kind !== "welcome");
  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
      {welcome ? <WelcomeEditor key={welcome.id + String(welcome.updatedAt)} event={event} t={welcome} canEdit={canEdit} followUps={followUps} open={open} setOpen={setOpen} /> : <Empty>The welcome email is missing for this event.</Empty>}
    </div>
  );
}

function WelcomeEditor({ event, t, canEdit, followUps, open, setOpen }: { event: AdminEvent; t: Template; canEdit: boolean; followUps: Template[]; open: string | null; setOpen: (k: string | null) => void }) {
  const utils = trpc.useUtils();
  const save = trpc.registration.templates.save.useMutation();
  const test = useSendTest(event.id);
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState<MsgDraft>(toDraft(t));
  const body = useRef<HTMLTextAreaElement>(null);
  const shown = editing ? d : toDraft(t);
  const debounced = useDebounced(shown, 450);
  const preview = trpc.registration.templates.preview.useQuery({ eventId: event.id, ...debounced, includes: { ...debounced.includes, hotelUrl: debounced.includes.hotelUrl || "" } }, { placeholderData: (prev) => prev, retry: false });
  const inc = d.includes;
  const setInc = (patch: Partial<Template["includes"]>) => setD({ ...d, includes: { ...d.includes, ...patch } });

  function insertField(token: string) {
    const el = body.current;
    const at = el ? el.selectionStart : d.body.length;
    const end = el ? el.selectionEnd : d.body.length;
    setD({ ...d, body: d.body.slice(0, at) + token + d.body.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  }

  async function submit() {
    try {
      await save.mutateAsync({ eventId: event.id, ...d, includes: { ...d.includes, hotelUrl: d.includes.hotel ? d.includes.hotelUrl ?? "" : "" } });
      await utils.registration.templates.list.invalidate();
      setEditing(false);
      toast("Welcome email saved");
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  return (
    <>
      <div className="col" style={{ flex: "1 1 520px", minWidth: 0, gap: 14 }}>
        <div className="row-between">
          <span className="h3" style={{ fontSize: 14 }}>Welcome email</span>
          {editing ? (
            <Pill tone="orange">Editing</Pill>
          ) : (
            <div className="row gap-8">
              <button className="btn btn-sm" disabled={test.pending} onClick={() => test.send(toDraft(t))}>
                Send me a test
              </button>
              {canEdit ? (
                <button className="btn btn-sm btn-w" onClick={() => (setD(toDraft(t)), setEditing(true))}>
                  Edit
                </button>
              ) : null}
            </div>
          )}
        </div>
        {!editing ? (
          <div>
            <KV label="Send">{ruleLabel(t.sendRule, false)}</KV>
            <KV label="From name">{t.fromName}</KV>
            <KV label="Reply-to">{t.replyTo}</KV>
            <KV label="Subject">{t.subject}</KV>
            <KV label="Message"><span style={{ whiteSpace: "pre-line" }}>{t.body}</span></KV>
            <KV label="Include in the email">{includesList(t.includes)}</KV>
            <KV label="Status">{t.enabled ? "On" : "Off"}</KV>
          </div>
        ) : (
          <>
            <div className="grid-3">
              <Field label="Send">
                <select className="select" value={d.sendRule} onChange={(e) => setD({ ...d, sendRule: e.target.value })}>
                  <option value="after_payment">Right after payment</option>
                  <option value="after_payment_1h">1 hour after payment</option>
                </select>
              </Field>
              <Field label="From name">
                <input className="input" value={d.fromName} onChange={(e) => setD({ ...d, fromName: e.target.value })} />
              </Field>
              <Field label="Reply-to">
                <input className="input" type="email" value={d.replyTo} onChange={(e) => setD({ ...d, replyTo: e.target.value })} placeholder="conference@example.org" />
              </Field>
              <Field label="Subject" className="span-3">
                <input className="input" value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
              </Field>
              <Field label="Message" className="span-3">
                <textarea ref={body} className="textarea" rows={4} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
              </Field>
            </div>
            <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              Insert a field
              <select className="select" style={{ width: 180 }} value="" onChange={(e) => e.target.value && insertField(e.target.value)}>
                <option value="">Pick a field</option>
                {FIELDS.map((f) => (
                  <option key={f.token} value={f.token}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="col gap-8" style={{ fontSize: 13 }}>
              <span className="field">Include in the email</span>
              <label className="check"><input type="checkbox" checked={inc.receipt} onChange={(e) => setInc({ receipt: e.target.checked })} />Ticket and receipt summary</label>
              <label className="check"><input type="checkbox" checked={inc.getApp} onChange={(e) => setInc({ getApp: e.target.checked })} />Get the app button with steps for iPhone and Android</label>
              <label className="check"><input type="checkbox" checked={inc.qr} onChange={(e) => setInc({ qr: e.target.checked })} />Check-in QR code</label>
              <label className="check"><input type="checkbox" checked={inc.calendar} onChange={(e) => setInc({ calendar: e.target.checked })} />Add to calendar link</label>
              <label className="check"><input type="checkbox" checked={inc.hotel} onChange={(e) => setInc({ hotel: e.target.checked })} />Hotel block link</label>
              {inc.hotel ? (
                <Field label="Hotel booking link">
                  <input className="input" style={{ maxWidth: 420 }} type="url" value={inc.hotelUrl ?? ""} onChange={(e) => setInc({ hotelUrl: e.target.value })} placeholder="https://" />
                </Field>
              ) : null}
              <label className="check"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />Send the welcome email</label>
            </div>
            <div className="row gap-10">
              <button className="btn btn-sm btn-solid btn-w" disabled={save.isPending} onClick={submit}>
                Save
              </button>
              <button className="btn btn-sm btn-w" onClick={() => (setD(toDraft(t)), setEditing(false))}>
                Cancel
              </button>
              <button className="btn btn-sm" disabled={test.pending} onClick={() => test.send(d)}>
                Send me a test
              </button>
            </div>
          </>
        )}
        <div className="col" style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          <span className="h3" style={{ fontSize: 14, paddingBottom: 4 }}>Follow-up messages</span>
          {followUps.map((f) => (
            <ExpandRow
              key={f.id}
              cols="minmax(0, 1fr) 200px 90px 96px"
              open={open === f.kind}
              onToggle={() => setOpen(open === f.kind ? null : f.kind)}
              closedLabel={canEdit ? "Edit" : "Details"}
              cells={[<span className="strong">{f.label}</span>, <span className="muted">{f.ruleLabel}</span>, <Pill tone={f.enabled ? "green" : "gray"}>{f.enabled ? "On" : "Off"}</Pill>]}
            >
              <FollowUpEditor key={String(f.updatedAt)} event={event} t={f} readOnly={!canEdit} onDone={() => setOpen(null)} />
            </ExpandRow>
          ))}
          <span className="small muted" style={{ paddingTop: 10 }}>Texts go only to people who agreed to texts at sign-up.</span>
        </div>
      </div>
      <div className="col gap-8" style={{ flex: "0 0 320px", maxWidth: "100%" }}>
        <span className="field">Preview</span>
        <div style={{ border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden", background: "#FFFFFF" }}>
          <div className="col" style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)", gap: 2 }}>
            <span className="small muted">{shown.fromName || "LeadDash Events"}</span>
            <span style={{ fontSize: 13, fontWeight: 800 }}>{preview.data?.subject ?? ""}</span>
          </div>
          {preview.error ? (
            <div className="small err" style={{ padding: 14 }}>{errorText(preview.error)}</div>
          ) : preview.data?.html ? (
            <iframe title="Welcome email preview" sandbox="" srcDoc={preview.data.html} style={{ width: "100%", height: 640, border: 0, display: "block" }} />
          ) : (
            <PageLoading />
          )}
        </div>
      </div>
    </>
  );
}

function FollowUpEditor({ event, t, readOnly, onDone }: { event: AdminEvent; t: Template; readOnly: boolean; onDone: () => void }) {
  const utils = trpc.useUtils();
  const save = trpc.registration.templates.save.useMutation();
  const test = useSendTest(event.id);
  const [d, setD] = useState<MsgDraft>(toDraft(t));
  const days = d.sendRule.match(/^days_before:(\d+)$/)?.[1] ?? "";
  const at = d.sendRule.match(/^at:(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  const isText = t.channel === "text";
  const setInc = (patch: Partial<Template["includes"]>) => setD({ ...d, includes: { ...d.includes, ...patch } });

  async function submit() {
    try {
      await save.mutateAsync({ eventId: event.id, ...d, includes: { ...d.includes, hotelUrl: d.includes.hotel ? d.includes.hotelUrl ?? "" : "" } });
      await utils.registration.templates.list.invalidate();
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
        {t.kind === "text_app" ? (
          <Field label="Send">
            <select className="select" value={d.sendRule} onChange={(e) => setD({ ...d, sendRule: e.target.value })}>
              <option value="after_payment">Right after payment</option>
              <option value="after_payment_1h">1 hour after payment</option>
            </select>
          </Field>
        ) : at ? (
          <>
            <Field label="Send on">
              <input className="input" type="date" value={at[1]} onChange={(e) => e.target.value && setD({ ...d, sendRule: `at:${e.target.value}T${at[2]}` })} />
            </Field>
            <Field label="At (event time)">
              <input className="input" type="time" value={at[2]} onChange={(e) => e.target.value && setD({ ...d, sendRule: `at:${at[1]}T${e.target.value}` })} />
            </Field>
          </>
        ) : (
          <Field label="Days before the event" hint="Sends at 9:00 AM event time">
            <input className="input" type="number" min={1} max={60} value={days} onChange={(e) => setD({ ...d, sendRule: `days_before:${Math.max(1, Math.min(60, Number(e.target.value) || 1))}` })} />
          </Field>
        )}
        {!isText ? (
          <Field label="Subject" className="span-3">
            <input className="input" value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
          </Field>
        ) : null}
        <Field label={isText ? `Text (${d.body.length} of 480)` : "Message"} className="span-3">
          <textarea className="textarea" rows={3} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
        </Field>
      </div>
      {t.kind === "app_reminder" ? (
        <label className="check">
          <input type="checkbox" checked={d.onlyIfNoApp} onChange={(e) => setD({ ...d, onlyIfNoApp: e.target.checked })} />
          Only send to people who have not opened the app
        </label>
      ) : null}
      {!isText ? (
        <div className="row wrap gap-16" style={{ fontSize: 13 }}>
          <label className="check"><input type="checkbox" checked={d.includes.getApp} onChange={(e) => setInc({ getApp: e.target.checked })} />Get the app button</label>
          <label className="check"><input type="checkbox" checked={d.includes.qr} onChange={(e) => setInc({ qr: e.target.checked })} />Check-in QR code</label>
          <label className="check"><input type="checkbox" checked={d.includes.calendar} onChange={(e) => setInc({ calendar: e.target.checked })} />Add to calendar link</label>
          <label className="check"><input type="checkbox" checked={d.includes.receipt} onChange={(e) => setInc({ receipt: e.target.checked })} />Ticket summary</label>
        </div>
      ) : (
        <span className="small muted">Fields: {"{{first name}}"}, {"{{app link}}"}, {"{{event name}}"}, {"{{event dates}}"}, {"{{venue}}"}</span>
      )}
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

/* ---------- Payments (event tab and organization page) ---------- */

function useStartOnboarding(orgId: number) {
  const connect = trpc.registration.stripe.connect.useMutation();
  return {
    pending: connect.isPending,
    go: async () => {
      try {
        const { url } = await connect.mutateAsync({ orgId });
        window.location.href = url;
      } catch (err) {
        toast(errorText(err), true);
      }
    },
  };
}

function SetupPanel({ orgId, orgName, canManage }: { orgId: number; orgName: string; canManage: boolean }) {
  const start = useStartOnboarding(orgId);
  return (
    <div className="col gap-16" style={{ maxWidth: 640, padding: "12px 0" }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--brand-tint)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <IconCard size={26} />
      </div>
      <span className="h2">Get paid with Stripe</span>
      <span style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)" }}>
        Connect {orgName}'s Stripe account so people can pay on the checkout page with a card, Apple Pay, Google Pay, Klarna or Afterpay. Payments go straight to {orgName}'s bank. Sign in to an existing Stripe account, or create one in a few minutes.
      </span>
      <div className="col gap-8" style={{ fontSize: 14 }}>
        <div className="row"><StepNumber n={1} size={26} />Click Connect with Stripe</div>
        <div className="row"><StepNumber n={2} size={26} />Sign in to Stripe (or create an account) and allow LeadDash</div>
        <div className="row"><StepNumber n={3} size={26} />Come back here; the checkout page turns on</div>
      </div>
      {canManage ? (
        <button className="btn" style={{ alignSelf: "flex-start", height: 44, padding: "0 20px", border: "none", background: "#635BFF", color: "#FFFFFF", fontSize: 15, fontWeight: 800 }} disabled={start.pending} onClick={start.go}>
          Connect with Stripe
        </button>
      ) : (
        <span className="small muted">An organization admin connects Stripe on the organization's Payments page.</span>
      )}
    </div>
  );
}

function feeText(fee: { cents: number; percent: number }) {
  const parts = [fee.cents > 0 ? fmtMoney(fee.cents) : "", fee.percent > 0 ? `${fee.percent}%` : ""].filter(Boolean);
  return parts.length ? `${parts.join(" plus ")} per ticket` : "None";
}

/** A Stripe capability status in plain words. */
function methodText(v: string) {
  if (v === "active") return <span style={{ color: "var(--brand)" }}>On</span>;
  if (v === "pending") return <span style={{ color: "var(--warn-ink)" }}>Stripe is reviewing it</span>;
  return <span className="muted">Off. Turn it on in Stripe under Settings, Payment methods.</span>;
}

const INTERVALS: Record<string, string> = { daily: "daily", weekly: "weekly", monthly: "monthly", manual: "when you ask" };

function AccountPanel({ orgId, orgName, status, canManage }: { orgId: number; orgName: string; status: Extract<StripeStatus, { connected: true }>; canManage: boolean }) {
  const utils = trpc.useUtils();
  const saveSettings = trpc.registration.stripe.saveSettings.useMutation();
  const refresh = trpc.registration.stripe.refresh.useMutation();
  const disconnect = trpc.registration.stripe.disconnect.useMutation();
  const start = useStartOnboarding(orgId);
  const [draft, setDraft] = useState<{ statementDescriptor: string; refundPolicy: string } | null>(null);
  const d = draft ?? { statementDescriptor: status.statementDescriptor, refundPolicy: status.refundPolicy };
  const invalidate = () => Promise.all([utils.registration.stripe.status.invalidate(), utils.registration.stripe.forEvent.invalidate()]);
  const state = status.chargesEnabled ? (status.payoutsEnabled ? "Connected, payouts on" : "Connected, payouts not on yet") : status.detailsSubmitted ? "Stripe is reviewing the details" : "Setup not finished";
  const payouts = status.bankLast4 ? `Bank ending ${status.bankLast4}${status.payoutInterval ? `, ${INTERVALS[status.payoutInterval] ?? status.payoutInterval}` : ""}` : status.payoutsEnabled ? "Set in your Stripe dashboard" : "";

  const view = (
    <div>
      <KV label="Status"><span style={{ color: status.chargesEnabled ? "var(--brand)" : "var(--warn-ink)" }}>{state}</span></KV>
      <KV label="Account">{`${status.businessName || orgName} · ${status.accountId}`}</KV>
      <KV label="Payouts to">{payouts}</KV>
      <KV label="Name on card statements">{status.statementDescriptor}</KV>
      <KV label="Ways to pay">Card, Apple Pay, Google Pay</KV>
      <KV label="Klarna">{methodText(status.payMethods.klarna)}</KV>
      <KV label="Afterpay">{methodText(status.payMethods.afterpay)}</KV>
      <KV label="Receipts">Stripe emails a receipt after each payment</KV>
      <KV label="Refunds">{status.refundPolicy}</KV>
      <KV label="LeadDash fee">{feeText(status.fee)}</KV>
    </div>
  );
  const edit = (
    <div className="grid-2">
      <Field label="Name on card statements" hint="5 to 22 letters, shown on buyers' card statements">
        <input className="input" maxLength={22} value={d.statementDescriptor} onChange={(e) => setDraft({ ...d, statementDescriptor: e.target.value.toUpperCase() })} />
      </Field>
      <Field label="Refund policy" className="span-2" hint="Shown on the checkout page">
        <textarea className="textarea" rows={2} maxLength={400} value={d.refundPolicy} onChange={(e) => setDraft({ ...d, refundPolicy: e.target.value })} placeholder="Full refund until Mar 22, 2027, then no refunds" />
      </Field>
    </div>
  );

  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div className="col" style={{ flex: "1 1 520px", minWidth: 0, gap: 14 }}>
        {canManage ? (
          <EditSection
            title="Stripe account"
            view={view}
            edit={edit}
            saving={saveSettings.isPending}
            onCancel={() => setDraft(null)}
            onSave={async () => {
              const r = await saveSettings.mutateAsync({ orgId, statementDescriptor: d.statementDescriptor, refundPolicy: d.refundPolicy });
              await invalidate();
              setDraft(null);
              toast(r.note || "Saved");
            }}
          />
        ) : (
          <section className="col gap-12">
            <span className="h3" style={{ fontSize: 14 }}>Stripe account</span>
            {view}
          </section>
        )}
        <div className="row wrap gap-10">
          <a className="btn btn-sm" href="https://dashboard.stripe.com/" target="_blank" rel="noreferrer">
            Open Stripe dashboard
          </a>
          {status.payMethods.klarna !== "active" || status.payMethods.afterpay !== "active" ? (
            <a className="btn btn-sm" href="https://dashboard.stripe.com/settings/payment_methods" target="_blank" rel="noreferrer">
              Turn on Klarna or Afterpay
            </a>
          ) : null}
          {canManage && !status.chargesEnabled ? (
            <a className="btn btn-sm btn-solid" href="https://dashboard.stripe.com/account/onboarding" target="_blank" rel="noreferrer">
              Finish setup in Stripe
            </a>
          ) : null}
          {canManage ? (
            <button
              className="btn btn-sm"
              disabled={refresh.isPending}
              onClick={async () => {
                try {
                  await refresh.mutateAsync({ orgId });
                  await invalidate();
                  toast("Status updated");
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Check status
            </button>
          ) : null}
          {canManage ? (
            <button
              className="btn btn-sm"
              disabled={disconnect.isPending}
              onClick={async () => {
                if (!confirmAction("Disconnect Stripe? The checkout page stops taking payments until you connect again. Nothing changes in your Stripe account.")) return;
                try {
                  await disconnect.mutateAsync({ orgId });
                  await invalidate();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Disconnect
            </button>
          ) : null}
        </div>
      </div>
      <div className="col gap-8" style={{ flex: "0 0 300px", maxWidth: "100%", background: "var(--brand-tint-2)", borderRadius: 12, padding: 16, fontSize: 13, lineHeight: 1.5 }}>
        <span className="h3" style={{ fontSize: 14 }}>Where the money goes</span>
        <span>Ticket payments go straight into {orgName}'s own Stripe account and pay out to {orgName}'s bank. LeadDash never holds the funds.</span>
        <span className="muted">This Stripe account is used for every event {orgName} runs in LeadDash Events.</span>
      </div>
    </div>
  );
}

const statusPill = (s: string) =>
  s === "paid" ? <Pill>Paid</Pill> : s === "refunded" ? <Pill tone="gray">Refunded</Pill> : s === "failed" ? <Pill tone="red">Failed</Pill> : <Pill tone="orange">{s}</Pill>;

function RecentPayments({ rows, canRefund, showEvent }: { rows: Payment[]; canRefund: boolean; showEvent?: boolean }) {
  const utils = trpc.useUtils();
  const refund = trpc.registration.payments.refund.useMutation();
  const [open, setOpen] = useState<number | null>(null);
  const cols = showEvent ? "130px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 100px 100px 96px" : "130px minmax(0, 1fr) minmax(0, 1fr) 100px 100px 96px";
  const labels = showEvent ? ["Date", "Attendee", "Event", "Ticket", "Amount", "Status", ""] : ["Date", "Attendee", "Ticket", "Amount", "Status", ""];
  const cells = (p: Payment) => [
    fmtWhen(p.paidAt ?? p.createdAt),
    <span className="strong clip" style={{ display: "block" }}>{p.name}</span>,
    ...(showEvent ? [<span className="muted clip" style={{ display: "block" }}>{p.eventName}</span>] : []),
    <span className="muted clip" style={{ display: "block" }}>{p.ticketName}</span>,
    fmtMoney(p.amountCents, "$0.00"),
    statusPill(p.status),
  ];

  async function doRefund(p: Payment) {
    if (!confirmAction(`Refund ${fmtMoney(p.amountCents)} to ${p.name}? Their registration will be cancelled.`)) return;
    try {
      await refund.mutateAsync({ eventId: p.eventId, orderId: p.id });
      await Promise.all([utils.registration.payments.list.invalidate(), utils.registration.payments.forOrg.invalidate(), utils.registration.summary.invalidate(), utils.registration.tickets.list.invalidate()]);
      toast("Refunded");
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  return (
    <div className="col" style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
      <span className="h3" style={{ fontSize: 14, paddingBottom: 4 }}>Recent payments</span>
      {!rows.length ? (
        <Empty>No payments yet.</Empty>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: showEvent ? 940 : 820 }}>
            <THead cols={cols} labels={labels} />
            {rows.map((p) =>
              p.status === "paid" && canRefund ? (
                <div key={p.id} className="trow" style={{ gridTemplateColumns: cols }}>
                  {cells(p).map((c, i) => (
                    <div key={i} style={{ minWidth: 0 }}>{c}</div>
                  ))}
                  <button className="btn btn-sm btn-w" disabled={refund.isPending} onClick={() => doRefund(p)}>
                    Refund
                  </button>
                </div>
              ) : (
                <ExpandRow key={p.id} cols={cols} cells={cells(p)} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)}>
                  <div>
                    <KV label="Email">{p.email}</KV>
                    <KV label="Paid">{p.paidAt ? fmtWhen(p.paidAt) : ""}</KV>
                    {p.refundedAt ? <KV label="Refunded">{fmtWhen(p.refundedAt)}</KV> : null}
                    <KV label="Ticket price">{fmtMoney(p.subtotalCents, "$0.00")}</KV>
                    {p.couponCode ? <KV label="Coupon">{`${p.couponCode}, ${fmtMoney(p.discountCents, "$0.00")} off`}</KV> : null}
                    <KV label="LeadDash fee">{fmtMoney(p.feeCents, "None")}</KV>
                    <KV label="Stripe payment">{p.stripePaymentIntentId ?? ""}</KV>
                  </div>
                </ExpandRow>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PaymentsTab({ event, status, canManage, canEdit }: { event: AdminEvent; status: RouterOutputs["registration"]["stripe"]["forEvent"]; canManage: boolean; canEdit: boolean }) {
  const { me } = useAdmin();
  const payments = trpc.registration.payments.list.useQuery({ eventId: event.id });
  const orgName = (status.connected && status.businessName) || me.orgs.find((o) => o.id === event.orgId)?.name || "the organization";
  if (!status.connected) return <SetupPanel orgId={event.orgId} orgName={orgName} canManage={canManage} />;
  return (
    <>
      <AccountPanel orgId={event.orgId} orgName={orgName} status={status} canManage={canManage} />
      {payments.isLoading ? <PageLoading /> : payments.error ? <ErrorNote error={payments.error} /> : <RecentPayments rows={payments.data!} canRefund={canEdit} />}
    </>
  );
}

/* ---------- /admin/payments ---------- */

export function OrgPaymentsScreen() {
  const { orgId, me } = useAdmin();
  if (!orgId) return <AdminPage title="Payments"><Empty>Pick an organization on the Events screen first.</Empty></AdminPage>;
  return <OrgPayments orgId={orgId} orgName={me.orgs.find((o) => o.id === orgId)?.name ?? ""} />;
}

function OrgPayments({ orgId, orgName }: { orgId: number; orgName: string }) {
  const utils = trpc.useUtils();
  const [location, navigate] = useLocation();
  const flag = new URLSearchParams(useSearch()).get("stripe");
  const status = trpc.registration.stripe.status.useQuery({ orgId });
  const payments = trpc.registration.payments.forOrg.useQuery({ orgId }, { enabled: !!status.data?.connected });
  const refresh = trpc.registration.stripe.refresh.useMutation();
  const start = useStartOnboarding(orgId);
  const handled = useRef(false);

  // Back from "Connect with Stripe": show the result and read the account's state.
  const reason = new URLSearchParams(useSearch()).get("reason");
  useEffect(() => {
    if (!flag || handled.current) return;
    handled.current = true;
    if (flag === "connected") {
      refresh
        .mutateAsync({ orgId })
        .then(async (s) => {
          await Promise.all([utils.registration.stripe.status.invalidate(), utils.registration.stripe.forEvent.invalidate()]);
          toast(s.connected && s.chargesEnabled ? "Stripe is connected" : "Connected. Stripe still needs a few details: click Finish setup in Stripe.");
        })
        .catch((err) => toast(errorText(err), true))
        .finally(() => navigate(location, { replace: true }));
    } else if (flag === "failed") {
      toast(reason || "Stripe was not connected. Try again.", true);
      navigate(location, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flag]);

  const s = status.data;
  const name = (s?.connected && s.businessName) || orgName || "your organization";
  let body: ReactNode;
  if (status.isLoading || refresh.isPending) body = <PageLoading />;
  else if (status.error) body = <ErrorNote error={status.error} />;
  else if (!s!.connected) body = <SetupPanel orgId={orgId} orgName={name} canManage />;
  else
    body = (
      <>
        <AccountPanel orgId={orgId} orgName={name} status={s!} canManage />
        {payments.isLoading ? <PageLoading /> : payments.error ? <ErrorNote error={payments.error} /> : <RecentPayments rows={payments.data!} canRefund showEvent />}
      </>
    );
  return (
    <AdminPage title="Payments" banner={s ? <StripeBar status={s} /> : null}>
      <div className="folder-body">{body}</div>
    </AdminPage>
  );
}
