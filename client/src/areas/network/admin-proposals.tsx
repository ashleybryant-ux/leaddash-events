/** /admin/e/:eventId/proposals: call for proposals settings, the proposal list and decisions, and the reviewer queue. */
import { useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdminEvent } from "../../shells/AdminShell";
import { CopyButton, EditSection, Empty, ErrorNote, ExpandRow, Field, FolderTabs, KV, Kpi, PageLoading, Pill, RichText, RichTextEditor, THead } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { eachDay, fmtDate, fmtWhen } from "@shared/format";

type ListData = RouterOutputs["network"]["proposals"]["admin"]["list"];
type Proposal = ListData["proposals"][number];
type Settings = RouterOutputs["network"]["proposals"]["admin"]["settings"];
type Queue = RouterOutputs["network"]["proposals"]["review"]["queue"];
type QueueItem = Queue["items"][number];

const STAGE: Record<string, { label: string; tone: "green" | "orange" | "gray" | "red" | "solid" }> = {
  in_review: { label: "In review", tone: "gray" },
  needs_decision: { label: "Needs decision", tone: "orange" },
  accepted: { label: "Accepted", tone: "green" },
  waitlisted: { label: "Waitlist", tone: "orange" },
  declined: { label: "Declined", tone: "red" },
  withdrawn: { label: "Withdrawn", tone: "gray" },
};
const REC: Record<string, string> = { accept: "Accept", maybe: "Maybe", decline: "Decline" };

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const keyFor = (label: string, taken: Set<string>) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "score";
  let k = base;
  for (let n = 2; taken.has(k); n++) k = `${base}_${n}`;
  taken.add(k);
  return k;
};

