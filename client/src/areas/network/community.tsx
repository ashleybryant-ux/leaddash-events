/** Community: topics, one topic with posts and replies, and starting a discussion. */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AppScreen, useEventApp } from "../../shells/AttendeeShell";
import { Empty, ErrorNote, Field, PageLoading, Sheet } from "../../ui/components";
import { IconBack, IconCommunity, IconLock } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtWhen, fmtWhenTime } from "@shared/format";
import { ago, ChoiceChip, Composer, LightTabs, PersonAvatar } from "./shared";

type ChannelData = RouterOutputs["network"]["community"]["channel"];
type PostData = ChannelData["posts"][number];
type ReplyData = PostData["replies"][number];

const joinBtn = { width: 80, height: 34, flexShrink: 0, borderRadius: 9, fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" } as const;

/** /community */
export function CommunityScreen() {
  const { slug, base, event } = useEventApp();
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<"all" | "joined">("all");
  const list = trpc.network.community.channels.useQuery({ slug }, { enabled: event.features.community });
  const join = trpc.network.community.join.useMutation();
  const channels = (list.data?.channels ?? []).filter((c) => tab === "all" || c.joined);

  return (
    <AppScreen
      nav="community"
      header={
        <header className="app-header" style={{ paddingBottom: 16 }}>
          <div className="row-between" style={{ alignItems: "flex-end" }}>
            <div className="col" style={{ gap: 2 }}>
              <div className="eyebrow">{event.shortName}</div>
              <div className="title">Community</div>
            </div>
            {event.features.networking ? (
              <Link href={`${base}/people`} style={{ height: 40, padding: "0 14px", borderRadius: 12, border: "1px solid #3E7A65", color: "#FFFFFF", fontSize: 13, fontWeight: 700, textDecoration: "none", display: "flex", alignItems: "center" }}>
                People
              </Link>
            ) : null}
          </div>
          {list.data?.canStart ? (
            <Link href={`${base}/community/new`} className="btn btn-primary btn-block" style={{ height: 46, borderRadius: 12, fontSize: 15 }}>
              Start a discussion
            </Link>
          ) : null}
        </header>
      }
      bodyStyle={{ gap: 10, paddingTop: 14 }}
    >
      {!event.features.community ? (
        <Empty>Community is turned off for this event.</Empty>
      ) : (
        <>
          <LightTabs
            label="Topics"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "all", label: "All topics" },
              { key: "joined", label: "Joined" },
            ]}
          />
          {list.isLoading ? (
            <PageLoading />
          ) : list.error ? (
            <ErrorNote error={list.error} />
          ) : !channels.length ? (
            <Empty>{tab === "joined" ? "Join a topic to see it here." : "No topics yet."}</Empty>
          ) : (
            channels.map((c) => (
              <div key={c.id} className="tile">
                <Link href={`${base}/community/${c.id}`} className="row grow" style={{ textDecoration: "none", color: "inherit", gap: 12 }}>
                  {c.official ? (
                    <span style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 12, background: "var(--brand)", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <IconCommunity size={20} />
                    </span>
                  ) : null}
                  <span className="grow col" style={{ gap: 2 }}>
                    <span className="row gap-6">
                      <span style={{ fontSize: 15, fontWeight: 800 }}>{c.name}</span>
                      {c.locked ? <IconLock /> : null}
                    </span>
                    <span className="small muted">
                      {[c.official ? "Event team" : "", `${c.posts} post${c.posts === 1 ? "" : "s"}`, c.lastPostAt ? ago(c.lastPostAt) : ""].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </Link>
                {c.pinned ? (
                  <span className="pill" style={{ fontSize: 11 }}>Pinned</span>
                ) : c.joined ? (
                  <span style={{ ...joinBtn, background: "var(--brand-tint)", color: "var(--brand)", cursor: "default" }}>Joined</span>
                ) : (
                  <button
                    type="button"
                    style={{ ...joinBtn, border: "1.5px solid var(--brand)", background: "#FFFFFF", color: "var(--brand)" }}
                    disabled={join.isPending}
                    onClick={async () => {
                      try {
                        await join.mutateAsync({ slug, channelId: c.id, joined: true });
                        await utils.network.community.channels.invalidate();
                      } catch (err) {
                        toast(errorText(err), true);
                      }
                    }}
                  >
                    Join
                  </button>
                )}
              </div>
            ))
          )}
        </>
      )}
    </AppScreen>
  );
}

