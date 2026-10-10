/**
 * Shared building blocks. Rules from the approved designs:
 * - Sections show values read-only with an Edit button; Edit opens compact fields with Save and Cancel (EditSection). No click-to-edit.
 * - List rows expand in place below the row (ExpandRow). Row buttons are the same width (className "btn btn-sm btn-w").
 * - Button labels fit on one line. Dates include the year (use @shared/format).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { trpc } from "../lib/trpc";
import { IconClose } from "./icons";
import { errorText, toast } from "./toast";

export function Spinner() {
  return <div className="spinner" role="progressbar" aria-label="Loading" />;
}

export function PageLoading() {
  return (
    <div className="page-loading">
      <Spinner />
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return <div className="empty err">{errorText(error)}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, children, className = "", hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  return (
    <label className={`field ${className}`}>
      {label}
      {children}
      {hint ? <span className="small muted" style={{ fontWeight: 500 }}>{hint}</span> : null}
    </label>
  );
}

export function Pill({ children, tone = "green" }: { children: ReactNode; tone?: "green" | "orange" | "gray" | "red" | "solid" }) {
  return <span className={`pill${tone === "green" ? "" : ` pill-${tone}`}`}>{children}</span>;
}

/** Folder-style tabs with a lip along the top of the card. */
export function FolderTabs<T extends string>({ tabs, value, onChange, hrefFor }: { tabs: { key: T; label: string }[]; value: T; onChange?: (key: T) => void; hrefFor?: (key: T) => string }) {
  return (
    <div role="tablist" className="folder-tabs">
      {tabs.map((t) =>
        hrefFor ? (
          <a key={t.key} role="tab" className="folder-tab" aria-selected={t.key === value} href={hrefFor(t.key)}>
            {t.label}
          </a>
        ) : (
          <button key={t.key} type="button" role="tab" className="folder-tab" aria-selected={t.key === value} onClick={() => onChange?.(t.key)}>
            {t.label}
          </button>
        )
      )}
    </div>
  );
}

/**
 * Read-only section with an Edit button. `view` shows the values; `edit`
 * renders the fields. onSave returns a promise; the section closes when it resolves.
 */
export function EditSection({ title, view, edit, onSave, onCancel, saving, startOpen = false, actions }: { title: ReactNode; view: ReactNode; edit: ReactNode; onSave: () => Promise<unknown> | void; onCancel?: () => void; saving?: boolean; startOpen?: boolean; actions?: ReactNode }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <section className="col gap-12">
      <div className="row-between">
        <span className="h3" style={{ fontSize: 14 }}>{title}</span>
        <div className="row gap-8">
          {open ? <Pill tone="orange">Editing</Pill> : (
            <>
              {actions}
              <button type="button" className="btn btn-sm btn-w" onClick={() => setOpen(true)}>
                Edit
              </button>
            </>
          )}
        </div>
      </div>
      {open ? (
        <>
          {edit}
          <div className="row gap-10">
            <button
              type="button"
              className="btn btn-sm btn-solid btn-w"
              disabled={saving}
              onClick={async () => {
                try {
                  await onSave();
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
          </div>
        </>
      ) : (
        view
      )}
    </section>
  );
}

/** A read-only label and value line (inside view mode of a section). */
export function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px minmax(0, 1fr)", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--line-2)", fontSize: 14 }}>
      <span className="muted strong" style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{children || <span className="muted">Not set</span>}</span>
    </div>
  );
}

/** Bottom sheet that pops over the current screen (speaker bios, quick details). */
export function Sheet({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop">
      <button className="sheet-close-area" aria-label="Close" onClick={onClose} />
      <div role="dialog" aria-label={label} className="sheet">
        <div className="sheet-grip" />
        {children}
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={title} className="modal">
        <div className="row-between">
          <span className="h3">{title}</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose} style={{ width: 36, height: 36 }}>
            <IconClose />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label="Close" style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 20, border: "1px solid #D5DEDA", background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
      <IconClose />
    </button>
  );
}

/** A person's photo, or a soft silhouette when there is none. */
export function Avatar({ url, name, size = 44 }: { url?: string | null; name?: string; size?: number }) {
  if (url) {
    return (
      <span className="avatar" style={{ width: size, height: size }}>
        <img src={url} alt={name ? `Photo of ${name}` : ""} />
      </span>
    );
  }
  return (
    <span className="avatar" role="img" aria-label={name ? `No photo for ${name}` : "No photo"} style={{ width: size, height: size }}>
      <svg width={size * 0.92} height={size * 0.92} viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="40" r="19" fill="#8FB5A6" />
        <path d="M12 100c4-22 19-36 38-36s34 14 38 36z" fill="#8FB5A6" />
      </svg>
    </span>
  );
}

