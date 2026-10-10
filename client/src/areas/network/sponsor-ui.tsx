/** Small pieces for the Sponsors and exhibitors page and the Add attendee sheet. */
import { useEffect, useState, type ReactNode } from "react";
import { IconClose } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import "./sponsors.css";

/** The thin number strip above the folder tabs. */
export function NumStrip({ items }: { items: { label: string; value: ReactNode; warn?: boolean }[] }) {
  return (
    <div className="num-strip">
      {items.map((it) => (
        <div key={it.label}>
          <span>{it.label}</span>
          <b className={it.warn ? "warn" : ""}>{it.value}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * A section card with a title bar. Read view first; the header button (Edit,
 * or another label such as Record) opens the fields with Save and Cancel.
 * Never click-to-edit.
 */
export function SpSection({
  title,
  view,
  edit,
  onSave,
  onOpen,
  onCancel,
  saving,
  actions,
  editLabel = "Edit",
  footerRight,
  startOpen = false,
  className = "",
}: {
  title: ReactNode;
  view: ReactNode;
  edit?: ReactNode;
  onSave?: () => Promise<unknown> | void;
  onOpen?: () => void;
  onCancel?: () => void;
  saving?: boolean;
  actions?: ReactNode;
  editLabel?: string;
  footerRight?: ReactNode;
  startOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <section className={`sp-sec${open ? " editing" : ""} ${className}`}>
      <div className="sp-sh">
        <b>{title}</b>
        {!open ? (
          <div className="row gap-8">
            {actions}
            {edit ? (
              <button
                type="button"
                className="btn btn-sm btn-w"
                onClick={() => {
                  onOpen?.();
                  setOpen(true);
                }}
              >
                {editLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {open ? (
        <div className="sp-body">
          {edit}
          <div className="row gap-10">
            <button
              type="button"
              className="btn btn-sm btn-solid btn-w"
              disabled={saving}
              onClick={async () => {
                try {
                  await onSave?.();
                  setOpen(false);
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn-sm btn-w"
              onClick={() => {
                onCancel?.();
                setOpen(false);
              }}
            >
              Cancel
            </button>
            {footerRight ? <div style={{ marginLeft: "auto" }}>{footerRight}</div> : null}
          </div>
        </div>
      ) : (
        view
      )}
    </section>
  );
}

/** A panel that slides in from the right (Add attendee). */
export function SideSheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="side-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={title} className="side-sheet">
        <div className="side-sheet-head">
          <span className="h3">{title}</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose} style={{ width: 36, height: 36 }}>
            <IconClose />
          </button>
        </div>
        <div className="side-sheet-body">{children}</div>
        <div className="side-sheet-foot">{footer}</div>
      </div>
    </div>
  );
}

/** "BH" for Brightpath Health. */
export function companyInitials(company: string) {
  const words = company.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

/** Today's calendar date on this computer ("2026-10-10"). */
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 1st, 2nd, 3rd, 4th... */
export function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${s}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
