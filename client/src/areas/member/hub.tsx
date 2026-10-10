/**
 * The member hub screens: Home (the one member dashboard), My card (with the
 * printable card and membership letter), Events, Documents and a group page.
 * Plus the public card check the QR code opens.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearch } from "wouter";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { MemberScreen, useMemberApp } from "../../shells/MemberShell";
import { brandStyle } from "../../shells/AttendeeShell";
import { Avatar, Empty, ErrorNote, PageLoading, Pill, QR, Sheet } from "../../ui/components";
import { IconBack, IconBell, IconChevron, IconFolder, IconSearch } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtDates, fmtHours, fmtWhen, fmtWhenTime } from "@shared/format";
import { DateTile, FileType, ListCard, ROLE_LABEL, STATUS_LABEL, mdy } from "./lib";

// ---------- Frame pieces ----------

function BrandHeader({ title, right, children }: { title: string; right?: ReactNode; children?: ReactNode }) {
  const { org } = useMemberApp();
  return (
    <header className="app-header">
      <div className="row-between">
        <div className="col" style={{ gap: 2 }}>
          <div className="eyebrow">{org.name} Member</div>
          <div className="title">{title}</div>
        </div>
        {right}
      </div>
      {children}
    </header>
  );
}

function BackBar({ title, href }: { title: string; href: string }) {
  return (
    <header className="app-bar">
      <Link href={href} aria-label="Back" className="icon-btn" style={{ color: "var(--ink)" }}>
        <IconBack />
      </Link>
      <div className="title clip">{title}</div>
    </header>
  );
}

/** The bell in the home header: alerts from the member hub (new documents). */
function AlertsBell() {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const list = trpc.core.notifications.list.useQuery({});
  const markRead = trpc.core.notifications.markRead.useMutation({ onSuccess: () => utils.core.notifications.list.invalidate() });
  const mine = (list.data ?? []).filter((n) => n.eventId === null);
  const unread = mine.filter((n) => !n.readAt);
  return (
    <>
      <button
        aria-label="Notifications"
        className="icon-btn"
        style={{ position: "relative", background: "var(--brand-mid)", color: "#FFFFFF" }}
        onClick={() => {
          setOpen(true);
          if (unread.length) markRead.mutate({ ids: unread.map((n) => n.id) });
        }}
      >
        <IconBell />
        {unread.length ? <span style={{ position: "absolute", top: 6, right: 6, width: 10, height: 10, borderRadius: 5, background: "var(--accent)" }} /> : null}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} label="Notifications">
        <span className="h3">Notifications</span>
        {mine.length ? (
          <div className="list">
            {mine.slice(0, 30).map((n) => (
              <Link key={n.id} href={n.url || "#"} className="list-item" style={{ padding: "10px 0" }} onClick={() => setOpen(false)}>
                <div className="grow col" style={{ gap: 2 }}>
                  <span className="strong">{n.title}</span>
                  <span className="small muted">
                    {n.body ? `${n.body} · ` : ""}
                    {fmtWhenTime(n.createdAt)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <Empty>No notifications yet.</Empty>
        )}
      </Sheet>
    </>
  );
}

function statusLine(card: { status: string; expiresOn: string | null }) {
  if (card.status === "active") return card.expiresOn ? `Active through ${fmtDate(card.expiresOn)}` : "Active";
  if (card.status === "grace") return card.expiresOn ? `Grace period, expired ${fmtDate(card.expiresOn)}` : "Grace period";
  if (card.status === "lapsed") return card.expiresOn ? `Lapsed on ${fmtDate(card.expiresOn)}` : "Lapsed";
  return "Cancelled";
}

function RenewButton({ url, className = "btn btn-primary btn-sm" }: { url: string; className?: string }) {
  if (!url) return <span className="small muted">Contact the organization to renew.</span>;
  return (
    <a className={className} href={url} target="_blank" rel="noreferrer">
      Renew
    </a>
  );
}

// ---------- Home ----------

export function MemberHome() {
  const { orgSlug, base } = useMemberApp();
  const home = trpc.member.hub.home.useQuery({ orgSlug });
  const groups = trpc.member.groups.mine.useQuery({ orgSlug }, { enabled: !!home.data?.active });
  if (home.isLoading) return <MemberScreen nav="home"><PageLoading /></MemberScreen>;
  if (home.error) return <MemberScreen nav="home"><ErrorNote error={home.error} /></MemberScreen>;
  const h = home.data!;
  const registered = h.events.filter((e) => e.registered);
  const others = h.events.filter((e) => !e.registered);
  const coming = [...registered, ...others].slice(0, 4);
  return (
    <MemberScreen
      nav="home"
      header={
        <BrandHeader title={`Welcome back, ${h.card.firstName}`} right={<AlertsBell />}>
          <Link href={`${base}/card`} style={{ textDecoration: "none", background: "#FFFFFF", color: "var(--ink)", borderRadius: 14, padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div className="col" style={{ gap: 3 }}>
              <span className="label-caps">{h.card.level} member</span>
              <span style={{ fontSize: 16, fontWeight: 800 }}>{statusLine(h.card)}</span>
              <span className="small strong" style={{ color: "var(--brand)", fontSize: 13 }}>Show my member card</span>
            </div>
            <QR value={h.card.verifyUrl} size={46} label="Member QR code" />
          </Link>
        </BrandHeader>
      }
    >
      {!h.active ? (
        <div className="banner banner-warn">
          <span>Your membership has lapsed. Renew to open documents, groups and member pricing.</span>
          <RenewButton url={h.renewUrl} />
        </div>
      ) : (
        <>
          <div className="grid-3" style={{ gap: 8, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <MiniStat value={String(h.ceHours)} label="CE hours this cycle" />
            <MiniStat value={String(h.groups.length)} label="Committees" />
            <MiniStat value={String(registered.length)} label="Events registered" />
          </div>

          {coming.length ? (
            <>
              <div className="section-title" style={{ paddingTop: 2 }}>Coming up</div>
              {coming.map((e) =>
                e.registered ? (
                  <Link key={e.id} href={`/e/${e.slug}`} className="tile">
                    <DateTile iso={e.startDate} />
                    <div className="grow col" style={{ gap: 2 }}>
                      <span className="strong" style={{ fontSize: 15 }}>{e.name}</span>
                      <span className="muted" style={{ fontSize: 13 }}>Registered · Open the event app</span>
                    </div>
                    <IconChevron />
                  </Link>
                ) : (
                  <div key={e.id} className="tile">
                    <DateTile iso={e.startDate} muted />
                    <div className="grow col" style={{ gap: 2 }}>
                      <span className="strong" style={{ fontSize: 15 }}>{e.name}</span>
                      <span className="muted" style={{ fontSize: 13 }}>{[e.city || e.venueName, e.ceHours ? fmtHours(e.ceHours) : ""].filter(Boolean).join(" · ") || fmtDates(e.startDate, e.endDate)}</span>
                    </div>
                    <a className="btn btn-primary btn-sm" href={`/r/${e.slug}`}>
                      Register
                    </a>
                  </div>
                )
              )}
            </>
          ) : null}

          {h.groups.length ? (
            <>
              <div className="section-title" style={{ paddingTop: 2 }}>My committees</div>
              <ListCard>
                {h.groups.map((g) => (
                  <Link key={g.id} href={`${base}/groups/${g.id}`} className="list-item" style={{ justifyContent: "space-between" }}>
                    <div className="col grow" style={{ gap: 2 }}>
                      <span className="strong">{g.name}</span>
                      <span className="muted" style={{ fontSize: 13 }}>
                        {[g.nextMeeting ? `Meeting ${g.nextMeeting}` : "", g.newFiles ? `${g.newFiles} new file${g.newFiles === 1 ? "" : "s"}` : "", g.newPosts ? `${g.newPosts} new post${g.newPosts === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "Open the group"}
                      </span>
                    </div>
                    <Pill tone={g.role === "member" ? "green" : "orange"}>{ROLE_LABEL[g.role]}</Pill>
                  </Link>
                ))}
              </ListCard>
            </>
          ) : null}

          {groups.data?.canJoin.length ? (
            <>
              <div className="section-title" style={{ paddingTop: 2 }}>Groups you can join</div>
              <ListCard>
                {groups.data.canJoin.slice(0, 5).map((g) => (
                  <Link key={g.id} href={`${base}/groups/${g.id}`} className="list-item">
                    <div className="col grow" style={{ gap: 2 }}>
                      <span className="strong">{g.name}</span>
                      <span className="muted" style={{ fontSize: 13 }}>{g.kindLabel}</span>
                    </div>
                    <IconChevron />
                  </Link>
                ))}
              </ListCard>
            </>
          ) : null}

          {h.newDocuments ? (
            <Link href={`${base}/docs`} className="tile">
              <span className="tile-icon">
                <IconFolder />
              </span>
              <span className="strong grow">
                {h.newDocuments} new document{h.newDocuments === 1 ? "" : "s"}
              </span>
              <IconChevron />
            </Link>
          ) : null}

          {h.evaluationsDue.length ? (
            <div className="banner banner-warn" style={{ borderRadius: 14 }}>
              <span>
                {h.evaluationsDue.length} evaluation{h.evaluationsDue.length === 1 ? "" : "s"} waiting for your CE
              </span>
              <a href={h.evaluationsDue[0].url} style={{ color: "var(--warn-ink)", fontWeight: 800 }}>
                Finish
              </a>
            </div>
          ) : null}
        </>
      )}
    </MemberScreen>
  );
}

function MiniStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="card" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 2, borderRadius: 12 }}>
      <span style={{ fontSize: 20, fontWeight: 800 }}>{value}</span>
      <span className="small muted strong" style={{ fontWeight: 600 }}>{label}</span>
    </div>
  );
}

// ---------- My card ----------

type Card = RouterOutputs["member"]["hub"]["card"];

function CardFace({ c }: { c: Card }) {
  const tone = c.status === "active" ? { bg: "var(--accent)", ink: "var(--accent-ink)" } : c.status === "grace" ? { bg: "var(--warn-bg)", ink: "var(--warn-ink)" } : { bg: "var(--bad-bg)", ink: "var(--bad-ink)" };
  return (
    <div style={{ borderRadius: 20, background: "#0F2A23", color: "#FFFFFF", padding: 20, display: "flex", flexDirection: "column", gap: 18, boxShadow: "0 10px 24px rgba(15, 42, 35, 0.22)" }}>
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="col" style={{ gap: 4 }}>
          {c.logoUrl ? <img src={c.logoUrl} alt={`${c.orgName} logo`} style={{ height: 28, alignSelf: "flex-start", background: "#FFFFFF", borderRadius: 6, padding: 2 }} /> : null}
          <span style={{ fontSize: 18, fontWeight: 800 }}>{c.orgName}</span>
        </div>
        <span style={{ fontSize: 12, fontWeight: 800, color: tone.ink, background: tone.bg, borderRadius: 6, padding: "4px 8px" }}>{STATUS_LABEL[c.status]}</span>
      </div>
      <div className="row" style={{ gap: 14 }}>
        <Avatar url={c.photoUrl} name={c.name} size={64} />
        <div className="col" style={{ gap: 3 }}>
          <span style={{ fontSize: 20, fontWeight: 800 }}>{c.name}</span>
          <span style={{ fontSize: 13, color: "#CFE3DA" }}>{c.level} member</span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <CardField label="Member ID" value={c.memberNumber} />
        <CardField label="Since" value={c.memberSince || "Not set"} />
        <CardField label="Expires" value={c.expiresOn ? mdy(c.expiresOn) : "Not set"} />
      </div>
      <div style={{ alignSelf: "center", background: "#FFFFFF", borderRadius: 14, padding: 12 }}>
        <QR value={c.verifyUrl} size={150} label="Member QR code" />
      </div>
      <span style={{ alignSelf: "center", fontSize: 12, color: "#CFE3DA", textAlign: "center" }}>Scan at check-in, member pricing, and partner discounts</span>
    </div>
  );
}

function CardField({ label, value }: { label: string; value: string }) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#8FB5A6", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

export function MemberCard() {
  const { orgSlug, base } = useMemberApp();
  const view = new URLSearchParams(useSearch()).get("view");
  const card = trpc.member.hub.card.useQuery({ orgSlug });
  if (card.isLoading) return <MemberScreen nav="card"><PageLoading /></MemberScreen>;
  if (card.error) return <MemberScreen nav="card"><ErrorNote error={card.error} /></MemberScreen>;
  const c = card.data!;
  if (view === "print") return <PrintCard c={c} back={`${base}/card`} />;
  if (view === "letter") return <MembershipLetter c={c} back={`${base}/card`} />;
  const active = c.status === "active" || c.status === "grace";
  const walletButtons = [
    c.wallet.apple ? (
      <a key="apple" className="btn btn-lg" href={`/api/member/${orgSlug}/wallet/apple`} style={{ background: "#0F2A23", borderColor: "#0F2A23", color: "#FFFFFF", fontSize: 14, height: 48 }}>
        Add to Apple Wallet
      </a>
    ) : null,
    c.wallet.google ? (
      <a key="google" className="btn btn-lg" href={`/api/member/${orgSlug}/wallet/google`} style={{ fontSize: 14, height: 48 }}>
        Add to Google Wallet
      </a>
    ) : null,
  ].filter(Boolean);
  return (
    <MemberScreen nav="card" header={<BackBar title="My member card" href={base} />}>
      <CardFace c={c} />
      {!active ? (
        <div className="banner banner-warn">
          <span>Your membership has lapsed.</span>
          <RenewButton url={c.renewUrl} />
        </div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: walletButtons.length === 1 ? "repeat(2, minmax(0, 1fr))" : walletButtons.length ? "repeat(2, minmax(0, 1fr))" : "1fr", gap: 10 }}>
        {walletButtons}
        {walletButtons.length < 2 ? (
          <Link className="btn btn-lg" href={`${base}/card?view=print`} style={{ fontSize: 14, height: 48 }}>
            Download card
          </Link>
        ) : null}
      </div>
      <ListCard>
        <div className="list-item" style={{ justifyContent: "space-between", fontSize: 14 }}>
          <span className="strong">Renewal</span>
          {active ? <span className="muted">{c.autoRenew ? `Auto-renews ${c.expiresOn ? fmtDate(c.expiresOn) : ""}` : c.expiresOn ? `Renew by ${fmtDate(c.expiresOn)}` : "No end date"}</span> : <RenewButton url={c.renewUrl} />}
        </div>
        {active ? (
          <Link href={`${base}/card?view=letter`} className="list-item" style={{ justifyContent: "space-between", fontSize: 14, fontWeight: 700, color: "var(--brand)" }}>
            Download membership letter
            <IconChevron />
          </Link>
        ) : null}
      </ListCard>
    </MemberScreen>
  );
}

function PrintFrame({ back, children }: { back: string; children: ReactNode }) {
  const { org } = useMemberApp();
  return (
    <div style={{ ...brandStyle({ colorPrimary: org.colorPrimary, colorAccent: org.colorAccent }), minHeight: "100dvh", background: "#FFFFFF", padding: 24 }}>
      <div className="row gap-10 no-print" style={{ marginBottom: 20 }}>
        <Link className="btn btn-sm btn-w" href={back}>
          Back
        </Link>
        <button className="btn btn-sm btn-solid btn-w" onClick={() => window.print()}>
          Print
        </button>
      </div>
      {children}
    </div>
  );
}

/** A printable card (and Save as PDF from the print dialog). */
function PrintCard({ c, back }: { c: Card; back: string }) {
  return (
    <PrintFrame back={back}>
      <div style={{ maxWidth: 360, margin: "0 auto", WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}>
        <CardFace c={c} />
      </div>
    </PrintFrame>
  );
}

/** A printable letter confirming membership. */
function MembershipLetter({ c, back }: { c: Card; back: string }) {
  const issued = fmtWhen(new Date());
  return (
    <PrintFrame back={back}>
      <article style={{ maxWidth: 640, margin: "0 auto", color: "var(--ink)", fontSize: 15, lineHeight: 1.6, display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="row-between" style={{ borderBottom: "3px solid var(--brand)", paddingBottom: 12 }}>
          <div className="row gap-12">
            {c.logoUrl ? <img src={c.logoUrl} alt={`${c.orgName} logo`} style={{ height: 48 }} /> : null}
            <span className="h2">{c.orgName}</span>
          </div>
          <span className="muted">{issued}</span>
        </div>
        <p style={{ margin: 0 }}>To whom it may concern:</p>
        <p style={{ margin: 0 }}>
          This letter confirms that <b>{c.name}</b> is a <b>{c.level}</b> member of {c.orgName}
          {c.status === "active" ? " in good standing" : ""}.
        </p>
        <div className="col" style={{ gap: 0 }}>
          <LetterRow label="Member ID" value={c.memberNumber} />
          <LetterRow label="Member since" value={c.memberSince || "Not set"} />
          <LetterRow label="Membership valid through" value={c.expiresOn ? fmtDate(c.expiresOn) : "No end date"} />
          <LetterRow label="Status" value={STATUS_LABEL[c.status]} />
        </div>
        <p style={{ margin: 0 }}>This membership can be checked at any time at the link below or by scanning the code.</p>
        <div className="row gap-16">
          <QR value={c.verifyUrl} size={96} label="Membership check QR code" />
          <span className="small muted" style={{ wordBreak: "break-all" }}>{c.verifyUrl}</span>
        </div>
        <p style={{ margin: "12px 0 0" }}>
          Sincerely,
          <br />
          Membership team, {c.orgName}
        </p>
      </article>
    </PrintFrame>
  );
}

function LetterRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", padding: "6px 0", borderBottom: "1px solid var(--line-2)" }}>
      <span className="muted">{label}</span>
      <span className="strong">{value}</span>
    </div>
  );
}

// ---------- Events ----------

export function MemberEvents() {
  const { orgSlug } = useMemberApp();
  const events = trpc.member.hub.events.useQuery({ orgSlug });
  return (
    <MemberScreen nav="events" header={<BrandHeader title="Events" />}>
      {events.isLoading ? (
        <PageLoading />
      ) : events.error ? (
        <ErrorNote error={events.error} />
      ) : !events.data?.length ? (
        <Empty>No upcoming events right now.</Empty>
      ) : (
        events.data.map((e) => (
          <div key={e.id} className="tile">
            <DateTile iso={e.startDate} muted={!e.registered} />
            <div className="grow col" style={{ gap: 2 }}>
              <span className="strong" style={{ fontSize: 15 }}>{e.name}</span>
              <span className="muted" style={{ fontSize: 13 }}>{fmtDates(e.startDate, e.endDate)}</span>
              <span className="muted" style={{ fontSize: 13 }}>{[e.registered ? "Registered" : "", e.city || e.venueName, e.ceHours ? fmtHours(e.ceHours) : ""].filter(Boolean).join(" · ")}</span>
            </div>
            {e.registered ? (
              <a className="btn btn-sm" href={`/e/${e.slug}`}>
                Open the app
              </a>
            ) : (
              <a className="btn btn-primary btn-sm" href={`/r/${e.slug}`}>
                Register
              </a>
            )}
          </div>
        ))
      )}
    </MemberScreen>
  );
}

// ---------- Documents ----------

function useOpenDoc() {
  const { orgSlug } = useMemberApp();
  const open = trpc.member.docs.open.useMutation();
  return async (documentId: number) => {
    // Open the tab first so the browser does not block it as a pop-up.
    const tab = window.open("", "_blank");
    try {
      const r = await open.mutateAsync({ orgSlug, documentId });
      if (tab) tab.location.href = r.url;
      else window.location.href = r.url;
    } catch (err) {
      tab?.close();
      toast(errorText(err), true);
    }
  };
}

type DocRow = { id: number; title: string; ext: string; version: number; updatedAt: Date; isNew: boolean; folderName?: string };

function DocList({ docs, showFolder }: { docs: DocRow[]; showFolder?: boolean }) {
  const openDoc = useOpenDoc();
  if (!docs.length) return <Empty>No documents here yet.</Empty>;
  return (
    <ListCard>
      {docs.map((d) => (
        <button key={d.id} type="button" className="list-item" onClick={() => openDoc(d.id)} style={{ border: "none", background: "transparent", width: "100%", textAlign: "left", cursor: "pointer" }}>
          <FileType ext={d.ext} />
          <div className="grow col" style={{ gap: 2, minWidth: 0 }}>
            <span className="strong clip" style={{ fontSize: 14 }}>{d.title}</span>
            <span className="small muted">{[showFolder ? d.folderName : "", `Version ${d.version}`, fmtWhen(d.updatedAt)].filter(Boolean).join(" · ")}</span>
          </div>
          {d.isNew ? <Pill tone="solid">New</Pill> : null}
        </button>
      ))}
    </ListCard>
  );
}

export function MemberDocs({ folderId }: { folderId?: string }) {
  if (folderId === "certificates") return <MemberCertificates />;
  if (folderId) return <MemberFolder folderId={Number(folderId)} />;
  return <MemberDocsHome />;
}

function MemberDocsHome() {
  const { orgSlug, base } = useMemberApp();
  const [q, setQ] = useState("");
  const data = trpc.member.docs.folders.useQuery({ orgSlug });
  const search = q.trim().toLowerCase();
  return (
    <MemberScreen
      nav="docs"
      header={
        <BrandHeader title="Documents">
          <label style={{ height: 44, borderRadius: 12, background: "#FFFFFF", display: "flex", alignItems: "center", gap: 8, padding: "0 12px", color: "var(--muted)" }}>
            <IconSearch />
            <input aria-label="Search documents" placeholder="Search documents" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, border: "none", outline: "none", fontSize: 14, color: "var(--ink)", background: "transparent", minWidth: 0 }} />
          </label>
        </BrandHeader>
      }
    >
      {data.isLoading ? (
        <PageLoading />
      ) : data.error ? (
        <ErrorNote error={data.error} />
      ) : search ? (
        <>
          <div className="section-title">Results</div>
          <DocList docs={data.data!.all.filter((d) => d.title.toLowerCase().includes(search) || d.folderName.toLowerCase().includes(search))} showFolder />
        </>
      ) : (
        <>
          <div className="section-title">Folders you can open</div>
          <div className="grid-2" style={{ gap: 8 }}>
            {data.data!.folders.map((f) => (
              <FolderTile key={f.id} href={`${base}/docs/${f.id}`} name={f.name} restricted={f.restricted} sub={[f.restricted ? f.accessLabel : "", `${f.count} file${f.count === 1 ? "" : "s"}`, f.newCount ? `${f.newCount} new` : ""].filter(Boolean).join(" · ")} />
            ))}
            <FolderTile href={`${base}/docs/certificates`} name="My certificates" sub={`${data.data!.certificates} file${data.data!.certificates === 1 ? "" : "s"}`} />
          </div>
          <div className="section-title" style={{ paddingTop: 6 }}>Recently added</div>
          <DocList docs={data.data!.recent} showFolder />
        </>
      )}
    </MemberScreen>
  );
}

function FolderTile({ href, name, sub, restricted }: { href: string; name: string; sub: string; restricted?: boolean }) {
  return (
    <Link href={href} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6, textDecoration: "none", color: "inherit", borderRadius: 12 }}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill={restricted ? "#FFF4E5" : "#E6F0EC"} stroke={restricted ? "#B5651D" : "#1F5F4A"} strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7h6l2 2h10v10H3z" />
      </svg>
      <span className="strong" style={{ fontSize: 14 }}>{name}</span>
      <span className="small muted">{sub}</span>
    </Link>
  );
}

function MemberFolder({ folderId }: { folderId: number }) {
  const { orgSlug, base } = useMemberApp();
  const folder = trpc.member.docs.folder.useQuery({ orgSlug, folderId });
  return (
    <MemberScreen nav="docs" header={<BackBar title={folder.data?.name ?? "Documents"} href={`${base}/docs`} />}>
      {folder.isLoading ? (
        <PageLoading />
      ) : folder.error ? (
        <ErrorNote error={folder.error} />
      ) : (
        <>
          <span className="small muted strong">{folder.data!.accessLabel}</span>
          <DocList docs={folder.data!.documents} />
        </>
      )}
    </MemberScreen>
  );
}

function MemberCertificates() {
  const { orgSlug, base } = useMemberApp();
  const certs = trpc.member.docs.certificates.useQuery({ orgSlug });
  return (
    <MemberScreen nav="docs" header={<BackBar title="My certificates" href={`${base}/docs`} />}>
      {certs.isLoading ? (
        <PageLoading />
      ) : certs.error ? (
        <ErrorNote error={certs.error} />
      ) : !certs.data?.length ? (
        <Empty>Certificates from the organization's events show here.</Empty>
      ) : (
        <ListCard>
          {certs.data.map((c) => (
            <a key={c.id} href={c.url} className="list-item">
              <FileType ext="PDF" />
              <div className="grow col" style={{ gap: 2, minWidth: 0 }}>
                <span className="strong clip">{c.title}</span>
                <span className="small muted">{[c.eventName, fmtHours(c.hours), fmtWhen(c.createdAt)].join(" · ")}</span>
              </div>
              <IconChevron />
            </a>
          ))}
        </ListCard>
      )}
    </MemberScreen>
  );
}

// ---------- Group page ----------

export function MemberGroup({ groupId }: { groupId: number }) {
  const { orgSlug, base } = useMemberApp();
  const utils = trpc.useUtils();
  const page = trpc.member.groups.page.useQuery({ orgSlug, groupId });
  const join = trpc.member.groups.join.useMutation();
  const leave = trpc.member.groups.leave.useMutation();
  const post = trpc.member.groups.post.useMutation();
  const delPost = trpc.member.groups.deletePost.useMutation();
  const add = trpc.member.groups.add.useMutation();
  const [tab, setTab] = useState<"discussion" | "files" | "members">("discussion");
  const [body, setBody] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const refresh = () => Promise.all([utils.member.groups.page.invalidate(), utils.member.groups.mine.invalidate(), utils.member.hub.home.invalidate()]);
  const g = page.data;
  useEffect(() => {
    if (g && !g.hasChannel && tab === "discussion") setTab(g.hasFolder ? "files" : "members");
  }, [g, tab]);
  if (page.isLoading) return <MemberScreen nav="home"><PageLoading /></MemberScreen>;
  if (page.error) return <MemberScreen nav="home" header={<BackBar title="Group" href={base} />}><ErrorNote error={page.error} /></MemberScreen>;
  const d = g!;
  const tabs = [
    ...(d.hasChannel ? [{ key: "discussion" as const, label: "Discussion" }] : []),
    ...(d.hasFolder ? [{ key: "files" as const, label: "Files" }] : []),
    { key: "members" as const, label: "Members" },
  ];
  return (
    <MemberScreen nav="home" header={<BackBar title={d.name} href={base} />}>
      <div className="card card-pad col gap-8">
        <div className="row-between">
          <Pill tone="gray">{d.kindLabel}</Pill>
          {d.role ? <Pill tone={d.role === "member" ? "green" : "orange"}>{ROLE_LABEL[d.role]}</Pill> : null}
        </div>
        {d.description ? <span>{d.description}</span> : null}
        <span className="small muted">{[d.nextMeeting ? `Next meeting ${d.nextMeeting}` : "", d.termEndsOn ? `Term ends ${fmtDate(d.termEndsOn)}` : "", d.joinLabel].filter(Boolean).join(" · ")}</span>
        {!d.joined ? (
          <button
            className="btn btn-primary btn-block"
            disabled={join.isPending}
            onClick={async () => {
              try {
                await join.mutateAsync({ orgSlug, groupId });
                await refresh();
                toast(`You joined ${d.name}.`);
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Join
          </button>
        ) : d.canEmail || d.canAdd ? (
          <div className="row gap-8 wrap">
            {d.canEmail ? (
              <button className="btn btn-sm" onClick={() => setEmailOpen(true)}>
                Email the group
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {d.joined ? (
        <>
          <div role="tablist" className="segmented" style={{ background: "var(--line-2)" }}>
            {tabs.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} style={{ color: tab === t.key ? undefined : "var(--muted)" }}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === "discussion" && d.hasChannel ? (
            <>
              <div className="card card-pad col gap-8">
                <textarea className="textarea" rows={3} placeholder={`Write to ${d.name}`} value={body} onChange={(e) => setBody(e.target.value)} aria-label="New post" />
                <button
                  className="btn btn-sm btn-solid"
                  style={{ alignSelf: "flex-end" }}
                  disabled={!body.trim() || post.isPending}
                  onClick={async () => {
                    try {
                      await post.mutateAsync({ orgSlug, groupId, body });
                      setBody("");
                      await utils.member.groups.page.invalidate();
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  Post
                </button>
              </div>
              {d.posts.length ? (
                <ListCard>
                  {d.posts.map((p) => (
                    <div key={p.id} className="col" style={{ padding: "12px 14px", gap: 4 }}>
                      <div className="row-between">
                        <span className="strong">{p.author}</span>
                        <span className="small muted">{fmtWhenTime(p.createdAt)}</span>
                      </div>
                      <span style={{ whiteSpace: "pre-wrap" }}>{p.body}</span>
                      {p.mine || d.role !== "member" ? (
                        <button
                          className="btn btn-xs"
                          style={{ alignSelf: "flex-end" }}
                          onClick={async () => {
                            if (!window.confirm("Delete this post?")) return;
                            await delPost.mutateAsync({ orgSlug, groupId, postId: p.id }).catch((err) => toast(errorText(err), true));
                            utils.member.groups.page.invalidate();
                          }}
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                  ))}
                </ListCard>
              ) : (
                <Empty>No posts yet. Start the conversation.</Empty>
              )}
            </>
          ) : null}

          {tab === "files" && d.folder ? <DocList docs={d.folder.documents} /> : null}

          {tab === "members" ? (
            <>
              {d.canAdd ? (
                <div className="card card-pad row gap-8">
                  <input className="input" type="email" placeholder="Add a member by email" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} aria-label="Member email" />
                  <button
                    className="btn btn-sm btn-w"
                    disabled={!addEmail.trim() || add.isPending}
                    onClick={async () => {
                      try {
                        const r = await add.mutateAsync({ orgSlug, groupId, email: addEmail.trim() });
                        setAddEmail("");
                        await utils.member.groups.page.invalidate();
                        toast(`Added ${r.name}.`);
                      } catch (err) {
                        toast(errorText(err), true);
                      }
                    }}
                  >
                    Add
                  </button>
                </div>
              ) : null}
              <ListCard>
                {d.members.map((m) => (
                  <div key={m.memberId} className="list-item" style={{ justifyContent: "space-between" }}>
                    <span className="strong">{m.name}</span>
                    {m.role !== "member" ? <Pill tone="orange">{ROLE_LABEL[m.role]}</Pill> : null}
                  </div>
                ))}
              </ListCard>
              <button
                className="btn btn-sm btn-ghost"
                style={{ alignSelf: "center", color: "var(--muted)" }}
                onClick={async () => {
                  if (!window.confirm(`Leave ${d.name}?`)) return;
                  try {
                    await leave.mutateAsync({ orgSlug, groupId });
                    await refresh();
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Leave group
              </button>
            </>
          ) : null}
        </>
      ) : null}
      <EmailGroupSheet open={emailOpen} onClose={() => setEmailOpen(false)} groupId={groupId} groupName={d.name} />
    </MemberScreen>
  );
}

function EmailGroupSheet({ open, onClose, groupId, groupName }: { open: boolean; onClose: () => void; groupId: number; groupName: string }) {
  const { orgSlug } = useMemberApp();
  const send = trpc.member.groups.email.useMutation();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  return (
    <Sheet open={open} onClose={onClose} label="Email the group">
      <span className="h3">Email {groupName}</span>
      <label className="field">
        Subject
        <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="field">
        Message
        <textarea className="textarea" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <button
        className="btn btn-solid btn-block"
        disabled={send.isPending || subject.trim().length < 2 || body.trim().length < 2}
        onClick={async () => {
          try {
            const r = await send.mutateAsync({ orgSlug, groupId, subject: subject.trim(), body: body.trim() });
            toast(`Sent to ${r.sent} member${r.sent === 1 ? "" : "s"}.`);
            setSubject("");
            setBody("");
            onClose();
          } catch (err) {
            toast(errorText(err), true);
          }
        }}
      >
        Send
      </button>
    </Sheet>
  );
}

// ---------- Public card check ----------

export function VerifyCard({ orgSlug, token }: { orgSlug: string; token: string }) {
  const org = trpc.core.org.publicBySlug.useQuery({ slug: orgSlug });
  const check = trpc.member.hub.verify.useQuery({ orgSlug, token });
  useEffect(() => {
    document.title = "Membership check";
  }, []);
  if (org.isLoading || check.isLoading) return <PageLoading />;
  if (org.error) return <div className="public"><ErrorNote error={org.error} /></div>;
  const o = org.data!;
  const c = check.data;
  return (
    <div className="public" style={brandStyle({ colorPrimary: o.colorPrimary, colorAccent: o.colorAccent })}>
      <header className="app-header">
        <div className="col" style={{ gap: 2 }}>
          <div className="eyebrow">{o.name}</div>
          <div className="title">Membership check</div>
        </div>
      </header>
      <main className="app-body">
        {check.error ? (
          <ErrorNote error={check.error} />
        ) : !c?.found ? (
          <div className="banner banner-bad">This card was not found. Ask the member to show the card from their member hub.</div>
        ) : (
          <>
            <div className={`banner ${c.valid ? "banner-ok" : "banner-bad"}`}>{c.valid ? "Valid membership" : "This membership is not active"}</div>
            <div className="card card-pad col gap-8">
              <span className="h2">{c.name}</span>
              <Row label="Level" value={`${c.level} member`} />
              <Row label="Status" value={STATUS_LABEL[c.status]} />
              <Row label="Expires" value={c.expiresOn ? fmtDate(c.expiresOn) : "No end date"} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between" style={{ padding: "8px 0", borderTop: "1px solid var(--line-2)" }}>
      <span className="muted strong">{label}</span>
      <span className="strong">{value}</span>
    </div>
  );
}
