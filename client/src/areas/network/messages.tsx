/** Messages: conversations, meeting requests, and one conversation (chat). */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "../../lib/trpc";
import { AppScreen, BrandHeader, useEventApp } from "../../shells/AttendeeShell";
import { Empty, ErrorNote, PageLoading, Sheet } from "../../ui/components";
import { IconBack, IconPlus } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtTime, fmtWhen } from "@shared/format";
import { clockTime, Composer, PersonAvatar, shortWhen } from "./shared";

/** Meeting requests you sent or received that still matter (pending or upcoming). */
function MeetingRequests() {
  const { slug, base, event } = useEventApp();
  const utils = trpc.useUtils();
  const mine = trpc.network.meetings.mine.useQuery({ slug }, { enabled: event.features.meetings });
  const respond = trpc.network.meetings.respond.useMutation();
  const cancel = trpc.network.meetings.cancel.useMutation();
  const today = new Date().toISOString().slice(0, 10);
  const rows = (mine.data ?? []).filter((m) => (m.status === "pending" || m.status === "accepted") && m.date >= today);
  if (!rows.length) return null;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      await utils.network.meetings.mine.invalidate();
      toast(done);
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  return (
    <section className="col gap-8" style={{ padding: "14px 16px 4px" }}>
      <div className="section-title">Meetings</div>
      {rows.map((m) =>
        m.other ? (
          <div key={m.id} className="card col" style={{ padding: 12, gap: 10 }}>
            <div className="row" style={{ gap: 10 }}>
              <Link href={`${base}/people/${m.other.id}`}>
                <PersonAvatar person={m.other} size={40} />
              </Link>
              <div className="grow col" style={{ gap: 2 }}>
                <span className="strong clip" style={{ fontSize: 14 }}>{m.other.name}</span>
                <span className="small muted">
                  {fmtDate(m.date)} at {fmtTime(m.startTime)} · {m.minutes} min{m.place ? ` · ${m.place}` : ""}
                </span>
              </div>
              {m.status === "accepted" ? <span className="pill">Confirmed</span> : <span className="pill pill-orange">{m.incoming ? "New request" : "Waiting"}</span>}
            </div>
            {m.note ? <div className="small" style={{ color: "var(--ink-2)" }}>{m.note}</div> : null}
            {m.incoming && m.status === "pending" ? (
              <div className="grid-2">
                <button className="btn btn-sm btn-solid" disabled={respond.isPending} onClick={() => act(() => respond.mutateAsync({ slug, id: m.id, accept: true }), "Accepted")}>
                  Accept
                </button>
                <button className="btn btn-sm" disabled={respond.isPending} onClick={() => act(() => respond.mutateAsync({ slug, id: m.id, accept: false }), "Declined")}>
                  Decline
                </button>
              </div>
            ) : (
              <button
                className="btn btn-sm"
                disabled={cancel.isPending}
                onClick={() => {
                  if (window.confirm("Cancel this meeting?")) act(() => cancel.mutateAsync({ slug, id: m.id }), "Canceled");
                }}
              >
                {m.status === "pending" ? "Cancel request" : "Cancel meeting"}
              </button>
            )}
          </div>
        ) : null
      )}
    </section>
  );
}

