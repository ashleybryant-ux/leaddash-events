/** /cert/:code: the printable certificate, which is also the public check that it is real. */
import { useEffect, useRef } from "react";
import { trpc } from "../../lib/trpc";
import { ErrorNote, PageLoading } from "../../ui/components";
import { fmtWhen } from "@shared/format";
import { CertificatePrintStyle, CertificateView } from "./views";

export function CertificatePage({ code }: { code: string }) {
  const q = trpc.ce.certificates.byCode.useQuery({ code });
  const printed = useRef(false);
  const autoPrint = new URLSearchParams(window.location.search).get("print") === "1";

  useEffect(() => {
    document.title = q.data ? `${q.data.certificateTitle}: ${q.data.title}` : "Certificate";
    if (q.data && autoPrint && !printed.current && !q.data.revoked) {
      printed.current = true;
      const t = window.setTimeout(() => window.print(), 700);
      return () => window.clearTimeout(t);
    }
  }, [q.data, autoPrint]);

  if (q.isLoading) return <PageLoading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const c = q.data;
  return (
    <div className="ce-cert-outer" style={{ minHeight: "100dvh", background: "var(--ground)", padding: "24px 16px" }}>
      <CertificatePrintStyle />
      <div className="ce-cert-page" style={{ maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        {!c ? (
          <div className="banner banner-bad">We could not find a certificate with ID {code.toUpperCase()}. Check the ID printed on the certificate.</div>
        ) : (
          <>
            {c.revoked ? (
              <div className="banner banner-bad no-print">This certificate was revoked{c.revokedAt ? ` on ${fmtWhen(c.revokedAt)}` : ""}. It is no longer valid.</div>
            ) : (
              <div className="banner banner-ok no-print">
                <span>
                  Verified. Issued to {c.name} by {c.providerName || c.eventName} on {fmtWhen(c.issuedAt)}.
                </span>
                <button className="btn btn-sm btn-w btn-solid" onClick={() => window.print()}>
                  Download
                </button>
              </div>
            )}
            <div style={{ boxShadow: "0 6px 24px rgba(15, 42, 35, 0.10)", border: "1px solid var(--line)" }} className="ce-cert-frame">
              <CertificateView
                revoked={c.revoked}
                c={{
                  certificateTitle: c.certificateTitle,
                  name: c.name,
                  sessionTitle: c.sessionTitle,
                  date: c.date,
                  hours: c.hours,
                  presenters: c.presenters,
                  approvalText: c.approvalText,
                  providerName: c.providerName,
                  providerNumber: c.providerNumber,
                  signerName: c.signerName,
                  signerTitle: c.signerTitle,
                  signatureStyle: c.signatureStyle,
                  signatureUrl: c.signatureUrl,
                  logoUrl: c.logoUrl,
                  colorPrimary: c.colorPrimary,
                  code: c.showCode ? c.code : null,
                  eventName: c.eventName,
                }}
              />
            </div>
            <div className="small muted no-print" style={{ textAlign: "center" }}>
              Anyone can check this certificate at {c.verifyUrl}
            </div>
            <style>{`@media print { .ce-cert-frame { box-shadow: none !important; border: none !important; } .ce-cert-outer { padding: 0 !important; min-height: 0 !important; } }`}</style>
          </>
        )}
      </div>
    </div>
  );
}
