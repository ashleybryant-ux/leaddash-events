/** /admin/e/:eventId/community: reported posts, topics (pin, close, archive), posting as the event, and community rules. */
import { useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { confirmAction, EditSection, Empty, ErrorNote, ExpandRow, Field, KV, Modal, PageLoading, Pill, THead } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtWhenTime } from "@shared/format";

type Channel = RouterOutputs["network"]["community"]["admin"]["channels"][number];
type Settings = RouterOutputs["network"]["community"]["admin"]["settings"];

const CATEGORIES = ["General", "Practice", "Meetups", "Travel", "Jobs", "Sessions"];

function Reported() {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const reported = trpc.network.community.admin.reported.useQuery({ eventId: ev.id });
  const setHidden = trpc.network.community.admin.setHidden.useMutation();
  const rows = (reported.data ?? []).filter((r) => r.reports > 0);
  const cols = "3fr 1.6fr 0.6fr 96px 96px";
  const act = async (postId: number, hidden: boolean) => {
    try {
      await setHidden.mutateAsync({ eventId: ev.id, postId, hidden });
      await utils.network.community.admin.invalidate();
      toast(hidden ? "Removed" : "Kept");
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  return (
    <div className="card col" style={{ gap: 0 }}>
      <div className="row-between" style={{ padding: "14px 18px" }}>
        <span className="h3">Reported posts</span>
        <span className="small strong" style={{ color: rows.length ? "var(--warn-ink)" : "var(--muted)" }}>{rows.length ? `${rows.length} to review` : "Nothing to review"}</span>
      </div>
      {reported.isLoading ? (
        <PageLoading />
      ) : reported.error ? (
        <ErrorNote error={reported.error} />
      ) : rows.length ? (
        <div style={{ overflowX: "auto", borderTop: "1px solid var(--line)" }}>
          <div className="table-inner">
            <THead cols={cols} labels={["Post", "Topic", "Reports", "", ""]} />
            {rows.map((r) => (
              <div key={r.id} className="trow" style={{ gridTemplateColumns: cols }}>
                <span style={{ minWidth: 0 }}>
                  <span className="strong">{r.author || "Event team"}: </span>
                  <span className="muted">{r.body.length > 160 ? `${r.body.slice(0, 160)}...` : r.body}</span>
                  {r.hidden ? (
                    <>
                      {" "}
                      <Pill tone="gray">Hidden</Pill>
                    </>
                  ) : null}
                </span>
                <span className="clip">{r.channelName}</span>
                <span className="strong">{r.reports}</span>
                {can("community", "edit") ? (
                  <>
                    <button className="btn btn-sm btn-w btn-danger" disabled={setHidden.isPending} onClick={() => act(r.id, true)}>
                      Remove
                    </button>
                    <button className="btn btn-sm btn-w" disabled={setHidden.isPending} onClick={() => act(r.id, false)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <span />
                    <span />
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChannelDetail({ c }: { c: Channel }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const posts = trpc.network.community.admin.posts.useQuery({ eventId: ev.id, channelId: c.id });
  const update = trpc.network.community.admin.updateChannel.useMutation();
  const setHidden = trpc.network.community.admin.setHidden.useMutation();
  const postAsEvent = trpc.network.community.admin.postAsEvent.useMutation();
  const blank = () => ({ name: c.name, description: c.description, category: c.category });
  const [d, setD] = useState(blank);
  const [body, setBody] = useState("");
  const editable = can("community", "edit");
  const refresh = () => utils.network.community.admin.invalidate();

  return (
    <div className="col gap-16">
      {editable ? (
        <EditSection
          title="Topic"
          saving={update.isPending}
          onCancel={() => setD(blank())}
          actions={
            <button
              type="button"
              className="btn btn-sm btn-w"
              disabled={update.isPending}
              onClick={async () => {
                if (!c.archived && !confirmAction(`Archive "${c.name}"? Attendees will no longer see it.`)) return;
                try {
                  await update.mutateAsync({ eventId: ev.id, channelId: c.id, archived: !c.archived });
                  await refresh();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              {c.archived ? "Restore" : "Archive"}
            </button>
          }
          onSave={async () => {
            await update.mutateAsync({ eventId: ev.id, channelId: c.id, name: d.name.trim(), description: d.description.trim(), category: d.category });
            await refresh();
          }}
          view={
            <div>
              <KV label="Name">{c.name}</KV>
              <KV label="Description">{c.description}</KV>
              <KV label="Category">{c.category}</KV>
              <KV label="Started by">{c.official ? "Event team" : c.startedBy}</KV>
              <KV label="Members">{String(c.members)}</KV>
            </div>
          }
          edit={
            <div className="grid-3">
              <Field label="Name">
                <input className="input" value={d.name} maxLength={100} onChange={(e) => setD({ ...d, name: e.target.value })} />
              </Field>
              <Field label="Category">
                <select className="select" value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })}>
                  {Array.from(new Set([...CATEGORIES, d.category])).map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Description" className="span-all">
                <input className="input" value={d.description} maxLength={300} onChange={(e) => setD({ ...d, description: e.target.value })} />
              </Field>
            </div>
          }
        />
      ) : null}

      {editable && !c.archived ? (
        <div className="col gap-8">
          <span className="editor-title">Post as the event team</span>
          <textarea className="textarea" rows={3} maxLength={4000} value={body} aria-label="Post as the event team" onChange={(e) => setBody(e.target.value)} />
          <div>
            <button
              className="btn btn-sm btn-solid btn-w"
              disabled={!body.trim() || postAsEvent.isPending}
              onClick={async () => {
                try {
                  await postAsEvent.mutateAsync({ eventId: ev.id, channelId: c.id, body: body.trim() });
                  setBody("");
                  await refresh();
                  toast("Posted");
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Post
            </button>
          </div>
        </div>
      ) : null}

      <div className="col gap-8">
        <span className="editor-title">Posts</span>
        {posts.isLoading ? (
          <PageLoading />
        ) : posts.error ? (
          <ErrorNote error={posts.error} />
        ) : !posts.data?.length ? (
          <span className="small muted">No posts yet.</span>
        ) : (
          <div className="list">
            {posts.data.flatMap((p) => [p, ...p.replies.map((r) => ({ ...r, reply: true }))]).map((p) => (
              <div key={p.id} className="row" style={{ padding: "10px 0", gap: 12, alignItems: "flex-start", paddingLeft: "reply" in p ? 24 : 0, opacity: p.hidden ? 0.6 : 1 }}>
                <div className="grow col" style={{ gap: 2 }}>
                  <span className="small">
                    <span className="strong">{p.byEvent ? "Event team" : p.author?.name ?? "Former attendee"}</span>
                    <span className="muted"> · {fmtWhenTime(p.at)}</span>
                    {p.hidden ? <span className="muted"> · Hidden</span> : null}
                    {p.reported ? <span style={{ color: "var(--warn-ink)", fontWeight: 700 }}> · {p.reported} report{p.reported === 1 ? "" : "s"}</span> : null}
                  </span>
                  <span style={{ whiteSpace: "pre-wrap" }}>{p.body}</span>
                </div>
                {editable ? (
                  <button
                    className="btn btn-sm btn-w"
                    disabled={setHidden.isPending}
                    onClick={async () => {
                      try {
                        await setHidden.mutateAsync({ eventId: ev.id, postId: p.id, hidden: !p.hidden });
                        await refresh();
                      } catch (err) {
                        toast(errorText(err), true);
                      }
                    }}
                  >
                    {p.hidden ? "Show" : "Hide"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Topics() {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const channels = trpc.network.community.admin.channels.useQuery({ eventId: ev.id });
  const update = trpc.network.community.admin.updateChannel.useMutation();
  const [open, setOpen] = useState<number | null>(null);
  const editable = can("community", "edit");
  const cols = editable ? "2.6fr 0.8fr 0.9fr 96px 96px 96px" : "2.6fr 0.8fr 0.9fr 96px";
  const toggle = async (c: Channel, patch: { pinned?: boolean; locked?: boolean }) => {
    try {
      await update.mutateAsync({ eventId: ev.id, channelId: c.id, ...patch });
      await utils.network.community.admin.channels.invalidate();
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  return (
    <div className="card col" style={{ gap: 0 }}>
      <div style={{ padding: "14px 18px" }}>
        <span className="h3">Topics</span>
      </div>
      {channels.isLoading ? (
        <PageLoading />
      ) : channels.error ? (
        <ErrorNote error={channels.error} />
      ) : !channels.data?.length ? (
        <Empty>No topics yet.</Empty>
      ) : (
        <div style={{ overflowX: "auto", borderTop: "1px solid var(--line)" }}>
          <div className="table-inner">
            <THead cols={cols} labels={editable ? ["Topic", "Posts", "Status", "", "", ""] : ["Topic", "Posts", "Status", ""]} />
            {channels.data.map((c) => (
              <ExpandRow
                key={c.id}
                cols={cols}
                open={open === c.id}
                onToggle={() => setOpen(open === c.id ? null : c.id)}
                cells={[
                  <span key="n" className="col" style={{ gap: 0 }}>
                    <span className="strong">{c.name}</span>
                    <span className="small muted">{c.official ? "Event team" : c.startedBy ? `Started by ${c.startedBy}` : ""}</span>
                  </span>,
                  <span key="p">{c.posts}</span>,
                  c.archived ? (
                    <Pill key="s" tone="gray">Archived</Pill>
                  ) : c.locked ? (
                    <Pill key="s" tone="orange">Locked</Pill>
                  ) : c.pinned ? (
                    <Pill key="s">Pinned</Pill>
                  ) : (
                    <Pill key="s" tone="gray">Open</Pill>
                  ),
                  ...(editable
                    ? [
                        <button key="pin" className="btn btn-sm btn-w" disabled={update.isPending || c.archived} onClick={() => toggle(c, { pinned: !c.pinned })}>
                          {c.pinned ? "Unpin" : "Pin"}
                        </button>,
                        <button key="lock" className="btn btn-sm btn-w" disabled={update.isPending || c.archived} onClick={() => toggle(c, { locked: !c.locked })}>
                          {c.locked ? "Unlock" : "Lock"}
                        </button>,
                      ]
                    : []),
                ]}
              >
                <ChannelDetail c={c} />
              </ExpandRow>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const REPORT_OPTIONS = [3, 5, 10];

function Rules({ s }: { s: Settings }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const update = trpc.network.community.admin.updateSettings.useMutation();
  const blank = () => ({ whoCanStart: s.whoCanStart, exhibitorPosting: s.exhibitorPosting, hideAfterReports: s.hideAfterReports });
  const [d, setD] = useState(blank);
  const who = { attendees: "All attendees", team: "Event team only" } as const;
  const exhibitors = { own: "Only in their own topic", anywhere: "Anywhere", none: "Not at all" } as const;
  const view = (
    <div>
      <KV label="Who can start topics">{who[s.whoCanStart]}</KV>
      <KV label="Exhibitors can post">{exhibitors[s.exhibitorPosting]}</KV>
      <KV label="Hide a post after">{s.hideAfterReports ? `${s.hideAfterReports} reports` : "Never"}</KV>
    </div>
  );
  if (!can("community", "edit")) {
    return (
      <div className="card card-pad col gap-12">
        <span className="h3" style={{ fontSize: 14 }}>Community rules</span>
        {view}
      </div>
    );
  }
  return (
    <div className="card card-pad">
      <EditSection
        title="Community rules"
        saving={update.isPending}
        onCancel={() => setD(blank())}
        onSave={async () => {
          await update.mutateAsync({ eventId: ev.id, ...d });
          await utils.network.community.admin.settings.invalidate();
        }}
        view={view}
        edit={
          <div className="grid-3">
            <Field label="Who can start topics">
              <select className="select" value={d.whoCanStart} onChange={(e) => setD({ ...d, whoCanStart: e.target.value as Settings["whoCanStart"] })}>
                <option value="attendees">All attendees</option>
                <option value="team">Event team only</option>
              </select>
            </Field>
            <Field label="Exhibitors can post">
              <select className="select" value={d.exhibitorPosting} onChange={(e) => setD({ ...d, exhibitorPosting: e.target.value as Settings["exhibitorPosting"] })}>
                <option value="own">Only in their own topic</option>
                <option value="anywhere">Anywhere</option>
                <option value="none">Not at all</option>
              </select>
            </Field>
            <Field label="Hide a post after">
              <select className="select" value={d.hideAfterReports ?? ""} onChange={(e) => setD({ ...d, hideAfterReports: e.target.value ? Number(e.target.value) : null })}>
                {Array.from(new Set([...REPORT_OPTIONS, ...(d.hideAfterReports ? [d.hideAfterReports] : [])]))
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <option key={n} value={n}>
                      {n} reports
                    </option>
                  ))}
                <option value="">Never</option>
              </select>
            </Field>
          </div>
        }
      />
    </div>
  );
}

function NewTopic({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const create = trpc.network.community.admin.createChannel.useMutation();
  const [d, setD] = useState({ name: "", description: "", category: "General", pinned: false });
  return (
    <Modal open={open} onClose={onClose} title="New topic">
      <div className="grid-2">
        <Field label="Name" className="span-all">
          <input className="input" value={d.name} maxLength={100} autoFocus onChange={(e) => setD({ ...d, name: e.target.value })} />
        </Field>
        <Field label="Description" className="span-all">
          <input className="input" value={d.description} maxLength={300} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </Field>
        <Field label="Category">
          <select className="select" value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <label className="check" style={{ alignSelf: "end", paddingBottom: 6 }}>
          <input type="checkbox" checked={d.pinned} onChange={(e) => setD({ ...d, pinned: e.target.checked })} />
          Pin to the top
        </label>
      </div>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={d.name.trim().length < 2 || create.isPending}
          onClick={async () => {
            try {
              await create.mutateAsync({ eventId: ev.id, name: d.name.trim(), description: d.description.trim(), category: d.category, pinned: d.pinned });
              await utils.network.community.admin.channels.invalidate();
              setD({ name: "", description: "", category: "General", pinned: false });
              onClose();
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

/** /admin/e/:eventId/community */
export function AdminCommunityScreen() {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const settings = trpc.network.community.admin.settings.useQuery({ eventId: ev.id });
  const [adding, setAdding] = useState(false);
  return (
    <AdminPage
      title="Community"
      actions={
        can("community", "edit") ? (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            New topic
          </button>
        ) : null
      }
    >
      {!ev.features?.community ? <div className="banner banner-warn">Community is turned off for this event. Turn it on in Event settings.</div> : null}
      <Reported />
      <Topics />
      {settings.isLoading ? <PageLoading /> : settings.error ? <ErrorNote error={settings.error} /> : settings.data ? <Rules key={JSON.stringify(settings.data)} s={settings.data} /> : null}
      <NewTopic open={adding} onClose={() => setAdding(false)} />
    </AdminPage>
  );
}
