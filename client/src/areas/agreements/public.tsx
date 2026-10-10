/**
 * Public agreement pages, branded with the event's look (no sign-in; the code
 * in the link is the secret): /sign/:code to sign from the emailed link, and
 * /agreement/:code, the signed copy with Download PDF.
 */
import { useEffect, useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { brandStyle } from "../../shells/AttendeeShell";
import { ErrorNote, PageLoading } from "../../ui/components";
import { IconCheck } from "../../ui/icons";
import { SignAgreement, loadSignatureFont } from "./SignAgreement";
import "./agreements.css";

type Pub = RouterOutputs["agreements"]["public"]["get"];

const KIND_WORD = { sponsor: "sponsor", exhibitor: "exhibitor", speaker: "speaker" } as const;

function useTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}

function LogoTile({ ev }: { ev: Pub["event"] }) {
  return (
    <div className="agr-logo">
      {ev.logoUrl ? (
        <img src={ev.logoUrl} alt={`${ev.orgName} logo`} />
      ) : (
        <i aria-hidden="true">
          <b />
        </i>
      )}
    </div>
  );
}

/** /sign/:code */
export function SignScreen({ code }: { code: string }) {
  const q = trpc.agreements.public.get.useQuery({ code }, { retry: false });
  const [done, setDone] = useState(false);
  useTitle(q.data ? `Sign your ${KIND_WORD[q.data.kind]} agreement` : undefined);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <div className="app"><div className="agr-pad"><ErrorNote error={q.error} /></div></div>;
  const d = q.data!;
  const ev = d.event;
  const speaker = d.kind === "speaker";
  const signed = done || d.status === "signed";
  return (
    <div className="app" style={brandStyle(ev.branding, ev.coverUrl)}>
      <div className={`agr-hero${speaker ? " tall" : ""}`} />
      <LogoTile ev={ev} />
      {signed ? (
        <main className="agr-pad">
          <div className="tile-icon" style={{ width: 48, height: 48, borderRadius: 24 }}>
            <IconCheck />
          </div>
          <h1>Thank you for signing</h1>
          <div className="agr-meta">
            Your {KIND_WORD[d.kind]} agreement for {ev.name} is signed. We emailed you a copy.
          </div>
          <a className="btn btn-primary btn-lg btn-block" href={`/agreement/${encodeURIComponent(code)}`}>
            View signed copy
          </a>
        </main>
      ) : (
        <SignAgreement
          code={code}
          html={d.html}
          kind={d.kind}
          askRecording={d.askRecording}
          prefill={d.prefill}
          short
          submitLabel="Sign agreement"
          onSigned={async () => {
            setDone(true);
            window.scrollTo({ top: 0 });
            await q.refetch();
          }}
        >
          <h1>Sign your {KIND_WORD[d.kind]} agreement</h1>
          {d.session ? (
            <div className="agr-sum">
              <div>
                <span>Session</span>
                <b>{d.session.title}</b>
              </div>
              <div>
                <span>When</span>
                <span>{d.session.when}</span>
              </div>
              {d.session.room ? (
                <div>
                  <span>Room</span>
                  <span>{d.session.room}</span>
                </div>
              ) : null}
            </div>
          ) : d.summary ? (
            <div className="agr-meta">{d.summary}</div>
          ) : (
            <div className="agr-meta">{ev.name}</div>
          )}
        </SignAgreement>
      )}
    </div>
  );
}

/** /agreement/:code: the signed copy, laid out like the PDF. */
export function SignedCopyScreen({ code }: { code: string }) {
  const q = trpc.agreements.public.copy.useQuery({ code }, { retry: false });
  useEffect(loadSignatureFont, []);
  useTitle(q.data ? `${q.data.title} - ${q.data.event.shortName}` : undefined);
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <div className="app"><div className="agr-pad"><ErrorNote error={q.error} /></div></div>;
  const d = q.data!;
  const ev = d.event;
  return (
    <div className="agr-copy-wrap" style={brandStyle(ev.branding)}>
      <div className="agr-copy-bar">
        {d.status !== "signed" ? (
          <a className="btn" href={`/sign/${encodeURIComponent(code)}`}>
            Sign now
          </a>
        ) : null}
        <a className="btn btn-primary" href={`/agreement/${encodeURIComponent(code)}/pdf?download=1`}>
          Download PDF
        </a>
      </div>
      <article className="agr-copy" aria-label={d.title}>
        <header className="agr-copy-head">
          {ev.logoUrl ? (
            <span className="mark img">
              <img src={ev.logoUrl} alt={`${ev.orgName} logo`} />
            </span>
          ) : (
            <span className="mark" aria-hidden="true">
              <b />
            </span>
          )}
          <span className="who">
            <b>{ev.name}</b>
            <br />
            {ev.orgName}
          </span>
        </header>
        <div className="agr-doc" dangerouslySetInnerHTML={{ __html: d.html }} />
        <div className="agr-sigs">
          {d.signatures.map((s, i) => (
            <div key={i}>
              <div className="line">{s.pngUrl ? <img src={s.pngUrl} alt={`Signature of ${s.name}`} /> : s.name}</div>
              <div className="meta">
                <b>{s.name || "Not signed yet"}</b>
                {s.title ? `, ${s.title}` : ""}
                <br />
                {s.company}
                {s.company ? <br /> : null}
                {s.when}
              </div>
            </div>
          ))}
        </div>
        <div className="agr-foot">{d.footer}</div>
      </article>
    </div>
  );
}
