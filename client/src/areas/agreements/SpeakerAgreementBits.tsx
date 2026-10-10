/**
 * Speaker agreement pieces for the Speakers page: the Agreement and Welcome
 * email pills, the All / Signed / Not signed folder tabs, the Send agreements
 * button, and the Agreement and emails section in an open speaker row.
 */
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { useAdmin } from "../../shells/AdminShell";
import { FolderTabs, Pill, confirmAction } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtWhen } from "@shared/format";
import { SpSection } from "../network/sponsor-ui";

type Data = RouterOutputs["agreements"]["speakers"];
export type SpeakerAgreementRow = Data["speakers"][number];
export type SpeakerTab = "all" | "signed" | "unsigned";

/** Agreement status for every speaker, by speaker id. */
export function useSpeakerAgreements(eventId: number) {
  const q = trpc.agreements.speakers.useQuery({ eventId });
  const byId = new Map((q.data?.speakers ?? []).map((r) => [r.speakerId, r]));
  return { byId, template: q.data?.template ?? null, loading: q.isLoading };
}

const signed = (r: SpeakerAgreementRow | undefined) => r?.agreement?.status === "signed";

/** Whether a speaker shows on the chosen tab. */
export function inSpeakerTab(tab: string, r: SpeakerAgreementRow | undefined) {
  if (tab === "signed") return signed(r);
  if (tab === "unsigned") return !signed(r);
  return true;
}

/** All, Signed and Not signed. Pass `extra` tabs (Slides missing) to add them after. */
export function SpeakerTabs<T extends string>({ value, onChange, ids, rows, extra = [] }: { value: string; onChange: (key: SpeakerTab | T) => void; ids: number[]; rows: Map<number, SpeakerAgreementRow>; extra?: { key: T; label: string }[] }) {
  const n = ids.filter((id) => signed(rows.get(id))).length;
  const tabs = [
    { key: "all" as const, label: `All (${ids.length})` },
    { key: "signed" as const, label: `Signed (${n})` },
    { key: "unsigned" as const, label: `Not signed (${ids.length - n})` },
    ...extra,
  ] as { key: SpeakerTab | T; label: string }[];
  return <FolderTabs tabs={tabs} value={value as SpeakerTab | T} onChange={onChange} />;
}

/** "Signed Oct 10, 2026" (green), "Sent Oct 8, 2026" (amber) or "Not sent" (red). */
export function AgreementPill({ row }: { row: SpeakerAgreementRow | undefined }) {
  const a = row?.agreement;
  if (a?.status === "signed") return <Pill>Signed {fmtWhen(a.signedAt)}</Pill>;
  if (a?.status === "sent") return <Pill tone="orange">Sent {fmtWhen(a.sentAt)}</Pill>;
  return <Pill tone="red">Not sent</Pill>;
}

/** "Welcome sent" once the speaker welcome email went out, else "Waiting". */
export function WelcomePill({ row }: { row: SpeakerAgreementRow | undefined }) {
  return row?.welcomeSent ? <Pill>Welcome sent</Pill> : <Pill tone="gray">Waiting</Pill>;
}

/** Header button: sends the agreement to every speaker with an email and no agreement yet. */
export function SendAgreementsButton({ eventId }: { eventId: number }) {
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const count = trpc.agreements.unsentCount.useQuery({ eventId });
  const send = trpc.agreements.sendAllSpeakers.useMutation();
  if (!can("speakers", "edit")) return null;
  return (
    <button
      type="button"
      className="btn"
      disabled={send.isPending}
      onClick={async () => {
        const c = count.data;
        if (!c?.hasTemplate) return toast("Add a speaker agreement first: Sponsors and exhibitors, Agreements tab.", true);
        if (!c.count) return toast("Every speaker with an email already has an agreement.");
        if (!confirmAction(`Send the speaker agreement to ${c.count} speaker${c.count === 1 ? "" : "s"} who have not received it?`)) return;
        try {
          const r = await send.mutateAsync({ eventId });
          await Promise.all([utils.agreements.speakers.invalidate({ eventId }), utils.agreements.unsentCount.invalidate({ eventId })]);
          toast(`Sent to ${r.sent} speaker${r.sent === 1 ? "" : "s"}`);
        } catch (err) {
          toast(errorText(err), true);
        }
      }}
    >
      Send agreements
    </button>
  );
}