/** A QR code drawn as SVG. */
export function QR({ value, size = 150, label = "QR code" }: { value: string; size?: number; label?: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    QRCode.toString(value, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#0F2A23", light: "#FFFFFF" } }).then(setSvg).catch(() => setSvg(""));
  }, [value]);
  return <div role="img" aria-label={label} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg.replace("<svg", `<svg width="${size}" height="${size}"`) }} />;
}

export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * Upload button. Calls core.files.upload and hands back the file id and url.
 * Pass eventId (event files) or orgId (organization files).
 */
export function UploadButton({ label = "Upload", accept = "image/*", eventId, orgId, isPublic = true, onUploaded, className = "btn btn-sm btn-w" }: { label?: string; accept?: string; eventId?: number; orgId?: number; isPublic?: boolean; onUploaded: (f: { id: number; url: string; name: string }) => void; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = trpc.core.files.upload.useMutation();
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            const base64 = await readFileBase64(file);
            const res = await upload.mutateAsync({ eventId, orgId, name: file.name, mime: file.type || "application/octet-stream", base64, isPublic });
            onUploaded(res);
          } catch (err) {
            toast(errorText(err), true);
          }
        }}
      />
      <button type="button" className={className} disabled={upload.isPending} onClick={() => input.current?.click()}>
        {upload.isPending ? "Uploading" : label}
      </button>
    </>
  );
}

/** Copies text and confirms with a toast. */
export function CopyButton({ text, label = "Copy", className = "btn btn-sm btn-w" }: { text: string; label?: string; className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => toast("Copied"),
          () => toast("Could not copy. Select the text and copy it.", true)
        );
      }}
    >
      {label}
    </button>
  );
}

