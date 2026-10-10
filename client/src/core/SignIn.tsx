import { useState } from "react";
import { trpc } from "../lib/trpc";
import { errorText } from "../ui/toast";

/**
 * Email-code sign-in. Used by the attendee app, the admin and the member hub.
 * `variant="app"` uses the larger attendee-app fields.
 */
export function SignIn({ title = "Sign in", subtitle, eventName, variant = "app", onDone }: { title?: string; subtitle?: string; eventName?: string; variant?: "app" | "admin"; onDone?: () => void }) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState("");
  const request = trpc.auth.requestCode.useMutation();
  const verify = trpc.auth.verifyCode.useMutation();

  return (
    <form
      className="col gap-14"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          if (step === "email") {
            await request.mutateAsync({ email, eventName });
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
      <div className="col gap-4">
        <h1 className={variant === "app" ? "h2" : "h1"}>{title}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {step === "email" ? subtitle ?? "Enter the email you registered with. We will send you a six-digit code." : `We sent a code to ${email}. It works for 15 minutes.`}
        </p>
      </div>
      {step === "email" ? (
        <label className="field">
          Email
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
      ) : (
        <label className="field">
          Code
          <input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
        </label>
      )}
      {error ? <div className="err">{error}</div> : null}
      <button className={`btn btn-primary ${variant === "app" ? "btn-lg" : ""} btn-block`} disabled={request.isPending || verify.isPending}>
        {step === "email" ? "Email me a code" : "Sign in"}
      </button>
      {step === "code" ? (
        <button type="button" className="btn btn-ghost" onClick={() => { setStep("email"); setCode(""); }}>
          Use a different email
        </button>
      ) : null}
    </form>
  );
}
