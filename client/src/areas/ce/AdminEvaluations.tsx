/**
 * /admin/e/:eventId/evaluations: evaluation forms, each row expanding in
 * place to its questions, settings and results by session.
 * /admin/e/:eventId/evaluations/:evaluationId: editing one form.
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { Empty, ErrorNote, ExpandRow, Field, PageLoading, Pill, THead, confirmAction } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtTime, fmtWhen } from "@shared/format";
import { downloadCsv } from "./util";

type Form = RouterOutputs["ce"]["evaluations"]["list"][number];
type Question = Form["questions"][number];
type Kind = Question["kind"];

const COLS = "minmax(0, 2fr) 110px 130px 130px 96px";
const KIND_LABEL: Record<Kind, string> = { rating: "Rating 1 to 5", yesno: "Yes or no", choice: "Multiple choice", text: "Comment" };
const ratingLabel = (q: Pick<Question, "kind" | "scale">) => (q.kind === "rating" ? `Rating 1 to ${q.scale ?? 5}` : KIND_LABEL[q.kind]);

const CLOSES: { hours: number; label: string }[] = [
  { hours: 14 * 24, label: "14 days after the session" },
  { hours: 30 * 24, label: "30 days after the session" },
  { hours: 0, label: "Never" },
];
const closesLabel = (h: number) => CLOSES.find((c) => c.hours === h)?.label ?? (h % 24 === 0 ? `${h / 24} days after the session` : `${h} hours after the session`);

const formsPath = (eventId: number) => `/admin/e/${eventId}/evaluations`;

export function AdminEvaluations() {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const [, navigate] = useLocation();
  const q = trpc.ce.evaluations.list.useQuery({ eventId: ev.id });
  const create = trpc.ce.evaluations.create.useMutation();
  const [open, setOpen] = useState<number | null>(null);
  const canEdit = can("evaluations", "edit");
  const openId = open ?? (q.data?.length === 1 ? q.data[0].id : null);

  return (
    <AdminPage
      title="Evaluations"
      actions={
        canEdit ? (
          <button
            className="btn btn-primary"
            disabled={create.isPending}
            onClick={async () => {
              try {
                const row = await create.mutateAsync({ eventId: ev.id, name: "New evaluation" });
                navigate(`${formsPath(ev.id)}/${row.id}`);
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Add form
          </button>
        ) : null
      }
    >
      <div className="table">
        {q.isLoading ? (
          <PageLoading />
        ) : q.error ? (
          <ErrorNote error={q.error} />
        ) : (
          <div className="table-inner">
            <THead cols={COLS} labels={["Form", "Questions", "Sessions", "Responses", ""]} />
            {!q.data!.length ? (
              <Empty>No evaluation forms yet.</Empty>
            ) : (
              q.data!.map((f) => (
                <ExpandRow
                  key={f.id}
                  cols={COLS}
                  open={openId === f.id}
                  onToggle={() => setOpen(openId === f.id ? -1 : f.id)}
                  cells={[
                    <span className="row gap-8">
                      <span className="strong clip">{f.name}</span>
                      {f.isDefault ? <Pill>Default</Pill> : null}
                    </span>,
                    <span>{f.questions.length}</span>,
                    <span>{f.sessionCount}</span>,
                    <span>{f.responseCount.toLocaleString()}</span>,
                  ]}
                >
                  <FormDetails form={f} canEdit={canEdit} />
                </ExpandRow>
              ))
            )}
          </div>
        )}
      </div>
    </AdminPage>
  );
}

function statText(q: Question, s: Form["summary"][number] | undefined) {
  if (!s) return "";
  if (q.kind === "rating") return "average" in s && s.average !== null && s.average !== undefined ? `Avg ${s.average.toFixed(1)}` : "No answers yet";
  if (q.kind === "yesno") return "yesShare" in s && s.yesShare !== null && s.yesShare !== undefined ? `${s.yesShare}% yes` : "No answers yet";
  if (q.kind === "choice") {
    const c = "choices" in s ? s.choices : undefined;
    if (!c || !Object.keys(c).length) return "No answers yet";
    const [top] = Object.entries(c).sort((a, b) => b[1] - a[1]);
    return `Most: ${top[0]}`;
  }
  return `${s.count.toLocaleString()} ${s.count === 1 ? "comment" : "comments"}`;
}

function FormDetails({ form, canEdit }: { form: Form; canEdit: boolean }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const results = trpc.ce.evaluations.results.useQuery({ eventId: ev.id, evaluationId: form.id });
  const remove = trpc.ce.evaluations.remove.useMutation();
  const [busy, setBusy] = useState(false);
  const qCols = "28px minmax(0, 1fr) 150px 110px 140px";

  return (
    <>
      <div className="row-between wrap">
        <div className="editor-title">Questions</div>
        <div className="row gap-10">
          <button
            className="btn btn-sm btn-w"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                downloadCsv(await utils.ce.evaluations.exportCsv.fetch({ eventId: ev.id, evaluationId: form.id }));
              } catch (err) {
                toast(errorText(err), true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Export
          </button>
          {canEdit ? (
            <Link className="btn btn-sm btn-w" href={`${formsPath(ev.id)}/${form.id}`}>
              Edit
            </Link>
          ) : null}
          {canEdit && form.responseCount === 0 ? (
            <button
              className="btn btn-sm btn-w btn-danger"
              disabled={remove.isPending}
              onClick={async () => {
                if (!confirmAction(`Delete ${form.name}?`)) return;
                try {
                  await remove.mutateAsync({ eventId: ev.id, evaluationId: form.id });
                  await utils.ce.evaluations.list.invalidate();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>
      <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
        {form.questions.map((x, i) => (
          <div key={x.id} style={{ display: "grid", gridTemplateColumns: qCols, gap: 12, alignItems: "center", padding: "9px 12px", fontSize: 13 }}>
            <span className="muted strong">{i + 1}</span>
            <span className="strong">{x.label}</span>
            <span className="muted">{ratingLabel(x)}</span>
            <span className="muted">{x.required ? "Required" : "Optional"}</span>
            <span className="strong">{statText(x, form.summary.find((s) => s.id === x.id))}</span>
          </div>
        ))}
        {!form.questions.length ? <Empty>No questions yet.</Empty> : null}
      </div>
      <div className="grid-3">
        <Setting label="Opens" value={form.opensAt === "checkin" ? "At check-in" : "When the session ends"} />
        <Setting label="Closes" value={closesLabel(form.closesAfterHours)} />
        <Setting label="Needed for certificate" value={form.neededForCertificate ? "Yes" : "No"} />
      </div>

      <div className="divider" />
      <div className="editor-title">Results by session</div>
      {results.isLoading ? (
        <PageLoading />
      ) : results.error ? (
        <ErrorNote error={results.error} />
      ) : !results.data?.perSession.length ? (
        <span className="small muted">No responses yet.</span>
      ) : (
        <>
          <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
            {results.data.perSession.map((s) => (
              <div key={s.sessionId} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 130px 120px 90px", gap: 12, alignItems: "center", padding: "9px 12px", fontSize: 13 }}>
                <span className="strong clip">{s.title}</span>
                <span className="muted">{fmtDate(s.date)}</span>
                <span>{s.responses.toLocaleString()} {s.responses === 1 ? "response" : "responses"}</span>
                <span className="strong">{s.average !== null ? `Avg ${s.average.toFixed(1)}` : ""}</span>
              </div>
            ))}
          </div>
          {results.data.comments.length ? (
            <div className="col gap-8">
              <span className="editor-title" style={{ fontSize: 13 }}>Latest comments</span>
              <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 8, maxHeight: 320, overflowY: "auto" }}>
                {results.data.comments.slice(0, 50).map((c, i) => (
                  <div key={i} className="col gap-4" style={{ padding: "9px 12px", fontSize: 13 }}>
                    <span style={{ lineHeight: 1.5 }}>{c.text}</span>
                    <span className="small muted">
                      {c.session} · {fmtWhen(c.at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="col gap-4" style={{ fontSize: 13 }}>
      <span className="muted strong" style={{ fontWeight: 600 }}>{label}</span>
      <span className="strong">{value}</span>
    </div>
  );
}

// ---------- /evaluations/:evaluationId ----------

type DraftQ = { id?: string; kind: Kind; label: string; required: boolean; options: string; scale?: number };

export function AdminEvaluationEdit({ evaluationId }: { evaluationId: number }) {
  const ev = useAdminEvent();
  const q = trpc.ce.evaluations.get.useQuery({ eventId: ev.id, evaluationId });
  if (q.isLoading) return <AdminPage title="Evaluations"><PageLoading /></AdminPage>;
  if (q.error) return <AdminPage title="Evaluations"><ErrorNote error={q.error} /></AdminPage>;
  return <EvaluationEditor key={q.dataUpdatedAt} data={q.data!} />;
}

function EvaluationEditor({ data }: { data: RouterOutputs["ce"]["evaluations"]["get"] }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const save = trpc.ce.evaluations.update.useMutation();
  const f = data.form;
  const [name, setName] = useState(f.name);
  const [isDefault, setIsDefault] = useState(f.isDefault);
  const [opensAt, setOpensAt] = useState(f.opensAt);
  const [closes, setCloses] = useState(f.closesAfterHours);
  const [needed, setNeeded] = useState(f.neededForCertificate);
  const [qs, setQs] = useState<DraftQ[]>(() => f.questions.map((x) => ({ id: x.id, kind: x.kind, label: x.label, required: x.required, options: (x.options ?? []).join(", "), scale: x.scale })));
  const [sessionIds, setSessionIds] = useState<Set<number>>(() => new Set(data.sessions.filter((s) => s.evaluationId === f.id).map((s) => s.id)));
  const back = formsPath(ev.id);
  const canEdit = can("evaluations", "edit");
  const setQ = (i: number, patch: Partial<DraftQ>) => setQs(qs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const qCols = "28px minmax(0, 1fr) 160px 120px 96px";
  const closeChoices = CLOSES.some((c) => c.hours === closes) ? CLOSES : [...CLOSES, { hours: closes, label: closesLabel(closes) }];

  return (
    <AdminPage title="Evaluations">
      <div className="table">
        <div className="table-inner">
          <THead cols={COLS} labels={["Form", "Questions", "Sessions", "Responses", ""]} />
          <div className="trow-open">
            <div className="trow" style={{ gridTemplateColumns: COLS, borderBottom: "none" }}>
              <span className="strong clip">{f.name}</span>
              <span>{f.questions.length}</span>
              <span>{data.sessionCount}</span>
              <span>{data.responseCount.toLocaleString()}</span>
              <Link className="btn btn-sm btn-w btn-solid" href={back}>
                Close
              </Link>
            </div>
            <div className="editor">
              <div className="editor-title">Editing form</div>
              {data.responseCount > 0 ? <div className="banner banner-warn">This form has {data.responseCount.toLocaleString()} responses. Changing a question changes how they are reported.</div> : null}
              <div className="grid-3">
                <Field label="Form name" className="span-2">
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <label className="check" style={{ alignSelf: "end", height: 32 }}>
                  <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
                  Default for CE sessions
                </label>
              </div>

              <div className="col gap-8">
                <div style={{ display: "grid", gridTemplateColumns: qCols, gap: 10 }} className="label-caps">
                  <span />
                  <span>Question</span>
                  <span>Answer type</span>
                  <span>Answer</span>
                  <span />
                </div>
                {qs.map((x, i) => (
                  <div key={i} className="col gap-6">
                    <div style={{ display: "grid", gridTemplateColumns: qCols, gap: 10, alignItems: "center" }}>
                      <span className="muted strong">{i + 1}</span>
                      <input className="input" aria-label={`Question ${i + 1}`} value={x.label} onChange={(e) => setQ(i, { label: e.target.value })} />
                      <select className="select" aria-label={`Answer type for question ${i + 1}`} value={x.kind} onChange={(e) => setQ(i, { kind: e.target.value as Kind })}>
                        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                          <option key={k} value={k}>
                            {k === "rating" ? ratingLabel({ kind: k, scale: x.scale }) : KIND_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      <select className="select" aria-label={`Required for question ${i + 1}`} value={x.required ? "1" : "0"} onChange={(e) => setQ(i, { required: e.target.value === "1" })}>
                        <option value="1">Required</option>
                        <option value="0">Optional</option>
                      </select>
                      <button className="btn btn-sm btn-w" onClick={() => setQs(qs.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </div>
                    {x.kind === "choice" ? (
                      <div style={{ display: "grid", gridTemplateColumns: qCols, gap: 10 }}>
                        <span />
                        <input className="input" aria-label={`Choices for question ${i + 1}`} placeholder="Choices, separated by commas" value={x.options} onChange={(e) => setQ(i, { options: e.target.value })} style={{ gridColumn: "span 3" }} />
                      </div>
                    ) : null}
                  </div>
                ))}
                <div>
                  <button className="btn btn-sm" onClick={() => setQs([...qs, { kind: "rating", label: "", required: true, options: "" }])}>
                    Add question
                  </button>
                </div>
              </div>

              <div className="grid-3">
                <Field label="Opens">
                  <select className="select" value={opensAt} onChange={(e) => setOpensAt(e.target.value as typeof opensAt)}>
                    <option value="session_end">When the session ends</option>
                    <option value="checkin">At check-in</option>
                  </select>
                </Field>
                <Field label="Closes">
                  <select className="select" value={closes} onChange={(e) => setCloses(Number(e.target.value))}>
                    {closeChoices.map((c) => (
                      <option key={c.hours} value={c.hours}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Needed for certificate">
                  <select className="select" value={needed ? "1" : "0"} onChange={(e) => setNeeded(e.target.value === "1")}>
                    <option value="1">Yes</option>
                    <option value="0">No</option>
                  </select>
                </Field>
              </div>

              <div className="col gap-8">
                <span className="editor-title" style={{ fontSize: 13 }}>Sessions that use this form</span>
                <span className="small muted">{isDefault ? "CE sessions that do not pick a form use this one. Pick sessions here to use it even without CE hours." : "Picked sessions use this form instead of the default."}</span>
                {data.sessions.length ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "6px 16px", maxHeight: 260, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
                    {data.sessions.map((s) => {
                      const elsewhere = s.evaluationId !== null && s.evaluationId !== f.id;
                      return (
                        <label key={s.id} className="check">
                          <input
                            type="checkbox"
                            checked={sessionIds.has(s.id)}
                            onChange={(e) => {
                              const next = new Set(sessionIds);
                              if (e.target.checked) next.add(s.id);
                              else next.delete(s.id);
                              setSessionIds(next);
                            }}
                          />
                          <span className="clip">
                            {fmtDate(s.date)}, {fmtTime(s.startTime)}: {s.title}
                            {elsewhere ? " (uses another form)" : ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <span className="small muted">No sessions yet.</span>
                )}
              </div>

              <div className="row gap-10">
                <button
                  className="btn btn-sm btn-solid btn-w"
                  disabled={!canEdit || save.isPending}
                  onClick={async () => {
                    try {
                      await save.mutateAsync({
                        eventId: ev.id,
                        evaluationId: f.id,
                        name,
                        isDefault,
                        opensAt,
                        closesAfterHours: closes,
                        neededForCertificate: needed,
                        sessionIds: Array.from(sessionIds),
                        questions: qs.map((x) => ({
                          id: x.id,
                          kind: x.kind,
                          label: x.label,
                          required: x.required,
                          ...(x.kind === "choice" ? { options: x.options.split(",").map((o) => o.trim()).filter(Boolean) } : {}),
                          ...(x.kind === "rating" ? { scale: x.scale ?? 5 } : {}),
                        })),
                      });
                      toast("Saved");
                      await utils.ce.evaluations.invalidate();
                      navigate(back);
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  Save
                </button>
                <Link className="btn btn-sm btn-w" href={back}>
                  Cancel
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminPage>
  );
}
