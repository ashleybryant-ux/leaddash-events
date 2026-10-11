/**
 * The event's branded front door: cover photo, logo, name, dates and place,
 * then a card (sign in, enter the code, or not registered), what the app
 * offers, the top sponsors, and Register. On a computer the cover fills the
 * left half and the card sits on the right.
 */
import { useRef, useState, type ReactNode } from "react";
import { trpc, type RouterOutputs } from "../lib/trpc";
import { brandStyle } from "../shells/AttendeeShell";
import { IconAward, IconBookmark, IconCalendar, IconImage, IconMail, IconPeople, IconPin } from "../ui/icons";
import { PoweredByLogo } from "../ui/Logo";
import { errorText } from "../ui/toast";
import { fmtDates } from "@shared/format";

type PublicEvent = RouterOutputs["core"]["events"]["publicBySlug"];

function placeLine(ev: PublicEvent) {
  const city = [ev.city, ev.state].filter(Boolean).join(", ");
  return [ev.venueName, city].filter(Boolean).join(" · ");
}

export function EventWelcome({ event, children, register = true }: { event: PublicEvent; children: ReactNode; register?: boolean }) {
  const sponsors = trpc.network.exhibitors.welcomeSponsors.useQuery({ slug: event.slug }, { retry: false });
  const appName = event.branding.appName || event.shortName;
  const monogram = appName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  const place = placeLine(event);
  const feats: { label: string; icon: ReactNode; show: boolean }[] = [
    { label: "Your agenda", icon: <IconBookmark size={20} />, show: true },
    { label: "CE credits", icon: <IconAward size={20} />, show: true },
    { label: "Meet people", icon: <IconPeople size={20} />, show: event.features.networking },
    { label: "Photos", icon: <IconImage size={20} />, show: event.features.photos },
  ];
  const cover = event.coverUrl ? { backgroundImage: `url("${event.coverUrl.replace(/"/g, "%22")}")` } : undefined;
  return (
    <div className="wl" style={brandStyle(event.branding, event.coverUrl)}>
      <div className="wl-hero" style={cover}>
        <div className="wl-hero-in">
          <div className="wl-logo">{event.logoUrl ? <img src={event.logoUrl} alt={`${event.orgName} logo`} /> : <span>{monogram}</span>}</div>
          <div className="wl-host">{event.orgName} presents</div>
          <h1>{event.name}</h1>
          <div className="wl-meta">
            <span><IconCalendar size={17} />{fmtDates(event.startDate, event.endDate)}</span>
            {place ? <span><IconPin size={17} />{place}</span> : null}
          </div>
        </div>
      </div>
      <div className="wl-side">
        <div className="wl-card">{children}</div>
        <div className="wl-feat">
          {feats.filter((f) => f.show).map((f) => (
            <div key={f.label}>
              <i>{f.icon}</i>
              {f.label}
            </div>
          ))}
        </div>
        {sponsors.data?.length ? (
          <>
            <div className="wl-lab">Thank you to our sponsors</div>
            <div className="wl-spons">
              {sponsors.data.map((s) => (
                <span key={s.id} title={s.company}>{s.logoUrl ? <img src={s.logoUrl} alt={s.company} /> : s.company}</span>
              ))}
            </div>
          </>
        ) : null}
        <div className="wl-foot">
          {register ? (
            <>
              <div className="wl-note">Not registered yet?</div>
              <a className="wl-btn wl-btn-o" href={`/r/${event.slug}`}>Register for {event.shortName}</a>
            </>
          ) : null}
          <PoweredByLogo />
        </div>
      </div>
    </div>
  );
}

/** Six boxes for the emailed code. Typing moves to the next box; pasting fills them all. */
export function CodeBoxes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");
  const put = (i: number, raw: string) => {
    const d = raw.replace(/\D/g, "");
    if (d.length > 1) {
      const next = (value.slice(0, i) + d).slice(0, 6);
      onChange(next);
      refs.current[Math.min(next.length, 5)]?.focus();
      return;
    }
    const arr = digits.slice();
    arr[i] = d;
    onChange(arr.join("").slice(0, 6));
    if (d && i < 5) refs.current[i + 1]?.focus();
  };
  return (
    <div className="wl-codes" role="group" aria-label="Six-digit code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          maxLength={i === 0 ? 6 : 1}
          value={d}
          autoFocus={i === 0}
          onChange={(e) => put(i, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
          }}
        />
      ))}
    </div>
  );
}

/** Email, then the six-digit code, in the event's colors. */
export function BrandSignIn({ eventName, onDone }: { eventName: string; onDone?: () => void }) {
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
    <form
      className="col"
      style={{ gap: 14 }}
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
      {step === "email" ? (
        <>
          <h2>Welcome! Sign in to the app</h2>
          <p>Enter the email you registered with. We will send you a six-digit code.</p>
          <label className="wl-field">
            Email
            <input className="wl-input" type="email" autoComplete="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        </>
      ) : (
        <>
          <h2>Check your email</h2>
          <div className="wl-sent"><IconMail size={18} />Code sent to {email}</div>
          <p>Enter the six-digit code. It works for 15 minutes.</p>
          <CodeBoxes value={code} onChange={setCode} />
        </>
      )}
      {error ? <div className="err">{error}</div> : null}
      <button className="wl-btn" disabled={busy || (step === "code" && code.length < 6)}>
        {step === "email" ? "Email me a code" : "Sign in"}
      </button>
      {step === "email" ? (
        <div className="wl-note">Tip: add the app to your home screen for session reminders.</div>
      ) : (
        <div className="wl-links">
          <button type="button" onClick={() => { setStep("email"); setCode(""); setResent(false); }}>Use a different email</button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setError("");
              try {
                await request.mutateAsync({ email, eventName });
                setResent(true);
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            {resent ? "New code sent" : "Send a new code"}
          </button>
        </div>
      )}
    </form>
  );
}

/** Signed in, but there is no registration for this email. */
export function NotRegisteredCard({ email, slug }: { email: string; slug: string }) {
  const utils = trpc.useUtils();
  const signOut = trpc.auth.signOut.useMutation({ onSuccess: () => utils.invalidate() });
  return (
    <div className="col" style={{ gap: 14 }}>
      <h2>We could not find your registration</h2>
      <p>There is no registration for {email} yet. Register to get your agenda, badge and CE certificates, or try the email you used to register.</p>
      <a className="wl-btn" href={`/r/${slug}`}>Register now</a>
      <button type="button" className="wl-btn wl-btn-o" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
        Try a different email
      </button>
    </div>
  );
}
