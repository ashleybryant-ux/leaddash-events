/**
 * /admin/e/:eventId/checkin: the registration desk. Search or scan a badge
 * code (USB scanner, camera, or typing), check in, and print the badge from
 * the browser (Chrome kiosk printing to the label printer).
 */
import { useEffect, useRef, useState } from "react";
import { trpc } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { Empty, ErrorNote, Field, Modal, PageLoading, Pill, confirmAction, NumStrip } from "../../ui/components";
import { IconSearch } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtWhenTime, fullName } from "@shared/format";
import { BadgeView } from "./views";
import { QrScanner, canScanQr } from "./util";

export const badgePrintPath = (eventId: number, attendeeId: number) => `/admin/e/${eventId}/checkin/badge/${attendeeId}`;

/** Opens the badge print page in a new window (it prints itself) and counts the print. */
export function usePrintBadge(eventId: number) {
  const printed = trpc.ce.checkin.badgePrinted.useMutation();
  return async (attendeeId: number) => {
    const w = window.open(`${badgePrintPath(eventId, attendeeId)}?auto=1`, `badge-${attendeeId}`, "width=520,height=640");
    if (!w) {
      toast("Allow pop-ups for this site to print badges.", true);
      return false;
    }
    await printed.mutateAsync({ eventId, attendeeId }).catch((err) => toast(errorText(err), true));
    return true;
  };
}