/** /messages */
export function MessagesScreen() {
  const { slug, base, event } = useEventApp();
  const list = trpc.network.messages.list.useQuery({ slug }, { refetchInterval: 10_000, enabled: event.features.messaging });

  return (
    <AppScreen
      nav="messages"
      header={
        <header className="app-header" style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div className="col" style={{ gap: 2 }}>
            <div className="eyebrow">{event.shortName}</div>
            <div className="title">Messages</div>
          </div>
          <Link href={`${base}/people`} aria-label="New message" style={{ width: 44, height: 44, borderRadius: 12, border: "1px solid #3E7A65", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <IconPlus size={20} />
          </Link>
        </header>
      }
      bodyStyle={{ padding: 0, gap: 0 }}
    >
      {!event.features.messaging ? (
        <Empty>Messaging is turned off for this event.</Empty>
      ) : (
        <>
          <MeetingRequests />
          {list.isLoading ? (
            <PageLoading />
          ) : list.error ? (
            <ErrorNote error={list.error} />
          ) : !list.data?.length ? (
            <div className="col" style={{ padding: 16 }}>
              <Empty>No messages yet. Find someone in People to say hello.</Empty>
              <Link href={`${base}/people`} className="btn btn-block">
                Open People
              </Link>
            </div>
          ) : (
            <div className="col" style={{ gap: 0 }}>
              {list.data.map((t) => {
                const p = t.people[0];
                if (!p) return null;
                const unread = t.unread > 0;
                return (
                  <Link key={t.threadId} href={`${base}/messages/${t.threadId}`} style={{ textDecoration: "none", color: "inherit", background: "#FFFFFF", borderBottom: "1px solid var(--line)", padding: "14px 16px", display: "flex", gap: 12, alignItems: "center" }}>
                    <PersonAvatar person={p} size={48} />
                    <div className="grow col" style={{ gap: 3 }}>
                      <div className="row-between" style={{ gap: 8 }}>
                        <span className="clip" style={{ fontSize: 15, fontWeight: unread ? 800 : 700 }}>{t.people.map((x) => x.name).join(", ")}</span>
                        <span style={{ fontSize: 12, fontWeight: unread ? 700 : 600, color: unread ? "var(--brand)" : "var(--muted)", flexShrink: 0 }}>{shortWhen(t.last.at)}</span>
                      </div>
                      <div className="clip" style={{ fontSize: 13, fontWeight: unread ? 600 : 500, color: unread ? "var(--ink)" : "var(--muted)" }}>
                        {t.blocked ? "Blocked" : `${t.last.mine ? "You: " : ""}${t.last.body}`}
                        {t.muted ? " · Muted" : ""}
                      </div>
                    </div>
                    {unread ? <span role="img" aria-label="Unread" style={{ width: 10, height: 10, flexShrink: 0, borderRadius: 5, background: "var(--accent)" }} /> : null}
                  </Link>
                );
              })}
            </div>
          )}
          <p className="small muted" style={{ textAlign: "center", padding: "16px 24px", margin: 0 }}>
            Messages stay between attendees. The event team does not see them.
          </p>
        </>
      )}
    </AppScreen>
  );
}

/** /messages/:threadId */
export function ChatScreen({ threadId }: { threadId: number }) {
  const { slug, base } = useEventApp();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const chat = trpc.network.messages.get.useQuery({ slug, threadId }, { refetchInterval: 4000 });
  const send = trpc.network.messages.send.useMutation();
  const markRead = trpc.network.messages.markRead.useMutation();
  const mute = trpc.network.messages.mute.useMutation();
  const block = trpc.network.people.block.useMutation();
  const unblock = trpc.network.people.unblock.useMutation();
  const [menu, setMenu] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const d = chat.data;
  const lastId = d?.messages[d.messages.length - 1]?.id ?? 0;

  // Mark read and scroll down whenever a new message arrives.
  useEffect(() => {
    if (!lastId) return;
    markRead.mutateAsync({ slug, threadId }).then(() => utils.network.unreadMessages.invalidate()).catch(() => undefined);
    end.current?.scrollIntoView({ block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, slug, threadId]);

  const other = d?.people[0];

  return (
    <AppScreen
      header={
        <header className="app-bar" style={{ padding: "calc(10px + env(safe-area-inset-top)) 12px 10px" }}>
          <button className="icon-btn" aria-label="Back to messages" onClick={() => navigate(`${base}/messages`)}>
            <IconBack />
          </button>
          {other ? (
            <Link href={`${base}/people/${other.id}`} className="grow row" style={{ textDecoration: "none", color: "inherit", gap: 10 }}>
              <PersonAvatar person={other} size={38} />
              <span className="col grow" style={{ gap: 0 }}>
                <span className="clip" style={{ fontSize: 15, fontWeight: 800 }}>{d.people.map((p) => p.name).join(", ")}</span>
                {other.jobTitle || other.organization ? <span className="clip small muted">{other.jobTitle || other.organization}</span> : null}
              </span>
            </Link>
          ) : (
            <span className="grow" />
          )}
          {d ? (
            <button className="icon-btn" aria-label="Block or report" onClick={() => setMenu(true)}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
          ) : null}
        </header>
      }
      footer={
        d && !d.blocked ? (
          <Composer
            placeholder="Write a message"
            busy={send.isPending}
            onSend={async (body) => {
              try {
                await send.mutateAsync({ slug, threadId, body });
                await utils.network.messages.get.invalidate({ slug, threadId });
                await utils.network.messages.list.invalidate();
              } catch (err) {
                toast(errorText(err), true);
                throw err;
              }
            }}
          />
        ) : d?.blocked ? (
          <div className="small muted" style={{ textAlign: "center" }}>You cannot message each other.</div>
        ) : null
      }
      bodyStyle={{ gap: 10 }}
    >
      {chat.isLoading ? (
        <PageLoading />
      ) : chat.error ? (
        <ErrorNote error={chat.error} />
      ) : d ? (
        <>
          {!d.messages.length ? <Empty>Say hello to {other?.firstName ?? "them"}.</Empty> : null}
          {d.messages.map((m, i) => {
            const prev = d.messages[i - 1];
            const next = d.messages[i + 1];
            const day = fmtWhen(m.at);
            const newDay = !prev || fmtWhen(prev.at) !== day;
            const lastOfRun = !next || next.mine !== m.mine || new Date(next.at).getTime() - new Date(m.at).getTime() > 10 * 60_000;
            return (
              <div key={m.id} className="col" style={{ gap: 4 }}>
                {newDay ? <div style={{ alignSelf: "center", fontSize: 12, fontWeight: 600, color: "var(--muted)", padding: "4px 0" }}>{day}</div> : null}
                <div
                  style={{
                    alignSelf: m.mine ? "flex-end" : "flex-start",
                    maxWidth: "78%",
                    background: m.mine ? "var(--brand)" : "#FFFFFF",
                    color: m.mine ? "var(--on-brand)" : "var(--ink)",
                    border: m.mine ? "none" : "1px solid var(--line)",
                    borderRadius: m.mine ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                    padding: "10px 12px",
                    fontSize: 14,
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {m.body}
                </div>
                {lastOfRun ? <div style={{ alignSelf: m.mine ? "flex-end" : "flex-start", fontSize: 11, color: "var(--muted)" }}>{clockTime(m.at)}</div> : null}
              </div>
            );
          })}
          <div ref={end} />
          <Sheet open={menu} onClose={() => setMenu(false)} label="Conversation options">
            <div className="h3">{other?.name}</div>
            <button
              className="btn btn-block"
              onClick={async () => {
                try {
                  await mute.mutateAsync({ slug, threadId, muted: !d.muted });
                  await utils.network.messages.invalidate();
                  await utils.network.unreadMessages.invalidate();
                  setMenu(false);
                  toast(d.muted ? "Notifications on" : "Muted");
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              {d.muted ? "Unmute" : "Mute"}
            </button>
            {other ? (
              other.blockedByMe ? (
                <button
                  className="btn btn-block"
                  onClick={async () => {
                    try {
                      await unblock.mutateAsync({ slug, attendeeId: other.id });
                      await utils.network.invalidate();
                      setMenu(false);
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  Unblock
                </button>
              ) : (
                <button
                  className="btn btn-block btn-danger"
                  onClick={async () => {
                    if (!window.confirm(`Block ${other.firstName}? You will not be able to message each other.`)) return;
                    try {
                      await block.mutateAsync({ slug, attendeeId: other.id });
                      await utils.network.invalidate();
                      setMenu(false);
                      toast("Blocked");
                      navigate(`${base}/messages`);
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  Block
                </button>
              )
            ) : null}
            <p className="small muted" style={{ margin: 0 }}>
              To report a message, block the person and tell the event team at the help desk.
            </p>
            <button className="btn btn-ghost btn-block" onClick={() => setMenu(false)}>
              Cancel
            </button>
          </Sheet>
        </>
      ) : null}
    </AppScreen>
  );
}
