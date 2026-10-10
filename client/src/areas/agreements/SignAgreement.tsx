/**
 * The signing step, reused on the sponsor and exhibitor checkout pages and on
 * the emailed sign link page. Render it as a direct child of the branded public
 * page frame (<div className="app" style={brandStyle(event.branding)}>), after
 * any steps bar or header: it brings its own padded body and the sticky footer
 * with the button, and uses the event's colors, font and button shape from the
 * frame's CSS variables. `children` show at the top of the body (a page title or
 * a summary card).
 *
 * Usage at checkout (the agreement row already exists for the checkout):
 *   <SignAgreement code={checkout.agreementCode} kind="sponsor" heading="Sponsor agreement"
 *     submitLabel="Sign and continue" footerTop={<TotalLine />} onSigned={() => goToPayment()} />
 *
 * With `code`, it loads the agreement text and signs it on submit (agreements.public.sign),
 * then calls onSigned. Without `code`, pass `html`; onSigned gets the typed name,
 * title, signature PNG and recording answer so the parent can sign it itself.
 */
import { useEffect, useState, type ReactNode } from "react";
import { trpc } from "../../lib/trpc";
import { PageLoading, ErrorNote } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import "./agreements.css";

export type AgreementKind = "sponsor" | "exhibitor" | "speaker";

export type SignResult = { code?: string; name: string; title: string; signaturePng: string; recordingAllowed: boolean | null };

export type SignAgreementProps = {
  /** The agreement's code (from createAgreement). Loads the text and signs on submit. */
  code?: string;
  /** The filled agreement HTML to show instead of loading it (preview, or when the parent signs). */
  html?: string;
  kind: AgreementKind;
  /** Heading above the agreement box ("Sponsor agreement"). Leave out when the page has its own title. */
  heading?: string;
  /** "Sign and continue" at checkout, "Sign agreement" on the sign link page. */
  submitLabel: string;
  /** Ask "May we record your session?" (speakers). Read from the agreement when `code` is given. */
  askRecording?: boolean;
  /** Full name and title typed in already. */
  prefill?: { name: string; title: string };
  /** Link for Download PDF. Defaults to the agreement's PDF when `code` is given. */
  pdfUrl?: string | null;
  /** Shown in the footer above the button (the Total line at checkout). */
  footerTop?: ReactNode;
  /** Shorter agreement box (when a summary card sits above it). */
  short?: boolean;
  /** Turns the button off (for example while the parent is busy). */
  disabled?: boolean;
  /** Shown at the top of the body, above the heading. */
  children?: ReactNode;
  onSigned: (result: SignResult) => void | Promise<void>;
};

const FONT = '"Dancing Script"';

/** Loads the light cursive signature font once (Dancing Script 400), like the app loads brand fonts. */
export function loadSignatureFont() {
  if (typeof document === "undefined" || document.getElementById("sig-font")) return;
  const link = document.createElement("link");
  link.id = "sig-font";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400&display=swap";
  document.head.appendChild(link);
}

/** Draws the typed name in the signature font and returns it as a PNG data URL. */
export async function signaturePng(name: string): Promise<string> {
  const size = 64;
  const font = `400 ${size}px ${FONT}, "Brush Script MT", cursive`;
  try {
    await Promise.race([document.fonts.load(`400 ${size}px ${FONT}`), new Promise((r) => setTimeout(r, 1500))]);
  } catch {
    // The fallback cursive font is fine.
  }
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const width = Math.min(1400, Math.ceil(measure.measureText(name).width) + 24);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(120, width);
  canvas.height = Math.round(size * 1.5);
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  ctx.fillStyle = "#1A2B4C";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(name, 12, Math.round(size * 1.05));
  return canvas.toDataURL("image/png");
}

