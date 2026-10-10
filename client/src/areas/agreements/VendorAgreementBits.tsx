/** Agreement line in a sponsor's or exhibitor's details: View PDF, Resend, or Send agreement. */
import { trpc } from "../../lib/trpc";
import { useAdmin, useAdminEvent } from "../../shells/AdminShell";
import { errorText, toast } from "../../ui/toast";

type VendorLike = {
  id: number;
  kind: "exhibitor" | "sponsor" | "both";
  email: string;
  agreement: { code: string; status: string; templateName: string } | null | undefined;
};

export function VendorAgreementLine({ v }: { v: VendorLike }) {
  const ev = useAdminEvent();
  const { can } = useAdmin();
  const utils = trpc.useUtils();
  const canEdit = can("vendors", "edit");
  const templates = trpc.agreements.templates.list.useQuery({ eventId: ev.id }, { enabled: canEdit && !v.agreement, staleTime: 30_000 });
  const send = trpc.agreements.send.useMutation();
  const go = async () => {
    try {
      await send.mutateAsync({ eventId: ev.id, vendorId: v.id });
      await utils.network.vendors.list.invalidate();
      toast(`Agreement sent to ${v.email}`);
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  const a = v.agreement;
  if (a) {
    return (
      <div className="sp-li">
        <span className="s2 grow">{a.templateName}</span>
        <span className="r">
          {a.status !== "signed" && canEdit ? (
            <button type="button" className="btn btn-sm btn-w" disabled={send.isPending} onClick={go}>
              Resend
            </button>
          ) : null}
          <a className="btn btn-sm btn-w" href={`/agreement/${encodeURIComponent(a.code)}`} target="_blank" rel="noopener noreferrer">
            View PDF
          </a>
        </span>
      </div>
    );
  }
  const kinds = templates.data?.templates.map((t) => t.kind) ?? [];
  const has = v.kind === "exhibitor" ? kinds.includes("exhibitor") : kinds.includes("sponsor") || (v.kind === "both" && kinds.includes("exhibitor"));
  if (!canEdit || !has) return null;
  return (
    <div className="sp-li">
      <span className="s2 grow">{v.email ? "No agreement sent yet" : "Add the contact's email to send the agreement"}</span>
      <span className="r">
        <button type="button" className="btn btn-sm btn-w-lg" disabled={send.isPending || !v.email} onClick={go}>
          Send agreement
        </button>
      </span>
    </div>
  );
}
