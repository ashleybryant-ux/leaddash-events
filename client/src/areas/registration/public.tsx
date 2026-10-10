/**
 * Public registration pages: the event landing page (/r/:slug), Register,
 * Pay (Stripe embedded checkout on the association's own account), the
 * confirmation page, the website embed (/embed/:slug) and Get the app (/get/:slug).
 * Branded with the event's colors; no sign-in needed.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { trpc } from "../../lib/trpc";
import { brandStyle } from "../../shells/AttendeeShell";
import { ErrorNote, PageLoading, QR, Spinner } from "../../ui/components";
import { IconCheck, IconLeaf, IconLock } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { isIOS, isStandalone } from "../../lib/push";
import { fmtDate, fmtDates, fmtMoney } from "@shared/format";
import { IconShare, StepNumber, clearDraft, emptyBuyer, loadDraft, saveDraft, stripeFor, useEmbedHeight, type Buyer, type Draft, type Offer, type PublicPage, type Question } from "./shared";

/* ---------- Frame ---------- */

function useTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}

function PublicFrame({ data, children, embed = false }: { data: PublicPage; children: ReactNode; embed?: boolean }) {
  useTitle(data.event.shortName);
  const style: CSSProperties = { ...brandStyle(data.event.branding), ...(embed ? { minHeight: 0, maxWidth: "none", border: "none", background: "transparent" } : {}) };
  return (
    <div className="app" style={style}>
      {children}
    </div>
  );
}

function usePage(slug: string) {
  return trpc.registration.page.useQuery({ slug }, { staleTime: 30_000 });
}