export function CheckInDesk() {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [camera, setCamera] = useState(false);
  const [walkIn, setWalkIn] = useState(false);
  const [editing, setEditing] = useState<{ firstName: string; lastName: string; credentials: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const counts = trpc.ce.checkin.counts.useQuery({ eventId: ev.id }, { refetchInterval: 15_000 });
  const results = trpc.ce.checkin.search.useQuery({ eventId: ev.id, q: term }, { enabled: term.trim().length >= 2 });
  const badge = trpc.ce.checkin.badge.useQuery({ eventId: ev.id, attendeeId: selected ?? 0 }, { enabled: !!selected });
  const checkIn = trpc.ce.checkin.checkIn.useMutation();
  const undo = trpc.ce.checkin.undo.useMutation();
  const editBadge = trpc.ce.checkin.editBadge.useMutation();
  const printBadge = usePrintBadge(ev.id);
  const canEdit = can("checkin", "edit");

  useEffect(() => {
    const t = window.setTimeout(() => setTerm(q), 200);
    return () => window.clearTimeout(t);
  }, [q]);

  const selectedRow = results.data?.find((r) => r.id === selected) ?? lastPicked.current;
  const refresh = async () => {
    await Promise.all([utils.ce.checkin.counts.invalidate(), utils.ce.checkin.search.invalidate(), utils.ce.checkin.badge.invalidate()]);
  };

  /** A scanned code (USB scanner Enter, or the camera) selects that person. */
  const fromCode = async (code: string) => {
    try {
      const row = await utils.ce.checkin.lookup.fetch({ eventId: ev.id, code });
      if (!row) return false;
      lastPicked.current = row;
      setSelected(row.id);
      setQ(`${row.firstName} ${row.lastName}`);
      setEditing(null);
      return true;
    } catch (err) {
      toast(errorText(err), true);
      return false;
    }
  };

  const doCheckIn = async (print: boolean) => {
    if (!selected) return;
    // Open the print window first, inside the click, so the browser allows it.
    if (print) await printBadge(selected);
    if (!selectedRow?.checkedInAt) {
      try {
        await checkIn.mutateAsync({ eventId: ev.id, attendeeId: selected });
        toast(`${selectedRow ? `${selectedRow.firstName} ${selectedRow.lastName}` : "They"} checked in`);
      } catch (err) {
        toast(errorText(err), true);
      }
    }
    await refresh();
    input.current?.focus();
    input.current?.select();
  };

  const size = badge.data?.size === "4x6" ? "4 x 6 in" : "4 x 3 in";

  return (
    <AdminPage
      title="Check-in desk"
      actions={
        <>
          {canScanQr() ? (
            <button className={`btn${camera ? " btn-solid" : ""}`} onClick={() => setCamera(!camera)}>
              {camera ? "Camera off" : "Scan with camera"}
            </button>
          ) : null}
          {canEdit ? (
            <button className="btn" onClick={() => setWalkIn(true)}>
              Add walk-in
            </button>
          ) : null}
        </>
      }
    >
      <NumStrip
        items={[
          { label: "Checked in", value: counts.data?.checkedIn ?? "0" },
          { label: "Not yet", value: counts.data?.notYet ?? "0" },
          { label: "Walk-ins", value: counts.data?.walkIns ?? "0" },
        ]}
      />

      <div className="row wrap" style={{ gap: 18, alignItems: "flex-start" }}>
        <div className="col" style={{ flex: "999 1 420px", minWidth: 0, gap: 12 }}>
          {camera ? (
            <div className="card card-pad center">
              <QrScanner
                size={260}
                onCode={async (code) => {
                  if (!(await fromCode(code))) toast("That code is not a badge for this event.", true);
                }}
              />
            </div>
          ) : null}
          <label style={{ height: 52, borderRadius: 12, border: "2px solid var(--brand)", background: "#FFFFFF", display: "flex", alignItems: "center", gap: 10, padding: "0 14px", color: "var(--brand)" }}>
            <IconSearch size={20} />
            <input
              ref={input}
              autoFocus
              aria-label="Scan badge code or search by name"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key !== "Enter" || !q.trim()) return;
                if (await fromCode(q)) return;
                const list = results.data ?? [];
                if (list.length === 1) {
                  lastPicked.current = list[0];
                  setSelected(list[0].id);
                }
              }}
              style={{ flex: 1, minWidth: 0, border: "none", outline: "none", fontSize: 16, color: "var(--ink)", background: "#FFFFFF" }}
            />
            <span className="small muted strong nowrap" style={{ fontWeight: 600 }}>Scan a code or type a name</span>
          </label>

          {term.trim().length >= 2 ? (
            <div className="card" style={{ overflow: "hidden" }}>
              {results.isLoading ? (
                <PageLoading />
              ) : results.error ? (
                <ErrorNote error={results.error} />
              ) : !results.data?.length ? (
                <Empty>No one matches "{term}".</Empty>
              ) : (
                <div className="list">
                  {results.data.map((r) => {
                    const on = r.id === selected;
                    return (
                      <div key={r.id} className="row" style={{ gap: 12, padding: "12px 16px", background: on ? "var(--brand-tint-2)" : undefined }}>
                        <div className="col grow" style={{ gap: 2 }}>
                          <span style={{ fontSize: 15, fontWeight: on ? 800 : 700 }}>{fullName(r)}</span>
                          <span className="muted" style={{ fontSize: 13 }}>
                            {[r.city, r.kindLabel].filter(Boolean).join(" · ")}
                            {r.status === "cancelled" ? " · Cancelled" : ""}
                          </span>
                        </div>
                        <span style={{ width: 110, textAlign: "center" }}>
                          {r.status === "cancelled" ? <Pill tone="red">Cancelled</Pill> : r.checkedInAt ? <Pill>Checked in</Pill> : <Pill tone="orange">Not checked in</Pill>}
                        </span>
                        <button
                          className={`btn btn-sm btn-w${on ? " btn-solid" : ""}`}
                          onClick={() => {
                            lastPicked.current = r;
                            setSelected(r.id);
                            setEditing(null);
                          }}
                        >
                          {on ? "Selected" : "Select"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="card" style={{ flex: "1 1 340px", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="row-between">
            <div className="h3">Badge</div>
            <span className="small muted strong" style={{ fontWeight: 600 }}>{size}</span>
          </div>
          {!selected ? (
            <Empty>Scan a badge code or search for a name.</Empty>
          ) : badge.isLoading ? (
            <PageLoading />
          ) : badge.error ? (
            <ErrorNote error={badge.error} />
          ) : badge.data ? (
            <>
              <div style={{ alignSelf: "center", width: badge.data.size === "4x6" ? 220 : 320, maxWidth: "100%", border: "1px solid var(--field)", borderRadius: 10, overflow: "hidden" }}>
                <BadgeView b={badge.data} />
              </div>
              {selectedRow?.checkedInAt ? (
                <div className="small muted" style={{ textAlign: "center" }}>
                  Checked in {fmtWhenTime(selectedRow.checkedInAt)}
                  {selectedRow.checkedInBy ? ` by ${selectedRow.checkedInBy}` : ""}
                  {selectedRow.badgePrints ? ` · Badge printed ${selectedRow.badgePrints === 1 ? "once" : `${selectedRow.badgePrints} times`}` : ""}
                </div>
              ) : null}
              {selectedRow?.status === "cancelled" ? (
                <div className="banner banner-bad">This registration was cancelled.</div>
              ) : canEdit ? (
                <>
                  <button className="btn btn-primary btn-lg" disabled={checkIn.isPending} onClick={() => doCheckIn(true)}>
                    {selectedRow?.checkedInAt ? "Reprint badge" : "Check in and print"}
                  </button>
                  {!selectedRow?.checkedInAt ? (
                    <button className="btn" disabled={checkIn.isPending} onClick={() => doCheckIn(false)}>
                      Check in only
                    </button>
                  ) : null}
                  {editing ? (
                    <div className="col" style={{ gap: 10 }}>
                      <div className="grid-3">
                        <Field label="First name">
                          <input className="input" value={editing.firstName} onChange={(e) => setEditing({ ...editing, firstName: e.target.value })} />
                        </Field>
                        <Field label="Last name">
                          <input className="input" value={editing.lastName} onChange={(e) => setEditing({ ...editing, lastName: e.target.value })} />
                        </Field>
                        <Field label="Credentials">
                          <input className="input" value={editing.credentials} onChange={(e) => setEditing({ ...editing, credentials: e.target.value })} />
                        </Field>
                      </div>
                      <div className="row gap-10">
                        <button
                          className="btn btn-sm btn-solid btn-w"
                          disabled={editBadge.isPending}
                          onClick={async () => {
                            try {
                              await editBadge.mutateAsync({ eventId: ev.id, attendeeId: selected, ...editing });
                              if (lastPicked.current) lastPicked.current = { ...lastPicked.current, ...editing };
                              setEditing(null);
                              await refresh();
                            } catch (err) {
                              toast(errorText(err), true);
                            }
                          }}
                        >
                          Save
                        </button>
                        <button className="btn btn-sm btn-w" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button className="btn" onClick={() => setEditing({ firstName: badge.data!.firstName, lastName: badge.data!.lastName, credentials: selectedRow?.credentials ?? badge.data!.credentials })}>
                      Edit badge name
                    </button>
                  )}
                  {selectedRow?.checkedInAt ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        if (!confirmAction("Undo this check-in?")) return;
                        await undo.mutateAsync({ eventId: ev.id, attendeeId: selected }).catch((err) => toast(errorText(err), true));
                        if (lastPicked.current) lastPicked.current = { ...lastPicked.current, checkedInAt: null };
                        await refresh();
                      }}
                    >
                      Undo check-in
                    </button>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <WalkInModal
        open={walkIn}
        eventId={ev.id}
        onClose={() => setWalkIn(false)}
        onAdded={async (id, name) => {
          setWalkIn(false);
          await refresh();
          setQ(name);
          setTerm(name);
          lastPicked.current = null;
          setSelected(id);
        }}
      />
    </AdminPage>
  );
}

type DeskRow = { id: number; firstName: string; lastName: string; credentials: string; checkedInAt: Date | null; checkedInBy: string; badgePrints: number; status: string };
/** The person picked by a scan stays selected even when they are not in the visible search results. */
const lastPicked: { current: DeskRow | null } = { current: null };

function WalkInModal({ open, eventId, onClose, onAdded }: { open: boolean; eventId: number; onClose: () => void; onAdded: (id: number, name: string) => void }) {
  const tickets = trpc.ce.checkin.tickets.useQuery({ eventId }, { enabled: open });
  const walkUp = trpc.ce.checkin.walkUp.useMutation();
  const blank = { firstName: "", lastName: "", email: "", credentials: "", city: "", phone: "", ticketTypeId: null as number | null };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="Add walk-in">
      <div className="grid-2">
        <Field label="First name">
          <input className="input" value={f.firstName} onChange={set("firstName")} />
        </Field>
        <Field label="Last name">
          <input className="input" value={f.lastName} onChange={set("lastName")} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={f.email} onChange={set("email")} />
        </Field>
        <Field label="Mobile">
          <input className="input" type="tel" value={f.phone} onChange={set("phone")} />
        </Field>
        <Field label="Credentials">
          <input className="input" value={f.credentials} onChange={set("credentials")} placeholder="LPC" />
        </Field>
        <Field label="City">
          <input className="input" value={f.city} onChange={set("city")} />
        </Field>
        <Field label="Ticket" className="span-2">
          <select className="select" value={f.ticketTypeId ?? ""} onChange={(e) => setF({ ...f, ticketTypeId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">No ticket</option>
            {(tickets.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="small muted" style={{ margin: 0 }}>No payment is taken. They are checked in right away.</p>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={walkUp.isPending}
          onClick={async () => {
            try {
              const res = await walkUp.mutateAsync({ eventId, ...f });
              const name = `${f.firstName} ${f.lastName}`;
              setF(blank);
              onAdded(res.id, name);
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

/** /admin/e/:eventId/checkin/badge/:attendeeId: the badge alone, sized to the label, printing itself. */
export function BadgePrintPage({ eventId, attendeeId }: { eventId: number; attendeeId: number }) {
  const q = trpc.ce.checkin.badge.useQuery({ eventId, attendeeId });
  const done = useRef(false);
  const auto = new URLSearchParams(window.location.search).get("auto") === "1";
  useEffect(() => {
    document.title = "Badge";
    if (!q.data || done.current || !auto) return;
    done.current = true;
    const close = () => window.close();
    window.addEventListener("afterprint", close);
    const t = window.setTimeout(() => window.print(), 600);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("afterprint", close);
    };
  }, [q.data, auto]);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const b = q.data!;
  const [w, h] = b.size === "4x6" ? ["4in", "6in"] : ["4in", "3in"];
  return (
    <div style={{ background: "#FFFFFF", minHeight: "100dvh" }}>
      <style>{`
@page { size: ${w} ${h}; margin: 0; }
html, body { background: #FFFFFF !important; margin: 0; }
.ce-badge-sheet { width: ${w}; margin: 16px auto; }
@media print { .ce-badge-sheet { margin: 0; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`}</style>
      <div className="ce-badge-sheet">
        <BadgeView b={b} />
      </div>
      <div className="no-print" style={{ textAlign: "center", padding: 12 }}>
        <button className="btn btn-sm" onClick={() => window.print()}>
          Print
        </button>
      </div>
    </div>
  );
}