/** A grid header row for admin tables. */
export function THead({ cols, labels }: { cols: string; labels: string[] }) {
  return (
    <div className="trow thead" style={{ gridTemplateColumns: cols }}>
      {labels.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

/** A table row that expands its editor in place below the row. */
export function ExpandRow({ cols, cells, open, onToggle, children, closedLabel = "Details", openLabel = "Close" }: { cols: string; cells: ReactNode[]; open: boolean; onToggle: () => void; children?: ReactNode; closedLabel?: string; openLabel?: string }) {
  return (
    <div className={open ? "trow-open" : ""} style={{ borderBottom: "1px solid var(--line)" }}>
      <div className="trow" style={{ gridTemplateColumns: cols, borderBottom: "none" }}>
        {cells.map((c, i) => (
          <div key={i} style={{ minWidth: 0 }}>{c}</div>
        ))}
        <button type="button" className={`btn btn-sm btn-w${open ? " btn-solid" : ""}`} onClick={onToggle}>
          {open ? openLabel : closedLabel}
        </button>
      </div>
      {open ? <div className="editor">{children}</div> : null}
    </div>
  );
}

/** Small stat card. */
export function Kpi({ label, value, note, bad }: { label: string; value: ReactNode; note?: string; bad?: boolean }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {note ? <span className="small strong" style={{ color: bad ? "var(--bad-ink)" : "var(--brand)" }}>{note}</span> : null}
    </div>
  );
}

/** Confirm before a destructive action. */
export function confirmAction(message: string) {
  return window.confirm(message);
}

/* ---------- Formatted text ---------- */

type RteCommand = { label: string; title: string; run: () => void; active?: () => boolean };

/**
 * A small formatted-text editor: headings, bold, italic, underline, lists and
 * links. Produces HTML; the server keeps only those tags when it saves.
 */
/** Lets a parent put text at the cursor (for example a field chip in an agreement). */
export type RichTextApi = { insertHtml: (html: string) => void };

export function RichTextEditor({ value, onChange, label, minHeight = 220, apiRef }: { value: string; onChange: (html: string) => void; label: string; minHeight?: number; apiRef?: { current: RichTextApi | null } }) {
  const box = useRef<HTMLDivElement>(null);
  const caret = useRef<Range | null>(null);
  const [, refresh] = useState(0);
  // Fill the box once (and when the saved value changes from outside), never while typing.
  useEffect(() => {
    if (box.current && box.current.innerHTML !== value && document.activeElement !== box.current) box.current.innerHTML = value || "<p><br></p>";
  }, [value]);
  // Remember where the cursor was, so inserting from outside the box goes there.
  const keepCaret = () => {
    const sel = document.getSelection();
    if (sel && sel.rangeCount && box.current?.contains(sel.anchorNode)) caret.current = sel.getRangeAt(0).cloneRange();
  };
  if (apiRef) {
    apiRef.current = {
      insertHtml: (html: string) => {
        const el = box.current;
        if (!el) return;
        el.focus();
        const sel = document.getSelection();
        if (sel) {
          sel.removeAllRanges();
          if (caret.current && el.contains(caret.current.startContainer)) sel.addRange(caret.current);
          else {
            const end = document.createRange();
            end.selectNodeContents(el.lastElementChild ?? el);
            end.collapse(false);
            sel.addRange(end);
          }
        }
        document.execCommand("insertHTML", false, html);
        keepCaret();
        onChange(el.innerHTML);
      },
    };
  }
  const exec = (cmd: string, arg?: string) => {
    box.current?.focus();
    document.execCommand(cmd, false, arg);
    onChange(box.current?.innerHTML ?? "");
    refresh((n) => n + 1);
  };
  const block = () => String(document.queryCommandValue("formatBlock") || "").toLowerCase().replace(/[<>]/g, "");
  const commands: RteCommand[] = [
    { label: "Heading", title: "Heading", run: () => exec("formatBlock", block() === "h2" ? "<p>" : "<h2>"), active: () => block() === "h2" },
    { label: "Subheading", title: "Subheading", run: () => exec("formatBlock", block() === "h3" ? "<p>" : "<h3>"), active: () => block() === "h3" },
    { label: "B", title: "Bold", run: () => exec("bold"), active: () => document.queryCommandState("bold") },
    { label: "I", title: "Italic", run: () => exec("italic"), active: () => document.queryCommandState("italic") },
    { label: "U", title: "Underline", run: () => exec("underline"), active: () => document.queryCommandState("underline") },
    { label: "Bullets", title: "Bulleted list", run: () => exec("insertUnorderedList"), active: () => document.queryCommandState("insertUnorderedList") },
    { label: "Numbers", title: "Numbered list", run: () => exec("insertOrderedList"), active: () => document.queryCommandState("insertOrderedList") },
    {
      label: "Link",
      title: "Link",
      run: () => {
        const url = window.prompt("Link address (starts with https:// or mailto:)", "https://");
        if (!url) return;
        const href = /^(https?:|mailto:)/i.test(url) ? url : /@/.test(url) ? `mailto:${url}` : `https://${url}`;
        exec("createLink", href);
      },
    },
    { label: "Clear", title: "Clear formatting", run: () => { exec("removeFormat"); exec("formatBlock", "<p>"); } },
  ];
  const inBox = () => !!box.current && box.current.contains(document.getSelection()?.anchorNode ?? null);
  return (
    <div className="rte">
      <div className="rte-tools" role="toolbar" aria-label={`${label} formatting`}>
        {commands.map((c) => (
          <button key={c.label} type="button" title={c.title} aria-label={c.title} aria-pressed={c.active ? inBox() && c.active() : undefined} onMouseDown={(e) => e.preventDefault()} onClick={c.run} style={c.label === "B" ? { fontWeight: 800 } : c.label === "I" ? { fontStyle: "italic" } : c.label === "U" ? { textDecoration: "underline" } : undefined}>
            {c.label}
          </button>
        ))}
      </div>
      <div
        ref={box}
        className="rte-box rich"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        style={{ minHeight }}
        onInput={() => onChange(box.current?.innerHTML ?? "")}
        onFocus={() => document.execCommand("defaultParagraphSeparator", false, "p")}
        onKeyDown={(e) => {
          // A new line after a heading starts normal text, not another heading.
          if (e.key === "Enter" && !e.shiftKey && (block() === "h2" || block() === "h3")) setTimeout(() => exec("formatBlock", "<p>"), 0);
        }}
        onKeyUp={() => {
          keepCaret();
          refresh((n) => n + 1);
        }}
        onMouseUp={() => {
          keepCaret();
          refresh((n) => n + 1);
        }}
        onBlur={keepCaret}
      />
    </div>
  );
}

/** Shows formatted text that the server already cleaned. */
export function RichText({ html, className = "" }: { html: string; className?: string }) {
  return <div className={`rich ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
