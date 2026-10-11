/**
 * The LeadDash Events sign-in page for organizations and staff (/ and /admin when signed out):
 * the dark green brand side, the conference photo, and the sign-in card across both.
 * On a phone the photo becomes the header and the card overlaps it.
 * Attendees sign in on their own event-branded page inside each event app.
 */
import { useState, type ReactNode } from "react";
import { trpc } from "../lib/trpc";
import { errorText } from "../ui/toast";
import { IconAward, IconCalendar, IconMail, IconPeople, IconStore } from "../ui/icons";
import { LeadDashLogo } from "../ui/Logo";
import { CodeBoxes } from "./EventWelcome";

const FEATURES: { icon: ReactNode; label: string; short: string }[] = [
  { icon: <IconCalendar size={22} />, label: "Registration and checkout", short: "Registration" },
  { icon: <IconPeople size={22} />, label: "Agenda, check-in and badges", short: "Agenda and badges" },
  { icon: <IconAward size={22} />, label: "CE certificates, sent for you", short: "CE certificates" },
  { icon: <IconStore size={22} />, label: "Sponsors and exhibitors", short: "Sponsors" },
];

function Headline() {
  return (
    <h1 className="as-h1">
      Events <br className="as-br" />
      that bring <br />
      <em>people further.</em>
    </h1>
  );
}

export function AdminSignInPage({ onDone }: { onDone?: () => void }) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState("");
  const [resent, setResent] = useState(false);
  const request = trpc.auth.requestCode.useMutation();
  const verify = trpc.auth.verifyCode.useMutation();
  const busy = request.isPending || verify.isPending;

  return (
    <div className="as">
      <section className="as-brand">
        <div className="as-brand-in">
          <LeadDashLogo tone="white" height={64} />
          <Headline />
          <p className="as-sub">
            Plan. Connect. Engage.
            <br className="as-br" /> All in one place.
          </p>
          <ul className="as-feats">
            {FEATURES.map((f) => (
              <li key={f.label}>
                <i>{f.icon}</i>
                <span className="as-long">{f.label}</span>
                <span className="as-short">{f.short}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <div className="as-photo" aria-hidden="true" />
      <form
        className="as-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            if (step === "email") {
              await request.mutateAsync({ email });
              setStep("code");
            } else {
              await verify.mutateAsync({ email, code: code.trim() });
              await utils.invalidate();
              onDone?.();
            }
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <div className="as-card-logo">
          <LeadDashLogo height={50} />
        </div>
        {step === "email" ? (
          <>
            <h2>Sign in</h2>
            <p className="as-card-sub">Enter your email. We will send you a six-digit code.</p>
            <label className="as-field">
              Email
              <span className="as-input">
                <IconMail size={18} />
                <input type="email" autoComplete="email" required placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
              </span>
            </label>
          </>
        ) : (
          <>
            <h2>Check your email</h2>
            <div className="as-sent">
              <IconMail size={16} />
              Code sent to {email}
            </div>
            <p className="as-card-sub">Enter the six-digit code. It works for 15 minutes.</p>
            <CodeBoxes value={code} onChange={setCode} />
          </>
        )}
        {error ? <div className="err">{error}</div> : null}
        <button className="as-btn" disabled={busy || (step === "code" && code.length < 6)}>
          {step === "email" ? "Email me a code" : "Sign in"} <span aria-hidden="true">&rarr;</span>
        </button>
        {step === "email" ? (
          <p className="as-foot">Attendees: open your event's app link to sign in.</p>
        ) : (
          <p className="as-foot as-links">
            <button type="button" onClick={() => { setStep("email"); setCode(""); setResent(false); }}>
              Use a different email
            </button>
            <span aria-hidden="true"> · </span>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setError("");
                try {
                  await request.mutateAsync({ email });
                  setResent(true);
                } catch (err) {
                  setError(errorText(err));
                }
              }}
            >
              {resent ? "New code sent" : "Send a new code"}
            </button>
          </p>
        )}
      </form>
      <ul className="as-tiles">
        {FEATURES.map((f) => (
          <li key={f.label}>
            <i>{f.icon}</i>
            {f.short}
          </li>
        ))}
      </ul>
    </div>
  );
}
