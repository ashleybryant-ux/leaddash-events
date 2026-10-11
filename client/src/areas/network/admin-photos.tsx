/** /admin/e/:eventId/photos: photo settings, and reviewing, posting, hiding and deleting attendee photos. */
import { useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { confirmAction, EditSection, Empty, ErrorNote, Field, FolderTabs, Lightbox, NumStrip, PageLoading } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { AddPhotosSheet, photoWhen } from "./photos";

type Data = RouterOutputs["network"]["photos"]["admin"]["list"];
type Settings = Data["settings"];
type Photo = Data["photos"][number];
type Tab = "pending" | "posted" | "hidden";

const NEW_PHOTOS = { false: "Post right away", true: "Event team reviews first" } as const;
const WHO = { everyone: "Everyone at the event", attendees: "Attendees only", staff: "Staff only" } as const;

function PhotoSettings({ s }: { s: Settings }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const update = trpc.network.photos.admin.updateSettings.useMutation();
  const [d, setD] = useState(s);
  const view = (
    <div className="kv-tight">
      <span className="k">Photos in the app</span>
      <span>{s.on ? "On" : "Off"}</span>
      <span className="k">New photos</span>
      <span>{NEW_PHOTOS[String(s.review) as "true" | "false"]}</span>
      <span className="k">Who can post</span>
      <span>{WHO[s.who]}</span>
    </div>
  );
  if (!can("community", "edit")) {
    return (
      <div className="card card-pad col gap-12">
        <span className="h3" style={{ fontSize: 14 }}>Photo settings</span>
        {view}
      </div>
    );
  }
  return (
    <div className="card card-pad">
      <EditSection
        title="Photo settings"
        saving={update.isPending}
        onCancel={() => setD(s)}
        onSave={async () => {
          await update.mutateAsync({ eventId: ev.id, ...d });
          await Promise.all([utils.network.photos.admin.list.invalidate(), utils.core.events.get.invalidate({ eventId: ev.id })]);
        }}
        view={view}
        edit={
          <>
            <div className="grid-3">
              <Field label="Photos in the app">
                <select className="select" value={d.on ? "on" : "off"} onChange={(e) => setD({ ...d, on: e.target.value === "on" })}>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </Field>
              <Field label="New photos">
                <select className="select" value={d.review ? "review" : "now"} onChange={(e) => setD({ ...d, review: e.target.value === "review" })}>
                  <option value="now">Post right away</option>
                  <option value="review">Event team reviews first</option>
                </select>
              </Field>
              <Field label="Who can post">
                <select className="select" value={d.who} onChange={(e) => setD({ ...d, who: e.target.value as Settings["who"] })}>
                  <option value="everyone">Everyone at the event</option>
                  <option value="attendees">Attendees only</option>
                  <option value="staff">Staff only</option>
                </select>
              </Field>
            </div>
            <div className="choices-hint">Choices for New photos: Post right away, Event team reviews first. Who can post: Everyone at the event, Attendees only, Staff only.</div>
          </>
        }
      />
    </div>
  );
}

function PhotoCard({ p, onOpen }: { p: Photo; onOpen: () => void }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const setStatus = trpc.network.photos.admin.setStatus.useMutation();
  const remove = trpc.network.photos.admin.remove.useMutation();
  const busy = setStatus.isPending || remove.isPending;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      await utils.network.photos.admin.list.invalidate();
      toast(done);
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  const post = (
    <button key="post" type="button" className="btn btn-sm btn-solid" disabled={busy} onClick={() => run(() => setStatus.mutateAsync({ eventId: ev.id, photoId: p.id, status: "posted" }), "Posted")}>
      Post
    </button>
  );
  const hide = (
    <button key="hide" type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => setStatus.mutateAsync({ eventId: ev.id, photoId: p.id, status: "hidden" }), "Hidden")}>
      Hide
    </button>
  );
  const del = (
    <button key="del" type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => confirmAction("Delete this photo for good?") && run(() => remove.mutateAsync({ eventId: ev.id, photoId: p.id }), "Deleted")}>
      Delete
    </button>
  );
  const buttons = p.status === "pending" ? [post, hide] : p.status === "posted" ? [hide, del] : [post, del];
  return (
    <div className="admin-photo">
      <button type="button" aria-label={`Open photo by ${p.by.name}`} onClick={onOpen}>
        <img src={p.thumbUrl} alt="" loading="lazy" />
      </button>
      <div className="body">
        <b style={{ fontSize: 13.5 }}>{p.by.name}</b>
        <span className="s2" style={{ minHeight: 18, overflowWrap: "anywhere" }}>{p.caption || "No caption"}</span>
        {p.reported && p.status === "pending" ? <span className="s2" style={{ color: "var(--warn-ink)", fontWeight: 700 }}>Reported by an attendee</span> : null}
        <span className="s2">{photoWhen(p.at, ev.timezone)}</span>
        {can("community", "edit") ? <div className="acts">{buttons}</div> : null}
      </div>
    </div>
  );
}

