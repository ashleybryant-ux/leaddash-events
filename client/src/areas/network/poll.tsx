/** /poll/:sessionId: live polls and audience questions for one session. */
import { useState } from "react";
import { useLocation } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AppScreen, useEventApp } from "../../shells/AttendeeShell";
import { Empty, ErrorNote, Field, PageLoading, Sheet } from "../../ui/components";
import { IconBack } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtRange } from "@shared/format";
import { Composer } from "./shared";

type Live = RouterOutputs["network"]["polls"]["live"];
type Poll = Live["polls"][number];

function PollCard({ poll, presenter, canVote, onChanged }: { poll: Poll; presenter: boolean; canVote: boolean; onChanged: () => Promise<unknown> }) {
  const { slug } = useEventApp();
  const vote = trpc.network.polls.vote.useMutation();
  const setStatus = trpc.network.polls.setStatus.useMutation();
  const remove = trpc.network.polls.remove.useMutation();
  const total = poll.results ? poll.results.reduce((a, b) => a + b, 0) : poll.total;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await onChanged();
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  const showResults = !!poll.results && (poll.myVote !== null || presenter || poll.status === "closed");
  return (
    <div className="card col" style={{ padding: 14, gap: 10 }}>
      <div className="row-between">
        <div className="label-caps" style={{ fontWeight: 800 }}>
          Poll · {total} vote{total === 1 ? "" : "s"}
        </div>
        {poll.status !== "open" ? <span className={`pill${poll.status === "draft" ? " pill-orange" : " pill-gray"}`}>{poll.status === "draft" ? "Not open yet" : "Closed"}</span> : null}
      </div>
      <div style={{ fontSize: 15, fontWeight: 800 }}>{poll.question}</div>
      <div className="col" style={{ gap: 6 }}>
        {poll.options.map((o, i) => {
          if (showResults && poll.results) {
            const pct = total ? Math.round((poll.results[i] / total) * 100) : 0;
            const mine = poll.myVote === i;
            return (
              <div key={i} style={{ position: "relative", height: 38, borderRadius: 9, border: mine ? "1.5px solid var(--brand)" : "1px solid #D5DEDA", overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: mine ? "var(--brand-tint)" : "var(--line-2)" }} />
                <div style={{ position: "relative", height: "100%", padding: "0 12px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13, fontWeight: mine ? 700 : 600 }}>
                  <span className="clip">
                    {o}
                    {mine ? " (your vote)" : ""}
                  </span>
                  <span>{pct}%</span>
                </div>
              </div>
            );
          }
          return (
            <button
              key={i}
              type="button"
              disabled={!canVote || poll.status !== "open" || vote.isPending}
              onClick={() => run(() => vote.mutateAsync({ slug, pollId: poll.id, option: i }))}
              style={{ height: 40, borderRadius: 9, border: "1.5px solid var(--brand)", background: "#FFFFFF", color: "var(--brand)", fontSize: 14, fontWeight: 700, textAlign: "left", padding: "0 12px", cursor: "pointer" }}
            >
              {o}
            </button>
          );
        })}
      </div>
      {presenter ? (
        <div className="row gap-8">
          {poll.status !== "open" ? (
            <button className="btn btn-sm btn-solid btn-w" disabled={setStatus.isPending} onClick={() => run(() => setStatus.mutateAsync({ slug, pollId: poll.id, status: "open" }))}>
              {poll.status === "closed" ? "Reopen" : "Open"}
            </button>
          ) : (
            <button className="btn btn-sm btn-w" disabled={setStatus.isPending} onClick={() => run(() => setStatus.mutateAsync({ slug, pollId: poll.id, status: "closed" }))}>
              Close
            </button>
          )}
          <button
            className="btn btn-sm btn-w btn-danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm("Delete this poll and its votes?")) void run(() => remove.mutateAsync({ slug, pollId: poll.id }));
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NewPollSheet({ open, onClose, sessionId, onDone }: { open: boolean; onClose: () => void; sessionId: number; onDone: () => Promise<unknown> }) {
  const { slug } = useEventApp();
  const create = trpc.network.polls.create.useMutation();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const clean = options.map((o) => o.trim()).filter(Boolean);
  const submit = async (openNow: boolean) => {
    try {
      await create.mutateAsync({ slug, sessionId, question: question.trim(), options: clean, open: openNow });
      setQuestion("");
      setOptions(["", ""]);
      await onDone();
      onClose();
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} label="New poll">
      <div className="h3">New poll</div>
      <Field label="Question">
        <input className="input" value={question} maxLength={300} onChange={(e) => setQuestion(e.target.value)} />
      </Field>
      {options.map((o, i) => (
        <div key={i} className="row gap-8">
          <input className="input grow" aria-label={`Answer ${i + 1}`} placeholder={`Answer ${i + 1}`} value={o} maxLength={120} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} />
          {options.length > 2 ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOptions(options.filter((_, j) => j !== i))}>
              Remove
            </button>
          ) : null}
        </div>
      ))}
      {options.length < 6 ? (
        <button type="button" className="btn btn-sm" onClick={() => setOptions([...options, ""])}>
          Add answer
        </button>
      ) : null}
      <div className="grid-2">
        <button className="btn" disabled={create.isPending || question.trim().length < 3 || clean.length < 2} onClick={() => submit(false)}>
          Save for later
        </button>
        <button className="btn btn-primary" disabled={create.isPending || question.trim().length < 3 || clean.length < 2} onClick={() => submit(true)}>
          Open now
        </button>
      </div>
    </Sheet>
  );
}

/** /poll/:sessionId */
export function LivePollScreen({ sessionId }: { sessionId: number }) {
  const { slug, base } = useEventApp();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const live = trpc.network.polls.live.useQuery({ slug, sessionId }, { refetchInterval: 4000 });
  const ask = trpc.network.polls.ask.useMutation();
  const upvote = trpc.network.polls.upvote.useMutation();
  const mark = trpc.network.polls.markQuestion.useMutation();
  const [anonymous, setAnonymous] = useState(false);
  const [newPoll, setNewPoll] = useState(false);
  const refresh = () => utils.network.polls.live.invalidate({ slug, sessionId });
  const d = live.data;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      toast(errorText(err), true);
    }
  };

  return (
    <AppScreen
      header={
        <header className="app-bar" style={{ padding: "calc(10px + env(safe-area-inset-top)) 12px 10px" }}>
          <button className="icon-btn" aria-label="Back to session" onClick={() => navigate(`${base}/session/${sessionId}`)}>
            <IconBack />
          </button>
          <div className="grow col" style={{ gap: 0, minWidth: 0 }}>
            <span className="clip" style={{ fontSize: 15, fontWeight: 800 }}>{d?.session.title ?? ""}</span>
            {d ? (
              <span className="small" style={{ color: d.session.live ? "var(--brand)" : "var(--muted)", fontWeight: 700 }}>
                {d.session.live ? "Live now" : `${fmtDate(d.session.date)} · ${fmtRange(d.session.startTime, d.session.endTime)}`}
                {d.session.room ? ` · ${d.session.room}` : ""}
              </span>
            ) : null}
          </div>
          {d?.presenter ? (
            <button className="btn btn-sm" style={{ width: 88, padding: 0 }} onClick={() => setNewPoll(true)}>
              New poll
            </button>
          ) : null}
        </header>
      }
      footer={
        d?.canVote ? (
          <Composer
            placeholder="Ask the speaker a question"
            busy={ask.isPending}
            above={
              <label className="check small" style={{ fontSize: 12 }}>
                <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
                Ask without my name
              </label>
            }
            onSend={async (body) => {
              if (body.length < 3) {
                toast("Write a little more.", true);
                throw new Error("short");
              }
              try {
                await ask.mutateAsync({ slug, sessionId, body, anonymous });
                await refresh();
                toast("Question sent");
              } catch (err) {
                toast(errorText(err), true);
                throw err;
              }
            }}
          />
        ) : null
      }
      bodyStyle={{ gap: 12 }}
    >
      {live.isLoading ? (
        <PageLoading />
      ) : live.error ? (
        <ErrorNote error={live.error} />
      ) : d ? (
        <>
          {!d.polls.length ? (d.presenter ? <Empty>No polls yet. Tap New poll to add one.</Empty> : null) : null}
          {d.polls.map((p) => (
            <PollCard key={p.id} poll={p} presenter={d.presenter} canVote={d.canVote} onChanged={refresh} />
          ))}
          <div className="section-title" style={{ paddingTop: 2 }}>Questions for the speaker</div>
          {!d.questions.length ? (
            <Empty>No questions yet.</Empty>
          ) : (
            <div className="card list" style={{ overflow: "hidden" }}>
              {d.questions.map((q) => (
                <div key={q.id} className="col" style={{ padding: "12px 14px", gap: 8, opacity: q.hidden ? 0.55 : 1 }}>
                  <div className="row" style={{ gap: 12 }}>
                    <button
                      type="button"
                      aria-label={`Upvote, ${q.votes} votes`}
                      aria-pressed={q.voted}
                      disabled={!d.canVote || q.voted || q.mine || upvote.isPending}
                      onClick={() => run(() => upvote.mutateAsync({ slug, questionId: q.id }))}
                      style={{ width: 48, height: 48, flexShrink: 0, borderRadius: 10, border: q.voted ? "1.5px solid var(--brand)" : "1px solid #D5DEDA", background: q.voted ? "var(--brand-tint)" : "#FFFFFF", color: q.voted ? "var(--brand)" : "var(--ink)", fontSize: 13, fontWeight: q.voted ? 800 : 700, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M6 15l6-6 6 6" />
                      </svg>
                      {q.votes}
                    </button>
                    <span className="grow col" style={{ gap: 2 }}>
                      <span style={{ fontSize: 14, lineHeight: 1.45 }}>{q.body}</span>
                      <span className="small muted">
                        {[q.askedBy || "Anonymous", q.answered ? "Answered" : "", q.hidden ? "Hidden" : ""].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </div>
                  {d.presenter ? (
                    <div className="row gap-8" style={{ paddingLeft: 60 }}>
                      <button className="btn btn-xs" style={{ width: 96, padding: 0 }} disabled={mark.isPending} onClick={() => run(() => mark.mutateAsync({ slug, questionId: q.id, answered: !q.answered }))}>
                        {q.answered ? "Not answered" : "Answered"}
                      </button>
                      <button className="btn btn-xs" style={{ width: 96, padding: 0 }} disabled={mark.isPending} onClick={() => run(() => mark.mutateAsync({ slug, questionId: q.id, hidden: !q.hidden }))}>
                        {q.hidden ? "Show" : "Hide"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {d.presenter ? <NewPollSheet open={newPoll} onClose={() => setNewPoll(false)} sessionId={sessionId} onDone={refresh} /> : null}
        </>
      ) : null}
    </AppScreen>
  );
}