function SettingsCard({ s }: { s: Settings }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const update = trpc.network.proposals.admin.updateSettings.useMutation();
  const blank = () => ({
    opensOn: s.opensOn ?? "",
    closesOn: s.closesOn ?? "",
    intro: s.intro,
    formats: s.formats.join("\n"),
    tracks: s.tracks.join("\n"),
    rubric: s.rubric.map((r) => ({ ...r })),
    blind: s.blind,
    reviewersPerProposal: s.reviewersPerProposal,
  });
  const [d, setD] = useState(blank);
  return (
    <div className="card card-pad">
      <EditSection
        title="Call settings"
        saving={update.isPending}
        onCancel={() => setD(blank())}
        onSave={async () => {
          // Existing scores keep their key so past reviews still line up; new ones get a key from the label.
          const taken = new Set(d.rubric.map((r) => r.key).filter(Boolean));
          const rubric = d.rubric.filter((r) => r.label.trim()).map((r) => ({ key: r.key || keyFor(r.label, taken), label: r.label.trim(), max: r.max }));
          await update.mutateAsync({
            eventId: ev.id,
            opensOn: d.opensOn || null,
            closesOn: d.closesOn || null,
            intro: d.intro,
            formats: lines(d.formats),
            tracks: lines(d.tracks),
            rubric,
            blind: d.blind,
            reviewersPerProposal: d.reviewersPerProposal,
          });
          await utils.network.proposals.admin.invalidate();
          toast("Saved");
        }}
        view={
          <div>
            <KV label="Status">{s.open ? <Pill>Open</Pill> : <Pill tone="gray">Closed</Pill>}</KV>
            <KV label="Guidelines">{s.intro ? <div style={{ maxHeight: 180, overflow: "hidden", maskImage: "linear-gradient(#000 70%, transparent)" }}><RichText html={s.intro} /></div> : null}</KV>
            <KV label="Opens">{fmtDate(s.opensOn)}</KV>
            <KV label="Due date">{fmtDate(s.closesOn)}</KV>
            <KV label="Formats">{s.formats.join(", ")}</KV>
            <KV label="Tracks">{s.tracks.join(", ")}</KV>
            <KV label="Scores">{s.rubric.map((r) => `${r.label} (1 to ${r.max})`).join(", ")}</KV>
            <KV label="Blind review">{s.blind ? "On (names hidden)" : "Off"}</KV>
            <KV label="Reviews per proposal">{String(s.reviewersPerProposal)}</KV>
            <KV label="Reviewers">{s.reviewers.length ? s.reviewers.map((r) => r.name).join(", ") : "Add people with a Reviewer role in Staff roles"}</KV>
            <KV label="Proposal link">{s.link}</KV>
          </div>
        }
        edit={
          <div className="col gap-12">
            <div className="grid-4">
              <Field label="Opens">
                <input className="input" type="date" value={d.opensOn} onChange={(e) => setD({ ...d, opensOn: e.target.value })} />
              </Field>
              <Field label="Due date">
                <input className="input" type="date" value={d.closesOn} onChange={(e) => setD({ ...d, closesOn: e.target.value })} />
              </Field>
              <Field label="Reviews per proposal">
                <select className="select" value={d.reviewersPerProposal} onChange={(e) => setD({ ...d, reviewersPerProposal: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Blind review">
                <select className="select" value={d.blind ? "on" : "off"} onChange={(e) => setD({ ...d, blind: e.target.value === "on" })}>
                  <option value="on">On (names hidden)</option>
                  <option value="off">Off</option>
                </select>
              </Field>
            </div>
            <div className="col gap-4">
              <span className="field">Guidelines on the proposal page</span>
              <RichTextEditor label="Guidelines on the proposal page" value={d.intro} onChange={(html) => setD({ ...d, intro: html })} />
              <span className="small muted">Use Heading and Subheading for sections. Text pasted from Word or Google Docs keeps its headings, bold and lists.</span>
            </div>
            <div className="grid-2">
              <Field label="Formats" hint="One per line">
                <textarea className="textarea" rows={4} value={d.formats} onChange={(e) => setD({ ...d, formats: e.target.value })} />
              </Field>
              <Field label="Tracks" hint="One per line">
                <textarea className="textarea" rows={4} value={d.tracks} onChange={(e) => setD({ ...d, tracks: e.target.value })} />
              </Field>
            </div>
            <div className="col gap-6">
              <span className="field">Scores reviewers give</span>
              {d.rubric.map((r, i) => (
                <div key={i} className="row gap-8">
                  <input className="input grow" aria-label={`Score ${i + 1} name`} value={r.label} maxLength={80} onChange={(e) => setD({ ...d, rubric: d.rubric.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                  <select className="select" style={{ width: 110 }} aria-label={`Score ${i + 1} top score`} value={r.max} onChange={(e) => setD({ ...d, rubric: d.rubric.map((x, j) => (j === i ? { ...x, max: Number(e.target.value) } : x)) })}>
                    {[3, 4, 5, 10].map((n) => (
                      <option key={n} value={n}>
                        1 to {n}
                      </option>
                    ))}
                  </select>
                  {d.rubric.length > 1 ? (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setD({ ...d, rubric: d.rubric.filter((_, j) => j !== i) })}>
                      Remove
                    </button>
                  ) : null}
                </div>
              ))}
              {d.rubric.length < 10 ? (
                <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setD({ ...d, rubric: [...d.rubric, { key: "", label: "", max: 5 }] })}>
                  Add score
                </button>
              ) : null}
            </div>
          </div>
        }
      />
    </div>
  );
}

function ProposalDetail({ p, data, reviewers }: { p: Proposal; data: ListData; reviewers: Settings["reviewers"] }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const assign = trpc.network.proposals.admin.assign.useMutation();
  const decide = trpc.network.proposals.admin.decide.useMutation();
  const days = eachDay(data.eventDays.start, data.eventDays.end);
  const [chosen, setChosen] = useState<number[]>(p.reviews.map((r) => r.reviewerUserId));
  const [decision, setDecision] = useState<"accepted" | "waitlisted" | "declined" | null>(null);
  const [note, setNote] = useState("");
  const [email, setEmail] = useState(true);
  const [addSession, setAddSession] = useState(!p.sessionId);
  const [sendAgreement, setSendAgreement] = useState(data.speakerAgreement?.sendOnAccept ?? false);
  const [welcomeAfterSign, setWelcomeAfterSign] = useState(true);
  const [session, setSession] = useState({ date: days[0] ?? "", startTime: "10:00", endTime: /workshop|90/i.test(p.format) ? "11:30" : "11:00", room: "" });
  const assignedChanged = chosen.slice().sort().join() !== p.reviews.map((r) => r.reviewerUserId).sort().join();

  return (
    <div className="col gap-14">
      <div className="grid-4">
        <div className="col" style={{ gap: 2 }}>
          <span className="small muted strong">Format</span>
          <span className="strong">{p.format || "Not set"}</span>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <span className="small muted strong">Submitted</span>
          <span className="strong">{fmtWhen(p.createdAt)}</span>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <span className="small muted strong">CE requested</span>
          <span className="strong">{p.ceRequested ? "Yes" : "No"}</span>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <span className="small muted strong">Contact</span>
          <span className="strong clip">{p.email}</span>
        </div>
      </div>
      <div className="col gap-4">
        <span className="small muted strong">Abstract</span>
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{p.abstract}</div>
      </div>
      {p.objectives.length ? (
        <div className="col gap-4">
          <span className="small muted strong">Learning objectives</span>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {p.objectives.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {p.coPresenters.length || p.bio ? (
        <div className="col gap-4">
          <span className="small muted strong">Presenters</span>
          <span>
            {[`${p.name}${p.credentials ? `, ${p.credentials}` : ""}`, ...p.coPresenters.map((c) => `${c.name}${c.credentials ? `, ${c.credentials}` : ""}`)].join("; ")}
          </span>
          {p.bio ? <span className="muted" style={{ whiteSpace: "pre-wrap" }}>{p.bio}</span> : null}
        </div>
      ) : null}
      {Object.keys(p.answers).length ? (
        <div className="col gap-4">
          {Object.entries(p.answers).map(([k, v]) => (
            <span key={k}>
              <span className="small muted strong">{k}: </span>
              {v}
            </span>
          ))}
        </div>
      ) : null}

      <div className="col gap-8">
        <span className="editor-title">Reviewers</span>
        {reviewers.length ? (
          <div className="row wrap gap-12">
            {reviewers.map((r) => (
              <label key={r.id} className="check">
                <input type="checkbox" checked={chosen.includes(r.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, r.id] : chosen.filter((x) => x !== r.id))} />
                {r.name}
              </label>
            ))}
            {assignedChanged ? (
              <button
                className="btn btn-sm btn-solid btn-w"
                disabled={assign.isPending}
                onClick={async () => {
                  try {
                    await assign.mutateAsync({ eventId: ev.id, proposalId: p.id, reviewerUserIds: chosen });
                    await utils.network.proposals.admin.list.invalidate();
                    toast("Reviewers saved");
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Save
              </button>
            ) : null}
          </div>
        ) : (
          <span className="small muted">Add people with a Reviewer role in Staff roles.</span>
        )}
      </div>

      {p.reviews.length ? (
        <div className="col gap-6">
          <span className="editor-title">Reviews</span>
          <div className="table">
            <div className="table-inner" style={{ minWidth: 560 }}>
              <THead cols={`1.4fr repeat(${data.rubric.length}, 0.6fr) 0.8fr 2fr`} labels={["Reviewer", ...data.rubric.map((r) => r.label), "Says", "Comment"]} />
              {p.reviews.map((r) => (
                <div key={r.id} className="trow" style={{ gridTemplateColumns: `1.4fr repeat(${data.rubric.length}, 0.6fr) 0.8fr 2fr` }}>
                  <span className="strong">{r.reviewer}</span>
                  {data.rubric.map((x) => (
                    <span key={x.key}>{r.submittedAt && r.scores ? r.scores[x.key] ?? "" : ""}</span>
                  ))}
                  <span>{r.submittedAt ? REC[r.recommendation ?? ""] ?? "" : <span className="muted">Not yet</span>}</span>
                  <span className="small" style={{ whiteSpace: "pre-wrap" }}>{r.comment}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="col gap-10">
        <span className="editor-title">Decision</span>
        <div className="row gap-10">
          {(
            [
              ["accepted", "Accept"],
              ["waitlisted", "Waitlist"],
              ["declined", "Decline"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className={`btn btn-sm btn-w${decision === k ? " btn-solid" : ""}`} aria-pressed={decision === k} onClick={() => setDecision(decision === k ? null : k)}>
              {label}
            </button>
          ))}
        </div>
        {decision ? (
          <div className="col gap-10" style={{ background: "var(--brand-tint-2)", borderRadius: 10, padding: 14 }}>
            {decision === "accepted" ? (
              p.sessionId ? (
                <span className="small strong" style={{ color: "var(--brand)" }}>This proposal is already in the program.</span>
              ) : (
                <>
                  <label className="check">
                    <input type="checkbox" checked={addSession} onChange={(e) => setAddSession(e.target.checked)} />
                    Add the session and presenters to the program
                  </label>
                  {addSession ? (
                    <div className="grid-4">
                      <Field label="Day">
                        <select className="select" value={session.date} onChange={(e) => setSession({ ...session, date: e.target.value })}>
                          {days.map((d) => (
                            <option key={d} value={d}>
                              {fmtDate(d)}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Starts">
                        <input className="input" type="time" value={session.startTime} onChange={(e) => setSession({ ...session, startTime: e.target.value })} />
                      </Field>
                      <Field label="Ends">
                        <input className="input" type="time" value={session.endTime} onChange={(e) => setSession({ ...session, endTime: e.target.value })} />
                      </Field>
                      <Field label="Room">
                        <input className="input" value={session.room} maxLength={120} onChange={(e) => setSession({ ...session, room: e.target.value })} />
                      </Field>
                    </div>
                  ) : null}
                </>
              )
            ) : null}
            <span className="label-caps">Emails</span>
            <label className="check">
              <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
              {decision === "accepted" ? "Send the acceptance email" : `Email ${p.name} the decision`}
            </label>
            {decision === "accepted" && data.speakerAgreement && (p.sessionId || addSession) ? (
              <>
                <label className="check">
                  <input type="checkbox" checked={sendAgreement} onChange={(e) => setSendAgreement(e.target.checked)} />
                  Send the speaker agreement to sign
                </label>
                {sendAgreement ? (
                  <label className="check">
                    <input type="checkbox" checked={welcomeAfterSign} onChange={(e) => setWelcomeAfterSign(e.target.checked)} />
                    Send the speaker welcome email after they sign
                  </label>
                ) : null}
              </>
            ) : null}
            <Field label="Note in the email (optional)">
              <textarea className="textarea" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="row gap-10">
              <button
                className="btn btn-sm btn-solid btn-w-lg"
                disabled={decide.isPending}
                onClick={async () => {
                  try {
                    await decide.mutateAsync({
                      eventId: ev.id,
                      proposalId: p.id,
                      decision,
                      note: note.trim(),
                      sendEmail: email,
                      session: decision === "accepted" && addSession && !p.sessionId ? session : null,
                      sendAgreement: decision === "accepted" && !!data.speakerAgreement && sendAgreement,
                      welcomeAfterSign,
                    });
                    await utils.network.proposals.admin.list.invalidate();
                    setDecision(null);
                    toast(email ? "Decision sent" : "Decision saved");
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                {email ? "Send decision" : "Save decision"}
              </button>
              <button className="btn btn-sm btn-w" onClick={() => setDecision(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type Filter = "all" | "needs_decision" | "in_review" | "accepted" | "waitlisted" | "declined";

function AdminView() {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const settings = trpc.network.proposals.admin.settings.useQuery({ eventId: ev.id });
  const list = trpc.network.proposals.admin.list.useQuery({ eventId: ev.id });
  const auto = trpc.network.proposals.admin.autoAssign.useMutation();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<number | null>(null);
  if (settings.isLoading || list.isLoading) return <PageLoading />;
  if (settings.error) return <ErrorNote error={settings.error} />;
  if (list.error) return <ErrorNote error={list.error} />;
  const s = settings.data!;
  const data = list.data!;
  const rows = data.proposals.filter((p) => filter === "all" || p.summary.stage === filter);
  const cols = "2.4fr 1.4fr 1fr 0.9fr 1.1fr 96px";

  return (
    <>
      <div className="row wrap gap-10" style={{ justifyContent: "flex-end", marginTop: -8 }}>
        <CopyButton text={s.link} label="Copy proposal link" className="btn btn-sm" />
        <button
          className="btn btn-sm"
          disabled={auto.isPending || !s.reviewers.length}
          onClick={async () => {
            try {
              const r = await auto.mutateAsync({ eventId: ev.id });
              await utils.network.proposals.admin.list.invalidate();
              toast(r.added ? `${r.added} review${r.added === 1 ? "" : "s"} assigned` : "Every proposal has its reviewers");
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Assign reviewers evenly
        </button>
      </div>
      <div className="grid-4">
        <Kpi label="Submitted" value={data.stats.submitted} />
        <Kpi label="Fully reviewed" value={data.stats.fullyReviewed} />
        <Kpi label="Accepted" value={data.stats.accepted} />
        <Kpi label="Declined" value={data.stats.declined} />
      </div>
      <SettingsCard s={s} />
      <div>
        <FolderTabs<Filter>
          value={filter}
          onChange={setFilter}
          tabs={[
            { key: "all", label: "All" },
            { key: "needs_decision", label: "Needs decision" },
            { key: "in_review", label: "In review" },
            { key: "accepted", label: "Accepted" },
            { key: "waitlisted", label: "Waitlist" },
            { key: "declined", label: "Declined" },
          ]}
        />
        <div className="table">
          <div className="table-inner">
            <THead cols={cols} labels={["Proposal", "Submitted by", "Track", "Avg score", "Status", ""]} />
            {!rows.length ? (
              <Empty>{data.proposals.length ? "No proposals in this group." : "No proposals yet. Share the proposal link to collect them."}</Empty>
            ) : (
              rows.map((p) => {
                const stage = STAGE[p.summary.stage] ?? STAGE.in_review;
                return (
                  <ExpandRow
                    key={p.id}
                    cols={cols}
                    open={open === p.id}
                    onToggle={() => setOpen(open === p.id ? null : p.id)}
                    cells={[
                      <span key="t" className="strong">{p.title}</span>,
                      <span key="n">
                        {p.name}
                        {p.credentials ? `, ${p.credentials}` : ""}
                      </span>,
                      <span key="tr">{p.track}</span>,
                      <span key="s" className="strong">{p.summary.avg !== null ? `${p.summary.avg} of 5` : p.summary.assigned ? `${p.summary.reviewed} of ${p.summary.needed} in` : <span className="muted">No reviewers</span>}</span>,
                      <Pill key="st" tone={stage.tone}>{stage.label}</Pill>,
                    ]}
                  >
                    <ProposalDetail p={p} data={data} reviewers={s.reviewers} />
                  </ExpandRow>
                );
              })
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function ReviewForm({ item, rubric }: { item: QueueItem; rubric: Queue["rubric"] }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const submit = trpc.network.proposals.review.submit.useMutation();
  const [scores, setScores] = useState<Record<string, number>>(item.scores ?? {});
  const [rec, setRec] = useState<"accept" | "maybe" | "decline" | "">(item.recommendation ?? "");
  const [comment, setComment] = useState(item.comment);
  const ready = rubric.every((r) => scores[r.key]) && !!rec;
  return (
    <div className="col gap-14">
      <div className="grid-3">
        <div className="col" style={{ gap: 2 }}>
          <span className="small muted strong">Format</span>
          <span className="strong">{item.format || "Not set"}</span>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <span className="small muted strong">CE requested</span>
          <span className="strong">{item.ceRequested ? "Yes" : "No"}</span>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <span className="small muted strong">Presenters</span>
          <span className="strong">{item.submitter ? [item.submitter.name, ...item.submitter.coPresenters].join("; ") : `${item.presenters} presenter${item.presenters === 1 ? "" : "s"}, names hidden`}</span>
        </div>
      </div>
      <div className="col gap-4">
        <span className="small muted strong">Abstract</span>
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{item.abstract}</div>
      </div>
      {item.objectives.length ? (
        <div className="col gap-4">
          <span className="small muted strong">Learning objectives</span>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {item.objectives.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {item.submitter?.bio ? (
        <div className="col gap-4">
          <span className="small muted strong">Bio</span>
          <div style={{ whiteSpace: "pre-wrap" }}>{item.submitter.bio}</div>
        </div>
      ) : null}
      <div className="grid-4">
        {rubric.map((r) => (
          <Field key={r.key} label={r.label}>
            <select className="select" value={scores[r.key] ?? ""} onChange={(e) => setScores({ ...scores, [r.key]: Number(e.target.value) })}>
              <option value="">Score</option>
              {Array.from({ length: r.max }, (_, i) => r.max - i).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <Field label="Recommendation">
          <select className="select" value={rec} onChange={(e) => setRec(e.target.value as typeof rec)}>
            <option value="">Pick one</option>
            <option value="accept">Accept</option>
            <option value="maybe">Maybe</option>
            <option value="decline">Decline</option>
          </select>
        </Field>
      </div>
      <Field label="Comment for the committee">
        <textarea className="textarea" rows={3} maxLength={3000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w-lg"
          disabled={!ready || submit.isPending}
          onClick={async () => {
            if (!rec) return;
            try {
              await submit.mutateAsync({ eventId: ev.id, assignmentId: item.assignmentId, scores, recommendation: rec, comment: comment.trim() });
              await utils.network.proposals.review.queue.invalidate();
              toast("Review saved");
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          {item.submittedAt ? "Update review" : "Submit review"}
        </button>
      </div>
    </div>
  );
}

function ReviewQueue() {
  const ev = useAdminEvent();
  const q = trpc.network.proposals.review.queue.useQuery({ eventId: ev.id });
  const [open, setOpen] = useState<number | null>(null);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data!;
  const left = d.items.filter((i) => !i.submittedAt).length;
  const cols = "2.6fr 1fr 1.4fr 1fr 96px";
  return (
    <>
      <div className="grid-4">
        <Kpi label="Assigned to you" value={d.items.length} />
        <Kpi label="Left to review" value={left} />
      </div>
      {d.blind ? <div className="banner banner-ok">Blind review is on. Presenter names are hidden.</div> : null}
      <div className="table">
        <div className="table-inner">
          <THead cols={cols} labels={["Proposal", "Track", "Format", "Your review", ""]} />
          {!d.items.length ? (
            <Empty>No proposals are assigned to you yet.</Empty>
          ) : (
            d.items.map((i) => (
              <ExpandRow
                key={i.assignmentId}
                cols={cols}
                open={open === i.assignmentId}
                onToggle={() => setOpen(open === i.assignmentId ? null : i.assignmentId)}
                closedLabel={i.submittedAt ? "Details" : "Review"}
                cells={[
                  <span key="t" className="strong">{i.title}</span>,
                  <span key="tr">{i.track}</span>,
                  <span key="f">{i.format}</span>,
                  i.submittedAt ? <Pill key="s">Done</Pill> : <Pill key="s" tone="orange">To review</Pill>,
                ]}
              >
                <ReviewForm item={i} rubric={d.rubric} />
              </ExpandRow>
            ))
          )}
        </div>
      </div>
    </>
  );
}

/** /admin/e/:eventId/proposals */
export function AdminProposalsScreen() {
  const ev = useAdminEvent();
  const mode = trpc.network.proposals.admin.mode.useQuery({ eventId: ev.id });
  const [tab, setTab] = useState<"all" | "mine">("all");
  if (mode.isLoading) return <AdminPage title="Call for proposals"><PageLoading /></AdminPage>;
  if (mode.error) return <AdminPage title="Call for proposals"><ErrorNote error={mode.error} /></AdminPage>;
  const m = mode.data!;
  const both = !!m.full && m.reviewer;
  const showQueue = !m.full || (both && tab === "mine");
  return (
    <AdminPage title={m.full ? "Call for proposals" : "Proposals to review"}>
      {both ? (
        <FolderTabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "all", label: "All proposals" },
            { key: "mine", label: "My reviews" },
          ]}
        />
      ) : null}
      {showQueue ? <ReviewQueue /> : <AdminView />}
    </AdminPage>
  );
}
