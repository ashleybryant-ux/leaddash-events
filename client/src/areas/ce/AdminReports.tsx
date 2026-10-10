/**
 * /admin/e/:eventId/reports: registrations, check-in, session attendance,
 * evaluation scores, CE hours issued, app adoption, vendors and engagement.
 */
import { useState } from "react";
import { trpc } from "../../lib/trpc";
import { AdminPage, useAdminEvent } from "../../shells/AdminShell";
import { Empty, ErrorNote, Kpi, PageLoading } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtTime } from "@shared/format";
import { downloadCsv } from "./util";

const n = (v: number) => v.toLocaleString();

function Bar({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="muted">No data</span>;
  return (
    <span className="row gap-8" style={{ minWidth: 0 }}>
      <span style={{ flex: 1, height: 8, borderRadius: 4, background: "var(--line-2)", overflow: "hidden", minWidth: 40 }}>
        <span style={{ display: "block", width: `${Math.min(100, percent)}%`, height: "100%", background: "var(--brand)" }} />
      </span>
      <span className="strong" style={{ width: 40, textAlign: "right" }}>{percent}%</span>
    </span>
  );
}

function useExport(eventId: number) {
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const run = async (section: "sessions" | "registrations" | "all") => {
    setBusy(true);
    try {
      downloadCsv(await utils.ce.reports.exportCsv.fetch({ eventId, section }));
    } catch (err) {
      toast(errorText(err), true);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function AdminReports() {
  const ev = useAdminEvent();
  const q = trpc.ce.reports.event.useQuery({ eventId: ev.id });
  const exp = useExport(ev.id);
  const r = q.data;
  const sCols = "minmax(0, 2fr) 100px minmax(0, 1.2fr) minmax(0, 1.2fr) 90px";
  const twoCol = "minmax(0, 1fr) 90px";
  const maxDay = Math.max(1, ...(r?.byDay ?? []).map((d) => d.count));

  return (
    <AdminPage
      title="Reports"
      actions={
        <button className="btn btn-primary" disabled={exp.busy || !r} onClick={() => exp.run("all")}>
          Export all
        </button>
      }
    >
      {q.isLoading ? (
        <PageLoading />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : r ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <Kpi label="Registered" value={n(r.kpis.registered)} />
            <Kpi label="Checked in" value={n(r.kpis.checkedIn)} note={`${r.kpis.checkInRate}% of registered`} />
            <Kpi label="Opened the app" value={n(r.kpis.openedApp)} note={r.kpis.registered ? `${Math.round((r.kpis.openedApp / r.kpis.registered) * 100)}% of registered` : undefined} />
            <Kpi label="CE hours issued" value={n(r.kpis.ceHours)} note={`${n(r.kpis.certificates)} certificates`} />
            {r.kpis.returning ? <Kpi label={r.kpis.returning.label} value={`${r.kpis.returning.percent}%`} /> : null}
          </div>

          <div className="card" style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 760 }}>
              <div className="row-between" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
                <div className="h3">Sessions</div>
                <button className="btn btn-sm btn-w" disabled={exp.busy} onClick={() => exp.run("sessions")}>
                  Export
                </button>
              </div>
              <div className="trow thead" style={{ gridTemplateColumns: sCols }}>
                <div>Session</div>
                <div>Checked in</div>
                <div>Of those scheduled</div>
                <div>Of capacity</div>
                <div>Eval score</div>
              </div>
              {!r.sessions.length ? (
                <Empty>No sessions yet.</Empty>
              ) : (
                r.sessions.map((s) => (
                  <div key={s.id} className="trow" style={{ gridTemplateColumns: sCols }}>
                    <span className="col gap-4" style={{ minWidth: 0 }}>
                      <span className="strong clip">{s.title}</span>
                      <span className="small muted">
                        {fmtDate(s.date)}, {fmtTime(s.startTime)}
                        {s.ceHours > 0 ? ` · ${s.ceHours} CE` : ""}
                        {s.evaluations ? ` · ${n(s.evaluations)} evaluations` : ""}
                      </span>
                    </span>
                    <span>{n(s.checkedIn)}</span>
                    <Bar percent={s.ofScheduled} />
                    {s.capacity ? (
                      <span className="col gap-4">
                        <Bar percent={s.ofCapacity} />
                        <span className="small muted">of {n(s.capacity)} seats</span>
                      </span>
                    ) : (
                      <span className="muted">No limit</span>
                    )}
                    <span className="strong">{s.evalScore !== null ? s.evalScore.toFixed(1) : ""}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18 }}>
            <div className="card card-pad col gap-12">
              <div className="row-between">
                <div className="h3">Registrations by ticket</div>
                <button className="btn btn-sm btn-w" disabled={exp.busy} onClick={() => exp.run("registrations")}>
                  Export
                </button>
              </div>
              {r.byTicket.length ? (
                <div className="list">
                  {r.byTicket.map((t) => (
                    <div key={t.ticket} style={{ display: "grid", gridTemplateColumns: twoCol, gap: 12, padding: "9px 0", fontSize: 14 }}>
                      <span className="clip">{t.ticket}</span>
                      <span className="strong" style={{ textAlign: "right" }}>{n(t.count)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>No registrations yet.</Empty>
              )}
            </div>
            <div className="card card-pad col gap-12">
              <div className="h3">Registrations by day</div>
              {r.byDay.length ? (
                <div className="list" style={{ maxHeight: 320, overflowY: "auto" }}>
                  {r.byDay.map((d) => (
                    <div key={d.date} style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr) 50px", gap: 12, alignItems: "center", padding: "7px 0", fontSize: 13 }}>
                      <span>{fmtDate(d.date)}</span>
                      <span style={{ height: 8, borderRadius: 4, background: "var(--line-2)", overflow: "hidden" }}>
                        <span style={{ display: "block", width: `${(d.count / maxDay) * 100}%`, height: "100%", background: "var(--brand)" }} />
                      </span>
                      <span className="strong" style={{ textAlign: "right" }}>{n(d.count)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>No registrations yet.</Empty>
              )}
            </div>
            <div className="card card-pad col gap-12">
              <div className="h3">Vendors</div>
              {r.vendors.length ? (
                <div className="list">
                  {r.vendors.map((v) => (
                    <div key={v.id} style={{ display: "grid", gridTemplateColumns: twoCol, gap: 12, padding: "9px 0", fontSize: 14 }}>
                      <span className="clip">{v.company}</span>
                      <span className="strong" style={{ textAlign: "right" }}>{n(v.leads)} {v.leads === 1 ? "lead" : "leads"}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>No vendors yet.</Empty>
              )}
            </div>
            <div className="card card-pad col gap-12">
              <div className="h3">Engagement</div>
              <div className="list">
                {[
                  ["Community posts", r.engagement.posts],
                  ["Messages sent", r.engagement.messages],
                  ["Meetings booked", r.engagement.meetings],
                ].map(([label, value]) => (
                  <div key={label} style={{ display: "grid", gridTemplateColumns: twoCol, gap: 12, padding: "9px 0", fontSize: 14 }}>
                    <span>{label}</span>
                    <span className="strong" style={{ textAlign: "right" }}>{n(Number(value))}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </AdminPage>
  );
}
