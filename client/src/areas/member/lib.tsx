/** Small helpers shared by the member hub and the organization admin screens. */
import type { ReactNode } from "react";

/** Saves text as a file (CSV exports). */
export function downloadText(filename: string, text: string, mime = "text/csv") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

const TYPE_COLORS: Record<string, [string, string]> = {
  PDF: ["#FCE8E6", "#A32A1E"],
  DOC: ["#E6EEFB", "#1D4E9E"],
  XLS: ["#E7F4EA", "#1E6B34"],
  CSV: ["#E7F4EA", "#1E6B34"],
  PPT: ["#FFF4E5", "#6B3D00"],
};

/** The little file-type tile (PDF, DOC, XLS) in document lists. */
export function FileType({ ext, size = "md" }: { ext: string; size?: "md" | "sm" }) {
  const [bg, ink] = TYPE_COLORS[ext] ?? ["#EEF2F1", "#4B5B57"];
  const dims = size === "md" ? { width: 36, height: 40 } : { width: 32, height: 36 };
  return (
    <span aria-label={`${ext} file`} style={{ ...dims, borderRadius: 6, background: bg, color: ink, fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      {ext.slice(0, 4)}
    </span>
  );
}

export const STATUS_LABEL: Record<string, string> = { active: "Active", grace: "Grace period", lapsed: "Lapsed", cancelled: "Cancelled" };
export const statusTone = (s: string) => (s === "active" ? "green" : s === "grace" ? "orange" : s === "lapsed" ? "red" : "gray") as "green" | "orange" | "red" | "gray";
export const ROLE_LABEL: Record<string, string> = { member: "Member", co_chair: "Co-chair", chair: "Chair" };

/** "2027-12-31" -> "12/31/2027" (the card's compact date). */
export const mdy = (iso: string | null | undefined) => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "");

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** The month and day tile on event rows. */
export function DateTile({ iso, muted }: { iso: string; muted?: boolean }) {
  return (
    <div style={{ width: 48, height: 52, borderRadius: 10, background: muted ? "var(--line-2)" : "var(--brand-tint)", color: muted ? "var(--muted)" : "var(--brand)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 800 }}>{MONTHS[Number(iso.slice(5, 7)) - 1]}</span>
      <span style={{ fontSize: 18, fontWeight: 800 }}>{Number(iso.slice(8, 10))}</span>
    </div>
  );
}

/** A white card with rows divided by lines (member app lists). */
export function ListCard({ children }: { children: ReactNode }) {
  return (
    <div className="card list" style={{ borderRadius: 14 }}>
      {children}
    </div>
  );
}