function Steps({ on }: { on: number }) {
  return (
    <div className="steps" style={{ padding: "12px 16px 0" }}>
      {["Ticket", "Details", "Payment"].map((label, i) => (
        <div key={label} className={i < on ? "on" : ""}>
          <div className="bar" />
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

const ticketNote = (t: Offer) => (t.soldOut ? "Sold out" : t.saleEndsOn ? `Ends ${fmtDate(t.saleEndsOn)}` : t.description || t.includes);

/* ---------- /r/:slug ---------- */

export function EventLandingScreen({ slug }: { slug: string }) {
  const q = usePage(slug);
  const [, navigate] = useLocation();
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <div className="app"><ErrorNote error={q.error} /></div>;
  const d = q.data!;
  const ev = d.event;
  const where = [ev.venueName, ev.city].filter(Boolean).join(", ");
  const open = !d.closed && d.tickets.some((t) => !t.soldOut);
  return (
    <PublicFrame data={d}>
      <div role="img" aria-label="Cover image" className="cover" style={{ flexShrink: 0, ...(d.page.coverUrl ? { backgroundImage: `url(${d.page.coverUrl})` } : {}) }}>
        {ev.logoUrl ? (
          <div style={{ position: "absolute", left: 16, bottom: -22, width: 52, height: 52, borderRadius: 12, background: "#FFFFFF", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", padding: 4 }}>
            <img src={ev.logoUrl} alt={`${ev.orgName} logo`} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          </div>
        ) : null}
      </div>
      <main className="app-body" style={{ paddingTop: 32, gap: 10 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, lineHeight: 1.2 }}>{d.page.headline}</h1>
        <div className="muted" style={{ fontSize: 13, fontWeight: 600 }}>
          {fmtDates(ev.startDate, ev.endDate)}
          {where ? ` · ${where}` : ""}
        </div>
        {d.page.description ? <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)", whiteSpace: "pre-line" }}>{d.page.description}</div> : null}
        <div className="section-title" style={{ paddingTop: 6 }}>Tickets</div>
        {d.page.payOverTime && (d.payments.klarna || d.payments.afterpay) && !d.closed && d.tickets.some((t) => t.priceCents >= 100) ? (
          <div className="small muted">Pay in full, or over time with {[d.payments.klarna ? "Klarna" : "", d.payments.afterpay ? "Afterpay" : ""].filter(Boolean).join(" or ")}.</div>
        ) : null}
        {d.closed ? (
          <div className="banner banner-warn">Registration is closed.</div>
        ) : !d.tickets.length ? (
          <div className="banner banner-warn">Tickets are not on sale yet.</div>
        ) : (
          <div className="col gap-8">
            {d.tickets.map((t) => (
              <div key={t.id} className="option" style={{ cursor: "default", justifyContent: "space-between", opacity: t.soldOut ? 0.6 : 1 }}>
                <span className="col" style={{ gap: 2 }}>
                  <span style={{ fontSize: 14, fontWeight: 800 }}>{t.name}</span>
                  {t.saleEndsOn || t.soldOut || t.membersOnly ? (
                    <span className="small strong" style={{ color: t.soldOut ? "var(--bad-ink)" : "var(--warn-ink)" }}>
                      {[t.membersOnly ? "Members only" : "", t.soldOut ? "Sold out" : t.saleEndsOn ? `Ends ${fmtDate(t.saleEndsOn)}` : ""].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </span>
                <span style={{ fontSize: 14, fontWeight: 800 }}>{fmtMoney(t.priceCents)}</span>
              </div>
            ))}
          </div>
        )}
      </main>
      {open ? (
        <div className="app-footer">
          <button className="btn btn-primary btn-lg btn-block" onClick={() => navigate(`/r/${slug}/register`)}>
            {d.page.buttonLabel}
          </button>
        </div>
      ) : null}
    </PublicFrame>
  );
}

/* ---------- Ticket and details (Register step and the embed) ---------- */

function TicketChoice({ tickets, value, onChange }: { tickets: Offer[]; value: number | null; onChange: (id: number) => void }) {
  return (
    <fieldset style={{ margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 8 }}>
      <legend style={{ padding: "0 0 8px", fontSize: 14, fontWeight: 800 }}>Your ticket</legend>
      {tickets.map((t) => (
        <label key={t.id} className={`option${value === t.id ? " selected" : ""}`} style={t.soldOut ? { opacity: 0.6, cursor: "default" } : undefined}>
          <input type="radio" name="ticket" checked={value === t.id} disabled={t.soldOut} onChange={() => onChange(t.id)} />
          <span className="grow col" style={{ gap: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 800 }}>{t.name}</span>
            <span className="small muted">{[t.membersOnly ? "Members only" : "", ticketNote(t)].filter(Boolean).join(" · ")}</span>
          </span>
          <span style={{ fontSize: 14, fontWeight: 800 }}>{fmtMoney(t.priceCents)}</span>
        </label>
      ))}
    </fieldset>
  );
}

function DetailsFields({ questions, buyer, set }: { questions: Question[]; buyer: Buyer; set: (b: Buyer) => void }) {
  const field = (k: keyof Buyer) => (e: { target: { value: string } }) => set({ ...buyer, [k]: e.target.value });
  const answer = (key: string) => (e: { target: { value: string } }) => set({ ...buyer, answers: { ...buyer.answers, [key]: e.target.value } });
  const req = (q: Question) => (q.required ? "" : " (optional)");
  const askMobile = questions.find((q) => q.key === "mobile");
  return (
    <>
      <div className="grid-2">
        <label className="field">
          First name
          <input className="input" autoComplete="given-name" value={buyer.firstName} onChange={field("firstName")} />
        </label>
        <label className="field">
          Last name
          <input className="input" autoComplete="family-name" value={buyer.lastName} onChange={field("lastName")} />
        </label>
        <label className="field span-2">
          Email
          <input className="input" type="email" autoComplete="email" inputMode="email" value={buyer.email} onChange={field("email")} />
        </label>
        {questions.map((q) => {
          if (q.locked || q.key === "name_email") return null;
          if (q.key === "mobile")
            return (
              <label key={q.key} className="field">
                Mobile{req(q)}
                <input className="input" type="tel" autoComplete="tel" inputMode="tel" value={buyer.phone} onChange={field("phone")} />
              </label>
            );
          if (q.key === "credentials")
            return (
              <label key={q.key} className="field">
                Credentials{req(q)}
                <input className="input" value={buyer.credentials} onChange={field("credentials")} placeholder="LPC, NCC" />
              </label>
            );
          if (q.kind === "license")
            return (
              <div key={q.key} className="span-2 grid-2">
                <label className="field">
                  License number{req(q)}
                  <input className="input" value={buyer.licenseNumber} onChange={field("licenseNumber")} />
                </label>
                <label className="field">
                  License state{req(q)}
                  <input className="input" maxLength={30} value={buyer.licenseState} onChange={field("licenseState")} placeholder="OK" />
                </label>
              </div>
            );
          if (q.kind === "select")
            return (
              <label key={q.key} className="field span-2">
                {q.label}
                {req(q)}
                <select className="select" value={buyer.answers[q.key] ?? ""} onChange={answer(q.key)}>
                  <option value="">Choose one</option>
                  {(q.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            );
          if (q.kind === "textarea")
            return (
              <label key={q.key} className="field span-2">
                {q.label}
                {req(q)}
                <textarea className="textarea" rows={2} value={buyer.answers[q.key] ?? ""} onChange={answer(q.key)} />
              </label>
            );
          return (
            <label key={q.key} className="field span-2">
              {q.label}
              {req(q)}
              <input className="input" type={q.kind === "phone" ? "tel" : "text"} value={buyer.answers[q.key] ?? ""} onChange={answer(q.key)} />
            </label>
          );
        })}
      </div>
      {askMobile ? (
        <label className="check" style={{ alignItems: "flex-start", fontSize: 12, lineHeight: 1.45, color: "var(--ink-2)" }}>
          <input type="checkbox" checked={buyer.textConsent} onChange={(e) => set({ ...buyer, textConsent: e.target.checked })} />
          Text me the app link and event updates. Reply STOP to opt out.
        </label>
      ) : null}
    </>
  );
}

/** The ticket and details form, and what happens on Continue (free: register now; paid: go to payment). */
function useRegisterForm(slug: string, data: PublicPage | undefined, embed: boolean) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const saved = loadDraft(slug);
  const wanted = Number(new URLSearchParams(search).get("ticket")) || null;
  const [ticketId, setTicketId] = useState<number | null>(saved?.ticketId ?? wanted);
  const [buyer, setBuyer] = useState<Buyer>(saved?.buyer ?? emptyBuyer());
  const [error, setError] = useState("");
  const check = trpc.registration.check.useMutation();
  const start = trpc.registration.start.useMutation();
  const available = (data?.tickets ?? []).filter((t) => !t.soldOut);
  const chosen = data?.tickets.find((t) => t.id === ticketId && !t.soldOut) ?? (available.length === 1 ? available[0] : undefined);
  const free = chosen ? chosen.priceCents === 0 : false;

  async function submit(onPaid: (d: Draft) => void) {
    setError("");
    if (!chosen) return setError("Pick a ticket.");
    const draft: Draft = { ticketId: chosen.id, buyer: { ...buyer, email: buyer.email.trim() }, coupon: saved?.coupon };
    try {
      if (free) {
        const res = await start.mutateAsync({ slug, ticketId: chosen.id, buyer: draft.buyer, embed });
        if (res.kind === "free") {
          clearDraft(slug);
          navigate(res.doneUrl);
        }
        return;
      }
      await check.mutateAsync({ slug, ticketId: chosen.id, buyer: draft.buyer });
      saveDraft(slug, draft);
      onPaid(draft);
    } catch (err) {
      setError(errorText(err));
    }
  }
  return { ticketId: chosen?.id ?? null, setTicketId, buyer, setBuyer, chosen, free, error, busy: check.isPending || start.isPending, submit };
}

/* ---------- /r/:slug/register ---------- */

export function RegisterScreen({ slug }: { slug: string }) {
  const q = usePage(slug);
  const [, navigate] = useLocation();
  const f = useRegisterForm(slug, q.data, false);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <div className="app"><ErrorNote error={q.error} /></div>;
  const d = q.data!;
  if (d.closed || !d.tickets.length) {
    return (
      <PublicFrame data={d}>
        <main className="app-body">
          <div className="banner banner-warn">{d.closed ? "Registration is closed." : "Tickets are not on sale yet."}</div>
        </main>
      </PublicFrame>
    );
  }
  return (
    <PublicFrame data={d}>
      <Steps on={2} />
      <main className="app-body" style={{ paddingTop: 14 }}>
        <TicketChoice tickets={d.tickets} value={f.ticketId} onChange={f.setTicketId} />
        <div style={{ fontSize: 14, fontWeight: 800, paddingTop: 4 }}>Your details</div>
        <DetailsFields questions={d.page.questions} buyer={f.buyer} set={f.setBuyer} />
      </main>
      <div className="app-footer">
        {f.error ? <div className="err" role="alert">{f.error}</div> : null}
        <div className="row-between" style={{ fontSize: 15, fontWeight: 800 }}>
          <span>Total</span>
          <span>{f.chosen ? fmtMoney(f.chosen.priceCents) : ""}</span>
        </div>
        <button className="btn btn-primary btn-lg btn-block" disabled={f.busy} onClick={() => f.submit(() => navigate(`/r/${slug}/pay`))}>
          {f.free ? "Register" : "Continue to payment"}
        </button>
      </div>
    </PublicFrame>
  );
}

/* ---------- Payment (the Pay page and the embed) ---------- */

function PaymentStep({ slug, data, draft, embed, footer }: { slug: string; data: PublicPage; draft: Draft; embed: boolean; footer: (content: ReactNode) => ReactNode }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [couponInput, setCouponInput] = useState(draft.coupon ?? "");
  const [coupon, setCoupon] = useState(draft.coupon ?? "");
  const [couponError, setCouponError] = useState("");
  const [applying, setApplying] = useState(false);
  const quote = trpc.registration.quote.useQuery({ slug, ticketId: draft.ticketId, coupon: coupon || undefined }, { retry: false });
  const start = trpc.registration.start.useMutation();
  const [secret, setSecret] = useState<string | null>(null);
  const [startError, setStartError] = useState("");
  const startedFor = useRef("");
  const pay = data.payments;
  const amount = quote.data?.amountCents ?? null;

  // Paid totals: create the Stripe Checkout Session (again when the coupon changes).
  useEffect(() => {
    if (amount === null || amount <= 0 || !pay.ready) return;
    const key = `${draft.ticketId}:${coupon}`;
    if (startedFor.current === key) return;
    startedFor.current = key;
    setSecret(null);
    setStartError("");
    start
      .mutateAsync({ slug, ticketId: draft.ticketId, buyer: draft.buyer, coupon: coupon || undefined, embed })
      .then((res) => {
        if (res.kind === "paid") setSecret(res.clientSecret);
        else navigate(res.doneUrl);
      })
      .catch((err) => setStartError(errorText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, coupon, pay.ready]);

  async function apply() {
    const code = couponInput.trim();
    setCouponError("");
    if (!code) {
      setCoupon("");
      saveDraft(slug, { ...draft, coupon: undefined });
      return;
    }
    setApplying(true);
    try {
      await utils.registration.quote.fetch({ slug, ticketId: draft.ticketId, coupon: code });
      setCoupon(code);
      saveDraft(slug, { ...draft, coupon: code });
    } catch (err) {
      setCouponError(errorText(err));
    } finally {
      setApplying(false);
    }
  }

  async function registerFree() {
    try {
      const res = await start.mutateAsync({ slug, ticketId: draft.ticketId, buyer: draft.buyer, coupon: coupon || undefined, embed });
      clearDraft(slug);
      if (res.kind === "free") navigate(res.doneUrl);
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  if (quote.error) {
    return (
      <div className="col gap-12">
        <div className="err" role="alert">{errorText(quote.error)}</div>
        <button className="btn btn-block" onClick={() => navigate(`/r/${slug}/register`)}>
          Back to details
        </button>
      </div>
    );
  }
  const q = quote.data;
  return (
    <>
      <div className="card" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, fontSize: 14, borderRadius: 12 }}>
        <div className="row-between">
          <span className="strong">{q?.ticketName ?? "Ticket"}</span>
          <span>{q ? fmtMoney(q.subtotalCents) : ""}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 84px", gap: 8 }}>
          <input className="input" aria-label="Coupon code" placeholder="Coupon code" value={couponInput} onChange={(e) => setCouponInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} style={{ height: 36, borderRadius: 8 }} />
          <button className="btn btn-sm" style={{ height: 36 }} disabled={applying} onClick={apply}>
            Apply
          </button>
        </div>
        {couponError ? <div className="err">{couponError}</div> : null}
        {q && q.discountCents > 0 ? (
          <div className="row-between muted">
            <span>Coupon {q.couponCode}</span>
            <span>-{fmtMoney(q.discountCents)}</span>
          </div>
        ) : null}
        <div className="row-between" style={{ borderTop: "1px solid var(--line-2)", paddingTop: 8, fontWeight: 800 }}>
          <span>Total</span>
          <span>{q ? fmtMoney(q.amountCents) : ""}</span>
        </div>
      </div>
      {!q ? (
        <div className="center" style={{ padding: 24 }}>
          <Spinner />
        </div>
      ) : q.amountCents === 0 ? (
        footer(
          <button className="btn btn-primary btn-lg btn-block" disabled={start.isPending} onClick={registerFree}>
            Register
          </button>
        )
      ) : !pay.ready ? (
        <div className="banner banner-warn">This event is not taking payments yet. Please try again later.</div>
      ) : startError ? (
        <div className="col gap-8">
          <div className="err" role="alert">{startError}</div>
          <button className="btn btn-block" onClick={() => navigate(`/r/${slug}/register`)}>
            Back to details
          </button>
        </div>
      ) : secret && pay.publishableKey && pay.accountId ? (
        <div style={{ borderRadius: 12, overflow: "hidden", background: "#FFFFFF", border: "1px solid var(--line)" }}>
          <EmbeddedCheckoutProvider key={secret} stripe={stripeFor(pay.publishableKey, pay.accountId)} options={{ clientSecret: secret }}>
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        </div>
      ) : (
        <div className="center" style={{ padding: 24 }}>
          <Spinner />
        </div>
      )}
      <div className="row gap-6 small muted">
        <IconLock />
        Payment processed by Stripe for {pay.businessName || data.event.orgName}
      </div>
      {pay.refundPolicy ? <div className="small muted">Refunds: {pay.refundPolicy}</div> : null}
    </>
  );
}

/* ---------- /r/:slug/pay ---------- */

export function PayScreen({ slug }: { slug: string }) {
  const q = usePage(slug);
  const [, navigate] = useLocation();
  const draft = loadDraft(slug);
  useEffect(() => {
    if (!draft) navigate(`/r/${slug}/register`, { replace: true });
  }, [draft, slug, navigate]);
  if (q.isLoading || !draft) return <PageLoading />;
  if (q.error) return <div className="app"><ErrorNote error={q.error} /></div>;
  return (
    <PublicFrame data={q.data!}>
      <Steps on={3} />
      <main className="app-body" style={{ paddingTop: 14 }}>
        <PaymentStep slug={slug} data={q.data!} draft={draft} embed={false} footer={(c) => c} />
      </main>
    </PublicFrame>
  );
}

/* ---------- /r/:slug/done ---------- */

export function DoneScreen({ slug }: { slug: string }) {
  const params = new URLSearchParams(useSearch());
  const sessionId = params.get("session_id") ?? undefined;
  const order = params.get("order") ?? undefined;
  const embed = params.get("embed") === "1";
  const page = usePage(slug);
  const done = trpc.registration.done.useQuery(
    { slug, sessionId, order },
    { enabled: !!(sessionId || order), retry: 1, refetchInterval: (query) => (query.state.data?.status === "processing" && query.state.dataUpdateCount < 40 ? 3000 : false) }
  );
  useEmbedHeight(embed);
  useEffect(() => {
    if (done.data?.status === "registered") clearDraft(slug);
  }, [done.data?.status, slug]);
  if (page.isLoading || done.isLoading) return <PageLoading />;
  if (page.error) return <div className="app"><ErrorNote error={page.error} /></div>;
  const d = page.data!;
  if (!sessionId && !order) return <PublicFrame data={d} embed={embed}><main className="app-body"><ErrorNote error={{ message: "That registration was not found." }} /></main></PublicFrame>;
  if (done.error) return <PublicFrame data={d} embed={embed}><main className="app-body"><ErrorNote error={done.error} /></main></PublicFrame>;
  const r = done.data!;
  const target = embed ? "_blank" : undefined;

  if (r.status === "processing") {
    return (
      <PublicFrame data={d} embed={embed}>
        <main className="app-body center col" style={{ padding: 32, textAlign: "center" }}>
          <Spinner />
          <div className="h3">Confirming your payment</div>
          <div className="muted">This takes a few seconds. We will email {r.email} when it is done.</div>
        </main>
      </PublicFrame>
    );
  }
  if (r.status !== "registered") {
    return (
      <PublicFrame data={d} embed={embed}>
        <main className="app-body" style={{ padding: "24px 18px" }}>
          <h1 className="h2">{r.status === "refunded" ? "This registration was refunded" : "Your payment did not go through"}</h1>
          <div className="muted">{r.status === "refunded" ? "Contact the event team if you have questions." : "You were not charged. Try again with another card."}</div>
          {r.status !== "refunded" ? (
            <a className="btn btn-primary btn-lg btn-block" href={embed ? `/embed/${slug}` : `/r/${slug}/register`}>
              Try again
            </a>
          ) : null}
        </main>
      </PublicFrame>
    );
  }
  return (
    <PublicFrame data={d} embed={embed}>
      <main className="app-body" style={{ padding: "24px 18px", gap: 14 }}>
        <div style={{ width: 60, height: 60, borderRadius: 30, background: "var(--brand-tint)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <IconCheck size={30} />
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>You're registered{r.firstName ? `, ${r.firstName}` : ""}</h1>
        <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)" }}>
          {r.sendWelcome ? `We sent your ${r.paid ? "receipt and " : ""}welcome email to ${r.email}.` : `Your registration for ${d.event.shortName} is confirmed for ${r.email}.`}
        </div>
        {r.showConfirmation ? (
          <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={{ fontSize: 15, fontWeight: 800 }}>Get the conference app</span>
            <span className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>Your agenda, badge, and CE certificates live in the app.</span>
            <a className="btn btn-primary btn-block" style={{ height: 46, fontSize: 15 }} href={`/get/${slug}`} target={target}>
              Install the app
            </a>
            <div className="col gap-8" style={{ fontSize: 13 }}>
              <span className="strong">On iPhone</span>
              <div className="row"><StepNumber n={1} />Open this page in Safari</div>
              <div className="row"><StepNumber n={2} />Tap Share, then Add to Home Screen</div>
              <div className="row"><StepNumber n={3} />Open the app and sign in with your email</div>
            </div>
          </div>
        ) : null}
        <a className="btn btn-block" style={{ height: 46, fontSize: 15, borderRadius: 12 }} href={`/r/${slug}/calendar.ics`}>
          Add to calendar
        </a>
      </main>
    </PublicFrame>
  );
}

/* ---------- /embed/:slug ---------- */

export function EmbedScreen({ slug }: { slug: string }) {
  const q = usePage(slug);
  const f = useRegisterForm(slug, q.data, true);
  const [paying, setPaying] = useState<Draft | null>(null);
  useEmbedHeight(true);
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);
  if (q.isLoading) return <div className="center" style={{ padding: 40 }}><Spinner /></div>;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data!;
  const box: CSSProperties = { border: "1px solid var(--line)", borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 12, background: "#FFFFFF" };
  return (
    <PublicFrame data={d} embed>
      <div style={{ padding: 2 }}>
        <div style={box}>
          <span style={{ fontSize: 18, fontWeight: 800 }}>Register for {d.event.shortName}</span>
          <span className="muted" style={{ fontSize: 13 }}>{fmtDates(d.event.startDate, d.event.endDate)}</span>
          {d.closed || !d.tickets.length ? (
            <div className="banner banner-warn">{d.closed ? "Registration is closed." : "Tickets are not on sale yet."}</div>
          ) : paying ? (
            <>
              <PaymentStep slug={slug} data={d} draft={paying} embed footer={(c) => c} />
              <button className="btn btn-ghost btn-sm" onClick={() => setPaying(null)}>
                Back to details
              </button>
            </>
          ) : (
            <>
              <TicketChoice tickets={d.tickets} value={f.ticketId} onChange={f.setTicketId} />
              <DetailsFields questions={d.page.questions} buyer={f.buyer} set={f.setBuyer} />
              {f.error ? <div className="err" role="alert">{f.error}</div> : null}
              <button className="btn btn-primary btn-lg btn-block" disabled={f.busy} onClick={() => f.submit((draft) => setPaying(draft))}>
                {f.free ? "Register" : "Continue to payment"}
              </button>
              {!f.free ? (
                <span className="muted" style={{ fontSize: 11, textAlign: "center" }}>
                  Payment processed by Stripe for {d.payments.businessName || d.event.orgName}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </PublicFrame>
  );
}

/* ---------- /get/:slug ---------- */

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let deferredPrompt: InstallPrompt | null = null;
const promptListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Only the Get the app page holds the prompt for its own button; elsewhere the browser shows its usual install hint.
    if (!window.location.pathname.startsWith("/get/")) return;
    e.preventDefault();
    deferredPrompt = e as InstallPrompt;
    promptListeners.forEach((f) => f());
  });
}

function useInstallPrompt() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    promptListeners.add(f);
    return () => {
      promptListeners.delete(f);
    };
  }, []);
  return deferredPrompt;
}

/** Points the browser at the event app's install manifest, as the attendee app does. */
function useManifest(slug: string, color: string) {
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "manifest";
      document.head.appendChild(link);
    }
    link.href = `/e/${slug}/manifest.webmanifest`;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  }, [slug, color]);
}

export function GetAppScreen({ slug }: { slug: string }) {
  const q = trpc.core.events.publicBySlug.useQuery({ slug });
  const prompt = useInstallPrompt();
  const [, navigate] = useLocation();
  useManifest(slug, q.data?.branding.colorPrimary ?? "#1F5F4A");
  useTitle(q.data ? `Get the ${q.data.shortName} app` : undefined);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <div className="app"><ErrorNote error={q.error} /></div>;
  const ev = q.data!;
  const ios = isIOS();
  const appHref = `/e/${slug}`;

  async function install() {
    if (isStandalone()) return navigate(appHref);
    if (prompt) {
      await prompt.prompt();
      const choice = await prompt.userChoice.catch(() => ({ outcome: "dismissed" as const }));
      deferredPrompt = null;
      if (choice.outcome === "accepted") toast("The app is on your home screen.");
      return;
    }
    if (ios) {
      toast("On iPhone, follow the steps below.");
      document.getElementById("iphone-steps")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    // No install prompt from this browser: open the app, where the browser menu offers Install.
    navigate(appHref);
  }

  return (
    <div className="app" style={brandStyle(ev.branding)}>
      <div style={{ background: "var(--brand)", color: "#FFFFFF", padding: "calc(28px + env(safe-area-inset-top)) 24px 26px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
        <div style={{ width: 76, height: 76, borderRadius: 20, background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", padding: ev.logoUrl ? 8 : 0 }}>
          {ev.logoUrl ? <img src={ev.logoUrl} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /> : <img src="/icon-192.png" alt="" style={{ width: "100%", height: "100%" }} />}
        </div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, lineHeight: 1.25 }}>Get the {ev.name} app</h1>
        <div style={{ fontSize: 14, color: "var(--side-text)" }}>{fmtDates(ev.startDate, ev.endDate)}</div>
      </div>
      <main className="app-body" style={{ padding: "20px 18px 0", gap: 14 }}>
        <button className="btn btn-primary btn-block" style={{ height: 54, borderRadius: 14, fontSize: 17 }} onClick={install}>
          Install the app
        </button>
        <div className="small muted" style={{ textAlign: "center" }}>
          {ios ? "On iPhone, add the app from Safari with the steps below." : "On Android, this adds the app to your home screen in one tap."}
        </div>
        <div id="iphone-steps" className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>On iPhone</div>
          <div className="row gap-12" style={{ fontSize: 14 }}>
            <StepNumber n={1} size={28} />
            <span className="grow">Tap the Share button in Safari</span>
            <span style={{ color: "var(--brand)" }}><IconShare /></span>
          </div>
          <div className="row gap-12" style={{ fontSize: 14 }}>
            <StepNumber n={2} size={28} />
            <span>Tap Add to Home Screen</span>
          </div>
          <div className="row gap-12" style={{ fontSize: 14 }}>
            <StepNumber n={3} size={28} />
            <span>Leave Open as Web App on, then tap Add</span>
          </div>
        </div>
        <a className="btn btn-block" style={{ height: 46, borderRadius: 12 }} href={appHref}>
          Open the app
        </a>
        <div className="card" style={{ padding: 14, display: "flex", gap: 14, alignItems: "center" }}>
          <QR value={typeof window !== "undefined" ? window.location.href : `/get/${slug}`} size={84} label="QR code to open this page on your phone" />
          <div className="col" style={{ gap: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 800 }}>On a computer?</span>
            <span className="muted" style={{ fontSize: 13, lineHeight: 1.45 }}>Scan this with your phone's camera to open this page there.</span>
          </div>
        </div>
        <div className="row small muted strong" style={{ marginTop: "auto", padding: "8px 0 16px", justifyContent: "center", gap: 6 }}>
          <IconLeaf size={16} />
          Powered by LeadDash Events
        </div>
      </main>
    </div>
  );
}
