/**
 * Attendee app Photos: /e/:slug/photos. A grid of posted photos (All photos)
 * and the person's own (My photos, with ones waiting for review), the Add
 * photos sheet, and the full-screen photo view with Like, Download and
 * Report or Delete.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AppScreen, BackBar, useEventApp } from "../../shells/AttendeeShell";
import { confirmAction, Empty, ErrorNote, Field, Modal, PageLoading, Sheet } from "../../ui/components";
import { IconClose, IconHeart } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtTime } from "@shared/format";
import { dateToZoned } from "@shared/time";

export type PhotoItem = RouterOutputs["network"]["photos"]["list"]["items"][number];

/* ---------- When the person last opened Photos (for the dot on Home) ---------- */

const seenKey = (eventId: number, attendeeId: number) => `ld-photos-seen-${eventId}-${attendeeId}`;

export function photosSeenAt(eventId: number, attendeeId: number) {
  try {
    return Number(localStorage.getItem(seenKey(eventId, attendeeId)) || 0);
  } catch {
    return 0;
  }
}

function markPhotosSeen(eventId: number, attendeeId: number) {
  try {
    localStorage.setItem(seenKey(eventId, attendeeId), String(Date.now()));
  } catch {
    /* private window */
  }
}

/** "Apr 22, 2027 · 10:42 AM" in the event's time zone. */
export function photoWhen(at: number, tz: string) {
  try {
    const z = dateToZoned(new Date(at), tz);
    return `${fmtDate(z.date)} · ${fmtTime(z.time)}`;
  } catch {
    const d = new Date(at);
    return `${fmtDate(d.toISOString().slice(0, 10))} · ${fmtTime(`${d.getHours()}:${d.getMinutes()}`)}`;
  }
}

/* ---------- Getting a picked photo ready to send ---------- */

