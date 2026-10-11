/**
 * Public sponsor and exhibitor pages, branded with the event's look like the
 * attendee checkout: /r/:slug/sponsor and /r/:slug/exhibit (Package or Booth,
 * Company, Agreement, Payment), the confirmation page (.../done?c=) and the pay
 * link (.../pay?v=). Card and bank details are typed on Stripe's own form.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { brandStyle } from "../../shells/AttendeeShell";
import { ErrorNote, PageLoading, Spinner, readFileBase64 } from "../../ui/components";
import { IconCheck } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtDates, fmtMoney, fmtWhen } from "@shared/format";
import { SignAgreement } from "../agreements/SignAgreement";
import { stripeFor } from "./shared";

type Kind = "sponsor" | "exhibitor";
type PayOption = "full" | "deposit" | "invoice";
type PageData = RouterOutputs["registration"]["vendorCheckout"]["page"];
type Pkg = PageData["packages"][number];
type Prepared = RouterOutputs["registration"]["vendorCheckout"]["prepare"];
type Person = { name: string; email: string };

type Form = {
  company: string;
  website: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  category: string;
  about: string;
  offer: string;
  boothRequest: string;
  logoFileId: number | null;
  logoToken: string;
  logoUrl: string | null;
  people: Person[];
  addons: Record<string, number>;
};

type Saved = { step: 1 | 2 | 3 | 4; packageId: number | null; form: Form; payOption: PayOption | null; prep: Prepared | null };

const blankForm = (): Form => ({ company: "", website: "", firstName: "", lastName: "", email: "", phone: "", category: "", about: "", offer: "", boothRequest: "", logoFileId: null, logoToken: "", logoUrl: null, people: [], addons: {} });
const blank = (): Saved => ({ step: 1, packageId: null, form: blankForm(), payOption: null, prep: null });

const storeKey = (slug: string, kind: Kind) => `ld-vendor:${slug}:${kind}`;
function loadSaved(slug: string, kind: Kind): Saved | null {
  try {
    const raw = sessionStorage.getItem(storeKey(slug, kind));
    const d = raw ? (JSON.parse(raw) as Saved) : null;
    return d && d.form ? { ...blank(), ...d, form: { ...blankForm(), ...d.form } } : null;
  } catch {
    return null;
  }
}
function storeSaved(slug: string, kind: Kind, d: Saved | null) {
  try {
    if (d) sessionStorage.setItem(storeKey(slug, kind), JSON.stringify(d));
    else sessionStorage.removeItem(storeKey(slug, kind));
  } catch {
    /* private window: the page still works within this visit */
  }
}

const initialsOf = (s: string) => {
  const w = s.trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? "") + (w[1]?.[0] ?? "")).toUpperCase() || "?";
};

/* ---------- Frame ---------- */

type EventInfo = PageData["event"];

function Frame({ ev, children }: { ev: EventInfo; children: ReactNode }) {
  useEffect(() => {
    document.title = ev.shortName;
  }, [ev.shortName]);
  return (
    <div className="app" style={brandStyle(ev.branding, ev.branding.header === "cover" ? ev.coverUrl : null)}>
      {children}
    </div>
  );
}

