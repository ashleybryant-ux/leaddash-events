/** Admin: announcements, help center (questions, requests, lost and found), dining, About your host, branding. */
import { useState, type ReactNode } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { EditSection, Empty, ErrorNote, ExpandRow, Field, FolderTabs, PageLoading, Pill, QR, THead, UploadButton, confirmAction } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { eachDay, fmtDate, fmtDates, fmtRange, fmtTime, fmtWhen, fmtWhenTime } from "@shared/format";
import { Facts, Section } from "./adminProgram";
import { brandStyle, loadBrandFont } from "../../shells/AttendeeShell";
import {
  BACKGROUND_LABELS,
  BUTTON_TEXT_LABELS,
  FONTS,
  HEADER_LABELS,
  LOOK_BACKGROUNDS,
  LOOK_BUTTON_TEXT,
  LOOK_FONTS,
  LOOK_HEADERS,
  LOOK_SHAPES,
  LOOK_TEXT_SIZES,
  SHAPE_LABELS,
  SHAPE_RADIUS,
  TEXT_SIZE_LABELS,
  THEMES,
  brandWarnings,
  buttonInk,
  colorsFromPixels,
  mix,
  readableOn,
  type Look,
} from "@shared/brand";

const dateSub = (e: { startDate: string; endDate: string }) => fmtDates(e.startDate, e.endDate);

/* ---------------- Announcements ---------------- */

type Announcement = RouterOutputs["program"]["announcements"]["list"][number];
type Audience = Announcement["audience"];

const AUDIENCES: { key: Audience; label: string }[] = [
  { key: "everyone", label: "Everyone" },
  { key: "checked_in", label: "Checked in" },
  { key: "not_checked_in", label: "Not checked in yet" },
  { key: "speakers", label: "Speakers" },
  { key: "vendors", label: "Exhibitors" },
  { key: "ticket", label: "One ticket type" },
  { key: "session", label: "People in a session" },
];

type AnnounceForm = { title: string; body: string; audience: Audience; ticketTypeId: number | null; sessionId: number | null; url: string; sendPush: boolean; sendEmail: boolean; when: "now" | "later"; sendAt: string };

const blankAnnounce: AnnounceForm = { title: "", body: "", audience: "everyone", ticketTypeId: null, sessionId: null, url: "", sendPush: true, sendEmail: false, when: "now", sendAt: "" };

/** Date to the value of a datetime-local input (the admin's own clock). */
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function audienceLabel(a: Announcement) {
  if (a.audience === "session") return a.sessionTitle ? `People in ${a.sessionTitle}` : "People in a session";
  if (a.audience === "ticket") return a.ticketName ? `${a.ticketName} tickets` : "One ticket type";
  return AUDIENCES.find((x) => x.key === a.audience)?.label ?? a.audience;
}

