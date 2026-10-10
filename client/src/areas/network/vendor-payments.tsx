/**
 * The Payments section on a sponsor or exhibitor: price, paid, owed, every
 * payment, the next scheduled charge, and Record (a payment staff took).
 * Other screens add buttons with `nextChargeActions` (on the next charge row)
 * and `extraActions` (a row of buttons under the payments).
 */
import { useState, type ReactNode } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { Field, confirmAction } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtMoney } from "@shared/format";
import { toCents } from "./shared";
import { SpSection, todayIso } from "./sponsor-ui";

export type VendorRow = RouterOutputs["network"]["vendors"]["list"]["vendors"][number];
type Method = "card" | "bank" | "check" | "cash" | "invoice" | "other";

const blankRecord = (v: VendorRow) => ({ amount: v.owedCents ? fmtMoney(v.owedCents, "") : "", method: "card" as Method, paidOn: todayIso(), note: "" });

export function PaymentsSection({ v, nextChargeActions, extraActions }: { v: VendorRow; nextChargeActions?: ReactNode; extraActions?: ReactNode }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const record = trpc.network.packages.recordPayment.useMutation();
  const remove = trpc.network.packages.removePayment.useMutation();
  const setDate = trpc.network.packages.setNextChargeOn.useMutation();
  const [d, setD] = useState(() => blankRecord(v));
  const [moving, setMoving] = useState<string | null>(null);
  const canEdit = can("vendors", "edit");
  const refresh = () => utils.network.vendors.list.invalidate();
  const paid = v.paidCents + v.pendingCents;
  const hasNext = v.nextChargeCents > 0 && !!v.nextChargeOn;

  const lines = (
    <>
      {v.payments.map((p) => (
        <div key={p.id} className="sp-li">
          <div className="grow">
            <b>{p.title}</b>
            <span className="s2">{p.detail}</span>
          </div>
          {canEdit && p.removable ? (
            <span className="r">
              <button
                type="button"
                className="btn btn-sm btn-w"
                disabled={remove.isPending}
                onClick={async () => {
                  if (!confirmAction(`Remove the ${p.title}?`)) return;
                  try {
                    await remove.mutateAsync({ eventId: ev.id, paymentId: p.id });
                    await refresh();
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Remove
              </button>
            </span>
          ) : null}
        </div>
      ))}
    </>
  );

  const view = (
    <>
      <div className="sp-kv">
        <span className="k">Package price</span>
        <span>{fmtMoney(v.amountCents, "$0.00")}</span>
        <span className="k">Paid</span>
        <span>{fmtMoney(paid, "$0.00")}</span>
        <span className="k">Owed</span>
        <span>{v.owedCents ? <b className="owed">{fmtMoney(v.owedCents)}</b> : "$0.00"}</span>
      </div>
      {lines}
      {hasNext ? (
        <div className="sp-li tint">
          {moving !== null ? (
            <>
              <div className="grow">
                <b>Next charge</b>
                <span className="s2">{fmtMoney(v.nextChargeCents)} · {v.payMethodLabel || "Saved payment method"}</span>
              </div>
              <span className="r">
                <input className="input" type="date" aria-label="Next charge date" style={{ width: 150 }} value={moving} min={todayIso()} onChange={(e) => setMoving(e.target.value)} />
                <button
                  type="button"
                  className="btn btn-sm btn-solid btn-w"
                  disabled={!moving || setDate.isPending}
                  onClick={async () => {
                    try {
                      await setDate.mutateAsync({ eventId: ev.id, vendorId: v.id, date: moving });
                      setMoving(null);
                      toast("Date changed");
                      await refresh();
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  Save
                </button>
                <button type="button" className="btn btn-sm btn-w" onClick={() => setMoving(null)}>
                  Cancel
                </button>
              </span>
            </>
          ) : (
            <>
              <div className="grow">
                <b>Next charge {fmtDate(v.nextChargeOn)}</b>
                <span className="s2">
                  {[fmtMoney(v.nextChargeCents), v.payMethodLabel, v.nextChargeRemindOn ? `Reminder ${fmtDate(v.nextChargeRemindOn)}` : ""].filter(Boolean).join(" · ")}
                </span>
                {v.nextChargeError ? <span className="s2 err">{v.nextChargeError}</span> : null}
              </div>
              {canEdit ? (
                <span className="r">
                  {nextChargeActions}
                  <button type="button" className="btn btn-sm btn-w-lg" onClick={() => setMoving(v.nextChargeOn ?? todayIso())}>
                    Change date
                  </button>
                </span>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {extraActions ? (
        <div className="sp-li">
          <span className="row gap-8 wrap">{extraActions}</span>
        </div>
      ) : null}
    </>
  );

  if (!canEdit) return <SpSection title="Payments" view={view} />;
  return (
    <SpSection
      title="Payments"
      editLabel="Record"
      onOpen={() => setD(blankRecord(v))}
      saving={record.isPending}
      onSave={async () => {
        const amountCents = toCents(d.amount);
        if (amountCents <= 0) throw new Error("Enter the amount paid.");
        if (!d.paidOn) throw new Error("Enter the date it was paid.");
        await record.mutateAsync({ eventId: ev.id, vendorId: v.id, amountCents, method: d.method, paidOn: d.paidOn, note: d.note });
        toast("Payment recorded");
        await refresh();
      }}
      view={view}
      edit={
        <>
          {v.payments.length ? <div style={{ margin: "-12px -14px 0" }}>{lines}</div> : null}
          <div className="grid-3" style={{ gap: 10 }}>
            <Field label="Amount">
              <input className="input" inputMode="decimal" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} />
            </Field>
            <Field label="How paid">
              <select className="select" value={d.method} onChange={(e) => setD({ ...d, method: e.target.value as Method })}>
                <option value="card">Card</option>
                <option value="bank">Bank account</option>
                <option value="check">Check</option>
                <option value="cash">Cash</option>
                <option value="invoice">Invoice</option>
                <option value="other">Other</option>
              </select>
            </Field>
            <Field label="Paid on">
              <input className="input" type="date" value={d.paidOn} onChange={(e) => setD({ ...d, paidOn: e.target.value })} />
            </Field>
          </div>
          <Field label="Note or check number">
            <input className="input" value={d.note} maxLength={200} onChange={(e) => setD({ ...d, note: e.target.value })} />
          </Field>
          {hasNext ? <span className="small muted">A payment that covers what is owed cancels the charge on {fmtDate(v.nextChargeOn)}.</span> : null}
        </>
      }
    />
  );
}