/** The Agreement and emails section in an open speaker row. */
export function SpeakerAgreementSection({ eventId, speakerId, email }: { eventId: number; speakerId: number; email: string }) {
  const { can } = useAdmin();
  const canEdit = can("speakers", "edit");
  const utils = trpc.useUtils();
  const { byId, template } = useSpeakerAgreements(eventId);
  const sendOne = trpc.agreements.sendSpeaker.useMutation();
  const resend = trpc.agreements.resend.useMutation();
  const welcome = trpc.agreements.sendWelcome.useMutation();
  const row = byId.get(speakerId);
  const a = row?.agreement ?? null;
  const refresh = () => Promise.all([utils.agreements.speakers.invalidate({ eventId }), utils.agreements.unsentCount.invalidate({ eventId })]);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      await refresh();
      toast(done);
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  const sentLine = a?.sentAt ? `${fmtWhen(a.sentAt)}${a.status === "sent" && a.nextReminderAt ? ` · reminder ${fmtWhen(a.nextReminderAt)}` : ""}` : "Not sent";
  const welcomeLine = row?.welcomeSent ? "Sent" : a?.status === "signed" ? "Not sent yet" : a && a.welcomeAfterSign ? "Sends after they sign" : "Not sent";
  return (
    <SpSection
      title="Agreement and emails"
      view={
        <>
          <div className="sp-kv">
            <span className="k">Agreement</span>
            <span>{a?.name || template?.name || <span className="muted">No speaker agreement yet</span>}</span>
            <span className="k">Sent</span>
            <span>{sentLine}</span>
            <span className="k">Signed</span>
            <span>{a?.status === "signed" ? `${fmtWhen(a.signedAt)}${a.signerName ? ` by ${a.signerName}` : ""}` : "Not yet"}</span>
            {a?.status === "signed" && a.recordingAllowed !== null ? (
              <>
                <span className="k">Recording</span>
                <span>{a.recordingAllowed ? "Allowed" : "Not allowed"}</span>
              </>
            ) : null}
            <span className="k">Welcome email</span>
            <span>{welcomeLine}</span>
          </div>
          {canEdit ? (
            <div className="row gap-8 wrap" style={{ padding: "0 14px 14px" }}>
              {a?.status === "signed" ? (
                <a className="btn btn-sm btn-w-lg" href={a.copyLink} target="_blank" rel="noopener noreferrer">
                  View PDF
                </a>
              ) : a ? (
                <button type="button" className="btn btn-sm btn-w-lg" disabled={resend.isPending} onClick={() => run(() => resend.mutateAsync({ eventId, agreementId: a.id }), `Sent to ${email}`)}>
                  Resend
                </button>
              ) : (
                <button type="button" className="btn btn-sm btn-w-lg" disabled={sendOne.isPending || !template || !email} onClick={() => run(() => sendOne.mutateAsync({ eventId, speakerId }), `Sent to ${email}`)}>
                  Send
                </button>
              )}
              {a && a.status !== "signed" ? (
                <button
                  type="button"
                  className="btn btn-sm btn-w-lg"
                  onClick={() =>
                    navigator.clipboard?.writeText(a.signLink).then(
                      () => toast("Sign link copied"),
                      () => toast("Could not copy the link.", true)
                    )
                  }
                >
                  Copy sign link
                </button>
              ) : null}
              <button type="button" className="btn btn-sm btn-w-lg" disabled={welcome.isPending || !email} onClick={() => run(() => welcome.mutateAsync({ eventId, speakerId }), "Welcome email sent")}>
                Send welcome
              </button>
            </div>
          ) : null}
        </>
      }
    />
  );
}