function AnnounceEditor({ existing, onDone }: { existing?: Announcement; onDone?: () => void }) {
  const event = useAdminEvent();
  const utils = trpc.useUtils();
  const opts = trpc.program.announcements.options.useQuery({ eventId: event.id });
  const create = trpc.program.announcements.create.useMutation();
  const update = trpc.program.announcements.update.useMutation();
  const del = trpc.program.announcements.delete.useMutation();
  const [f, setF] = useState<AnnounceForm>(() =>
    existing
      ? { title: existing.title, body: existing.body, audience: existing.audience, ticketTypeId: existing.ticketTypeId, sessionId: existing.sessionId, url: existing.url, sendPush: existing.sendPush, sendEmail: existing.sendEmail, when: existing.sendAt ? "later" : "now", sendAt: existing.sendAt ? toLocalInput(new Date(existing.sendAt)) : "" }
      : blankAnnounce
  );
  const o = opts.data;
  const count = (k: Audience) => (o && k in o.counts ? ` (${o.counts[k as keyof typeof o.counts]})` : "");
  const busy = create.isPending || update.isPending;
  const submit = async (draft: boolean) => {
    if (!draft && !f.sendPush && !f.sendEmail) return toast("Pick push, email or both.", true);
    if (!draft && f.when === "later" && !f.sendAt) return toast("Pick when to send it.", true);
    const input = {
      eventId: event.id,
      title: f.title,
      body: f.body,
      audience: f.audience,
      ticketTypeId: f.audience === "ticket" ? f.ticketTypeId : null,
      sessionId: f.audience === "session" ? f.sessionId : null,
      url: f.url,
      sendPush: f.sendPush,
      sendEmail: f.sendEmail,
      sendAt: f.when === "later" && f.sendAt ? new Date(f.sendAt).getTime() : null,
      draft,
    };
    try {
      const res = existing ? await update.mutateAsync({ ...input, id: existing.id }) : await create.mutateAsync(input);
      await utils.program.announcements.list.invalidate({ eventId: event.id });
      if (!existing) setF(blankAnnounce);
      toast(draft ? "Draft saved" : input.sendAt ? `Scheduled for ${fmtWhenTime(input.sendAt)}` : `Sent to ${res.recipients} ${res.recipients === 1 ? "person" : "people"}`);
      onDone?.();
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  return (
    <div className="col gap-12">
      <div className="grid-2" style={{ gap: 12 }}>
        <Field label="Title">
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Send to">
          <select className="select" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value as Audience })}>
            {AUDIENCES.map((a) => (
              <option key={a.key} value={a.key}>{a.label}{count(a.key)}</option>
            ))}
          </select>
        </Field>
        <Field label="Message" className={f.audience === "session" || f.audience === "ticket" ? "" : "span-2"}>
          <textarea className="textarea" rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
        {f.audience === "session" ? (
          <Field label="Session">
            <select className="select" value={f.sessionId ?? ""} onChange={(e) => setF({ ...f, sessionId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Pick a session</option>
              {(o?.sessions ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.title} ({s.people})</option>
              ))}
            </select>
          </Field>
        ) : f.audience === "ticket" ? (
          <Field label="Ticket type">
            <select className="select" value={f.ticketTypeId ?? ""} onChange={(e) => setF({ ...f, ticketTypeId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Pick a ticket type</option>
              {(o?.tickets ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.people})</option>
              ))}
            </select>
          </Field>
        ) : null}
        <div className="col" style={{ gap: 6 }}>
          <span className="field" style={{ gap: 0 }}>Send by</span>
          <div className="row gap-16">
            <label className="check">
              <input type="checkbox" checked={f.sendPush} onChange={(e) => setF({ ...f, sendPush: e.target.checked })} />
              Push
            </label>
            <label className="check">
              <input type="checkbox" checked={f.sendEmail} onChange={(e) => setF({ ...f, sendEmail: e.target.checked })} />
              Email
            </label>
          </div>
        </div>
        <div className="row gap-10" style={{ alignItems: "flex-end" }}>
          <Field label="When" className="grow">
            <select className="select" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value as "now" | "later", sendAt: e.target.value === "later" && !f.sendAt ? toLocalInput(new Date(Date.now() + 3600_000)) : f.sendAt })}>
              <option value="now">Now</option>
              <option value="later">Schedule for later</option>
            </select>
          </Field>
          {f.when === "later" ? (
            <Field label="Send at" className="grow">
              <input className="input" type="datetime-local" value={f.sendAt} onChange={(e) => setF({ ...f, sendAt: e.target.value })} />
            </Field>
          ) : null}
        </div>
        <Field label="Link (optional)" className="span-2" hint="A page in the app (/e/...) or a website (https://). Empty opens Alerts.">
          <input className="input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder={`/e/${event.slug}/agenda`} />
        </Field>
      </div>
      <div className="row gap-10">
        <button className="btn btn-sm btn-solid btn-w" disabled={busy || f.title.trim().length < 2} onClick={() => submit(false)}>
          {f.when === "later" ? "Schedule" : "Send"}
        </button>
        <button className="btn btn-sm btn-w" disabled={busy || f.title.trim().length < 2} onClick={() => submit(true)}>
          Save draft
        </button>
        {existing ? (
          <button
            className="btn btn-sm btn-danger btn-w"
            disabled={del.isPending}
            onClick={async () => {
              if (!confirmAction(`Delete ${existing.title}?`)) return;
              try {
                await del.mutateAsync({ eventId: event.id, id: existing.id });
                await utils.program.announcements.list.invalidate({ eventId: event.id });
                onDone?.();
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
  );
}

/** /admin/e/:eventId/announcements */
export function AdminAnnounceScreen() {
  const event = useAdminEvent();
  const { can } = useAdmin();
  const q = trpc.program.announcements.list.useQuery({ eventId: event.id });
  const [open, setOpen] = useState<number | null>(null);
  const canEdit = can("announcements", "edit");
  const rows = q.data ?? [];
  const pending = rows.filter((r) => !r.sentAt);
  const sent = rows.filter((r) => r.sentAt);
  const pCols = "minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1.4fr) 96px";
  const sCols = "minmax(0, 2.2fr) minmax(0, 1.4fr) minmax(0, 1.2fr) 80px 96px";
  return (
    <AdminPage title={canEdit ? "New announcement" : "Announcements"} sub={`${event.name} · ${dateSub(event)}`}>
      {canEdit ? (
        <div className="card card-pad">
          <AnnounceEditor />
        </div>
      ) : null}
      {q.isLoading ? <PageLoading /> : q.error ? <ErrorNote error={q.error} /> : null}
      {pending.length ? (
        <div className="col gap-10">
          <span className="section-title">Scheduled and drafts</span>
          <div className="table">
            <div className="table-inner">
              <THead cols={pCols} labels={["Announcement", "Send to", "Status", ""]} />
              {pending.map((a) => (
                <ExpandRow
                  key={a.id}
                  cols={pCols}
                  open={open === a.id}
                  onToggle={() => setOpen(open === a.id ? null : a.id)}
                  closedLabel={canEdit ? "Edit" : "View"}
                  cells={[
                    <span className="strong">{a.title}</span>,
                    <span>{audienceLabel(a)}</span>,
                    a.draft ? <Pill tone="gray">Draft</Pill> : <Pill tone="orange">{`Sends ${fmtWhenTime(a.sendAt)}`}</Pill>,
                  ]}
                >
                  {canEdit ? <AnnounceEditor existing={a} onDone={() => setOpen(null)} /> : <div style={{ whiteSpace: "pre-wrap" }}>{a.body}</div>}
                </ExpandRow>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <div className="col gap-10">
        <span className="section-title">Sent</span>
        {!sent.length && !q.isLoading ? (
          <Empty>Nothing sent yet.</Empty>
        ) : sent.length ? (
          <div className="table">
            <div className="table-inner">
              <THead cols={sCols} labels={["Announcement", "Sent to", "Sent", "Opened", ""]} />
              {sent.map((a) => (
                <ExpandRow
                  key={a.id}
                  cols={sCols}
                  open={open === a.id}
                  onToggle={() => setOpen(open === a.id ? null : a.id)}
                  closedLabel="View"
                  cells={[
                    <span className="strong">{a.title}</span>,
                    <span>{audienceLabel(a)} ({a.recipients})</span>,
                    <span>{fmtWhenTime(a.sentAt)}</span>,
                    <span>{a.openedPercent === null ? <span className="muted">None</span> : `${a.openedPercent}%`}</span>,
                  ]}
                >
                  <Facts
                    items={[
                      { label: "Message", value: a.body, wide: true },
                      { label: "Sent by", value: [a.sendPush ? "Push" : "", a.sendEmail ? "Email" : "", "In-app alert"].filter(Boolean).join(", ") },
                      { label: "Sent", value: fmtWhenTime(a.sentAt) },
                      { label: "From", value: a.createdByName },
                      ...(a.url ? [{ label: "Link", value: a.url }] : []),
                    ]}
                  />
                </ExpandRow>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </AdminPage>
  );
}

/* ---------------- Help center ---------------- */

type HelpTab = "articles" | "requests" | "lost";
type HelpData = RouterOutputs["program"]["help"]["adminGet"];

/** /admin/e/:eventId/help */
export function AdminHelpScreen() {
  const event = useAdminEvent();
  const { can } = useAdmin();
  const q = trpc.program.help.adminGet.useQuery({ eventId: event.id });
  const initial = (() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "requests" || t === "lost" ? t : "articles";
  })() as HelpTab;
  const [tab, setTab] = useState<HelpTab>(initial);
  const canEdit = can("help", "edit");
  const openCount = q.data?.requests.filter((r) => r.status === "open").length ?? 0;
  return (
    <AdminPage title={event.name} sub={dateSub(event)}>
      <div className="col" style={{ gap: 0 }}>
        <FolderTabs
          tabs={[
            { key: "articles", label: "Articles" },
            { key: "requests", label: openCount ? `Requests (${openCount})` : "Requests" },
            { key: "lost", label: "Lost and found" },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="folder-body">
          {q.isLoading ? <PageLoading /> : q.error ? <ErrorNote error={q.error} /> : tab === "articles" ? <HelpArticles d={q.data!} canEdit={canEdit} /> : tab === "requests" ? <HelpRequests d={q.data!} canEdit={canEdit} /> : <LostFoundAdmin d={q.data!} canEdit={canEdit} />}
        </div>
      </div>
    </AdminPage>
  );
}

function useHelpRefresh() {
  const event = useAdminEvent();
  const utils = trpc.useUtils();
  return () => utils.program.help.adminGet.invalidate({ eventId: event.id });
}

function HelpArticles({ d, canEdit }: { d: HelpData; canEdit: boolean }) {
  const event = useAdminEvent();
  const refresh = useHelpRefresh();
  const saveDesk = trpc.program.help.saveDesk.useMutation();
  const [desk, setDesk] = useState({ place: d.desk.place, hours: d.desk.hours, phone: d.desk.phone, lostFoundNote: d.desk.lostFoundNote });
  const [open, setOpen] = useState<number | "new" | null>(null);
  const deskLine = [d.desk.place, d.desk.hours, d.desk.phone].filter(Boolean).join(" · ");
  return (
    <div className="col gap-16">
      <Section
        canEdit={canEdit}
        title="Help desk"
        saving={saveDesk.isPending}
        onCancel={() => setDesk({ place: d.desk.place, hours: d.desk.hours, phone: d.desk.phone, lostFoundNote: d.desk.lostFoundNote })}
        onSave={async () => {
          await saveDesk.mutateAsync({ eventId: event.id, ...desk });
          await refresh();
          toast("Help desk saved");
        }}
        view={<Facts items={[{ label: "Help desk", value: deskLine, wide: true }, { label: "Lost and found note", value: d.desk.lostFoundNote, wide: true }]} />}
        edit={
          <div className="grid-3">
            <Field label="Where">
              <input className="input" value={desk.place} onChange={(e) => setDesk({ ...desk, place: e.target.value })} placeholder="Registration desk, main lobby" />
            </Field>
            <Field label="Hours">
              <input className="input" value={desk.hours} onChange={(e) => setDesk({ ...desk, hours: e.target.value })} placeholder="7:00 AM to 6:00 PM" />
            </Field>
            <Field label="Phone">
              <input className="input" value={desk.phone} onChange={(e) => setDesk({ ...desk, phone: e.target.value })} />
            </Field>
            <Field label="Lost and found note" className="span-all">
              <input className="input" value={desk.lostFoundNote} onChange={(e) => setDesk({ ...desk, lostFoundNote: e.target.value })} />
            </Field>
          </div>
        }
      />
      <div className="divider" />
      <div className="row-between">
        <span className="h3" style={{ fontSize: 14 }}>Common questions</span>
        {canEdit ? (
          <button className="btn btn-sm btn-w-lg" onClick={() => setOpen("new")}>
            Add question
          </button>
        ) : null}
      </div>
      {open === "new" ? <ArticleEditor onDone={() => setOpen(null)} /> : null}
      <div className="col" style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
        {!d.articles.length ? <Empty>No questions yet.</Empty> : null}
        {d.articles.map((a, i) => (
          <div key={a.id} style={{ borderTop: i ? "1px solid var(--line)" : "none", background: open === a.id ? "var(--brand-tint-2)" : "#FFFFFF" }}>
            <div className="row-between" style={{ padding: "10px 14px" }}>
              <span className="col grow" style={{ gap: 2 }}>
                <span className="strong">{a.question}</span>
                <span className="small muted">{a.category}</span>
              </span>
              {canEdit ? (
                <button className={`btn btn-sm btn-w${open === a.id ? " btn-solid" : ""}`} onClick={() => setOpen(open === a.id ? null : a.id)}>
                  {open === a.id ? "Close" : "Edit"}
                </button>
              ) : null}
            </div>
            {open === a.id ? (
              <div style={{ padding: "0 14px 14px" }}>
                <ArticleEditor article={a} onDone={() => setOpen(null)} />
              </div>
            ) : (
              <div className="small" style={{ padding: "0 14px 12px", color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{a.answer}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ArticleEditor({ article, onDone }: { article?: HelpData["articles"][number]; onDone: () => void }) {
  const event = useAdminEvent();
  const refresh = useHelpRefresh();
  const save = trpc.program.help.saveArticle.useMutation();
  const del = trpc.program.help.deleteArticle.useMutation();
  const [f, setF] = useState({ category: article?.category ?? "General", question: article?.question ?? "", answer: article?.answer ?? "", sort: String(article?.sort ?? 0) });
  return (
    <div className="editor" style={{ margin: 0 }}>
      <span className="editor-title">{article ? "Editing question" : "New question"}</span>
      <div className="grid-3">
        <Field label="Question" className="span-2">
          <input className="input" value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} />
        </Field>
        <Field label="Category">
          <input className="input" list="help-cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
          <datalist id="help-cats">
            {["General", "At the venue", "CE credits", "Registration"].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="Answer" className="span-all">
          <textarea className="textarea" rows={3} value={f.answer} onChange={(e) => setF({ ...f, answer: e.target.value })} />
        </Field>
        <Field label="Order">
          <input className="input" inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} />
        </Field>
      </div>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={save.isPending}
          onClick={async () => {
            try {
              await save.mutateAsync({ eventId: event.id, id: article?.id ?? null, category: f.category, question: f.question, answer: f.answer, sort: Math.max(0, Math.round(Number(f.sort)) || 0) });
              await refresh();
              toast("Question saved");
              onDone();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Save
        </button>
        <button className="btn btn-sm btn-w" onClick={onDone}>
          Cancel
        </button>
        {article ? (
          <button
            className="btn btn-sm btn-danger btn-w"
            disabled={del.isPending}
            onClick={async () => {
              if (!confirmAction(`Delete "${article.question}"?`)) return;
              try {
                await del.mutateAsync({ eventId: event.id, id: article.id });
                await refresh();
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
    </div>
  );
}

const REQ_STATUS: Record<string, { label: string; tone: "orange" | "green" | "gray" }> = {
  open: { label: "Open", tone: "orange" },
  answered: { label: "Answered", tone: "green" },
  closed: { label: "Resolved", tone: "gray" },
};

function HelpRequests({ d, canEdit }: { d: HelpData; canEdit: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const openCount = d.requests.filter((r) => r.status === "open").length;
  const cols = "minmax(0, 1.4fr) minmax(0, 2.4fr) minmax(0, 1.2fr) 100px";
  return (
    <div className="col gap-12">
      <div className="row gap-10">
        <span className="h3" style={{ fontSize: 14 }}>Help requests</span>
        {openCount ? <Pill tone="orange">{openCount} open</Pill> : null}
      </div>
      {!d.requests.length ? (
        <Empty>No requests yet. Attendees send them from Help in the app.</Empty>
      ) : (
        <div className="table" style={{ border: "1px solid var(--line)" }}>
          <div className="table-inner">
            <THead cols={`${cols} 96px`} labels={["Attendee", "Message", "Sent", "Status", ""]} />
            {d.requests.map((r) => {
              const st = REQ_STATUS[r.status];
              return (
                <ExpandRow
                  key={r.id}
                  cols={`${cols} 96px`}
                  open={open === r.id}
                  onToggle={() => setOpen(open === r.id ? null : r.id)}
                  closedLabel={r.status === "open" && canEdit ? "Reply" : "View"}
                  cells={[
                    <span className="strong clip">{r.attendeeName}</span>,
                    <span className="col" style={{ gap: 0 }}>
                      <span className="strong small">{r.topic}</span>
                      <span className="clip">{r.message}</span>
                    </span>,
                    <span className="small">{fmtWhenTime(r.createdAt)}</span>,
                    <Pill tone={st.tone}>{st.label}</Pill>,
                  ]}
                >
                  <RequestPanel r={r} canEdit={canEdit} onDone={() => setOpen(null)} />
                </ExpandRow>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function RequestPanel({ r, canEdit, onDone }: { r: HelpData["requests"][number]; canEdit: boolean; onDone: () => void }) {
  const event = useAdminEvent();
  const refresh = useHelpRefresh();
  const reply = trpc.program.help.reply.useMutation();
  const status = trpc.program.help.setRequestStatus.useMutation();
  const [text, setText] = useState(r.reply);
  return (
    <div className="col gap-12">
      <Facts
        items={[
          { label: "From", value: r.attendeeEmail ? `${r.attendeeName} (${r.attendeeEmail})` : r.attendeeName },
          { label: "Topic", value: r.topic },
          { label: "Sent", value: fmtWhenTime(r.createdAt) },
          { label: "Message", value: r.message, wide: true },
          ...(r.reply ? [{ label: `Reply${r.repliedByName ? ` from ${r.repliedByName}` : ""}${r.repliedAt ? `, ${fmtWhenTime(r.repliedAt)}` : ""}`, value: r.reply, wide: true }] : []),
        ]}
      />
      {canEdit ? (
        <>
          {r.status !== "closed" ? (
            <Field label={r.reply ? "Update the reply" : "Reply"} hint="The attendee gets an alert in the app.">
              <textarea className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          ) : null}
          <div className="row gap-10">
            {r.status !== "closed" ? (
              <button
                className="btn btn-sm btn-solid btn-w"
                disabled={reply.isPending || !text.trim()}
                onClick={async () => {
                  try {
                    await reply.mutateAsync({ eventId: event.id, id: r.id, reply: text });
                    await refresh();
                    toast("Reply sent");
                    onDone();
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Send reply
              </button>
            ) : null}
            <button
              className="btn btn-sm btn-w"
              disabled={status.isPending}
              onClick={async () => {
                try {
                  await status.mutateAsync({ eventId: event.id, id: r.id, status: r.status === "closed" ? "open" : "closed" });
                  await refresh();
                  onDone();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              {r.status === "closed" ? "Reopen" : "Resolve"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

const LOST_CATS = ["Phone", "Keys", "Wallet", "Bag", "Clothing", "Other"] as const;
type LostCat = (typeof LOST_CATS)[number];

function itemStatus(i: HelpData["lostFound"][number]): { label: string; tone: "orange" | "green" | "gray" } {
  if (i.status === "returned") return { label: "Picked up", tone: "gray" };
  if (i.kind === "lost") return i.status === "claimed" ? { label: "Owner notified", tone: "green" } : { label: "Looking", tone: "orange" };
  return i.status === "claimed" ? { label: "Owner notified", tone: "green" } : { label: "At help desk", tone: "orange" };
}

function LostFoundAdmin({ d, canEdit }: { d: HelpData; canEdit: boolean }) {
  const event = useAdminEvent();
  const refresh = useHelpRefresh();
  const setStatus = trpc.program.help.setItemStatus.useMutation();
  const [open, setOpen] = useState<number | "new" | null>(null);
  const cols = "120px minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1.3fr) 130px 96px";
  const act = async (id: number, status: "open" | "claimed" | "returned", msg: string) => {
    try {
      await setStatus.mutateAsync({ eventId: event.id, id, status });
      await refresh();
      toast(msg);
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  return (
    <div className="col gap-12">
      <div className="row-between">
        <span className="h3" style={{ fontSize: 14 }}>Lost and found</span>
        {canEdit ? (
          <button className="btn btn-sm btn-w-lg" onClick={() => setOpen("new")}>
            Log found item
          </button>
        ) : null}
      </div>
      {open === "new" ? <ItemEditor places={d.rooms} onDone={() => setOpen(null)} /> : null}
      {!d.lostFound.length ? (
        <Empty>Nothing reported yet.</Empty>
      ) : (
        <div className="table" style={{ border: "1px solid var(--line)" }}>
          <div className="table-inner">
            <THead cols={cols} labels={["Kind", "Item", "Where", "Owner", "Status", ""]} />
            {d.lostFound.map((i) => {
              const st = itemStatus(i);
              const isOpen = open === i.id;
              let action: ReactNode = null;
              if (canEdit) {
                if (i.status === "returned") action = <button className="btn btn-sm btn-w" disabled={setStatus.isPending} onClick={() => act(i.id, "open", "Reopened")}>Reopen</button>;
                else if (i.kind === "lost" && i.status === "open") action = <button className="btn btn-sm btn-w" disabled={setStatus.isPending} onClick={() => act(i.id, "claimed", "Owner notified")}>Mark found</button>;
                else if (i.status === "claimed") action = <button className="btn btn-sm btn-w" disabled={setStatus.isPending} onClick={() => act(i.id, "returned", "Marked picked up")}>Picked up</button>;
                else action = <button className={`btn btn-sm btn-w${isOpen ? " btn-solid" : ""}`} onClick={() => setOpen(isOpen ? null : i.id)}>{isOpen ? "Close" : "Edit"}</button>;
              }
              return (
                <div key={i.id} className={isOpen ? "trow-open" : ""} style={{ borderBottom: "1px solid var(--line)" }}>
                  <div className="trow" style={{ gridTemplateColumns: cols, borderBottom: "none" }}>
                    <span>{i.kind === "lost" ? "Reported lost" : "Turned in"}</span>
                    <span className="row gap-8" style={{ minWidth: 0 }}>
                      {i.photoUrl ? <img src={i.photoUrl} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: "cover" }} /> : null}
                      <span className="col" style={{ gap: 0, minWidth: 0 }}>
                        <span className="strong clip">{i.item}</span>
                        <span className="small muted">{i.category} · {fmtWhen(i.createdAt)}</span>
                      </span>
                    </span>
                    <span className="clip">{i.place || <span className="muted">Not sure</span>}</span>
                    <span className="clip">{i.ownerName || <span className="muted">Unclaimed</span>}</span>
                    <span><Pill tone={st.tone}>{st.label}</Pill></span>
                    <span>{action}</span>
                  </div>
                  {isOpen ? (
                    <div className="editor">
                      <ItemEditor item={i} places={d.rooms} onDone={() => setOpen(null)} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ItemEditor({ item, places, onDone }: { item?: HelpData["lostFound"][number]; places: string[]; onDone: () => void }) {
  const event = useAdminEvent();
  const refresh = useHelpRefresh();
  const save = trpc.program.help.saveItem.useMutation();
  const del = trpc.program.help.deleteItem.useMutation();
  const setStatus = trpc.program.help.setItemStatus.useMutation();
  const [f, setF] = useState({ category: (item?.category || "Other") as LostCat, item: item?.item ?? "", description: item?.description ?? "", place: item?.place ?? "", photoFileId: item?.photoFileId ?? null, photoUrl: item?.photoUrl ?? null });
  return (
    <div className="col gap-12" style={item ? undefined : { border: "1px solid var(--line)", borderRadius: 10, padding: 14 }}>
      <span className="editor-title">{item ? "Editing item" : "Found item"}</span>
      <div className="grid-3">
        <Field label="Item">
          <input className="input" value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} placeholder="Car keys with a blue lanyard" />
        </Field>
        <Field label="Kind of item">
          <select className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as LostCat })}>
            {LOST_CATS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Where it was found">
          <input className="input" list="lf-places" value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} />
          <datalist id="lf-places">
            {places.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>
        <Field label="Notes (staff only)" className="span-2">
          <input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <div className="row gap-8" style={{ alignItems: "flex-end" }}>
          {f.photoUrl ? <img src={f.photoUrl} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: "cover" }} /> : null}
          <UploadButton label={f.photoFileId ? "New photo" : "Add photo"} eventId={event.id} onUploaded={(file) => setF({ ...f, photoFileId: file.id, photoUrl: file.url })} />
        </div>
      </div>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={save.isPending || f.item.trim().length < 2}
          onClick={async () => {
            try {
              await save.mutateAsync({ eventId: event.id, id: item?.id ?? null, category: f.category, item: f.item, description: f.description, place: f.place, photoFileId: f.photoFileId });
              await refresh();
              toast("Item saved");
              onDone();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Save
        </button>
        <button className="btn btn-sm btn-w" onClick={onDone}>
          Cancel
        </button>
        {item ? (
          <>
            <button
              className="btn btn-sm btn-w"
              disabled={setStatus.isPending}
              onClick={async () => {
                try {
                  await setStatus.mutateAsync({ eventId: event.id, id: item.id, status: "returned" });
                  await refresh();
                  onDone();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Picked up
            </button>
            <button
              className="btn btn-sm btn-danger btn-w"
              disabled={del.isPending}
              onClick={async () => {
                if (!confirmAction(`Delete ${item.item}?`)) return;
                try {
                  await del.mutateAsync({ eventId: event.id, id: item.id });
                  await refresh();
                  onDone();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Delete
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- Dining ---------------- */

type DiningData = RouterOutputs["program"]["dining"]["adminList"];
type Meal = DiningData["menu"][number];
type Place = DiningData["nearby"][number];
type Diet = "V" | "VG" | "GF" | "DF" | "NF" | "H" | "K";

const DIET_CHOICES: { label: string; tags: Diet[] }[] = [
  { label: "None", tags: [] },
  { label: "Vegetarian", tags: ["V"] },
  { label: "Vegan", tags: ["VG"] },
  { label: "Gluten free", tags: ["GF"] },
  { label: "Vegan, gluten free", tags: ["VG", "GF"] },
  { label: "Vegetarian, gluten free", tags: ["V", "GF"] },
  { label: "Dairy free", tags: ["DF"] },
  { label: "Nut free", tags: ["NF"] },
  { label: "Halal", tags: ["H"] },
  { label: "Kosher", tags: ["K"] },
];
const dietKey = (tags: string[]) => [...tags].sort().join(",");
const dietLabel = (tags: string[]) => DIET_CHOICES.find((c) => dietKey(c.tags) === dietKey(tags))?.label ?? tags.join(", ");

const PLACE_TYPES = [
  { key: "", label: "Other" },
  { key: "quick", label: "Quick bite" },
  { key: "sitdown", label: "Sit-down" },
  { key: "coffee", label: "Coffee" },
] as const;
type PlaceType = (typeof PLACE_TYPES)[number]["key"];
type Price = "" | "$" | "$$" | "$$$" | "$$$$";

/** /admin/e/:eventId/dining */
export function AdminDiningScreen() {
  const event = useAdminEvent();
  const q = trpc.program.dining.adminList.useQuery({ eventId: event.id });
  const [open, setOpen] = useState<string | null>(null);
  const mCols = "120px minmax(0, 1.2fr) minmax(0, 1.4fr) minmax(0, 1.2fr) 60px 96px";
  const pCols = "minmax(0, 1.8fr) 110px 60px 70px minmax(0, 1.3fr) 96px";
  return (
    <AdminPage title={event.name} sub={dateSub(event)}>
      {!event.features.dining ? <div className="banner banner-warn">Dining is turned off in the app. Turn it on in Branding.</div> : null}
      {q.isLoading ? (
        <PageLoading />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : (
        <>
          <div className="card col" style={{ overflow: "hidden", gap: 0 }}>
            <div className="row-between" style={{ padding: "14px 18px" }}>
              <span className="h3">Event menu</span>
              <button className="btn btn-sm btn-w" onClick={() => setOpen("meal:new")}>Add meal</button>
            </div>
            {open === "meal:new" ? (
              <div className="editor">
                <MealEditor onDone={() => setOpen(null)} />
              </div>
            ) : null}
            <div style={{ overflowX: "auto", borderTop: "1px solid var(--line)" }}>
              <div className="table-inner">
                <THead cols={mCols} labels={["Date", "Meal", "Time", "Location", "Items", ""]} />
                {!q.data!.menu.length ? <Empty>No meals yet.</Empty> : null}
                {q.data!.menu.map((m) => (
                  <ExpandRow
                    key={m.id}
                    cols={mCols}
                    open={open === `meal:${m.id}`}
                    onToggle={() => setOpen(open === `meal:${m.id}` ? null : `meal:${m.id}`)}
                    closedLabel="Edit"
                    cells={[
                      <span>{fmtDate(m.date)}</span>,
                      <span className="strong">{m.meal || m.title}</span>,
                      <span>{m.time && m.endTime ? fmtRange(m.time, m.endTime) : fmtTime(m.time) || <span className="muted">Not set</span>}</span>,
                      <span className="clip">{m.location || <span className="muted">Not set</span>}</span>,
                      <span>{m.items.length}</span>,
                    ]}
                  >
                    <MealEditor meal={m} onDone={() => setOpen(null)} />
                  </ExpandRow>
                ))}
              </div>
            </div>
          </div>
          <div className="card col" style={{ overflow: "hidden", gap: 0 }}>
            <div className="row-between" style={{ padding: "14px 18px" }}>
              <span className="h3">Near the venue</span>
              <button className="btn btn-sm btn-w" onClick={() => setOpen("place:new")}>Add place</button>
            </div>
            {open === "place:new" ? (
              <div className="editor">
                <PlaceEditor onDone={() => setOpen(null)} />
              </div>
            ) : null}
            <div style={{ overflowX: "auto", borderTop: "1px solid var(--line)" }}>
              <div className="table-inner">
                <THead cols={pCols} labels={["Place", "Type", "Price", "Walk", "Attendee offer", ""]} />
                {!q.data!.nearby.length ? <Empty>No places yet.</Empty> : null}
                {q.data!.nearby.map((p) => (
                  <ExpandRow
                    key={p.id}
                    cols={pCols}
                    open={open === `place:${p.id}`}
                    onToggle={() => setOpen(open === `place:${p.id}` ? null : `place:${p.id}`)}
                    closedLabel="Edit"
                    cells={[
                      <span className="col" style={{ gap: 0 }}>
                        <span className="strong clip">{p.title}</span>
                        {p.cuisine ? <span className="small muted">{p.cuisine}</span> : null}
                      </span>,
                      <span>{PLACE_TYPES.find((t) => t.key === p.category)?.label ?? "Other"}</span>,
                      <span>{p.price || <span className="muted">None</span>}</span>,
                      <span>{p.walkMinutes !== null ? `${p.walkMinutes} min` : <span className="muted">None</span>}</span>,
                      <span className="clip">{p.note || <span className="muted">None</span>}</span>,
                    ]}
                  >
                    <PlaceEditor place={p} onDone={() => setOpen(null)} />
                  </ExpandRow>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </AdminPage>
  );
}

function DiningButtons({ saving, onSave, onCancel, onDelete }: { saving: boolean; onSave: () => void; onCancel: () => void; onDelete?: () => void }) {
  return (
    <div className="row gap-10">
      <button className="btn btn-sm btn-solid btn-w" disabled={saving} onClick={onSave}>Save</button>
      <button className="btn btn-sm btn-w" onClick={onCancel}>Cancel</button>
      {onDelete ? <button className="btn btn-sm btn-danger btn-w" onClick={onDelete}>Delete</button> : null}
    </div>
  );
}

function useDiningActions(onDone: () => void) {
  const event = useAdminEvent();
  const utils = trpc.useUtils();
  const del = trpc.program.dining.delete.useMutation();
  const refresh = () => utils.program.dining.adminList.invalidate({ eventId: event.id });
  return {
    refresh,
    remove: async (id: number, name: string) => {
      if (!confirmAction(`Delete ${name}?`)) return;
      try {
        await del.mutateAsync({ eventId: event.id, id });
        await refresh();
        onDone();
      } catch (err) {
        toast(errorText(err), true);
      }
    },
  };
}

function MealEditor({ meal, onDone }: { meal?: Meal; onDone: () => void }) {
  const event = useAdminEvent();
  const save = trpc.program.dining.saveMeal.useMutation();
  const { refresh, remove } = useDiningActions(onDone);
  const days = eachDay(event.startDate, event.endDate);
  const [f, setF] = useState({ date: meal?.date ?? days[0], meal: meal?.meal || meal?.title || "", time: meal?.time ?? "", endTime: meal?.endTime ?? "", location: meal?.location ?? "", note: meal?.note ?? "", items: (meal?.items ?? []).map((i) => ({ name: i.name, dietary: i.dietary as Diet[] })) });
  return (
    <div className="col gap-12">
      <span className="editor-title">{meal ? "Editing meal" : "New meal"}</span>
      <div className="grid-3">
        <Field label="Date">
          <select className="select" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })}>
            {days.map((d) => (
              <option key={d} value={d}>{fmtDate(d)}</option>
            ))}
          </select>
        </Field>
        <Field label="Meal">
          <input className="input" list="meal-names" value={f.meal} onChange={(e) => setF({ ...f, meal: e.target.value })} />
          <datalist id="meal-names">
            {["Breakfast", "Lunch", "Dinner", "Coffee break", "Welcome reception"].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Location">
          <input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
        </Field>
        <Field label="Start">
          <input className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
        </Field>
        <Field label="End">
          <input className="input" type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} />
        </Field>
        <Field label="Note">
          <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Bring your badge" />
        </Field>
      </div>
      <div className="col gap-8">
        <div className="row gap-10 small strong muted">
          <span className="grow">Menu item</span>
          <span style={{ width: 200 }}>Dietary label</span>
          <span style={{ width: 96 }} />
        </div>
        {f.items.map((it, idx) => (
          <div key={idx} className="row gap-10">
            <input className="input grow" aria-label="Menu item" value={it.name} onChange={(e) => setF({ ...f, items: f.items.map((x, j) => (j === idx ? { ...x, name: e.target.value } : x)) })} />
            <select
              className="select"
              style={{ width: 200 }}
              aria-label="Dietary label"
              value={dietKey(it.dietary)}
              onChange={(e) => setF({ ...f, items: f.items.map((x, j) => (j === idx ? { ...x, dietary: DIET_CHOICES.find((c) => dietKey(c.tags) === e.target.value)?.tags ?? [] } : x)) })}
            >
              {DIET_CHOICES.some((c) => dietKey(c.tags) === dietKey(it.dietary)) ? null : <option value={dietKey(it.dietary)}>{dietLabel(it.dietary)}</option>}
              {DIET_CHOICES.map((c) => (
                <option key={c.label} value={dietKey(c.tags)}>{c.label}</option>
              ))}
            </select>
            <button className="btn btn-sm btn-w" onClick={() => setF({ ...f, items: f.items.filter((_, j) => j !== idx) })}>Remove</button>
          </div>
        ))}
        <div>
          <button className="btn btn-sm btn-w" onClick={() => setF({ ...f, items: [...f.items, { name: "", dietary: [] }] })}>Add item</button>
        </div>
      </div>
      <DiningButtons
        saving={save.isPending}
        onCancel={onDone}
        onDelete={meal ? () => remove(meal.id, meal.meal || meal.title) : undefined}
        onSave={async () => {
          try {
            await save.mutateAsync({ eventId: event.id, id: meal?.id ?? null, date: f.date, meal: f.meal, time: f.time, endTime: f.endTime, location: f.location, note: f.note, items: f.items.filter((i) => i.name.trim()), sort: meal?.sort ?? 0 });
            await refresh();
            toast("Meal saved");
            onDone();
          } catch (err) {
            toast(errorText(err), true);
          }
        }}
      />
    </div>
  );
}

function PlaceEditor({ place, onDone }: { place?: Place; onDone: () => void }) {
  const event = useAdminEvent();
  const save = trpc.program.dining.savePlace.useMutation();
  const { refresh, remove } = useDiningActions(onDone);
  const [f, setF] = useState({
    title: place?.title ?? "",
    category: (place?.category ?? "") as PlaceType,
    cuisine: place?.cuisine ?? "",
    price: (place?.price ?? "") as Price,
    walkMinutes: place?.walkMinutes != null ? String(place.walkMinutes) : "",
    description: place?.description ?? "",
    address: place?.address ?? "",
    url: place?.url ?? "",
    phone: place?.phone ?? "",
    note: place?.note ?? "",
    sort: String(place?.sort ?? 0),
  });
  const t = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="col gap-12">
      <span className="editor-title">{place ? "Editing place" : "New place"}</span>
      <div className="grid-3">
        <Field label="Name">
          <input className="input" value={f.title} onChange={t("title")} />
        </Field>
        <Field label="Type">
          <select className="select" value={f.category} onChange={t("category")}>
            {PLACE_TYPES.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Cuisine">
          <input className="input" value={f.cuisine} onChange={t("cuisine")} placeholder="Southern" />
        </Field>
        <Field label="Price">
          <select className="select" value={f.price} onChange={t("price")}>
            {["", "$", "$$", "$$$", "$$$$"].map((p) => (
              <option key={p} value={p}>{p || "Not set"}</option>
            ))}
          </select>
        </Field>
        <Field label="Walk (minutes)">
          <input className="input" inputMode="numeric" value={f.walkMinutes} onChange={t("walkMinutes")} />
        </Field>
        <Field label="Attendee offer">
          <input className="input" value={f.note} onChange={t("note")} placeholder="10% with badge" />
        </Field>
        <Field label="Address" className="span-2">
          <input className="input" value={f.address} onChange={t("address")} />
        </Field>
        <Field label="Phone">
          <input className="input" value={f.phone} onChange={t("phone")} />
        </Field>
        <Field label="Website" className="span-2">
          <input className="input" value={f.url} onChange={t("url")} placeholder="https://" />
        </Field>
        <Field label="Order">
          <input className="input" inputMode="numeric" value={f.sort} onChange={t("sort")} />
        </Field>
        <Field label="Short description" className="span-all">
          <input className="input" value={f.description} onChange={t("description")} />
        </Field>
      </div>
      <DiningButtons
        saving={save.isPending}
        onCancel={onDone}
        onDelete={place ? () => remove(place.id, place.title) : undefined}
        onSave={async () => {
          try {
            await save.mutateAsync({
              eventId: event.id,
              id: place?.id ?? null,
              ...f,
              walkMinutes: f.walkMinutes.trim() ? Math.max(0, Math.round(Number(f.walkMinutes)) || 0) : null,
              sort: Math.max(0, Math.round(Number(f.sort)) || 0),
            });
            await refresh();
            toast("Place saved");
            onDone();
          } catch (err) {
            toast(errorText(err), true);
          }
        }}
      />
    </div>
  );
}

/* ---------------- About your host ---------------- */

type JoinMode = "website" | "custom" | "hidden";
const JOIN_LABELS: Record<JoinMode, string> = { website: "Host website", custom: "Another link", hidden: "Hide the button" };

/** /admin/e/:eventId/host: read view with Edit; Edit opens the fields in place. */
export function AdminHostScreen() {
  const event = useAdminEvent();
  const utils = trpc.useUtils();
  const q = trpc.program.host.adminGet.useQuery({ eventId: event.id });
  const save = trpc.program.host.update.useMutation();
  const [f, setF] = useState<null | { name: string; about: string; mission: string; imageFileId: number | null; imageUrl: string | null; joinMode: JoinMode; joinUrl: string; website: string; email: string; phone: string; instagram: string; facebook: string; linkedin: string }>(null);
  if (q.isLoading) return <AdminPage title={event.name} sub={dateSub(event)}><PageLoading /></AdminPage>;
  if (q.error) return <AdminPage title={event.name} sub={dateSub(event)}><ErrorNote error={q.error} /></AdminPage>;
  const h = q.data!;
  const form = f ?? { name: h.name, about: h.about, mission: h.mission, imageFileId: h.imageFileId, imageUrl: h.imageUrl, joinMode: h.joinMode as JoinMode, joinUrl: h.joinMode === "custom" ? h.joinUrl : "", website: h.website, email: h.email, phone: h.phone, instagram: h.instagram, facebook: h.facebook, linkedin: h.linkedin };
  const t = (k: "name" | "about" | "mission" | "joinUrl" | "website" | "email" | "phone" | "instagram" | "facebook" | "linkedin") => (e: { target: { value: string } }) => setF({ ...form, [k]: e.target.value });
  const logo = (url: string | null, size: number) => (
    <div style={{ width: size, height: size, borderRadius: 14, border: "1px solid var(--line)", background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      {url ? <img src={url} alt="Host logo" style={{ width: "84%", height: "84%", objectFit: "contain" }} /> : <span className="small strong muted">LOGO</span>}
    </div>
  );
  const socials = [h.instagram && "Instagram", h.facebook && "Facebook", h.linkedin && "LinkedIn"].filter(Boolean).join(", ");
  return (
    <AdminPage title={event.name} sub={dateSub(event)}>
      <div className="card card-pad">
        <EditSection
          title="About your host"
          saving={save.isPending}
          onCancel={() => setF(null)}
          onSave={async () => {
            const { imageUrl, ...rest } = form;
            void imageUrl;
            await save.mutateAsync({ eventId: event.id, ...rest });
            setF(null);
            await utils.program.host.adminGet.invalidate({ eventId: event.id });
            toast("Saved");
          }}
          view={
            <div className="row gap-20" style={{ alignItems: "flex-start" }}>
              <div className="col gap-6">
                <span className="small muted strong">Host logo</span>
                {logo(h.imageUrl, 88)}
              </div>
              <div className="grow">
                <Facts
                  items={[
                    { label: "Host name", value: h.name },
                    { label: "Join or renew button opens", value: JOIN_LABELS[h.joinMode as JoinMode] + (h.joinMode === "custom" ? ` (${h.joinUrl})` : "") },
                    { label: "Website", value: h.website },
                    { label: "Email", value: h.email },
                    { label: "Phone", value: h.phone },
                    { label: "Social links", value: socials },
                    { label: "About", value: h.about, wide: true },
                    { label: "Mission", value: h.mission, wide: true },
                  ]}
                />
              </div>
            </div>
          }
          edit={
            <div className="col gap-12">
              <div className="row gap-12">
                {logo(form.imageUrl, 64)}
                <UploadButton label={form.imageFileId ? "Replace" : "Upload"} eventId={event.id} onUploaded={(file) => setF({ ...form, imageFileId: file.id, imageUrl: file.url })} />
                {form.imageFileId ? <button className="btn btn-sm btn-w" onClick={() => setF({ ...form, imageFileId: null, imageUrl: null })}>Remove</button> : null}
              </div>
              <div className="grid-3">
                <Field label="Host name" className="span-2">
                  <input className="input" value={form.name} onChange={t("name")} />
                </Field>
                <Field label="Join or renew button opens">
                  <select className="select" value={form.joinMode} onChange={(e) => setF({ ...form, joinMode: e.target.value as JoinMode })}>
                    {(Object.keys(JOIN_LABELS) as JoinMode[]).map((k) => (
                      <option key={k} value={k}>{JOIN_LABELS[k]}</option>
                    ))}
                  </select>
                </Field>
                {form.joinMode === "custom" ? (
                  <Field label="Join link" className="span-all">
                    <input className="input" value={form.joinUrl} onChange={t("joinUrl")} placeholder="https://" />
                  </Field>
                ) : null}
                <Field label="About" className="span-all">
                  <textarea className="textarea" rows={4} value={form.about} onChange={t("about")} />
                </Field>
                <Field label="Mission" className="span-all">
                  <textarea className="textarea" rows={2} value={form.mission} onChange={t("mission")} />
                </Field>
                <Field label="Website">
                  <input className="input" value={form.website} onChange={t("website")} placeholder="https://" />
                </Field>
                <Field label="Email">
                  <input className="input" type="email" value={form.email} onChange={t("email")} />
                </Field>
                <Field label="Phone">
                  <input className="input" value={form.phone} onChange={t("phone")} />
                </Field>
                <Field label="Instagram">
                  <input className="input" value={form.instagram} onChange={t("instagram")} placeholder="https://" />
                </Field>
                <Field label="Facebook">
                  <input className="input" value={form.facebook} onChange={t("facebook")} placeholder="https://" />
                </Field>
                <Field label="LinkedIn">
                  <input className="input" value={form.linkedin} onChange={t("linkedin")} placeholder="https://" />
                </Field>
              </div>
            </div>
          }
        />
      </div>
    </AdminPage>
  );
}

/* ---------------- Branding ---------------- */

type BrandingData = RouterOutputs["program"]["branding"]["get"];
type Features = BrandingData["features"];
type Bands = { attendee: string; speaker: string; vendor: string; staff: string };
type Badge = BrandingData["badge"] & { bandColors: Bands };

const FEATURE_LABELS: { key: keyof Features; label: string }[] = [
  { key: "messaging", label: "Attendee messaging" },
  { key: "networking", label: "People directory" },
  { key: "meetings", label: "Meeting requests" },
  { key: "community", label: "Community" },
  { key: "polls", label: "Live polls and Q&A" },
  { key: "exhibitors", label: "Exhibitors and sponsors" },
  { key: "dining", label: "Food and dining" },
  { key: "photos", label: "Photos" },
];

const BAND_LABELS: { key: keyof Bands; label: string }[] = [
  { key: "attendee", label: "Attendee" },
  { key: "speaker", label: "Speaker" },
  { key: "vendor", label: "Exhibitor" },
  { key: "staff", label: "Staff" },
];

const HEX = /^#[0-9a-fA-F]{6}$/;

function ColorField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="row gap-6">
        <input type="color" aria-label={`${label} picker`} value={HEX.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value.toUpperCase())} style={{ width: 32, height: 32, padding: 0, border: "1px solid var(--field)", borderRadius: 6, background: "#FFFFFF", flexShrink: 0 }} />
        <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </Field>
  );
}

function ImageBox({ url, label, size = 56 }: { url: string | null; label: string; size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: 12, border: "1px solid var(--line)", background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
      {url ? <img src={url} alt={label} style={{ width: "84%", height: "84%", objectFit: "contain" }} /> : <span className="small strong muted">{label.toUpperCase()}</span>}
    </div>
  );
}

/** A row of picture choices (header style, button shape, font). The chosen card has a thick border. */
function OptionCards<T extends string>({ label, options, value, onChange, columns }: { label: string; options: { key: T; label: string; thumb: ReactNode }[]; value: T; onChange: (v: T) => void; columns?: number }) {
  return (
    <div className="col gap-8">
      <span className="small muted strong">{label}</span>
      <div role="radiogroup" aria-label={label} style={{ display: "grid", gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))`, gap: 8 }}>
        {options.map((o) => {
          const on = o.key === value;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.key)}
              style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 6, padding: on ? 7 : 8, borderRadius: 10, border: on ? "2px solid var(--brand)" : "1px solid var(--line)", background: "#FFFFFF", cursor: "pointer", textAlign: "left" }}
            >
              {o.thumb}
              <span className="small strong" style={{ color: "var(--ink)" }}>{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Reads the uploaded logo and suggests a main color and a button color from it. */
async function colorsFromLogo(url: string) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.drawImage(img, 0, 0, 64, 64);
  return colorsFromPixels(g.getImageData(0, 0, 64, 64).data);
}

type LookDraft = { colorPrimary: string; colorAccent: string; colorHighlight: string } & Look;

/** /admin/e/:eventId/branding */
export function AdminBrandingScreen() {
  const event = useAdminEvent();
  const { can, me } = useAdmin();
  const utils = trpc.useUtils();
  const q = trpc.program.branding.get.useQuery({ eventId: event.id });
  const save = trpc.program.branding.update.useMutation();
  const [look, setLook] = useState<LookDraft | null>(null);
  const [ident, setIdent] = useState<null | { appName: string; logoFileId: number | null; logoUrl: string | null; coverFileId: number | null; coverUrl: string | null; iconFileId: number | null; iconUrl: string | null }>(null);
  const [features, setFeatures] = useState<Features | null>(null);
  const [badge, setBadge] = useState<Badge | null>(null);
  const [matching, setMatching] = useState(false);
  const [previewOf, setPreviewOf] = useState<"app" | "checkout" | "email">("app");
  const tabs = null;
  if (q.isLoading) return <AdminPage title={event.name} sub={dateSub(event)}><PageLoading /></AdminPage>;
  if (q.error) return <AdminPage title={event.name} sub={dateSub(event)}><ErrorNote error={q.error} /></AdminPage>;
  const b = q.data!;
  const savedLook: LookDraft = { colorPrimary: b.colorPrimary, colorAccent: b.colorAccent, colorHighlight: b.colorHighlight ?? "", ...b.look };
  const savedIdent = { appName: b.appName, logoFileId: b.logoFileId, logoUrl: b.logoUrl, coverFileId: b.coverFileId, coverUrl: b.coverUrl, iconFileId: b.iconFileId, iconUrl: b.iconUrl };
  const savedBadge: Badge = { ...b.badge, bandColors: b.badge.bandColors as Bands };
  const L = look ?? savedLook;
  const I = ident ?? savedIdent;
  const F = features ?? b.features;
  const B = badge ?? savedBadge;
  const setL = (patch: Partial<LookDraft>) => setLook({ ...L, ...patch });
  const setI = (patch: Partial<typeof I>) => setIdent({ ...I, ...patch });
  const setB = (patch: Partial<Badge>) => setBadge({ ...B, ...patch });
  const appUrl = `${window.location.origin}/e/${b.slug}`;
  const warnings = brandWarnings(L);
  const theme = THEMES.find((t) => t.colorPrimary.toUpperCase() === L.colorPrimary.toUpperCase() && t.colorAccent.toUpperCase() === L.colorAccent.toUpperCase() && t.colorHighlight.toUpperCase() === (L.colorHighlight || "").toUpperCase());
  const [first, ...rest] = (me.name || "Taylor Reed").split(" ");
  const sampleLast = rest.join(" ") || "Reed";
  const onFeatures = FEATURE_LABELS.filter((x) => b.features[x.key]).map((x) => x.label);

  /** Saves everything, using the saved values for every section except the one being edited. */
  const saveAll = async (parts: { look?: LookDraft; ident?: typeof I; features?: Features; badge?: Badge }) => {
    const lk = parts.look ?? savedLook;
    const id = parts.ident ?? savedIdent;
    const bd = parts.badge ?? savedBadge;
    if (!HEX.test(lk.colorPrimary) || !HEX.test(lk.colorAccent) || (lk.colorHighlight && !HEX.test(lk.colorHighlight)) || !Object.values(bd.bandColors).every((c) => HEX.test(c))) throw new Error("Colors look like #1F5F4A.");
    await save.mutateAsync({
      eventId: event.id,
      appName: id.appName,
      colorPrimary: lk.colorPrimary,
      colorAccent: lk.colorAccent,
      colorHighlight: lk.colorHighlight,
      look: { header: lk.header, buttonShape: lk.buttonShape, font: lk.font, buttonText: lk.buttonText, background: lk.background, textSize: lk.textSize },
      logoFileId: id.logoFileId,
      coverFileId: id.coverFileId,
      iconFileId: id.iconFileId,
      badge: { showCredentials: bd.showCredentials, showOrg: bd.showOrg, showCity: bd.showCity, ribbonByTicket: bd.ribbonByTicket, size: bd.size, nameStyle: bd.nameStyle ?? "first", showQr: bd.showQr ?? true, bandColors: bd.bandColors },
      features: parts.features ?? b.features,
    });
    await Promise.all([utils.program.branding.get.invalidate({ eventId: event.id }), utils.core.events.get.invalidate({ eventId: event.id })]);
    toast("Branding saved");
  };

  const matchLogo = async () => {
    if (!I.logoUrl) return toast("Upload a logo first, under Name, logo and icon.", true);
    setMatching(true);
    try {
      const c = await colorsFromLogo(I.logoUrl);
      if (!c) toast("The logo has no strong colors to use. Pick a theme instead.", true);
      else setL(c);
    } catch {
      toast("Could not read the logo. Try uploading it again.", true);
    } finally {
      setMatching(false);
    }
  };

  const brand = HEX.test(L.colorPrimary) ? L.colorPrimary : "#1F5F4A";
  const lookView = (
    <Facts
      items={[
        { label: "Theme", value: theme?.name ?? "Custom" },
        { label: "Main color", value: <span className="row gap-6"><span style={{ width: 14, height: 14, borderRadius: 4, background: b.colorPrimary }} />{b.colorPrimary}</span> },
        { label: "Button color", value: <span className="row gap-6"><span style={{ width: 14, height: 14, borderRadius: 4, background: b.colorAccent }} />{b.colorAccent}</span> },
        { label: "Highlight color", value: b.colorHighlight ? <span className="row gap-6"><span style={{ width: 14, height: 14, borderRadius: 4, background: b.colorHighlight }} />{b.colorHighlight}</span> : <span className="muted">Same as main color</span> },
        { label: "Button text", value: BUTTON_TEXT_LABELS[b.look.buttonText] },
        { label: "Page background", value: BACKGROUND_LABELS[b.look.background] },
        { label: "Text size", value: TEXT_SIZE_LABELS[b.look.textSize] },
        { label: "Header", value: HEADER_LABELS[b.look.header] },
        { label: "Button shape", value: SHAPE_LABELS[b.look.buttonShape] },
        { label: "Font", value: FONTS[b.look.font].label },
      ]}
    />
  );
  const lookEdit = (
    <div className="col gap-16">
      <div className="col gap-8">
        <div className="row-between">
          <span className="small muted strong">Start from a theme</span>
          <button type="button" className="btn btn-sm" disabled={matching} onClick={matchLogo}>{matching ? "Reading logo" : "Match my logo"}</button>
        </div>
        <div role="radiogroup" aria-label="Theme" style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 8 }}>
          {THEMES.map((t) => {
            const on = theme?.name === t.name;
            return (
              <button key={t.name} type="button" role="radio" aria-checked={on} onClick={() => setL({ colorPrimary: t.colorPrimary, colorAccent: t.colorAccent, colorHighlight: t.colorHighlight })} style={{ display: "flex", flexDirection: "column", gap: 6, padding: on ? 7 : 8, borderRadius: 10, border: on ? "2px solid var(--brand)" : "1px solid var(--line)", background: "#FFFFFF", cursor: "pointer", alignItems: "stretch" }}>
                <span style={{ display: "flex", height: 28, borderRadius: 6, overflow: "hidden" }}>
                  <span style={{ flex: 2, background: t.colorPrimary }} />
                  <span style={{ flex: 1, background: t.colorAccent }} />
                  <span style={{ flex: 1, background: t.colorHighlight }} />
                </span>
                <span className="small strong" style={{ color: "var(--ink)", textAlign: "left" }}>{t.name}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid-3">
        <ColorField label="Main color" value={L.colorPrimary} onChange={(v) => setL({ colorPrimary: v })} hint="Header, menu, dates" />
        <ColorField label="Button color" value={L.colorAccent} onChange={(v) => setL({ colorAccent: v })} hint="Register, Add to my agenda" />
        <ColorField label="Highlight color" value={L.colorHighlight || L.colorPrimary} onChange={(v) => setL({ colorHighlight: v })} hint={L.colorHighlight ? "Tags, links, selected tab" : "Same as main color until you pick one"} />
        <Field label="Button text" hint="Picks what is easy to read">
          <select className="select" value={L.buttonText} onChange={(e) => setL({ buttonText: e.target.value as Look["buttonText"] })}>
            {LOOK_BUTTON_TEXT.map((k) => <option key={k} value={k}>{BUTTON_TEXT_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="Page background">
          <select className="select" value={L.background} onChange={(e) => setL({ background: e.target.value as Look["background"] })}>
            {LOOK_BACKGROUNDS.map((k) => <option key={k} value={k}>{BACKGROUND_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="Text size">
          <select className="select" value={L.textSize} onChange={(e) => setL({ textSize: e.target.value as Look["textSize"] })}>
            {LOOK_TEXT_SIZES.map((k) => <option key={k} value={k}>{TEXT_SIZE_LABELS[k]}</option>)}
          </select>
        </Field>
      </div>
      {warnings.length ? (
        <div className="banner banner-warn" style={{ justifyContent: "flex-start" }}>{warnings.join(" ")}</div>
      ) : (
        <div className="banner banner-ok" style={{ justifyContent: "flex-start" }}>Easy to read: text on the header and buttons passes the contrast check.</div>
      )}
      <OptionCards
        label="Header"
        value={L.header}
        onChange={(v) => setL({ header: v })}
        options={LOOK_HEADERS.map((k) => ({
          key: k,
          label: HEADER_LABELS[k],
          thumb: (
            <span
              style={{
                height: 34,
                borderRadius: 6,
                boxSizing: "border-box",
                display: "flex",
                alignItems: k === "cover" ? "flex-end" : "center",
                padding: k === "cover" ? "0 8px 5px" : "0 8px",
                gap: 6,
                background: k === "light" ? "#FFFFFF" : k === "cover" ? (I.coverUrl ? `linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)), url("${I.coverUrl}") center / cover` : `linear-gradient(135deg, ${brand}, ${mix(brand, "#FFFFFF", 0.4)})`) : brand,
                border: k === "light" ? "1px solid var(--line)" : "none",
                borderBottom: k === "light" ? `3px solid ${brand}` : "none",
              }}
            >
              <span style={{ width: 12, height: 12, borderRadius: 3, background: k === "light" ? brand : "#FFFFFF" }} />
              <span style={{ width: 50, height: 6, borderRadius: 3, background: k === "light" ? "var(--ink)" : "#FFFFFF" }} />
            </span>
          ),
        }))}
      />
      {L.header === "cover" && !I.coverUrl ? <div className="small muted">Upload a cover under Name, logo and icon. Until then the header uses the main color.</div> : null}
      <OptionCards
        label="Button shape"
        value={L.buttonShape}
        onChange={(v) => setL({ buttonShape: v })}
        options={LOOK_SHAPES.map((k) => ({
          key: k,
          label: SHAPE_LABELS[k],
          thumb: (
            <span style={{ height: 30, borderRadius: k === "pill" ? 15 : SHAPE_RADIUS[k], background: HEX.test(L.colorAccent) ? L.colorAccent : "#E88A3A", color: buttonInk(L), fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>Register</span>
          ),
        }))}
      />
      <OptionCards
        label="Font"
        value={L.font}
        onChange={(v) => {
          loadBrandFont({ font: v });
          setL({ font: v });
        }}
        options={LOOK_FONTS.map((k) => {
          loadBrandFont({ font: k });
          return { key: k, label: FONTS[k].label, thumb: <span style={{ height: 30, fontFamily: FONTS[k].css, fontSize: 20, fontWeight: 700, color: "var(--ink)", display: "flex", alignItems: "center" }}>Aa</span> };
        })}
      />
      <div className="small muted">Used on the app, checkout page, call for proposals page, emails and badges.</div>
    </div>
  );

  return (
    <AdminPage title={event.name} sub={dateSub(event)}>
      <div className="col" style={{ gap: 0 }}>
        {tabs}
        <div className={tabs ? "folder-body" : "card card-pad col gap-16"}>
          <div className="row gap-24 wrap" style={{ alignItems: "flex-start" }}>
            <div className="col gap-20" style={{ flex: "1 1 560px", minWidth: 0 }}>
              <EditSection
                title="App look"
                saving={save.isPending}
                onCancel={() => setLook(null)}
                onSave={async () => {
                  await saveAll({ look: L });
                  setLook(null);
                }}
                view={lookView}
                edit={lookEdit}
              />
              <div className="divider" />
              <EditSection
                title="Name, logo and icon"
                saving={save.isPending}
                onCancel={() => setIdent(null)}
                onSave={async () => {
                  await saveAll({ ident: I });
                  setIdent(null);
                }}
                view={
                  <div className="col gap-16">
                    <div className="row gap-16">
                      <div className="col gap-4"><span className="small muted strong">Logo</span><ImageBox url={b.logoUrl} label="Logo" /></div>
                      <div className="col gap-4"><span className="small muted strong">App icon</span><ImageBox url={b.iconUrl} label="Icon" /></div>
                      <div className="col gap-4"><span className="small muted strong">Cover</span><ImageBox url={b.coverUrl} label="Cover" /></div>
                    </div>
                    <Facts items={[{ label: "App name", value: b.appName }, { label: "App address", value: appUrl, wide: true }]} />
                  </div>
                }
                edit={
                  <div className="col gap-16">
                    <div className="grid-3">
                      <Field label="App name">
                        <input className="input" value={I.appName} onChange={(e) => setI({ appName: e.target.value })} />
                      </Field>
                      <Field label="App address" className="span-2">
                        <input className="input" readOnly value={appUrl} />
                      </Field>
                    </div>
                    <div className="row gap-20 wrap">
                      {([
                        { key: "logo", label: "Logo" },
                        { key: "icon", label: "App icon" },
                        { key: "cover", label: "Cover" },
                      ] as const).map((img) => {
                        const url = I[`${img.key}Url`];
                        const id = I[`${img.key}FileId`];
                        return (
                          <div key={img.key} className="col gap-6">
                            <span className="small muted strong">{img.label}</span>
                            <div className="row gap-8">
                              <ImageBox url={url} label={img.key === "logo" ? "Logo" : img.key === "icon" ? "Icon" : "Cover"} />
                              <div className="col gap-6">
                                <UploadButton eventId={event.id} label={id ? "Replace" : "Upload"} onUploaded={(file) => setI({ [`${img.key}FileId`]: file.id, [`${img.key}Url`]: file.url } as Partial<typeof I>)} />
                                {id ? <button className="btn btn-sm btn-w" onClick={() => setI({ [`${img.key}FileId`]: null, [`${img.key}Url`]: null } as Partial<typeof I>)}>Remove</button> : null}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                }
              />
              <div className="divider" />
              <EditSection
                title="In the app"
                saving={save.isPending}
                onCancel={() => setFeatures(null)}
                onSave={async () => {
                  await saveAll({ features: F });
                  setFeatures(null);
                }}
                view={<Facts items={[{ label: "Turned on", value: onFeatures.length ? onFeatures.join(", ") : "Agenda only", wide: true }]} />}
                edit={
                  <div className="grid-3" style={{ gap: 8 }}>
                    {FEATURE_LABELS.map((x) => (
                      <label key={x.key} className="check">
                        <input type="checkbox" checked={F[x.key]} onChange={(e) => setFeatures({ ...F, [x.key]: e.target.checked })} />
                        {x.label}
                      </label>
                    ))}
                  </div>
                }
              />
              <div className="divider" />
              <EditSection
                title="Badge"
                saving={save.isPending}
                onCancel={() => setBadge(null)}
                onSave={async () => {
                  await saveAll({ badge: B });
                  setBadge(null);
                }}
                view={
                  <Facts
                    items={[
                      { label: "Badge size", value: b.badge.size === "4x6" ? "4 x 6 in" : "4 x 3 in" },
                      { label: "Name style", value: b.badge.nameStyle === "full" ? "Full name" : "First name large" },
                      {
                        label: "Show on badge",
                        value: [b.badge.showCredentials && "Credentials", b.badge.showCity && "City and state", b.badge.showOrg && "Organization", b.badge.showQr && "QR code", b.badge.ribbonByTicket && "Attendee type band"].filter(Boolean).join(", "),
                      },
                    ]}
                  />
                }
                edit={
                  <div className="col gap-16">
                    <div className="grid-3">
                      <Field label="Badge size">
                        <select className="select" value={B.size} onChange={(e) => setB({ size: e.target.value as "4x3" | "4x6" })}>
                          <option value="4x3">4 x 3 in</option>
                          <option value="4x6">4 x 6 in</option>
                        </select>
                      </Field>
                      <Field label="Name style">
                        <select className="select" value={B.nameStyle ?? "first"} onChange={(e) => setB({ nameStyle: e.target.value as "first" | "full" })}>
                          <option value="first">First name large</option>
                          <option value="full">Full name</option>
                        </select>
                      </Field>
                    </div>
                    <div className="col gap-8">
                      <span className="small muted strong">Show on badge</span>
                      <div className="row gap-16 wrap">
                        <label className="check"><input type="checkbox" checked={B.showCredentials} onChange={(e) => setB({ showCredentials: e.target.checked })} />Credentials</label>
                        <label className="check"><input type="checkbox" checked={B.showCity} onChange={(e) => setB({ showCity: e.target.checked })} />City and state</label>
                        <label className="check"><input type="checkbox" checked={B.showOrg} onChange={(e) => setB({ showOrg: e.target.checked })} />Organization</label>
                        <label className="check"><input type="checkbox" checked={B.showQr ?? true} onChange={(e) => setB({ showQr: e.target.checked })} />QR code</label>
                        <label className="check"><input type="checkbox" checked={B.ribbonByTicket} onChange={(e) => setB({ ribbonByTicket: e.target.checked })} />Attendee type band</label>
                      </div>
                    </div>
                    {B.ribbonByTicket ? (
                      <div className="col gap-8">
                        <span className="small muted strong">Band color by attendee type</span>
                        <div className="grid-4">
                          {BAND_LABELS.map((x) => (
                            <ColorField key={x.key} label={x.label} value={B.bandColors[x.key]} onChange={(v) => setB({ bandColors: { ...B.bandColors, [x.key]: v } })} />
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                }
              />
            </div>
            <div className="col gap-12" style={{ flex: "0 1 340px", minWidth: 0 }}>
              <div className="row-between">
                <span className="h3" style={{ fontSize: 14 }}>Preview</span>
                <div role="tablist" aria-label="Preview" className="row" style={{ gap: 0, border: "1px solid var(--field)", borderRadius: 8, overflow: "hidden" }}>
                  {(["app", "checkout", "email"] as const).map((k) => (
                    <button key={k} type="button" role="tab" aria-selected={previewOf === k} onClick={() => setPreviewOf(k)} style={{ height: 30, padding: "0 12px", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", background: previewOf === k ? "var(--brand)" : "#FFFFFF", color: previewOf === k ? "#FFFFFF" : "var(--muted)" }}>
                      {k === "app" ? "App" : k === "checkout" ? "Checkout" : "Email"}
                    </button>
                  ))}
                </div>
              </div>
              <span className="small muted">Changes show here as you pick them.</span>
              {previewOf === "app" ? <AppPreview look={L} appName={I.appName || event.name} logoUrl={I.logoUrl} coverUrl={I.coverUrl} /> : previewOf === "checkout" ? <CheckoutPreview look={L} name={event.name} coverUrl={I.coverUrl} /> : <EmailPreview look={L} name={event.name} coverUrl={I.coverUrl} />}
              <span className="h3" style={{ fontSize: 14 }}>Badge preview</span>
              <BadgePreview look={L} badge={B} logoUrl={I.logoUrl} name={I.appName || event.name} first={first} last={sampleLast} credentials="PhD" city={event.city} url={appUrl} />
            </div>
          </div>
        </div>
      </div>
    </AdminPage>
  );
}

const SAMPLE_SESSIONS = [
  { time: "8:30 AM to 9:45 AM", title: "Opening General Session", room: "Ballroom A", track: "General", added: true },
  { time: "10:00 AM to 11:30 AM", title: "Building Better Teams", room: "Room 204", track: "Leadership", added: false },
  { time: "1:15 PM to 2:15 PM", title: "Ethics in Practice", room: "Room 110", track: "Ethics", added: false },
];

function Logo({ url, size, bg, ink }: { url: string | null; size: number; bg: string; ink: string }) {
  return (
    <span style={{ width: size, height: size, borderRadius: size / 4, background: bg, color: ink, fontSize: 8, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
      {url ? <img src={url} alt="" style={{ width: "82%", height: "82%", objectFit: "contain" }} /> : "LOGO"}
    </span>
  );
}

/** The agenda screen drawn with the draft look, using the same CSS variables as the real app. */
function AppPreview({ look, appName, logoUrl, coverUrl }: { look: LookDraft; appName: string; logoUrl: string | null; coverUrl: string | null }) {
  const vars = brandStyle(look, coverUrl);
  const light = look.header === "light";
  const zoom = look.textSize === "larger" ? 1.1 : 1;
  return (
    <div style={{ ...vars, width: 290, height: 580, alignSelf: "center", borderRadius: 30, border: "8px solid #0F2A23", overflow: "hidden", background: "var(--app-bg)", fontFamily: "var(--app-font)", display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
      <div style={{ backgroundColor: "var(--header-bg)", backgroundImage: "var(--header-image)", backgroundSize: "cover", backgroundPosition: "center", borderBottom: "3px solid var(--header-border)", color: "var(--header-ink)", padding: look.header === "cover" && coverUrl ? "30px 14px 12px" : "14px", display: "flex", alignItems: "center", gap: 10 }}>
        <Logo url={logoUrl} size={30} bg={light ? "var(--brand)" : "#FFFFFF"} ink={light ? "var(--on-brand)" : "var(--brand)"} />
        <span className="clip" style={{ fontSize: 15, fontWeight: 800 }}>{appName}</span>
      </div>
      <div style={{ flex: 1, padding: 12, display: "flex", flexDirection: "column", gap: 10, overflow: "hidden", zoom }}>
        <span style={{ fontSize: 17, fontWeight: 800, color: "var(--ink)" }}>Agenda</span>
        <div style={{ display: "flex", gap: 6 }}>
          {["Thu, Apr 22", "Fri, Apr 23", "Sat, Apr 24"].map((d, i) => (
            <span key={d} style={{ flex: 1, textAlign: "center", padding: "6px 0", borderRadius: look.buttonShape === "pill" ? 999 : look.buttonShape === "square" ? 4 : 8, fontSize: 11, fontWeight: 700, ...(i === 0 ? { background: "var(--brand)", color: "var(--on-brand)" } : { background: "#FFFFFF", color: "var(--muted)", border: "1px solid var(--line)" }) }}>{d}</span>
          ))}
        </div>
        {SAMPLE_SESSIONS.map((s) => (
          <div key={s.title} style={{ background: "#FFFFFF", border: "1px solid var(--line)", borderRadius: 12, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--brand)" }}>{s.time}</span>
            <span style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)" }}>{s.title}</span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              {s.room} · <span style={{ color: "var(--highlight-text)", background: "var(--highlight-tint)", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>{s.track}</span>
            </span>
            <div>
              {s.added ? (
                <span style={{ height: 30, padding: "0 12px", borderRadius: "var(--btn-radius)", border: "1.5px solid var(--brand)", color: "var(--brand)", background: "#FFFFFF", fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center" }}>On my agenda</span>
              ) : (
                <span style={{ height: 30, padding: "0 12px", borderRadius: "var(--btn-radius)", background: "var(--accent)", color: "var(--accent-ink)", fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center" }}>Add to my agenda</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ background: "#FFFFFF", borderTop: "1px solid var(--line)", padding: "8px 6px 10px", display: "flex", justifyContent: "space-around" }}>
        {["Agenda", "My agenda", "Community", "Messages", "More"].map((n, i) => (
          <span key={n} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, fontSize: 9, fontWeight: 700, color: i === 0 ? "var(--highlight-text)" : "#7A8A85" }}>
            <span style={{ width: 18, height: 18, borderRadius: 5, background: i === 0 ? "var(--highlight)" : "#C9D5D0" }} />
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}

function CheckoutPreview({ look, name, coverUrl }: { look: LookDraft; name: string; coverUrl: string | null }) {
  return (
    <div style={{ ...brandStyle(look, coverUrl), border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden", background: "var(--app-bg)", fontFamily: "var(--app-font)" }}>
      <div style={{ height: 110, background: coverUrl ? `url("${coverUrl}") center / cover` : "linear-gradient(135deg, var(--brand), var(--brand-dark))" }} />
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: "var(--ink)" }}>{name}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--brand)" }}>Apr 22, 2027 to Apr 24, 2027</span>
        {[["Full conference", "$395.00", true], ["One day", "$175.00", false]].map(([t, p, on]) => (
          <div key={String(t)} style={{ background: "#FFFFFF", border: on ? "2px solid var(--brand)" : "1px solid var(--line)", borderRadius: 12, padding: on ? 11 : 12, display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ fontWeight: 800, color: "var(--ink)" }}>{t}</span>
            <span style={{ fontWeight: 700, color: "var(--ink)" }}>{p}</span>
          </div>
        ))}
        <span style={{ height: 44, borderRadius: "var(--btn-radius)", background: "var(--accent)", color: "var(--accent-ink)", fontSize: 15, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>Register</span>
      </div>
    </div>
  );
}

function EmailPreview({ look, name, coverUrl }: { look: LookDraft; name: string; coverUrl: string | null }) {
  return (
    <div style={{ ...brandStyle(look, coverUrl), background: "#F8FAFB", border: "1px solid var(--line)", borderRadius: 14, padding: 12 }}>
      <div style={{ background: "#FFFFFF", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", fontFamily: "var(--app-font)", color: "var(--ink)" }}>
        {coverUrl ? <div style={{ height: 90, background: `url("${coverUrl}") center / cover` }} /> : <div style={{ height: 8, background: "var(--brand)" }} />}
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, fontSize: 13, lineHeight: 1.5 }}>
          <span style={{ fontSize: 17, fontWeight: 800 }}>You're registered</span>
          <span>Thanks for registering for {name}. Your ticket and receipt are below.</span>
          <span style={{ alignSelf: "flex-start", padding: "10px 18px", borderRadius: "var(--btn-radius)", background: "var(--accent)", color: "var(--accent-ink)", fontWeight: 800 }}>Get the app</span>
          <span className="small muted">Sent with LeadDash Events</span>
        </div>
      </div>
    </div>
  );
}

function BadgePreview({ look, badge, logoUrl, name, first, last, credentials, city, url }: { look: LookDraft; badge: Badge; logoUrl: string | null; name: string; first: string; last: string; credentials: string; city: string; url: string }) {
  const brand = HEX.test(look.colorPrimary) ? look.colorPrimary : "#1F5F4A";
  const band = HEX.test(badge.bandColors.speaker) ? badge.bandColors.speaker : "#e88a3a";
  const tall = badge.size === "4x6";
  return (
    <div style={{ width: 260, height: tall ? 390 : 195, border: "1px solid var(--line)", borderRadius: 10, background: "#FFFFFF", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: FONTS[look.font].css }}>
      <div style={{ background: brand, color: readableOn(brand), padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
        <Logo url={logoUrl} size={24} bg="#FFFFFF" ink={brand} />
        <span className="clip" style={{ fontSize: 11, fontWeight: 700 }}>{name}</span>
      </div>
      <div className="row grow" style={{ padding: "10px 12px", alignItems: tall ? "flex-start" : "center", gap: 10, flexDirection: tall ? "column" : "row" }}>
        <div className="col grow" style={{ gap: 2 }}>
          {badge.nameStyle === "full" ? (
            <span style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.1 }}>{first} {last}{badge.showCredentials ? `, ${credentials}` : ""}</span>
          ) : (
            <>
              <span style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.05 }}>{first}</span>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{last}{badge.showCredentials ? `, ${credentials}` : ""}</span>
            </>
          )}
          {badge.showOrg ? <span className="small muted">Organization</span> : null}
          {badge.showCity && city ? <span className="small muted">{city}</span> : null}
        </div>
        {badge.showQr ?? true ? <QR value={url} size={tall ? 90 : 64} label="Badge QR code preview" /> : null}
      </div>
      {badge.ribbonByTicket ? <div style={{ background: band, color: readableOn(band), textAlign: "center", fontSize: 12, fontWeight: 800, letterSpacing: "0.12em", padding: "6px 0" }}>SPEAKER</div> : null}
    </div>
  );
}