export function AdminPhotosScreen() {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const q = trpc.network.photos.admin.list.useQuery({ eventId: ev.id });
  const upload = trpc.network.photos.admin.upload.useMutation();
  const [tab, setTab] = useState<Tab>("pending");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Photo | null>(null);
  const d = q.data;
  const shown = (d?.photos ?? []).filter((p) => p.status === tab);
  return (
    <AdminPage
      title="Photos"
      actions={
        <>
          {d?.counts.posted ? (
            <a className="btn" href={`/api/photos/${ev.id}/photos.zip`} download>
              Download all
            </a>
          ) : (
            <button type="button" className="btn" disabled title="No posted photos yet">
              Download all
            </button>
          )}
          {can("community", "edit") ? (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              Add photos
            </button>
          ) : null}
        </>
      }
    >
      {q.isLoading ? (
        <PageLoading />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : d ? (
        <>
          <NumStrip
            items={[
              { label: "Posted", value: d.counts.posted.toLocaleString("en-US") },
              { label: "Waiting for review", value: d.counts.pending.toLocaleString("en-US"), warn: d.counts.pending > 0 },
              { label: "Hidden", value: d.counts.hidden.toLocaleString("en-US") },
              { label: "Likes", value: d.counts.likes.toLocaleString("en-US") },
            ]}
          />
          <PhotoSettings key={JSON.stringify(d.settings)} s={d.settings} />
          <div>
            <FolderTabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: "pending", label: `Waiting for review (${d.counts.pending})` },
                { key: "posted", label: `Posted (${d.counts.posted})` },
                { key: "hidden", label: `Hidden (${d.counts.hidden})` },
              ]}
            />
            <div className="folder-body" style={{ padding: 14 }}>
              {shown.length ? (
                <div className="admin-photo-grid">
                  {shown.map((p) => (
                    <PhotoCard key={p.id} p={p} onOpen={() => setOpen(p)} />
                  ))}
                </div>
              ) : (
                <Empty>{tab === "pending" ? "Nothing waiting for review." : tab === "posted" ? "No posted photos yet." : "No hidden photos."}</Empty>
              )}
            </div>
          </div>
        </>
      ) : null}
      <Lightbox open={!!open} onClose={() => setOpen(null)} label="Photo">
        {open ? (
          <>
            <img src={open.url} alt={open.caption || `Photo by ${open.by.name}`} style={{ width: "100%", display: "block", maxHeight: "70dvh", objectFit: "contain", background: "#0F2A23" }} />
            <div className="lightbox-body" style={{ gap: 4 }}>
              <b>{open.by.name}</b>
              <span className="small muted">{[photoWhen(open.at, ev.timezone), open.sessionTitle].filter(Boolean).join(" · ")}</span>
              {open.caption ? <span style={{ fontSize: 14 }}>{open.caption}</span> : null}
            </div>
          </>
        ) : null}
      </Lightbox>
      <AddPhotosSheet
        frame="modal"
        open={adding}
        onClose={() => {
          setAdding(false);
          void utils.network.photos.admin.list.invalidate();
        }}
        review={false}
        sessions={[]}
        send={(p) => upload.mutateAsync({ eventId: ev.id, ...p })}
      />
    </AdminPage>
  );
}