/** Today with the year ("Oct 10, 2026"). */
const today = () => new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function SignAgreement(props: SignAgreementProps) {
  const q = trpc.agreements.public.get.useQuery({ code: props.code ?? "" }, { enabled: !!props.code && props.html === undefined, retry: false });
  if (props.code && props.html === undefined) {
    if (q.isLoading) return <PageLoading />;
    if (q.error) return <div className="agr-pad"><ErrorNote error={q.error} /></div>;
  }
  const d = q.data;
  return (
    <SignForm
      {...props}
      html={props.html ?? d?.html ?? ""}
      askRecording={props.askRecording ?? d?.askRecording ?? false}
      prefill={props.prefill ?? d?.prefill}
      pdfUrl={props.pdfUrl === undefined ? (props.code ? `/agreement/${encodeURIComponent(props.code)}/pdf?download=1` : null) : props.pdfUrl}
    />
  );
}

function SignForm({ code, html, kind, heading, submitLabel, askRecording, prefill, pdfUrl, footerTop, short, disabled, children, onSigned }: SignAgreementProps & { html: string }) {
  const sign = trpc.agreements.public.sign.useMutation();
  const [full, setFull] = useState(false);
  const [name, setName] = useState(prefill?.name ?? "");
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [agree, setAgree] = useState(false);
  const [recording, setRecording] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(loadSignatureFont, []);
  const speaker = kind === "speaker";
  const ready = name.trim().length >= 2 && agree && (!askRecording || recording !== null);

  const submit = async () => {
    if (!ready) {
      toast(name.trim().length < 2 ? "Type your full name." : askRecording && recording === null ? "Choose whether we may record your session." : "Check the box to confirm.", true);
      return;
    }
    setBusy(true);
    try {
      const png = await signaturePng(name.trim());
      const result: SignResult = { code, name: name.trim(), title: title.trim(), signaturePng: png, recordingAllowed: askRecording ? recording : null };
      if (code) await sign.mutateAsync({ code, name: result.name, title: result.title, signaturePng: png, recordingAllowed: result.recordingAllowed });
      await onSigned(result);
    } catch (err) {
      toast(errorText(err), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="agr-pad agr-sign">
        {children}
        {heading ? <h2 className="agr-h">{heading}</h2> : null}
        <div className={`agr-box${full ? " full" : short ? " short" : ""}`}>
          <div className="agr-doc" dangerouslySetInnerHTML={{ __html: html }} />
          {full ? null : <div className="agr-fade" />}
        </div>
        <div className="agr-two">
          <button type="button" className="btn" onClick={() => setFull(!full)} aria-expanded={full}>
            {full ? "Show less" : "Read full agreement"}
          </button>
          {pdfUrl ? (
            <a className="btn" href={pdfUrl} target="_blank" rel="noopener noreferrer">
              Download PDF
            </a>
          ) : (
            <span />
          )}
        </div>
        {askRecording ? (
          <>
            <h2 className="agr-h">May we record your session?</h2>
            <div role="radiogroup" aria-label="May we record your session?" className="col gap-8">
              <label className={`agr-opt${recording === true ? " on" : ""}`}>
                <input type="radio" name="recording" checked={recording === true} onChange={() => setRecording(true)} />
                <span>
                  Yes
                  <small>Attendees can watch the recording in the app after the event.</small>
                </span>
              </label>
              <label className={`agr-opt${recording === false ? " on" : ""}`}>
                <input type="radio" name="recording" checked={recording === false} onChange={() => setRecording(false)} />
                <span>No</span>
              </label>
            </div>
          </>
        ) : null}
        <h2 className="agr-h">Sign</h2>
        <div className="grid-2">
          <label className="field">
            Full name
            <input className="input" autoComplete="name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            {speaker ? "Credentials" : "Title"}
            <input className="input" autoComplete={speaker ? "off" : "organization-title"} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
        <div className="agr-sig" aria-label="Signature preview">
          <div className="lbl">Signature</div>
          <div className="name">{name.trim() || " "}</div>
          <div className="when">{today()} · signed electronically</div>
        </div>
        <label className="agr-check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>{speaker ? "I have read this agreement and I agree to it." : "I have read this agreement and I am signing it for my company."}</span>
        </label>
      </div>
      <div className="app-footer" style={{ marginTop: "auto" }}>
        {footerTop}
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy || disabled} onClick={submit}>
          {busy ? "Signing" : submitLabel}
        </button>
      </div>
    </>
  );
}
