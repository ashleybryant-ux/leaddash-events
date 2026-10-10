/**
 * The certificate and the badge as they print. Sizes use container units, so
 * the same markup works as a small preview, a full page, and on paper.
 */
import type { ReactNode } from "react";
import { QR } from "../../ui/components";
import { fmtHours } from "@shared/format";
import { useCertificateFonts } from "./util";
import { FONTS, readableOn, type LookFont } from "@shared/brand";
import { loadBrandFont } from "../../shells/AttendeeShell";

export type CertData = {
  certificateTitle: string;
  name: string;
  sessionTitle: string;
  date: string;
  hours: number | null;
  presenters: string[];
  approvalText: string;
  providerName: string;
  providerNumber: string;
  signerName: string;
  signerTitle: string;
  signatureStyle: "script" | "image";
  signatureUrl: string | null;
  logoUrl: string | null;
  colorPrimary: string;
  code: string | null;
  eventName: string;
};

const SERIF = "'Libre Baskerville', Georgia, serif";

function LogoMark({ url, color, size }: { url: string | null; color: string; size: string }) {
  if (url) return <img src={url} alt="" style={{ height: size, maxWidth: "30cqw", objectFit: "contain" }} />;
  return <div aria-hidden="true" style={{ width: size, height: size, borderRadius: "1.5cqw", background: color }} />;
}

