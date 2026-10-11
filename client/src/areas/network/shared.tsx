/** Small pieces shared by the network screens. */
import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Avatar } from "../../ui/components";
import { IconBack } from "../../ui/icons";
import { useEventApp } from "../../shells/AttendeeShell";
import { fmtTime, fmtWhen, initials } from "@shared/format";

const TONES: [string, string][] = [
  ["#CFE3DA", "#1F5F4A"],
  ["#FBE3CC", "#6B3D00"],
  ["#DCE6F5", "#1D3D6B"],
  ["#E8E1F3", "#46306B"],
];

/** A person's photo, or their initials on a soft color. */
export function PersonAvatar({ person, size = 48 }: { person: { id: number; firstName: string; lastName: string; photoUrl?: string | null; name?: string }; size?: number }) {
  const name = person.name ?? `${person.firstName} ${person.lastName}`;
  if (person.photoUrl) return <Avatar url={person.photoUrl} name={name} size={size} />;
  const [bg, fg] = TONES[person.id % TONES.length];
  return (
    <span className="avatar avatar-initials" role="img" aria-label={name} style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.round(size * 0.32) }}>
      {initials(person.firstName, person.lastName)}
    </span>
  );
}

/** Light tabs used under white headers (All / Sponsors / Exhibitors, Level 1 / Level 2). */
export function LightTabs<T extends string | number>({ tabs, value, onChange, label }: { tabs: { key: T; label: string }[]; value: T; onChange: (key: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} style={{ padding: 4, borderRadius: 12, background: "var(--line-2)", display: "grid", gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`, gap: 4 }}>
      {tabs.map((t) => (
        <button
          key={String(t.key)}
          type="button"
          role="tab"
          aria-selected={t.key === value}
          onClick={() => onChange(t.key)}
          className="clip"
          style={{ height: 36, borderRadius: 9, border: "none", cursor: "pointer", background: t.key === value ? "#FFFFFF" : "transparent", color: t.key === value ? "var(--ink)" : "var(--muted)", fontSize: 14, fontWeight: t.key === value ? 800 : 600, padding: "0 6px" }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** White header with a back button, a title and optional content below (tabs). */
export function BackHeader({ title, sub, back, right, children }: { title: ReactNode; sub?: ReactNode; back?: string; right?: ReactNode; children?: ReactNode }) {
  const { base } = useEventApp();
  const [, navigate] = useLocation();
  return (
    <header className="app-bar" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
      <div className="row gap-8">
        <button className="icon-btn" aria-label="Back" onClick={() => (back ? navigate(back) : window.history.length > 1 ? window.history.back() : navigate(`${base}/home`))}>
          <IconBack />
        </button>
        <div className="grow col" style={{ gap: 0 }}>
          <span className="clip" style={{ fontSize: 17, fontWeight: 800 }}>{title}</span>
          {sub ? <span className="small muted clip">{sub}</span> : null}
        </div>
        {right}
      </div>
      {children ? <div style={{ margin: "0 4px" }}>{children}</div> : null}
    </header>
  );
}

/** "Just now", "12 min ago", "2 hr ago", then the date with the year. */
export function ago(value: Date | string | number | null | undefined) {
  if (!value) return "";
  const ms = Date.now() - new Date(value).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return fmtWhen(value);
}

/** Today: "10:52 AM". Earlier: "Apr 21, 2027". */
export function shortWhen(value: Date | string | number) {
  const d = new Date(value);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(`${d.getHours()}:${d.getMinutes()}`);
  return fmtWhen(d);
}

export const clockTime = (value: Date | string | number) => {
  const d = new Date(value);
  return fmtTime(`${d.getHours()}:${d.getMinutes()}`);
};

/** Saves text as a file in the browser. */
export function downloadText(filename: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Round composer at the bottom of chat-like screens. */
export function Composer({ placeholder, onSend, disabled, busy, above }: { placeholder: string; onSend: (text: string) => Promise<unknown>; disabled?: boolean; busy?: boolean; above?: ReactNode }) {
  const [text, setText] = useState("");
  return (
    <form
      className="col gap-8"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        try {
          await onSend(t);
          setText("");
        } catch {
          /* the caller shows the error */
        }
      }}
    >
      {above}
      <div className="row gap-8">
        <input
          className="input grow"
          aria-label={placeholder}
          placeholder={placeholder}
          value={text}
          maxLength={2000}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          style={{ height: 44, borderRadius: 22, padding: "0 14px" }}
        />
        <button type="submit" aria-label="Send" disabled={disabled || busy || !text.trim()} style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 22, border: "none", background: "var(--accent)", color: "var(--accent-ink)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 12l16-8-6 16-2-7z" />
          </svg>
        </button>
      </div>
    </form>
  );
}

/** Option chip with the selected look from the mockups (tint with a brand border). */
export function ChoiceChip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      style={{ flexShrink: 0, height: 36, padding: "0 14px", borderRadius: 18, border: `1px solid ${selected ? "var(--brand)" : "#D5DEDA"}`, background: selected ? "var(--brand-tint)" : "#FFFFFF", color: selected ? "var(--brand)" : "var(--ink)", fontSize: 13, fontWeight: selected ? 700 : 600, cursor: "pointer", whiteSpace: "nowrap" }}
    >
      {children}
    </button>
  );
}

/** Dollars typed by a person to cents. */
export const toCents = (s: string) => {
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const toDollars = (cents: number) => (cents ? (cents / 100).toFixed(2).replace(/\.00$/, "") : "");