async function decode(file: File): Promise<{ img: CanvasImageSource; w: number; h: number; done: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      return { img: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
    } catch {
      /* fall back to an <img> (older Safari) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    return { img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("That photo could not be opened. Pick a JPEG or PNG photo.");
  }
}

function toJpeg(src: { img: CanvasImageSource; w: number; h: number }, maxSide: number, quality: number) {
  const scale = Math.min(1, maxSide / Math.max(src.w, src.h));
  const w = Math.max(1, Math.round(src.w * scale));
  const h = Math.max(1, Math.round(src.h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src.img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Resizes a photo in the browser to about 2000px on the long side (JPEG, quality 0.85)
 * plus a small copy for the grid. Re-drawing also drops location data from the camera.
 */
export async function preparePhoto(file: File) {
  const src = await decode(file);
  try {
    return { name: `${(file.name || "photo").replace(/\.[^.]+$/, "").slice(0, 80) || "photo"}.jpg`, base64: toJpeg(src, 2000, 0.85), thumbBase64: toJpeg(src, 480, 0.8) };
  } finally {
    src.done();
  }
}

/* ---------- Add photos sheet ---------- */

type Picked = { file: File; url: string };

export function AddPhotosSheet({ open, onClose, review, sessions, send, frame = "sheet" }: { open: boolean; onClose: () => void; review: boolean; frame?: "sheet" | "modal"; sessions: { id: number; title: string }[]; send: (p: { name: string; base64: string; thumbBase64: string; caption: string; sessionId: number | null }) => Promise<unknown> }) {
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [caption, setCaption] = useState("");
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (open && !picked.length) setTimeout(() => input.current?.click(), 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = () => {
    picked.forEach((p) => URL.revokeObjectURL(p.url));
    setPicked([]);
    setCaption("");
    setSessionId(null);
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };
  const post = async () => {
    setBusy({ done: 0, total: picked.length });
    let sent = 0;
    try {
      for (const p of picked) {
        const ready = await preparePhoto(p.file);
        await send({ ...ready, caption: caption.trim(), sessionId });
        sent += 1;
        setBusy({ done: sent, total: picked.length });
      }
      toast(review ? (sent === 1 ? "Sent for review" : `${sent} photos sent for review`) : sent === 1 ? "Photo posted" : `${sent} photos posted`);
      setBusy(null);
      reset();
      onClose();
    } catch (err) {
      setBusy(null);
      setPicked((list) => list.slice(sent));
      toast(errorText(err), true);
    }
  };
  const n = picked.length;
  const body = (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
          e.target.value = "";
          setPicked((list) => [...list, ...files.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, 20));
        }}
      />
      <div className="photo-thumbs">
        {picked.map((p, i) => (
          <span key={p.url}>
            <img src={p.url} alt={`Photo ${i + 1}`} />
            {!busy ? (
              <button
                type="button"
                className="remove"
                aria-label={`Remove photo ${i + 1}`}
                onClick={() => {
                  URL.revokeObjectURL(p.url);
                  setPicked((list) => list.filter((x) => x !== p));
                }}
              >
                <IconClose size={12} />
              </button>
            ) : null}
          </span>
        ))}
        {n < 20 && !busy ? (
          <button type="button" className="add" aria-label="Pick more photos" onClick={() => input.current?.click()}>
            +
          </button>
        ) : null}
      </div>
      <Field label="Caption (optional)">
        <input className="input" value={caption} maxLength={300} onChange={(e) => setCaption(e.target.value)} />
      </Field>
      {sessions.length ? (
        <Field label="Session (optional)">
          <select className="select" value={sessionId ?? ""} onChange={(e) => setSessionId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No session</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {review ? <div className="photo-note">The event team reviews photos before they show to everyone.</div> : null}
      <button type="button" className="btn btn-primary btn-lg btn-block" style={{ height: 46, fontSize: 15 }} disabled={!n || !!busy} onClick={post}>
        {busy ? `Posting ${Math.min(busy.done + 1, busy.total)} of ${busy.total}` : n === 1 ? "Post 1 photo" : `Post ${n} photos`}
      </button>
    </>
  );
  if (frame === "modal") {
    return (
      <Modal open={open} onClose={close} title="Add photos">
        {body}
      </Modal>
    );
  }
  return (
    <Sheet open={open} onClose={close} label="Add photos">
      <span style={{ fontSize: 17, fontWeight: 800 }}>Add photos</span>
      {body}
    </Sheet>
  );
}

/* ---------- Photo view ---------- */

function PhotoView({ items, index, onIndex, onClose }: { items: PhotoItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const { slug, event } = useEventApp();
  const utils = trpc.useUtils();
  const like = trpc.network.photos.like.useMutation();
  const report = trpc.network.photos.report.useMutation();
  const remove = trpc.network.photos.remove.useMutation();
  const [local, setLocal] = useState<Record<number, { liked: boolean; likes: number }>>({});
  const touch = useRef<number | null>(null);
  const p = items[index];
  const go = (d: number) => {
    const next = index + d;
    if (next >= 0 && next < items.length) onIndex(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  });
  if (!p) return null;
  const state = local[p.id] ?? { liked: p.liked, likes: p.likes };
  const meta = [photoWhen(p.at, event.timezone), p.sessionTitle].filter(Boolean).join(" · ");
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      await utils.network.photos.list.invalidate();
      onClose();
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  return (
    <div
      className="photo-view"
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      onTouchStart={(e) => (touch.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const start = touch.current;
        const end = e.changedTouches[0]?.clientX;
        touch.current = null;
        if (start === null || end === undefined || Math.abs(end - start) < 50) return;
        go(end < start ? 1 : -1);
      }}
    >
      <button type="button" className="close" aria-label="Close" onClick={onClose}>
        <IconClose />
      </button>
      <div className="img" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <img src={p.url} alt={p.caption || `Photo by ${p.by.name}`} />
      </div>
      <div className="info">
        <div className="who">
          <span className="face">{p.by.photoUrl ? <img src={p.by.photoUrl} alt="" /> : p.by.initials}</span>
          <div className="col" style={{ minWidth: 0, gap: 1 }}>
            <b style={{ fontSize: 15 }}>{p.by.name}</b>
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{meta}</span>
          </div>
        </div>
        {p.status === "pending" ? <div className="photo-note">Waiting for review. Only you and the event team can see it.</div> : null}
        {p.caption ? <div style={{ fontSize: 14, overflowWrap: "anywhere" }}>{p.caption}</div> : null}
        <div className="acts">
          <button
            type="button"
            className={`btn${state.liked ? " liked" : ""}`}
            aria-pressed={state.liked}
            disabled={like.isPending || p.status !== "posted"}
            onClick={async () => {
              try {
                const r = await like.mutateAsync({ slug, photoId: p.id });
                setLocal((m) => ({ ...m, [p.id]: r }));
                void utils.network.photos.list.invalidate();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            <IconHeart filled={state.liked} size={14} />
            {state.liked ? "Liked" : "Like"} · {state.likes}
          </button>
          <a className="btn" href={p.downloadUrl} download>
            Download
          </a>
          {p.mine ? (
            <button type="button" className="btn" disabled={remove.isPending} onClick={() => confirmAction("Delete this photo?") && act(() => remove.mutateAsync({ slug, photoId: p.id }), "Photo deleted")}>
              Delete
            </button>
          ) : (
            <button type="button" className="btn" disabled={report.isPending || p.status !== "posted"} onClick={() => confirmAction("Report this photo to the event team? It comes down until they review it.") && act(() => report.mutateAsync({ slug, photoId: p.id }), "Thanks. The event team will take a look.")}>
              Report
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- The Photos screen ---------- */

export function PhotosScreen() {
  const { slug, event, me, base } = useEventApp();
  const utils = trpc.useUtils();
  const [mine, setMine] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const q = trpc.network.photos.list.useInfiniteQuery({ slug, mine }, { getNextPageParam: (last) => last.next ?? undefined });
  const agenda = trpc.program.sessions.agenda.useQuery({ slug }, { enabled: adding });
  const upload = trpc.network.photos.upload.useMutation();
  useEffect(() => {
    markPhotosSeen(event.id, me.attendee?.id ?? 0);
  }, [event.id, me.attendee?.id, q.data]);
  const items = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);
  const first = q.data?.pages[0];
  const sessions = useMemo(() => (agenda.data?.sessions ?? []).map((s) => ({ id: s.id, title: s.title })), [agenda.data]);

  return (
    <AppScreen
      nav="more"
      header={
        <BackBar
          title={<span style={{ fontSize: 17, fontWeight: 800 }}>Photos</span>}
          back={`${base}/home`}
          right={
            first?.canPost ? (
              <button type="button" className="btn btn-primary" style={{ height: 38, fontSize: 13.5 }} onClick={() => setAdding(true)}>
                Add photos
              </button>
            ) : null
          }
        />
      }
      bodyStyle={{ gap: 12 }}
    >
      <div role="tablist" className="seg-light">
        <button type="button" role="tab" aria-selected={!mine} onClick={() => setMine(false)}>
          All photos{first ? ` (${first.counts.all})` : ""}
        </button>
        <button type="button" role="tab" aria-selected={mine} onClick={() => setMine(true)}>
          My photos{first ? ` (${first.counts.mine})` : ""}
        </button>
      </div>
      {q.isLoading ? (
        <PageLoading />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : !items.length ? (
        <Empty>{mine ? "You have not posted any photos yet." : first?.canPost ? "No photos yet. Add the first one." : "No photos yet."}</Empty>
      ) : (
        <div className="photo-grid">
          {items.map((p, i) => (
            <button key={p.id} type="button" className="photo-cell" aria-label={`Open photo by ${p.by.name}`} onClick={() => setOpen(i)}>
              <img src={p.thumbUrl} alt="" loading="lazy" />
              {p.status === "pending" ? (
                <span className="wait">Waiting for review</span>
              ) : p.likes > 0 ? (
                <span className="likes">
                  <IconHeart filled size={10} />
                  {p.likes}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}
      {q.hasNextPage ? (
        <button type="button" className="btn btn-block" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          {q.isFetchingNextPage ? "Loading" : "Show more"}
        </button>
      ) : null}
      {open !== null ? <PhotoView items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} /> : null}
      <AddPhotosSheet
        open={adding}
        onClose={() => {
          setAdding(false);
          void utils.network.photos.list.invalidate();
        }}
        review={!!first?.review}
        sessions={sessions}
        send={(p) => upload.mutateAsync({ slug, ...p })}
      />
    </AppScreen>
  );
}