/** One certificate, Letter landscape (11 x 8.5). */
export function CertificateView({ c, revoked }: { c: CertData; revoked?: boolean }) {
  useCertificateFonts();
  const sub = [c.date, c.hours !== null ? fmtHours(c.hours) : ""].filter(Boolean).join(" · ");
  const approval = [c.approvalText, c.providerNumber ? `Provider ${c.providerNumber}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="ce-cert" style={{ containerType: "inline-size", width: "100%" }}>
      <div style={{ width: "100%", aspectRatio: "11 / 8.5", boxSizing: "border-box", background: "#FFFFFF", padding: "3cqw", position: "relative" }}>
        <div style={{ height: "100%", boxSizing: "border-box", border: `0.5cqw solid ${c.colorPrimary}`, padding: "4cqw 4.5cqw 3cqw", display: "flex", flexDirection: "column", alignItems: "center", gap: "1.5cqw", textAlign: "center", fontFamily: SERIF, color: "var(--ink)" }}>
          <LogoMark url={c.logoUrl} color={c.colorPrimary} size="7.5cqw" />
          <div style={{ fontSize: "3.9cqw", fontWeight: 700, color: c.colorPrimary }}>{c.certificateTitle}</div>
          <div style={{ fontSize: "2.1cqw", color: "var(--muted)" }}>This certifies that</div>
          <div style={{ fontSize: "4.2cqw", fontWeight: 700 }}>{c.name}</div>
          <div style={{ fontSize: "2.1cqw", color: "var(--muted)", lineHeight: 1.55 }}>
            attended and completed
            {c.sessionTitle ? (
              <>
                <br />
                <span style={{ color: "var(--ink)", fontWeight: 700 }}>{c.sessionTitle}</span>
              </>
            ) : null}
            {c.presenters.length ? (
              <>
                <br />
                Presented by {c.presenters.join(", ")}
              </>
            ) : null}
            {sub ? (
              <>
                <br />
                {sub}
              </>
            ) : null}
          </div>
          <div style={{ fontSize: "1.6cqw", color: "var(--muted)", lineHeight: 1.45, maxWidth: "80cqw" }}>
            {c.providerName ? <div>{c.providerName}</div> : null}
            {approval ? <div>{approval}</div> : null}
          </div>
          <div style={{ marginTop: "auto", width: "100%", display: "flex", justifyContent: "space-between", alignItems: "flex-end", fontSize: "1.6cqw", color: "var(--muted)" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "0.3cqw" }}>
              {c.signatureStyle === "image" && c.signatureUrl ? (
                <img src={c.signatureUrl} alt={`Signature of ${c.signerName}`} style={{ height: "5cqw", objectFit: "contain" }} />
              ) : (
                <span style={{ fontFamily: "'Dancing Script', cursive", fontWeight: 400, fontSize: "3.6cqw", color: "var(--ink)", lineHeight: 1.1 }}>{c.signerName}</span>
              )}
              <span style={{ borderTop: "1px solid #9DB3AB", paddingTop: "0.4cqw", minWidth: "24cqw", textAlign: "left" }}>{[c.signerName, c.signerTitle].filter(Boolean).join(", ")}</span>
            </div>
            {c.code ? <span>Certificate ID {c.code}</span> : null}
          </div>
        </div>
        {revoked ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <span style={{ transform: "rotate(-18deg)", border: "0.6cqw solid var(--bad-ink)", color: "var(--bad-ink)", fontFamily: "var(--font)", fontWeight: 800, fontSize: "8cqw", padding: "0.5cqw 3cqw", borderRadius: "1.5cqw", background: "rgba(255,255,255,0.85)" }}>REVOKED</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Page rules for printing certificates: Letter landscape, one per page. */
export function CertificatePrintStyle() {
  return (
    <style>{`
@page { size: letter landscape; margin: 0; }
@media print {
  html, body { background: #FFFFFF !important; }
  .ce-cert-page { width: 11in !important; max-width: none !important; margin: 0 !important; padding: 0 !important; }
  .ce-cert-page .ce-cert { width: 11in !important; break-after: page; page-break-after: always; }
  .ce-cert-page .ce-cert:last-child { break-after: auto; page-break-after: auto; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}`}</style>
  );
}

export type BadgeData = {
  firstName: string;
  lastName: string;
  credentials: string;
  organization: string;
  city: string;
  ribbon: string;
  size: "4x3" | "4x6";
  qr: string;
  eventName: string;
  colorPrimary: string;
  logoUrl: string | null;
  /** The event's font (App look). */
  font?: LookFont;
};

/** The printed badge: 4 x 3 (landscape) or 4 x 6 (portrait) inches. */
export function BadgeView({ b, extra }: { b: BadgeData; extra?: ReactNode }) {
  const tall = b.size === "4x6";
  const font = b.font && FONTS[b.font] ? b.font : "jakarta";
  loadBrandFont({ font });
  const last = [b.lastName, b.credentials].filter(Boolean).join(", ");
  const details = (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "1.2cqw", textAlign: tall ? "center" : "left" }}>
      <span style={{ fontSize: tall ? "13cqw" : "10cqw", fontWeight: 800, lineHeight: 1.05, overflowWrap: "anywhere" }}>{b.firstName}</span>
      <span style={{ fontSize: tall ? "7cqw" : "5.6cqw", fontWeight: 700, overflowWrap: "anywhere" }}>{last}</span>
      {b.organization ? <span style={{ fontSize: tall ? "5cqw" : "4cqw", color: "var(--ink-2)" }}>{b.organization}</span> : null}
      {b.city ? <span style={{ fontSize: tall ? "4.6cqw" : "3.8cqw", color: "var(--muted)" }}>{b.city}</span> : null}
    </div>
  );
  return (
    <div className="ce-badge" style={{ containerType: "inline-size", width: "100%" }}>
      <div style={{ width: "100%", aspectRatio: tall ? "4 / 6" : "4 / 3", boxSizing: "border-box", background: "#FFFFFF", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: FONTS[font].css, color: "var(--ink)" }}>
        <div style={{ background: b.colorPrimary, color: readableOn(b.colorPrimary), padding: "3cqw 4.5cqw", display: "flex", alignItems: "center", gap: "2.5cqw" }}>
          {b.logoUrl ? <img src={b.logoUrl} alt="" style={{ height: "8cqw", maxWidth: "22cqw", objectFit: "contain", background: "#FFFFFF", borderRadius: "2cqw", padding: "0.6cqw" }} /> : null}
          <span style={{ fontSize: "4cqw", fontWeight: 800 }}>{b.eventName}</span>
        </div>
        <div style={{ flex: 1, padding: "4cqw 4.5cqw", display: "flex", flexDirection: tall ? "column" : "row", alignItems: "center", justifyContent: tall ? "center" : undefined, gap: "4cqw" }}>
          {details}
          <div style={{ width: tall ? "46cqw" : "28cqw", flexShrink: 0 }}>
            <QrFill value={b.qr} />
          </div>
        </div>
        {b.ribbon ? <div style={{ background: "var(--line-2)", color: "var(--ink-2)", fontSize: "3.6cqw", fontWeight: 800, letterSpacing: "0.12em", textAlign: "center", padding: "1.6cqw" }}>{b.ribbon}</div> : null}
        {extra}
      </div>
    </div>
  );
}

/** A QR code that fills its box. */
function QrFill({ value }: { value: string }) {
  return (
    <div style={{ width: "100%", aspectRatio: "1 / 1" }}>
      <div style={{ width: "100%", height: "100%" }} className="ce-qr-fill">
        <QR value={value} size={400} label="Badge QR code" />
      </div>
      <style>{`.ce-qr-fill > div, .ce-qr-fill svg { width: 100% !important; height: 100% !important; }`}</style>
    </div>
  );
}