function Author({ post, first }: { post: PostData | ReplyData; first?: boolean }) {
  const { base, event } = useEventApp();
  if (post.byEvent || !post.author) {
    return (
      <div className="row" style={{ gap: 10 }}>
        <span style={{ width: 38, height: 38, flexShrink: 0, borderRadius: 19, background: "var(--brand)", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <IconCommunity size={18} />
        </span>
        <span className="col" style={{ gap: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 800 }}>{post.byEvent ? `${event.shortName} team` : "Former attendee"}</span>
          <span className="small muted">{fmtWhenTime(post.at)}</span>
        </span>
      </div>
    );
  }
  return (
    <Link href={`${base}/people/${post.author.id}`} className="row" style={{ gap: 10, textDecoration: "none", color: "inherit" }}>
      <PersonAvatar person={post.author} size={38} />
      <span className="col" style={{ gap: 0, minWidth: 0 }}>
        <span className="clip" style={{ fontSize: 14, fontWeight: 800 }}>{post.author.name}</span>
        <span className="small muted">{first ? `Started this topic · ${fmtWhen(post.at)}` : fmtWhenTime(post.at)}</span>
      </span>
    </Link>
  );
}

/** /community/:channelId */
export function ChannelScreen({ channelId }: { channelId: number }) {
  const { slug, base } = useEventApp();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const ch = trpc.network.community.channel.useQuery({ slug, channelId }, { refetchInterval: 15_000 });
  const join = trpc.network.community.join.useMutation();
  const post = trpc.network.community.post.useMutation();
  const like = trpc.network.community.like.useMutation();
  const report = trpc.network.community.report.useMutation();
  const [replyTo, setReplyTo] = useState<PostData | null>(null);
  const [options, setOptions] = useState<PostData | ReplyData | null>(null);
  const d = ch.data;
  const refresh = () => utils.network.community.invalidate();

  const toggleLike = async (p: PostData | ReplyData) => {
    try {
      await like.mutateAsync({ slug, postId: p.id, liked: !p.liked });
      await utils.network.community.channel.invalidate({ slug, channelId });
    } catch (err) {
      toast(errorText(err), true);
    }
  };

  const LikeButton = ({ p }: { p: PostData | ReplyData }) => (
    <button type="button" onClick={() => toggleLike(p)} aria-pressed={p.liked} className="btn btn-xs btn-ghost" style={{ padding: "0 6px", color: p.liked ? "var(--brand)" : "var(--muted)", fontWeight: p.liked ? 800 : 600 }}>
      {p.likes} like{p.likes === 1 ? "" : "s"}
    </button>
  );
  const OptionsButton = ({ p }: { p: PostData | ReplyData }) =>
    p.mine ? null : (
      <button className="icon-btn" aria-label="Post options" style={{ width: 36, height: 36 }} onClick={() => setOptions(p)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
    );

  const target = d?.replyToId ? null : replyTo;

  return (
    <AppScreen
      header={
        <header className="app-bar" style={{ padding: "calc(10px + env(safe-area-inset-top)) 12px 10px" }}>
          <button className="icon-btn" aria-label="Back to community" onClick={() => navigate(`${base}/community`)}>
            <IconBack />
          </button>
          <div className="grow col" style={{ gap: 0 }}>
            <span className="clip" style={{ fontSize: 15, fontWeight: 800 }}>{d?.name ?? ""}</span>
            {d ? <span className="small muted">{d.members} member{d.members === 1 ? "" : "s"}</span> : null}
          </div>
          {d ? (
            <button
              type="button"
              className={`btn btn-sm${d.joined ? "" : " btn-solid"}`}
              style={{ width: 80, padding: 0, ...(d.joined ? { background: "var(--brand-tint)", borderColor: "var(--brand-tint)" } : {}) }}
              disabled={join.isPending}
              onClick={async () => {
                try {
                  await join.mutateAsync({ slug, channelId, joined: !d.joined });
                  await refresh();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              {d.joined ? "Joined" : "Join"}
            </button>
          ) : null}
        </header>
      }
      footer={
        d ? (
          d.canPost ? (
            <Composer
              placeholder={d.replyToId || target ? "Write a reply" : "Write a post"}
              busy={post.isPending}
              above={
                target ? (
                  <div className="row-between small" style={{ fontWeight: 600, color: "var(--muted)" }}>
                    <span className="clip">Replying to {target.byEvent ? "the event team" : target.author?.firstName ?? "this post"}</span>
                    <button type="button" className="btn btn-xs btn-ghost" onClick={() => setReplyTo(null)}>
                      Cancel
                    </button>
                  </div>
                ) : undefined
              }
              onSend={async (body) => {
                try {
                  await post.mutateAsync({ slug, channelId, body, parentId: d.replyToId ?? target?.id ?? null });
                  setReplyTo(null);
                  await refresh();
                } catch (err) {
                  toast(errorText(err), true);
                  throw err;
                }
              }}
            />
          ) : (
            <div className="row small muted" style={{ justifyContent: "center", gap: 6 }}>
              <IconLock />
              {d.cannotPostReason}
            </div>
          )
        ) : null
      }
      bodyStyle={{ gap: 12 }}
    >
      {ch.isLoading ? (
        <PageLoading />
      ) : ch.error ? (
        <ErrorNote error={ch.error} />
      ) : d ? (
        <>
          {d.description ? <div className="small muted">{d.description}</div> : null}
          {!d.posts.length ? <Empty>No posts yet. Start the conversation.</Empty> : null}
          {d.posts.map((p, i) => (
            <div key={p.id} className="card col" style={{ padding: 14, gap: 10 }}>
              <div className="row-between" style={{ alignItems: "flex-start" }}>
                <Author post={p} first={!d.official && i === 0} />
                <OptionsButton p={p} />
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{p.body}</div>
              <div className="row" style={{ gap: 4 }}>
                <LikeButton p={p} />
                <span className="small muted" style={{ fontWeight: 600 }}>
                  {p.replies.length} repl{p.replies.length === 1 ? "y" : "ies"}
                </span>
                {!d.replyToId && d.canPost ? (
                  <button type="button" className="btn btn-xs btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setReplyTo(p)}>
                    Reply
                  </button>
                ) : null}
              </div>
              {p.replies.length ? (
                <div className="col" style={{ gap: 12, borderTop: "1px solid var(--line-2)", paddingTop: 12 }}>
                  {p.replies.map((r) => (
                    <div key={r.id} className="col" style={{ gap: 6 }}>
                      <div className="row-between" style={{ alignItems: "flex-start" }}>
                        <Author post={r} />
                        <OptionsButton p={r} />
                      </div>
                      <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", paddingLeft: 48 }}>{r.body}</div>
                      <div style={{ paddingLeft: 42 }}>
                        <LikeButton p={r} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          <Sheet open={!!options} onClose={() => setOptions(null)} label="Post options">
            <div className="h3">Post options</div>
            <button
              className="btn btn-block btn-danger"
              disabled={report.isPending}
              onClick={async () => {
                if (!options) return;
                try {
                  await report.mutateAsync({ slug, postId: options.id, reason: "" });
                  setOptions(null);
                  toast("Reported to the event team");
                  await refresh();
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Report post
            </button>
            <button className="btn btn-ghost btn-block" onClick={() => setOptions(null)}>
              Cancel
            </button>
          </Sheet>
        </>
      ) : null}
    </AppScreen>
  );
}

/** /community/new */
export function NewTopicScreen() {
  const { slug, base } = useEventApp();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const list = trpc.network.community.channels.useQuery({ slug });
  const start = trpc.network.community.start.useMutation();
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("General");
  const categories = (list.data?.categories ?? []).filter((c) => c !== "General");
  const ready = name.trim().length >= 3 && body.trim().length > 0;

  const submit = async () => {
    try {
      const { channelId } = await start.mutateAsync({ slug, name: name.trim(), body: body.trim(), category });
      await utils.network.community.invalidate();
      navigate(`${base}/community/${channelId}`);
    } catch (err) {
      toast(errorText(err), true);
    }
  };

  return (
    <AppScreen
      header={
        <header className="app-bar">
          <button className="icon-btn" aria-label="Cancel" onClick={() => navigate(`${base}/community`)}>
            <IconBack />
          </button>
          <div className="title grow">Start a discussion</div>
          <button className="btn btn-sm btn-primary" style={{ width: 72, padding: 0 }} disabled={!ready || start.isPending} onClick={submit}>
            Post
          </button>
        </header>
      }
      bodyStyle={{ gap: 14 }}
    >
      {list.data && !list.data.canStart ? <div className="banner banner-warn">Only the event team can start topics.</div> : null}
      <Field label="Topic title">
        <input className="input" value={name} maxLength={100} placeholder="Dinner meetup on Friday night" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="First post">
        <textarea className="textarea" rows={6} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      {categories.length ? (
        <div className="col gap-6">
          <span className="field" style={{ fontWeight: 700 }}>Category</span>
          <div className="row wrap gap-8">
            {categories.map((c) => (
              <ChoiceChip key={c} selected={category === c} onClick={() => setCategory(category === c ? "General" : c)}>
                {c}
              </ChoiceChip>
            ))}
          </div>
        </div>
      ) : null}
      <p className="small muted" style={{ margin: 0 }}>
        Posts follow the event's community guidelines.
      </p>
    </AppScreen>
  );
}
