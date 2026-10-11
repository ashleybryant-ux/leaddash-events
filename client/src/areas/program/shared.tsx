/** Small pieces shared by the program screens. */
import { type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import { trpc } from "../../lib/trpc";
import { useEventApp } from "../../shells/AttendeeShell";
import { Lightbox, Spinner } from "../../ui/components";
import { IconBack, IconLeaf } from "../../ui/icons";
import { fmtDate, fmtHours, fmtTime } from "@shared/format";

/** "1.5 CE" */
export const ceLabel = (h: number) => `${Number.isInteger(h) ? h.toFixed(1) : String(h)} CE`;

/** "Apr 22, 2027 · 10:30 AM · Room 204" */
export const whenLine = (s: { date: string; startTime: string; room?: string }) => [fmtDate(s.date), fmtTime(s.startTime), s.room].filter(Boolean).join(" · ");

export const hoursText = fmtHours;

/** Segmented control in the green header (Full agenda / My agenda, Event menu / Near the venue). */
export function Segmented({ items, light }: { items: { label: string; href: string; on: boolean }[]; light?: boolean }) {
  const style: CSSProperties | undefined = light ? { background: "var(--line-2)", margin: "0 4px" } : undefined;
  return (
    <div role="tablist" className="segmented" style={style}>
      {items.map((i) => (
        <Link key={i.href} href={i.href} role="tab" aria-selected={i.on} style={light && !i.on ? { color: "var(--muted)" } : undefined}>
          {i.label}
        </Link>
      ))}
    </div>
  );
}

/** White top bar with a back button, a title, and optional content under it (search, tabs). */
export function TopBar({ title, back, children }: { title: string; back?: string; children?: ReactNode }) {
  const { base } = useEventApp();
  return (
    <header className="app-bar" style={{ flexDirection: "column", alignItems: "stretch", gap: 10, paddingBottom: children ? 14 : 12 }}>
      <div className="row" style={{ gap: 8 }}>
        <Link href={back ?? `${base}/more`} className="icon-btn" aria-label="Back" style={{ color: "var(--ink)" }}>
          <IconBack />
        </Link>
        <div className="grow clip" style={{ fontSize: 18, fontWeight: 800 }}>{title}</div>
      </div>
      {children}
    </header>
  );
}

export function PoweredBy() {
  return (
    <div className="row small strong muted" style={{ justifyContent: "center", gap: 6, paddingTop: 6 }}>
      <IconLeaf size={16} />
      Powered by LeadDash Events
    </div>
  );
}

/** Number tile on the green header (My agenda stats). */
export function HeaderStat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div style={{ background: "#FFFFFF", color: "var(--ink)", borderRadius: 12, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 20, fontWeight: 800 }}>{value}</span>
      <span className="small strong muted">{label}</span>
    </div>
  );
}

/** Rounded chip used as a filter in the attendee app. */
export function Chip({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" className="chip" aria-pressed={on} aria-label={label} onClick={onClick} style={on ? { borderColor: "var(--brand)", background: "var(--brand-tint)", color: "var(--brand)", fontWeight: 700 } : undefined}>
      {children}
    </button>
  );
}

/**
 * Speaker bio that pops out as a lightbox over the current screen (no navigation).
 * Shows a large headshot at the top, then the bio, sessions, and Message and Website buttons.
 */
export function SpeakerSheet({ speakerId, onClose, showSessions = true }: { speakerId: number | null; onClose: () => void; showSessions?: boolean }) {
  const { slug, base } = useEventApp();
  const q = trpc.program.speakers.get.useQuery({ slug, speakerId: speakerId ?? 0 }, { enabled: !!speakerId });
  const s = q.data;
  return (
    <Lightbox open={!!speakerId} onClose={onClose} label="Speaker bio">
      {!s ? (
        <div className="center" style={{ padding: 40 }}>
          <Spinner />
        </div>
      ) : (
        <>
          {s.headshotUrl ? <img className="lightbox-photo" src={s.headshotUrl} alt={s.name} /> : <div className="lightbox-initials" aria-hidden="true">{initialsOf(s.name)}</div>}
          <div className="lightbox-body">
          <div className="col" style={{ gap: 3 }}>
            <span style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.25 }}>{s.name}</span>
            <span className="muted" style={{ fontSize: 13.5 }}>{[s.jobTitle || s.organization, s.city].filter(Boolean).join(" · ")}</span>
          </div>
          {s.bio ? <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{s.bio}</div> : null}
          {showSessions && s.sessions.length ? (
            <div className="col gap-8">
              <div className="section-title">Presenting</div>
              {s.sessions.map((x) => (
                <Link key={x.id} href={`${base}/session/${x.id}`} onClick={onClose} style={{ textDecoration: "none", color: "inherit", background: "var(--ground)", border: "1px solid var(--line)", borderRadius: 12, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <span className="col" style={{ gap: 2 }}>
                    <span className="strong" style={{ fontSize: 14 }}>{x.title}</span>
                    <span className="small muted">{whenLine(x)}</span>
                  </span>
                  {x.ceHours > 0 ? <span className="pill">{ceLabel(x.ceHours)}</span> : null}
                </Link>
              ))}
            </div>
          ) : null}
          {s.messageAttendeeId || s.website ? (
            <div className="grid-2">
              {s.messageAttendeeId ? (
                <Link href={`${base}/people/${s.messageAttendeeId}`} className="btn btn-primary" style={{ height: 46 }}>
                  Message
                </Link>
              ) : null}
              {s.website ? (
                <a href={s.website} target="_blank" rel="noreferrer" className="btn" style={{ height: 46 }}>
                  Website
                </a>
              ) : null}
            </div>
          ) : null}
          </div>
        </>
      )}
    </Lightbox>
  );
}

/** "RC" from "Renee Carter" for a speaker with no headshot. */
function initialsOf(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}