function Header({ ev }: { ev: EventInfo }) {
  const light = ev.branding.header === "light";
  return (
    <div style={{ position: "relative", flexShrink: 0, height: light ? 64 : 150, backgroundColor: "var(--header-bg)", backgroundImage: "var(--header-image)", backgroundSize: "cover", backgroundPosition: "center", borderBottom: "3px solid var(--header-border)" }}>
      <div style={{ position: "absolute", left: 18, bottom: -27, width: 54, height: 54, borderRadius: 12, background: "#FFFFFF", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", padding: 5 }}>
        {ev.logoUrl ? <img src={ev.logoUrl} alt={`${ev.orgName} logo`} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /> : <img src="/icon-192.png" alt="" style={{ width: "100%", height: "100%" }} />}
      </div>
    </div>
  );
}

function Steps({ labels, on }: { labels: string[]; on: number }) {
  return (
    <div className="steps" style={{ padding: "12px 16px 0" }}>
      {labels.map((label, i) => (
        <div key={label} className={i < on ? "on" : ""}>
          <div className="bar" />
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

const h2: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 800 };

function TotalLine({ label = "Total", value }: { label?: string; value: string }) {
  return (
    <div className="row-between" style={{ fontSize: 15, fontWeight: 800 }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function leftNote(p: Pkg) {
  if (p.soldOut) return { text: "Sold out", color: "var(--warn-ink)" };
  if (p.left == null) return null;
  if (p.left <= 3 || p.quantity == null) return { text: `${p.left} left`, color: "var(--warn-ink)" };
  return { text: `${p.left} of ${p.quantity} left`, color: "var(--brand)" };
}

/* ---------- Step 1: packages ---------- */

function PackageCard({ p, picked, onPick }: { p: Pkg; picked: boolean; onPick: () => void }) {
  const note = leftNote(p);
  return (
    <label className={`option${picked ? " selected" : ""}`} style={{ alignItems: "flex-start", flexDirection: "column", gap: 8, ...(p.soldOut ? { opacity: 0.55, cursor: "default" } : {}) }}>
      <span className="row" style={{ width: "100%", gap: 10, alignItems: "flex-start" }}>
        <input type="radio" name="package" checked={picked} disabled={p.soldOut} onChange={onPick} style={{ marginTop: 2 }} />
        <span className="col grow" style={{ gap: 1 }}>
          <span style={{ fontSize: 16, fontWeight: 800 }}>{p.name}</span>
          {note ? <span style={{ fontSize: 12, fontWeight: 700, color: note.color }}>{note.text}</span> : null}
        </span>
        <span style={{ fontSize: 16, fontWeight: 800 }}>{fmtMoney(p.priceCents, "$0.00")}</span>
      </span>
      {p.includes.length ? (
        <span className="col" style={{ gap: 4, paddingLeft: 2 }}>
          {p.includes.map((line) => (
            <span key={line} className="row" style={{ gap: 8, fontSize: 13, color: "var(--ink-2)", alignItems: "flex-start" }}>
              <span style={{ color: "var(--brand)", flexShrink: 0, marginTop: 1 }}>
                <IconCheck size={14} />
              </span>
              {line}
            </span>
          ))}
        </span>
      ) : null}
    </label>
  );
}

/* ---------- Step 2: company ---------- */

function LogoBox({ slug, kind, uploadToken, form, set }: { slug: string; kind: Kind; uploadToken?: string; form: Form; set: (p: Partial<Form>) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = trpc.registration.vendorCheckout.uploadLogo.useMutation();
  return (
    <div className="row" style={{ gap: 12, border: "1.5px dashed var(--line)", borderRadius: 12, padding: 12, background: "#FFFFFF" }}>
      <div style={{ width: 44, height: 44, borderRadius: 8, background: "var(--brand-tint)", color: "var(--brand)", fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
        {form.logoUrl ? <img src={form.logoUrl} alt="Your logo" style={{ width: "100%", height: "100%", objectFit: "contain", background: "#FFFFFF" }} /> : initialsOf(form.company)}
      </div>
      <div className="col grow" style={{ gap: 1 }}>
        <span style={{ fontSize: 14, fontWeight: 800 }}>Logo</span>
        <span className="small muted" style={{ fontSize: 13 }}>PNG, JPEG or WebP, square</span>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            const base64 = await readFileBase64(file);
            const mime = (["image/png", "image/jpeg", "image/webp"].includes(file.type) ? file.type : "image/png") as "image/png";
            const r = await upload.mutateAsync({ slug, kind, uploadToken, name: file.name, mime, base64 });
            set({ logoFileId: r.fileId, logoToken: r.token, logoUrl: r.url });
          } catch (err) {
            toast(errorText(err), true);
          }
        }}
      />
      <button type="button" className="btn btn-sm" style={{ borderColor: "var(--brand)", color: "var(--brand)", minWidth: 72 }} disabled={upload.isPending} onClick={() => input.current?.click()}>
        {upload.isPending ? "Uploading" : form.logoUrl ? "Replace" : "Upload"}
      </button>
    </div>
  );
}

function Stepper({ value, max, onChange, label }: { value: number; max: number | null; onChange: (n: number) => void; label: string }) {
  const btn: CSSProperties = { width: 34, height: 32, border: "none", background: "transparent", fontSize: 18, fontWeight: 700, cursor: "pointer", color: "var(--ink)" };
  return (
    <div className="row" role="group" aria-label={label} style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", gap: 0, flexShrink: 0 }}>
      <button type="button" style={btn} aria-label={`Fewer ${label}`} disabled={value <= 0} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span style={{ width: 34, textAlign: "center", fontWeight: 700, fontSize: 14, borderLeft: "1px solid var(--line)", borderRight: "1px solid var(--line)", lineHeight: "32px" }}>{value}</span>
      <button type="button" style={btn} aria-label={`More ${label}`} disabled={max != null && value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}

function CompanyStep({ slug, kind, data, pkg, form, set }: { slug: string; kind: Kind; data: PageData; pkg: Pkg; form: Form; set: (p: Partial<Form>) => void }) {
  const sponsor = kind === "sponsor";
  const passCount = pkg.passes + pkg.addons.reduce((n, a) => n + (a.addsPass ? form.addons[a.id] ?? 0 : 0), 0);
  const people = Array.from({ length: passCount }, (_, i) => form.people[i] ?? { name: "", email: "" });
  const setPerson = (i: number, patch: Partial<Person>) => {
    const next = [...people];
    next[i] = { ...next[i], ...patch };
    set({ people: next });
  };
  const field = (k: keyof Form) => (e: { target: { value: string } }) => set({ [k]: e.target.value } as Partial<Form>);
  // The contact fills Pass 1 (Staff 1) while that row is empty or still matches the contact.
  const contact = (k: "firstName" | "lastName" | "email") => (e: { target: { value: string } }) => {
    const next = { ...form, [k]: e.target.value };
    const first = people[0];
    const was = { name: `${form.firstName} ${form.lastName}`.trim(), email: form.email.trim() };
    const follows = first && (!first.name || first.name === was.name) && (!first.email || first.email === was.email);
    if (!follows) return set({ [k]: e.target.value } as Partial<Form>);
    set({ [k]: e.target.value, people: [{ ...first, name: `${next.firstName} ${next.lastName}`.trim(), email: next.email.trim() }, ...people.slice(1)] } as Partial<Form>);
  };
  return (
    <>
      <h2 style={h2}>Company</h2>
      <label className="field">
        Company name
        <input className="input" autoComplete="organization" value={form.company} onChange={field("company")} />
      </label>
      <label className="field">
        Website
        <input className="input" autoComplete="url" inputMode="url" value={form.website} onChange={field("website")} />
      </label>
      <div className="grid-2">
        <label className="field">
          First name
          <input className="input" autoComplete="given-name" value={form.firstName} onChange={contact("firstName")} />
        </label>
        <label className="field">
          Last name
          <input className="input" autoComplete="family-name" value={form.lastName} onChange={contact("lastName")} />
        </label>
      </div>
      <label className="field">
        Email
        <input className="input" type="email" inputMode="email" autoComplete="email" value={form.email} onChange={contact("email")} />
      </label>
      {sponsor ? (
        <label className="field">
          Mobile
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={field("phone")} />
        </label>
      ) : (
        <label className="field">
          Category
          <select className="select" value={form.category} onChange={field("category")}>
            <option value="">Choose one</option>
            {data.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
      {sponsor ? <h2 style={{ ...h2, paddingTop: 6 }}>In the app</h2> : null}
      <LogoBox slug={slug} kind={kind} uploadToken={data.uploadToken} form={form} set={set} />
      {sponsor ? (
        <label className="field">
          About your company
          <textarea className="textarea" rows={3} maxLength={2000} value={form.about} onChange={field("about")} />
        </label>
      ) : (
        <label className="field">
          Booth offer shown in the app (optional)
          <input className="input" maxLength={300} value={form.offer} onChange={field("offer")} />
        </label>
      )}
      {passCount > 0 ? (
        <>
          <h2 style={{ ...h2, paddingTop: 6 }}>{sponsor ? `Event passes (${passCount} included)` : `Booth staff (${passCount} included)`}</h2>
          {sponsor ? <span className="muted" style={{ fontSize: 13, marginTop: -4 }}>Add names now or later from your confirmation email.</span> : null}
          {people.map((p, i) => (
            <div key={i} className="grid-2">
              <label className="field">
                {sponsor ? `Pass ${i + 1} name` : `Staff ${i + 1} name`}
                <input className="input" placeholder="Name" value={p.name} onChange={(e) => setPerson(i, { name: e.target.value })} />
              </label>
              <label className="field">
                Email
                <input className="input" type="email" inputMode="email" placeholder="Email" value={p.email} onChange={(e) => setPerson(i, { email: e.target.value })} />
              </label>
            </div>
          ))}
        </>
      ) : null}
      {pkg.addons.length ? (
        <>
          <h2 style={{ ...h2, paddingTop: 6 }}>Add-ons</h2>
          {pkg.addons.map((a) => {
            const qty = form.addons[a.id] ?? 0;
            return (
              <div key={a.id} className="card row-between" style={{ padding: "10px 12px", gap: 10 }}>
                <span className="col" style={{ gap: 1 }}>
                  <span style={{ fontSize: 14, fontWeight: 800 }}>{a.name}</span>
                  <span className="muted" style={{ fontSize: 13 }}>{a.left === 0 && !qty ? "Sold out" : `${fmtMoney(a.priceCents, "$0.00")} each`}</span>
                </span>
                <Stepper label={a.name} value={qty} max={a.left} onChange={(n) => set({ addons: { ...form.addons, [a.id]: Math.max(0, n) } })} />
              </div>
            );
          })}
        </>
      ) : null}
      {!sponsor ? (
        <label className="field">
          Booth request (optional)
          <input className="input" maxLength={300} value={form.boothRequest} onChange={field("boothRequest")} />
        </label>
      ) : null}
    </>
  );
}

/** Back to the step before: the same secondary button at the bottom of every step, above the footer. */
function BackButton({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="btn btn-sm btn-w" style={{ alignSelf: "flex-start", marginTop: 4 }} onClick={onClick}>
      {label}
    </button>
  );
}

/* ---------- Step 4: payment ---------- */

function methodWords(methods: PageData["page"]["methods"]) {
  return methods === "ach" ? "bank account" : methods === "card" ? "card" : "card or bank account";
}

function optionText(o: PayOption, d: PageData, kind: Kind) {
  const p = d.page;
  if (o === "full") return { title: "Pay in full", sub: p.methods === "ach" ? "From your bank account." : p.methods === "card" ? "By card." : "Card or bank account." };
  if (o === "deposit") {
    const when = fmtDate(p.balanceDueOn);
    return { title: "Pay a deposit", sub: p.methods === "ach" ? `${p.depositPercent}% today. The rest comes from the same bank account on ${when}.` : `${p.depositPercent}% today. The rest is charged to the same ${methodWords(p.methods)} on ${when}.` };
  }
  return { title: "Pay by invoice", sub: `We email an invoice. Your ${kind === "sponsor" ? "package" : "booth"} is held for ${p.invoiceHoldDays} days.` };
}

const dueFor = (o: PayOption, total: number, pct: number) => (o === "invoice" ? 0 : o === "deposit" ? Math.round((total * pct) / 100) : total);

/* ---------- /r/:slug/sponsor and /r/:slug/exhibit ---------- */

export function VendorCheckoutScreen({ slug, kind }: { slug: string; kind: Kind }) {
  const q = trpc.registration.vendorCheckout.page.useQuery({ slug, kind }, { staleTime: 30_000 });
  const [, navigate] = useLocation();
  const [st, setSt] = useState<Saved>(() => loadSaved(slug, kind) ?? blank());
  const [error, setError] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const prepare = trpc.registration.vendorCheckout.prepare.useMutation();
  const sign = trpc.registration.vendorCheckout.sign.useMutation();
  const start = trpc.registration.vendorCheckout.start.useMutation();
  const update = (patch: Partial<Saved>) =>
    setSt((cur) => {
      const next = { ...cur, ...patch };
      storeSaved(slug, kind, next);
      return next;
    });
  const setForm = (p: Partial<Form>) => update({ form: { ...st.form, ...p } });
  const go = (step: Saved["step"]) => {
    setError("");
    setSecret(null);
    update({ step });
    window.scrollTo(0, 0);
  };

  // The first package that is not sold out starts picked.
  const firstOpen = q.data?.packages.find((p) => !p.soldOut)?.id ?? null;
  const pickedOk = !!q.data?.packages.some((p) => p.id === st.packageId && !p.soldOut);
  useEffect(() => {
    if (firstOpen !== null && !pickedOk) update({ packageId: firstOpen });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstOpen, pickedOk]);

  if (q.isLoading) return <PageLoading />;
  if (q.error) return <div className="app"><ErrorNote error={q.error} /></div>;
  const d = q.data!;
  const ev = d.event;
  const sponsor = kind === "sponsor";
  const pkg = d.packages.find((p) => p.id === st.packageId && !p.soldOut);
  const labels = [sponsor ? "Package" : "Booth", "Company", ...(d.hasAgreement ? ["Agreement"] : []), "Payment"];
  const stepNo = (s: Saved["step"]) => (s === 4 && !d.hasAgreement ? 3 : s);
  const addonCents = pkg ? pkg.addons.reduce((n, a) => n + a.priceCents * (st.form.addons[a.id] ?? 0), 0) : 0;
  const localTotal = (pkg?.priceCents ?? 0) + addonCents;

  const buyerInput = () => ({
    ...st.form,
    people: st.form.people,
    addons: Object.entries(st.form.addons)
      .map(([id, qty]) => ({ addonId: Number(id), qty }))
      .filter((a) => a.qty > 0 && pkg?.addons.some((x) => x.id === a.addonId)),
  });

  async function runPrepare(payOption: PayOption) {
    const { logoUrl: _u, ...form } = buyerInput();
    return prepare.mutateAsync({ slug, kind, token: st.prep?.token, packageId: pkg!.id, buyer: form, payOption });
  }

  if (d.closed) {
    return (
      <Frame ev={ev}>
        <Header ev={ev} />
        <main className="app-body" style={{ paddingTop: 40 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, lineHeight: 1.2 }}>{d.page.title}</h1>
          <div className="banner banner-warn">{d.closed}</div>
        </main>
      </Frame>
    );
  }

  /* Step 1 */
  if (st.step === 1 || !pkg) {
    const where = [ev.venueName, ev.city].filter(Boolean)[0];
    return (
      <Frame ev={ev}>
        <Header ev={ev} />
        <main className="app-body" style={{ paddingTop: 40, gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, lineHeight: 1.2 }}>{d.page.title}</h1>
          <div className="muted" style={{ fontSize: 13, fontWeight: 600 }}>
            {fmtDates(ev.startDate, ev.endDate)}
            {where ? ` · ${where}` : ""}
          </div>
          {d.page.intro ? <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink-2)", whiteSpace: "pre-line" }}>{d.page.intro}</div> : null}
          <div style={{ ...h2, paddingTop: 8 }}>{sponsor ? "Packages" : "Booths"}</div>
          {!d.packages.length ? <div className="banner banner-warn">{sponsor ? "Packages are not on sale yet." : "Booths are not on sale yet."}</div> : null}
          <div className="col gap-12">
            {d.packages.map((p) => (
              <PackageCard key={p.id} p={p} picked={st.packageId === p.id && !p.soldOut} onPick={() => update({ packageId: p.id })} />
            ))}
          </div>
        </main>
        {d.packages.some((p) => !p.soldOut) ? (
          <div className="app-footer">
            {error ? <div className="err" role="alert">{error}</div> : null}
            <button className="btn btn-primary btn-lg btn-block" onClick={() => (pkg ? go(2) : setError(sponsor ? "Pick a package." : "Pick a booth."))}>
              Continue
            </button>
          </div>
        ) : null}
      </Frame>
    );
  }

  /* Step 2 */
  if (st.step === 2 || !st.prep) {
    return (
      <Frame ev={ev}>
        <Steps labels={labels} on={2} />
        <main className="app-body" style={{ paddingTop: 14 }}>
          <CompanyStep slug={slug} kind={kind} data={d} pkg={pkg} form={st.form} set={setForm} />
          <BackButton onClick={() => go(1)} />
        </main>
        <div className="app-footer">
          {error ? <div className="err" role="alert">{error}</div> : null}
          <TotalLine value={fmtMoney(localTotal, "$0.00")} />
          <button
            className="btn btn-primary btn-lg btn-block"
            disabled={prepare.isPending}
            onClick={async () => {
              setError("");
              try {
                const prep = await runPrepare(st.payOption ?? (d.page.options.includes("deposit") ? "deposit" : d.page.options[0]));
                update({ prep, payOption: prep.payOption, step: prep.agreement && !prep.agreement.signed ? 3 : 4 });
                window.scrollTo(0, 0);
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            Continue
          </button>
        </div>
      </Frame>
    );
  }

  const prep = st.prep;

  /* Step 3 */
  if (st.step === 3 && prep.agreement) {
    return (
      <Frame ev={ev}>
        <Steps labels={labels} on={3} />
        <SignAgreement
          key={prep.agreement.code}
          html={prep.agreement.html}
          kind={kind}
          heading={sponsor ? "Sponsor agreement" : "Exhibitor agreement"}
          submitLabel="Sign and continue"
          prefill={{ name: `${st.form.firstName} ${st.form.lastName}`.trim(), title: "" }}
          pdfUrl={`/agreement/${encodeURIComponent(prep.agreement.code)}/pdf?download=1`}
          footerTop={<TotalLine value={fmtMoney(prep.totalCents, "$0.00")} />}
          disabled={sign.isPending}
          onSigned={async (r) => {
            await sign.mutateAsync({ slug, kind, token: prep.token, name: r.name, title: r.title, signaturePng: r.signaturePng });
            update({ prep: { ...prep, agreement: { ...prep.agreement!, signed: true } }, step: 4 });
            window.scrollTo(0, 0);
          }}
          bottom={<BackButton onClick={() => go(2)} />}
        />
      </Frame>
    );
  }

  /* Step 4 */
  const option: PayOption = st.payOption && d.page.options.includes(st.payOption) ? st.payOption : prep.payOption;
  const due = dueFor(option, prep.totalCents, d.page.depositPercent);
  const needsSign = !!prep.agreement && !prep.agreement.signed;
  const pay = d.payments;
  const cantPay = option !== "invoice" && due > 0 && !pay.ready;
  const passes = pkg.passes + pkg.addons.reduce((n, a) => n + (a.addsPass ? st.form.addons[a.id] ?? 0 : 0), 0);

  async function pickOption(o: PayOption) {
    if (o === option || secret) return;
    update({ payOption: o });
    if (!d.hasAgreement) return;
    try {
      const next = await runPrepare(o);
      update({ payOption: o, prep: next });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function payNow() {
    setError("");
    try {
      const r = await start.mutateAsync({ slug, kind, token: prep.token, payOption: option });
      if (r.kind === "done") {
        storeSaved(slug, kind, null);
        navigate(r.doneUrl);
      } else setSecret(r.clientSecret);
    } catch (err) {
      const msg = errorText(err);
      if (/Sign the agreement/.test(msg)) {
        update({ prep: { ...prep, agreement: prep.agreement ? { ...prep.agreement, signed: false } : null } });
      }
      setError(msg);
    }
  }

  return (
    <Frame ev={ev}>
      <Steps labels={labels} on={stepNo(4)} />
      <main className="app-body" style={{ paddingTop: 14 }}>
        <h2 style={h2}>Summary</h2>
        <div className="card" style={{ overflow: "hidden" }}>
          {prep.lines.map((l, i) => (
            <div key={l.label} className="row-between" style={{ padding: "11px 14px", fontSize: 14, borderTop: i ? "1px solid var(--line-2)" : "none" }}>
              <span>{l.label}</span>
              <span>{fmtMoney(l.cents, "$0.00")}</span>
            </div>
          ))}
          {sponsor ? (
            <div className="row-between" style={{ padding: "11px 14px", fontSize: 14, borderTop: "1px solid var(--line-2)" }}>
              <span>{st.form.company}</span>
              <span>{passes} pass{passes === 1 ? "" : "es"}</span>
            </div>
          ) : null}
          {prep.lines.length > 1 ? (
            <div className="row-between" style={{ padding: "11px 14px", fontSize: 14, fontWeight: 800, borderTop: "1px solid var(--line-2)" }}>
              <span>Total</span>
              <span>{fmtMoney(prep.totalCents, "$0.00")}</span>
            </div>
          ) : null}
        </div>
        <h2 style={{ ...h2, paddingTop: 6 }}>How to pay</h2>
        <div role="radiogroup" aria-label="How to pay" className="col gap-12">
          {d.page.options.map((o) => {
            const t = optionText(o, d, kind);
            const amount = dueFor(o, prep.totalCents, d.page.depositPercent);
            return (
              <label key={o} className={`option${o === option ? " selected" : ""}`} style={{ alignItems: "flex-start", ...(secret && o !== option ? { opacity: 0.55 } : {}) }}>
                <input type="radio" name="pay-option" checked={o === option} disabled={!!secret} onChange={() => pickOption(o)} style={{ marginTop: 2 }} />
                <span className="col grow" style={{ gap: 2 }}>
                  <span style={{ fontSize: 14, fontWeight: 800 }}>{t.title}</span>
                  <span className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>{t.sub}</span>
                </span>
                <span style={{ fontSize: 14, fontWeight: 800, whiteSpace: "nowrap" }}>{o === "invoice" ? "$0.00 today" : fmtMoney(amount, "$0.00")}</span>
              </label>
            );
          })}
        </div>
        {secret && pay.publishableKey && pay.accountId ? (
          <div style={{ borderRadius: 12, overflow: "hidden", background: "#FFFFFF", border: "1px solid var(--line)" }}>
            <EmbeddedCheckoutProvider key={secret} stripe={stripeFor(pay.publishableKey, pay.accountId)} options={{ clientSecret: secret }}>
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          </div>
        ) : null}
        {cantPay ? <div className="banner banner-warn">This page is not taking payments yet. Please try again later.</div> : null}
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, textAlign: "center" }}>
          {option === "invoice" || d.page.methods === "card" ? "" : d.page.methods === "ach" ? "Bank payments take up to 4 business days to clear. " : "If you pay from a bank account, it takes up to 4 business days to clear. "}
          Payments go to {pay.businessName || ev.orgName} through Stripe.
        </div>
        {secret ? <BackButton label="Change how to pay" onClick={() => setSecret(null)} /> : <BackButton onClick={() => go(2)} />}
      </main>
      {!secret ? (
        <div className="app-footer">
          {error ? <div className="err" role="alert">{error}</div> : null}
          {needsSign ? <div className="small muted">How you pay is part of the agreement. Sign it again to continue.</div> : null}
          <TotalLine value={option === "full" ? fmtMoney(due, "$0.00") : `${fmtMoney(due, "$0.00")} today`} />
          {needsSign ? (
            <button className="btn btn-primary btn-lg btn-block" onClick={() => go(3)}>
              Sign again
            </button>
          ) : (
            <button className="btn btn-primary btn-lg btn-block" disabled={start.isPending || prepare.isPending || cantPay} onClick={payNow}>
              {option === "invoice" ? "Request invoice" : `Pay ${fmtMoney(due, "$0.00")}`}
            </button>
          )}
        </div>
      ) : null}
    </Frame>
  );
}

/* ---------- Confirmation: /r/:slug/sponsor/done?c= ---------- */

function NextStep({ n, title, sub, action, children }: { n: number; title: string; sub: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="row" style={{ gap: 12 }}>
        <span style={{ width: 26, height: 26, borderRadius: 13, background: "var(--brand-tint)", color: "var(--brand)", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{n}</span>
        <span className="col grow" style={{ gap: 1 }}>
          <span style={{ fontSize: 14, fontWeight: 800 }}>{title}</span>
          <span className="muted" style={{ fontSize: 13 }}>{sub}</span>
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

const outline: CSSProperties = { borderColor: "var(--brand)", color: "var(--brand)", minWidth: 84 };

export function VendorDoneScreen({ slug, kind }: { slug: string; kind: Kind }) {
  const c = new URLSearchParams(useSearch()).get("c") ?? "";
  const page = trpc.registration.vendorCheckout.page.useQuery({ slug, kind }, { staleTime: 60_000 });
  const done = trpc.registration.vendorCheckout.done.useQuery({ slug, kind, c }, { enabled: c.length >= 10, retry: 1, refetchInterval: (query) => (query.state.data?.status === "processing" && query.state.dataUpdateCount < 40 ? 3000 : false) });
  const utils = trpc.useUtils();
  const add = trpc.registration.vendorCheckout.addPasses.useMutation();
  const [open, setOpen] = useState<"passes" | "listing" | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    if (done.data && done.data.status !== "processing") storeSaved(slug, kind, null);
  }, [done.data, slug, kind]);
  if (page.isLoading || done.isLoading) return <PageLoading />;
  if (page.error) return <div className="app"><ErrorNote error={page.error} /></div>;
  const ev = page.data!.event;
  if (!c || done.error) return <Frame ev={ev}><main className="app-body"><ErrorNote error={done.error ?? { message: "That checkout was not found." }} /></main></Frame>;
  const r = done.data!;
  const sponsor = kind === "sponsor";
  const back = `/r/${slug}/${sponsor ? "sponsor" : "exhibit"}`;

  if (r.status === "processing") {
    return (
      <Frame ev={ev}>
        <main className="app-body center col" style={{ padding: 32, textAlign: "center" }}>
          <Spinner />
          <div className="h3">Confirming your payment</div>
          <div className="muted">This takes a few seconds. We will email {r.email} when it is done.</div>
        </main>
      </Frame>
    );
  }
  if (r.status === "expired" || r.status === "failed") {
    const link = "payLink" in r ? r.payLink : null;
    return (
      <Frame ev={ev}>
        <main className="app-body" style={{ padding: "24px 18px", gap: 14 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>{r.status === "failed" ? "Your payment did not go through" : "This checkout timed out"}</h1>
          <div className="muted" style={{ fontSize: 14, lineHeight: 1.55 }}>{r.status === "failed" ? `Pay with another card or bank account. We also emailed the link to ${r.email}.` : "You were not charged. Start again to finish."}</div>
          <a className="btn btn-primary btn-lg btn-block" href={link ?? back}>
            {link ? "Pay now" : "Start again"}
          </a>
        </main>
      </Frame>
    );
  }
  if (!("passes" in r)) return null;
  const word = sponsor ? "sponsor" : "exhibitor";
  const headline = sponsor ? `You are a ${r.packageName} sponsor` : `Your ${r.packageName.toLowerCase().includes("booth") ? r.packageName : `${r.packageName} booth`} is booked`;
  const rest = r.restCents > 0 && r.restOn ? ` The other ${fmtMoney(r.restCents, "$0.00")} is charged on ${fmtDate(r.restOn)}.` : "";
  const text =
    r.status === "invoice"
      ? `Thank you, ${r.firstName}. The invoice for ${fmtMoney(r.totalCents, "$0.00")} is on its way to ${r.email}. Your ${sponsor ? "package" : "booth"} is held until ${fmtDate(r.holdUntil)}.`
      : r.status === "clearing"
        ? `Thank you, ${r.firstName}. Your bank payment of ${fmtMoney(r.dueTodayCents, "$0.00")} takes up to 4 business days to clear. Your receipt is on its way to ${r.email}.${rest}`
        : `Thank you, ${r.firstName}. A receipt for ${fmtMoney(r.dueTodayCents || r.totalCents, "$0.00")} is on its way to ${r.email}.${rest}`;
  const openPasses = Math.max(0, r.passes.total - r.passes.named);
  const rows = Array.from({ length: openPasses }, (_, i) => people[i] ?? { name: "", email: "" });
  const listingParts = [r.listing.logoUrl ? "Logo" : "", r.listing.about ? "about" : "", r.listing.website ? "website" : "", r.listing.offer ? "booth offer" : ""].filter(Boolean);
  let n = 0;
  return (
    <Frame ev={ev}>
      <main className="app-body" style={{ padding: "28px 18px", gap: 14 }}>
        <div style={{ width: 56, height: 56, borderRadius: 28, background: "var(--brand-tint)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <IconCheck size={26} />
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, lineHeight: 1.25 }}>{headline}</h1>
        <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink-2)" }}>{text}</div>
        {r.status === "invoice" && r.payLink ? (
          <a className="btn btn-primary btn-block" style={{ height: 46 }} href={r.payLink}>
            Pay now
          </a>
        ) : null}
        <div className="label-caps" style={{ paddingTop: 4 }}>Next steps</div>
        {r.passes.total > 0 ? (
          <NextStep
            n={++n}
            title={sponsor ? "Add your pass names" : "Add your booth staff"}
            sub={openPasses ? `${openPasses} of ${r.passes.total} ${sponsor ? "passes" : "staff passes"} open` : `All ${r.passes.total} named`}
            action={
              openPasses ? (
                <button type="button" className="btn btn-sm" style={outline} onClick={() => setOpen(open === "passes" ? null : "passes")}>
                  {open === "passes" ? "Close" : "Add names"}
                </button>
              ) : null
            }
          >
            {open === "passes" && openPasses ? (
              <div className="col gap-8">
                {rows.map((p, i) => (
                  <div key={i} className="grid-2">
                    <input className="input" aria-label={`Name ${i + 1}`} placeholder="Name" value={p.name} onChange={(e) => setPeople(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    <input className="input" type="email" aria-label={`Email ${i + 1}`} placeholder="Email" value={p.email} onChange={(e) => setPeople(rows.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  disabled={add.isPending}
                  onClick={async () => {
                    const list = rows.filter((p) => p.name.trim() || p.email.trim());
                    if (!list.length) return toast("Add a name and email.", true);
                    try {
                      const res = await add.mutateAsync({ slug, kind, c, people: list });
                      toast(`${res.added} added`);
                      setPeople([]);
                      setOpen(null);
                      await utils.registration.vendorCheckout.done.invalidate();
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  Save names
                </button>
              </div>
            ) : null}
          </NextStep>
        ) : null}
        <NextStep
          n={++n}
          title="Check your app listing"
          sub={listingParts.length ? listingParts.join(" and ").replace(/^./, (x) => x.toUpperCase()).replace(/ and (?=.* and )/g, ", ") : "Name only"}
          action={
            <button type="button" className="btn btn-sm" style={outline} onClick={() => setOpen(open === "listing" ? null : "listing")}>
              {open === "listing" ? "Close" : "View"}
            </button>
          }
        >
          {open === "listing" ? (
            <div className="col gap-8" style={{ borderTop: "1px solid var(--line-2)", paddingTop: 10 }}>
              <div className="row" style={{ gap: 10 }}>
                <div style={{ width: 44, height: 44, borderRadius: 8, background: "var(--brand-tint)", color: "var(--brand)", fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                  {r.listing.logoUrl ? <img src={r.listing.logoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", background: "#FFFFFF" }} /> : initialsOf(r.listing.company)}
                </div>
                <span className="col" style={{ gap: 1 }}>
                  <span style={{ fontWeight: 800, fontSize: 14 }}>{r.listing.company}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{r.listing.category || (sponsor ? `${r.packageName} sponsor` : "")}</span>
                </span>
              </div>
              {r.listing.about ? <div style={{ fontSize: 13, lineHeight: 1.5 }}>{r.listing.about}</div> : null}
              {r.listing.offer ? <div style={{ fontSize: 13, fontWeight: 700 }}>{r.listing.offer}</div> : null}
              {r.listing.website ? <div className="muted" style={{ fontSize: 13 }}>{r.listing.website}</div> : null}
              <div className="small muted">To change it, reply to your receipt email.</div>
            </div>
          ) : null}
        </NextStep>
        {r.agreement ? (
          <NextStep
            n={++n}
            title={`Your ${word} agreement`}
            sub={`Signed ${fmtWhen(r.agreement.signedAt)}`}
            action={
              <a className="btn btn-sm" style={outline} href={`/agreement/${encodeURIComponent(r.agreement.code)}/pdf?download=1`} target="_blank" rel="noreferrer">
                Download
              </a>
            }
          />
        ) : null}
      </main>
    </Frame>
  );
}

/* ---------- Pay link: /r/:slug/sponsor/pay?v= ---------- */

export function VendorPayScreen({ slug, kind }: { slug: string; kind: Kind }) {
  const params = new URLSearchParams(useSearch());
  const v = params.get("v") ?? "";
  const sessionId = params.get("session_id") ?? undefined;
  const wantsChange = params.get("change") === "1";
  const page = trpc.registration.vendorCheckout.page.useQuery({ slug, kind }, { staleTime: 60_000 });
  const info = trpc.registration.vendorCheckout.payInfo.useQuery({ slug, v, sessionId }, { enabled: v.length >= 10, retry: 1 });
  const payBalance = trpc.registration.vendorCheckout.payBalance.useMutation();
  const changeMethod = trpc.registration.vendorCheckout.changeMethod.useMutation();
  const [secret, setSecret] = useState<string | null>(null);
  const [mode, setMode] = useState<"pay" | "change" | null>(null);
  const auto = useRef(false);
  const begin = async (m: "pay" | "change") => {
    setMode(m);
    setSecret(null);
    try {
      const r = m === "pay" ? await payBalance.mutateAsync({ slug, v }) : await changeMethod.mutateAsync({ slug, v });
      setSecret(r.clientSecret);
    } catch (err) {
      toast(errorText(err), true);
      setMode(null);
    }
  };
  useEffect(() => {
    if (auto.current || !info.data || sessionId) return;
    if (wantsChange && info.data.canChange) {
      auto.current = true;
      void begin("change");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.data]);
  if (page.isLoading || info.isLoading) return <PageLoading />;
  if (page.error) return <div className="app"><ErrorNote error={page.error} /></div>;
  const ev = page.data!.event;
  const pay = page.data!.payments;
  if (!v || info.error) return <Frame ev={ev}><main className="app-body"><ErrorNote error={info.error ?? { message: "That payment link was not found." }} /></main></Frame>;
  const d = info.data!;
  const row = (l: string, val: string, bold = false, i = 1) => (
    <div className="row-between" style={{ padding: "11px 14px", fontSize: 14, borderTop: i ? "1px solid var(--line-2)" : "none", fontWeight: bold ? 800 : 400 }}>
      <span>{l}</span>
      <span>{val}</span>
    </div>
  );
  return (
    <Frame ev={ev}>
      <Header ev={ev} />
      <main className="app-body" style={{ paddingTop: 40 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, lineHeight: 1.25 }}>{d.company}</h1>
        <div className="muted" style={{ fontSize: 13, fontWeight: 600 }}>
          {ev.name} · {fmtDates(ev.startDate, ev.endDate)}
        </div>
        {sessionId ? <div className="banner banner-ok">{d.justPaid ? "Thank you. We have your payment." : "Your payment method is saved."}</div> : null}
        <div className="card" style={{ overflow: "hidden" }}>
          {row(d.what, fmtMoney(d.amountCents, "$0.00"), true, 0)}
          {d.payments.map((p) => row(`${p.pending ? "Paying" : "Paid"} ${fmtDate(p.paidOn)}`, fmtMoney(p.amountCents, "$0.00")))}
          {d.nextChargeCents > 0 && d.nextChargeOn ? row(`Charged ${fmtDate(d.nextChargeOn)}${d.payMethodLabel ? ` · ${d.payMethodLabel}` : ""}`, fmtMoney(d.nextChargeCents, "$0.00")) : null}
          {row(d.owedCents > 0 ? "Owed" : "Nothing owed", fmtMoney(d.owedCents, "$0.00"), true)}
        </div>
        {secret && pay.publishableKey && pay.accountId ? (
          <div style={{ borderRadius: 12, overflow: "hidden", background: "#FFFFFF", border: "1px solid var(--line)" }}>
            <EmbeddedCheckoutProvider key={secret} stripe={stripeFor(pay.publishableKey, pay.accountId)} options={{ clientSecret: secret }}>
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          </div>
        ) : mode ? (
          <div className="center" style={{ padding: 24 }}>
            <Spinner />
          </div>
        ) : d.owedCents > 0 ? (
          <div className="col gap-8">
            {!pay.ready ? <div className="banner banner-warn">This page is not taking payments yet. Please try again later.</div> : null}
            <button className="btn btn-primary btn-lg btn-block" disabled={!pay.ready} onClick={() => begin("pay")}>
              {d.nextChargeCents > 0 ? "Pay now instead" : `Pay ${fmtMoney(d.owedCents, "$0.00")}`}
            </button>
            {d.canChange ? (
              <button className="btn btn-lg btn-block" style={outline} disabled={!pay.ready} onClick={() => begin("change")}>
                Change payment method
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="muted" style={{ fontSize: 12, textAlign: "center" }}>Payments go to {pay.businessName || ev.orgName} through Stripe.</div>
      </main>
    </Frame>
  );
}
