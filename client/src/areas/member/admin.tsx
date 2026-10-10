/**
 * Organization admin screens for the member hub: Membership, Divisions and
 * committees, the Document library, and Reports across programs.
 * Every screen uses useAdmin().orgId; the server checks requireOrgAdmin.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdmin } from "../../shells/AdminShell";
import { Avatar, CopyButton, EditSection, Empty, ErrorNote, ExpandRow, Field, FolderTabs, KV, Kpi, Modal, PageLoading, Pill, THead, UploadButton, confirmAction } from "../../ui/components";
import { IconSearch } from "../../ui/icons";
import { errorText, toast } from "../../ui/toast";
import { fmtDate, fmtHours, fmtWhen } from "@shared/format";
import { FileType, ROLE_LABEL, STATUS_LABEL, downloadText, readFileText, statusTone } from "./lib";

type Outputs = RouterOutputs["member"]["admin"];

/** Organization screens need an organization picked. */
function NeedsOrg({ title, children }: { title: string; children: (orgId: number) => ReactNode }) {
  const { orgId } = useAdmin();
  if (!orgId) {
    return (
      <AdminPage title={title}>
        <Empty>Pick an organization on the Events screen first.</Empty>
      </AdminPage>
    );
  }
  return <>{children(orgId)}</>;
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label style={{ height: 44, maxWidth: 520, width: "100%", borderRadius: 10, border: "1px solid #D5DEDA", background: "#FFFFFF", color: "var(--muted)", display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
      <IconSearch />
      <input aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} style={{ flex: 1, border: "none", outline: "none", fontSize: 14, color: "var(--ink)", background: "#FFFFFF", minWidth: 0 }} />
    </label>
  );
}

/** Picks a CSV file and hands back its text. */
function CsvPicker({ label, onText, disabled }: { label: string; onText: (text: string) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onText(await readFileText(f));
        }}
      />
      <button type="button" className="btn btn-sm btn-solid" disabled={disabled} onClick={() => input.current?.click()}>
        {label}
      </button>
    </>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// =====================================================================
// Membership
// =====================================================================

type MemberRow = Outputs["members"]["list"]["members"][number];
type StatusTab = "all" | "active" | "grace" | "lapsed" | "cancelled" | "expiring";

type MemberForm = {
  email: string;
  firstName: string;
  lastName: string;
  credentials: string;
  level: string;
  memberNumber: string;
  memberSince: string;
  expiresOn: string;
  status: "active" | "grace" | "lapsed" | "cancelled";
  autoRenew: boolean;
  photoFileId: number | null;
  photoUrl: string | null;
};

const blankMember = (): MemberForm => ({ email: "", firstName: "", lastName: "", credentials: "", level: "Professional", memberNumber: "", memberSince: String(new Date().getFullYear()), expiresOn: "", status: "active", autoRenew: false, photoFileId: null, photoUrl: null });

const formFrom = (m: MemberRow): MemberForm => ({
  email: m.email,
  firstName: m.firstName,
  lastName: m.lastName,
  credentials: m.credentials,
  level: m.level,
  memberNumber: m.memberNumber,
  memberSince: m.memberSince,
  expiresOn: m.expiresOn ?? "",
  status: m.status,
  autoRenew: m.autoRenew,
  photoFileId: m.photoFileId,
  photoUrl: m.photoUrl,
});

const formInput = (f: MemberForm) => ({
  email: f.email.trim(),
  firstName: f.firstName.trim(),
  lastName: f.lastName.trim(),
  credentials: f.credentials.trim(),
  level: f.level.trim() || "Professional",
  memberNumber: f.memberNumber.trim(),
  memberSince: f.memberSince.trim(),
  expiresOn: f.expiresOn || null,
  status: f.status,
  autoRenew: f.autoRenew,
  photoFileId: f.photoFileId,
});

function MemberFields({ orgId, f, set, levels, numberHint }: { orgId: number; f: MemberForm; set: (f: MemberForm) => void; levels: string[]; numberHint?: string }) {
  const up = (patch: Partial<MemberForm>) => set({ ...f, ...patch });
  return (
    <div className="col gap-12">
      <div className="grid-4" style={{ gap: "12px 18px" }}>
        <Field label="First name">
          <input className="input" value={f.firstName} onChange={(e) => up({ firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <input className="input" value={f.lastName} onChange={(e) => up({ lastName: e.target.value })} />
        </Field>
        <Field label="Credentials">
          <input className="input" value={f.credentials} placeholder="LPC" onChange={(e) => up({ credentials: e.target.value })} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={f.email} onChange={(e) => up({ email: e.target.value })} />
        </Field>
        <Field label="Level">
          <input className="input" list="member-levels" value={f.level} onChange={(e) => up({ level: e.target.value })} />
        </Field>
        <Field label="Member ID" hint={numberHint}>
          <input className="input" value={f.memberNumber} placeholder="Made for you" onChange={(e) => up({ memberNumber: e.target.value })} />
        </Field>
        <Field label="Member since">
          <input className="input" value={f.memberSince} placeholder="2019" maxLength={10} onChange={(e) => up({ memberSince: e.target.value })} />
        </Field>
        <Field label="Expires on">
          <input className="input" type="date" value={f.expiresOn} onChange={(e) => up({ expiresOn: e.target.value })} />
        </Field>
        <Field label="Status">
          <select className="select" value={f.status} onChange={(e) => up({ status: e.target.value as MemberForm["status"] })}>
            <option value="active">Active</option>
            <option value="grace">Grace period</option>
            <option value="lapsed">Lapsed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Field>
      </div>
      <datalist id="member-levels">
        {Array.from(new Set(["Professional", "Student", "Retired", ...levels])).map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <div className="row wrap gap-16">
        <label className="check">
          <input type="checkbox" checked={f.autoRenew} onChange={(e) => up({ autoRenew: e.target.checked })} />
          Auto-renew is on
        </label>
        <div className="row gap-8">
          <Avatar url={f.photoUrl} name={`${f.firstName} ${f.lastName}`} size={36} />
          <UploadButton label={f.photoFileId ? "New photo" : "Add photo"} orgId={orgId} accept="image/png,image/jpeg,image/webp" onUploaded={(file) => up({ photoFileId: file.id, photoUrl: file.url })} />
          {f.photoFileId ? (
            <button type="button" className="btn btn-sm btn-w" onClick={() => up({ photoFileId: null, photoUrl: null })}>
              Remove
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AdminMembers() {
  return <NeedsOrg title="Membership">{(orgId) => <MembersScreen orgId={orgId} />}</NeedsOrg>;
}

function MembersScreen({ orgId }: { orgId: number }) {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<StatusTab>("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const list = trpc.member.admin.members.list.useQuery({ orgId, search: q, status: tab });
  const settings = trpc.member.admin.members.settings.useQuery({ orgId });
  const exportCsv = trpc.member.admin.members.exportCsv.useMutation();
  const cols = "minmax(0, 1.6fr) 120px minmax(0, 1fr) 120px 140px 96px";
  const c = list.data?.counts;
  const tabs: { key: StatusTab; label: string }[] = [
    { key: "all", label: `All (${c?.all ?? 0})` },
    { key: "active", label: `Active (${c?.active ?? 0})` },
    { key: "grace", label: `Grace period (${c?.grace ?? 0})` },
    { key: "expiring", label: `Expiring in 90 days (${c?.expiring ?? 0})` },
    { key: "lapsed", label: `Lapsed (${c?.lapsed ?? 0})` },
    { key: "cancelled", label: `Cancelled (${c?.cancelled ?? 0})` },
  ];
  return (
    <AdminPage
      title="Membership"
      actions={
        <>
          <button className="btn" onClick={() => setImporting(true)}>
            Import CSV
          </button>
          <button
            className="btn"
            disabled={exportCsv.isPending}
            onClick={async () => {
              try {
                const r = await exportCsv.mutateAsync({ orgId });
                downloadText(r.filename, r.csv);
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Export CSV
          </button>
          <button className="btn btn-primary" onClick={() => setOpenId("new")}>
            Add member
          </button>
        </>
      }
    >
      <SearchBox value={q} onChange={setQ} placeholder="Search by name, email or member ID" />
      <div className="col" style={{ gap: 0 }}>
        <FolderTabs tabs={tabs} value={tab} onChange={setTab} />
        <div className="table" style={{ borderRadius: "0 12px 12px 12px" }}>
          <div className="table-inner" style={{ minWidth: 860 }}>
            <THead cols={cols} labels={["Member", "Member ID", "Level", "Status", "Expires", ""]} />
            {openId === "new" ? (
              <div className="trow-open" style={{ borderBottom: "1px solid var(--line)" }}>
                <div className="editor" style={{ marginTop: 16 }}>
                  <NewMember orgId={orgId} levels={list.data?.levels ?? []} numberHint={settings.data ? `Next: ${settings.data.nextNumber}` : undefined} onDone={() => setOpenId(null)} />
                </div>
              </div>
            ) : null}
            {list.isLoading ? (
              <PageLoading />
            ) : list.error ? (
              <ErrorNote error={list.error} />
            ) : !list.data!.members.length ? (
              <Empty>{q || tab !== "all" ? "No members match." : "No members yet. Add one, or import a CSV."}</Empty>
            ) : (
              list.data!.members.map((m) => (
                <ExpandRow
                  key={m.id}
                  cols={cols}
                  open={openId === m.id}
                  onToggle={() => setOpenId(openId === m.id ? null : m.id)}
                  cells={[
                    <div className="row gap-8" style={{ minWidth: 0 }}>
                      <Avatar url={m.photoUrl} name={m.name} size={30} />
                      <div className="col" style={{ gap: 0, minWidth: 0 }}>
                        <span className="strong clip">{m.name}</span>
                        <span className="small muted clip">{m.email}</span>
                      </div>
                    </div>,
                    <span>{m.memberNumber}</span>,
                    <span className="clip">{m.level}</span>,
                    <Pill tone={statusTone(m.status)}>{STATUS_LABEL[m.status]}</Pill>,
                    <span className="muted">{m.expiresOn ? fmtDate(m.expiresOn) : "No end date"}</span>,
                  ]}
                >
                  <MemberDetail orgId={orgId} m={m} levels={list.data!.levels} onRemoved={() => setOpenId(null)} />
                </ExpandRow>
              ))
            )}
          </div>
        </div>
        {list.data && list.data.total > list.data.members.length ? <span className="small muted" style={{ paddingTop: 8 }}>Showing the first {list.data.members.length} of {list.data.total}. Search to narrow the list.</span> : null}
      </div>
      <HubSettings orgId={orgId} />
      <ImportMembers open={importing} onClose={() => setImporting(false)} orgId={orgId} onDone={() => utils.member.admin.members.invalidate()} />
    </AdminPage>
  );
}

function NewMember({ orgId, levels, numberHint, onDone }: { orgId: number; levels: string[]; numberHint?: string; onDone: () => void }) {
  const utils = trpc.useUtils();
  const create = trpc.member.admin.members.create.useMutation();
  const [f, setF] = useState<MemberForm>(blankMember);
  return (
    <>
      <div className="editor-title">New member</div>
      <MemberFields orgId={orgId} f={f} set={setF} levels={levels} numberHint={numberHint} />
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={create.isPending}
          onClick={async () => {
            try {
              const r = await create.mutateAsync({ orgId, ...formInput(f) });
              await utils.member.admin.members.invalidate();
              toast(`${r.name} added as ${r.memberNumber}.`);
              onDone();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Save
        </button>
        <button className="btn btn-sm btn-w" onClick={onDone}>
          Cancel
        </button>
      </div>
    </>
  );
}

function MemberDetail({ orgId, m, levels, onRemoved }: { orgId: number; m: MemberRow; levels: string[]; onRemoved: () => void }) {
  const utils = trpc.useUtils();
  const update = trpc.member.admin.members.update.useMutation();
  const remove = trpc.member.admin.members.remove.useMutation();
  const activity = trpc.member.admin.members.activity.useQuery({ orgId, memberId: m.id });
  const [f, setF] = useState<MemberForm>(() => formFrom(m));
  useEffect(() => setF(formFrom(m)), [m]);
  return (
    <>
      <EditSection
        title="Membership"
        saving={update.isPending}
        onCancel={() => setF(formFrom(m))}
        onSave={async () => {
          await update.mutateAsync({ orgId, memberId: m.id, ...formInput(f) });
          await utils.member.admin.members.invalidate();
          toast("Saved");
        }}
        actions={
          <button
            className="btn btn-sm btn-w btn-danger"
            disabled={remove.isPending}
            onClick={async () => {
              if (!confirmAction(`Remove ${m.name} from the member list? Their payments stay on the LeadDash platform.`)) return;
              try {
                await remove.mutateAsync({ orgId, memberId: m.id });
                await utils.member.admin.members.invalidate();
                onRemoved();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Remove
          </button>
        }
        view={
          <div className="col" style={{ gap: 0 }}>
            <KV label="Name">{m.name}</KV>
            <KV label="Email">{m.email}</KV>
            <KV label="Level">{m.level}</KV>
            <KV label="Member ID">{m.memberNumber}</KV>
            <KV label="Member since">{m.memberSince}</KV>
            <KV label="Expires on">{m.expiresOn ? fmtDate(m.expiresOn) : "No end date"}</KV>
            <KV label="Status">{STATUS_LABEL[m.status]}</KV>
            <KV label="Auto-renew">{m.autoRenew ? "On" : "Off"}</KV>
          </div>
        }
        edit={<MemberFields orgId={orgId} f={f} set={setF} levels={levels} />}
      />
      <div className="col gap-6">
        <span className="h3" style={{ fontSize: 14 }}>Activity</span>
        {activity.isLoading ? (
          <span className="small muted">Loading</span>
        ) : activity.data ? (
          <div className="col" style={{ gap: 0 }}>
            <KV label="CE hours this cycle">{fmtHours(activity.data.ceHours)}</KV>
            <KV label="Divisions and committees">{activity.data.groups.map((g) => `${g.name}${g.role !== "member" ? ` (${ROLE_LABEL[g.role]})` : ""}`).join(", ") || "None"}</KV>
            <KV label="Events">{activity.data.events.map((e) => `${e.name} (${fmtDate(e.startDate)})`).join(", ") || "None"}</KV>
          </div>
        ) : null}
      </div>
    </>
  );
}

function HubSettings({ orgId }: { orgId: number }) {
  const utils = trpc.useUtils();
  const s = trpc.member.admin.members.settings.useQuery({ orgId });
  const save = trpc.member.admin.members.saveSettings.useMutation();
  const [prefix, setPrefix] = useState("");
  const [renewUrl, setRenewUrl] = useState("");
  useEffect(() => {
    if (s.data) {
      setPrefix(s.data.numberPrefix);
      setRenewUrl(s.data.renewUrl);
    }
  }, [s.data]);
  if (!s.data) return null;
  return (
    <div className="card card-pad">
      <EditSection
        title="Member hub"
        saving={save.isPending}
        onCancel={() => {
          setPrefix(s.data!.numberPrefix);
          setRenewUrl(s.data!.renewUrl);
        }}
        onSave={async () => {
          await save.mutateAsync({ orgId, numberPrefix: prefix.trim(), renewUrl: renewUrl.trim() });
          await utils.member.admin.members.settings.invalidate();
          toast("Saved");
        }}
        view={
          <div className="col" style={{ gap: 0 }}>
            <KV label="Member hub link">
              <span className="row gap-8 wrap">
                <span style={{ wordBreak: "break-all" }}>{s.data.hubUrl}</span>
                <CopyButton text={s.data.hubUrl} />
              </span>
            </KV>
            <KV label="Member ID prefix">{s.data.numberPrefix || `Made from the organization (next ${s.data.nextNumber})`}</KV>
            <KV label="Renewal link">{s.data.renewUrl}</KV>
          </div>
        }
        edit={
          <div className="grid-3" style={{ gap: "12px 18px" }}>
            <Field label="Member ID prefix" hint="Letters and numbers, up to 8">
              <input className="input" value={prefix} maxLength={8} onChange={(e) => setPrefix(e.target.value.replace(/[^A-Za-z0-9]/g, ""))} />
            </Field>
            <Field label="Renewal link" hint="The LeadDash platform payment page">
              <input className="input" type="url" value={renewUrl} placeholder="https://" onChange={(e) => setRenewUrl(e.target.value)} />
            </Field>
          </div>
        }
      />
    </div>
  );
}

function ImportMembers({ open, onClose, orgId, onDone }: { open: boolean; onClose: () => void; orgId: number; onDone: () => void }) {
  const run = trpc.member.admin.members.importCsv.useMutation();
  const [result, setResult] = useState<Outputs["members"]["importCsv"] | null>(null);
  return (
    <Modal
      open={open}
      title="Import members"
      onClose={() => {
        setResult(null);
        onClose();
      }}
    >
      <span className="muted" style={{ fontSize: 13 }}>
        Columns: email, first, last, credentials, level, member number, member since, expires on, status. Emails already on the list are updated. Leave member number empty to have one made.
      </span>
      <div className="row gap-10">
        <CsvPicker
          label={run.isPending ? "Importing" : "Pick a CSV file"}
          disabled={run.isPending}
          onText={async (csv) => {
            try {
              const r = await run.mutateAsync({ orgId, csv });
              setResult(r);
              onDone();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        />
      </div>
      {result ? (
        <div className="col gap-6">
          <div className="banner banner-ok">
            {plural(result.added, "member")} added, {result.updated} updated
          </div>
          {result.errors.length ? (
            <div className="col gap-4">
              {result.errors.map((e) => (
                <span key={e} className="err">
                  {e}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

// =====================================================================
// Divisions and committees
// =====================================================================

type GroupRow = Outputs["groups"]["list"]["groups"][number];
type Role = "member" | "co_chair" | "chair";
type KindFilter = "all" | "division" | "committee" | "task_force";
type RosterRow = { memberId: number; name: string; email: string; role: Role };

type GroupForm = {
  name: string;
  kind: "division" | "committee" | "task_force";
  description: string;
  joinRule: "open" | "appointment" | "level";
  joinLevel: string;
  termEndsOn: string;
  hasChannel: boolean;
  hasFolder: boolean;
  chairCanEmail: boolean;
  chairCanAdd: boolean;
  nextMeeting: string;
  isBoard: boolean;
};

const blankGroup = (): GroupForm => ({ name: "", kind: "committee", description: "", joinRule: "appointment", joinLevel: "", termEndsOn: "", hasChannel: true, hasFolder: true, chairCanEmail: true, chairCanAdd: false, nextMeeting: "", isBoard: false });

export function AdminDivisions() {
  return <NeedsOrg title="Divisions and committees">{(orgId) => <DivisionsScreen orgId={orgId} />}</NeedsOrg>;
}

function DivisionsScreen({ orgId }: { orgId: number }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [openId, setOpenId] = useState<number | "new" | null>(null);
  const list = trpc.member.admin.groups.list.useQuery({ orgId, search: q, kind });
  const levels = trpc.member.admin.members.list.useQuery({ orgId, search: "", status: "all" }, { select: (d) => d.levels });
  const cols = "minmax(0, 1.4fr) 110px minmax(0, 1fr) 90px minmax(0, 1fr) 96px";
  const k = list.data?.kpis;
  return (
    <AdminPage
      title="Divisions and committees"
      sub="Members can join divisions; chairs run their own group"
      actions={
        <button className="btn btn-primary" onClick={() => setOpenId("new")}>
          New group
        </button>
      }
    >
      <div className="grid-4">
        <Kpi label="Divisions" value={k?.divisions ?? 0} />
        <Kpi label="Committees" value={k?.committees ?? 0} />
        <Kpi label="Members in at least one" value={k?.membersInAny ?? 0} />
        <Kpi label="Chair terms ending this year" value={k?.termsEnding ?? 0} />
      </div>
      <div className="row wrap gap-10">
        <input className="input" aria-label="Search groups" placeholder="Search divisions and committees" value={q} onChange={(e) => setQ(e.target.value)} style={{ height: 38, width: 320, maxWidth: "100%" }} />
        <select className="select" aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} style={{ height: 38, width: "auto" }}>
          <option value="all">All types</option>
          <option value="division">Divisions</option>
          <option value="committee">Committees</option>
          <option value="task_force">Task forces</option>
        </select>
      </div>
      <div className="table">
        <div className="table-inner" style={{ minWidth: 920 }}>
          <THead cols={cols} labels={["Name", "Type", "Chair", "Members", "Who can join", ""]} />
          {openId === "new" ? (
            <div className="trow-open" style={{ borderBottom: "1px solid var(--line)" }}>
              <div className="editor" style={{ marginTop: 16 }}>
                <GroupEditor orgId={orgId} levels={levels.data ?? []} onDone={() => setOpenId(null)} />
              </div>
            </div>
          ) : null}
          {list.isLoading ? (
            <PageLoading />
          ) : list.error ? (
            <ErrorNote error={list.error} />
          ) : !list.data!.groups.length ? (
            <Empty>{q || kind !== "all" ? "No groups match." : "No divisions or committees yet. Click New group."}</Empty>
          ) : (
            list.data!.groups.map((g) => (
              <ExpandRow
                key={g.id}
                cols={cols}
                open={openId === g.id}
                onToggle={() => setOpenId(openId === g.id ? null : g.id)}
                cells={[
                  <span className="strong">{g.name}</span>,
                  <Pill tone="gray">{g.kindLabel}</Pill>,
                  <span className={g.chairName ? "" : "muted"}>{g.chairName || "No chair yet"}</span>,
                  <span>{g.memberCount}</span>,
                  <span className="muted">{g.joinLabel}</span>,
                ]}
              >
                <GroupEditor orgId={orgId} group={g} levels={levels.data ?? []} onDone={() => setOpenId(null)} />
              </ExpandRow>
            ))
          )}
        </div>
      </div>
    </AdminPage>
  );
}

function GroupEditor({ orgId, group, levels, onDone }: { orgId: number; group?: GroupRow; levels: string[]; onDone: () => void }) {
  const utils = trpc.useUtils();
  const detail = trpc.member.admin.groups.get.useQuery({ orgId, groupId: group?.id ?? 0 }, { enabled: !!group });
  const save = trpc.member.admin.groups.save.useMutation();
  const remove = trpc.member.admin.groups.remove.useMutation();
  const [f, setF] = useState<GroupForm>(() =>
    group
      ? { name: group.name, kind: group.kind, description: group.description, joinRule: group.joinRule, joinLevel: group.joinLevel, termEndsOn: group.termEndsOn ?? "", hasChannel: group.hasChannel, hasFolder: group.hasFolder, chairCanEmail: group.chairCanEmail, chairCanAdd: group.chairCanAdd, nextMeeting: group.nextMeeting, isBoard: group.isBoard }
      : blankGroup()
  );
  const [roster, setRoster] = useState<RosterRow[] | null>(group ? null : []);
  useEffect(() => {
    if (detail.data && roster === null) setRoster(detail.data.members.map((m) => ({ memberId: m.memberId, name: m.name, email: m.email, role: m.role })));
  }, [detail.data, roster]);
  const up = (patch: Partial<GroupForm>) => setF({ ...f, ...patch });
  const kindWord = f.kind === "division" ? "Division" : f.kind === "task_force" ? "Task force" : "Committee";
  return (
    <>
      <div className="row-between">
        <div className="editor-title">{group ? `Editing ${kindWord.toLowerCase()}` : "New group"}</div>
        {group ? (
          <button
            className="btn btn-sm btn-w btn-danger"
            disabled={remove.isPending}
            onClick={async () => {
              if (!confirmAction(`Delete ${group.name}? Its discussion and folder go with it.`)) return;
              try {
                await remove.mutateAsync({ orgId, groupId: group.id });
                await utils.member.admin.groups.invalidate();
                onDone();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
      <div className="grid-4" style={{ gap: "12px 18px" }}>
        <Field label="Name">
          <input className="input" value={f.name} onChange={(e) => up({ name: e.target.value })} />
        </Field>
        <Field label="Type">
          <select className="select" value={f.kind} onChange={(e) => up({ kind: e.target.value as GroupForm["kind"] })}>
            <option value="committee">Committee</option>
            <option value="division">Division</option>
            <option value="task_force">Task force</option>
          </select>
        </Field>
        <Field label="Who can join">
          <select className="select" value={f.joinRule} onChange={(e) => up({ joinRule: e.target.value as GroupForm["joinRule"] })}>
            <option value="appointment">By appointment</option>
            <option value="open">Any member, opt in</option>
            <option value="level">Member level only</option>
          </select>
        </Field>
        {f.joinRule === "level" ? (
          <Field label="Member level">
            <input className="input" list="group-levels" value={f.joinLevel} placeholder="Student" onChange={(e) => up({ joinLevel: e.target.value })} />
            <datalist id="group-levels">
              {levels.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </Field>
        ) : null}
        <Field label="Term ends">
          <input className="input" type="date" value={f.termEndsOn} onChange={(e) => up({ termEndsOn: e.target.value })} />
        </Field>
        <Field label="Next meeting">
          <input className="input" value={f.nextMeeting} placeholder="Thu, Oct 15, 2026, 7 PM" maxLength={120} onChange={(e) => up({ nextMeeting: e.target.value })} />
        </Field>
        <Field label="Description" className="span-2">
          <input className="input" value={f.description} maxLength={2000} onChange={(e) => up({ description: e.target.value })} />
        </Field>
      </div>
      <div className="row wrap" style={{ gap: "8px 22px" }}>
        <span className="small muted strong" style={{ width: "100%", fontWeight: 600 }}>{kindWord} gets</span>
        <label className="check">
          <input type="checkbox" checked={f.hasChannel} onChange={(e) => up({ hasChannel: e.target.checked })} />
          Private discussion channel
        </label>
        <label className="check">
          <input type="checkbox" checked={f.hasFolder} onChange={(e) => up({ hasFolder: e.target.checked })} />
          Own document folder
        </label>
        <label className="check">
          <input type="checkbox" checked={f.chairCanEmail} onChange={(e) => up({ chairCanEmail: e.target.checked })} />
          Chair can email the group
        </label>
        <label className="check">
          <input type="checkbox" checked={f.chairCanAdd} onChange={(e) => up({ chairCanAdd: e.target.checked })} />
          Chair can add members
        </label>
        <label className="check">
          <input type="checkbox" checked={f.isBoard} onChange={(e) => up({ isBoard: e.target.checked })} />
          This is the board (opens Board only folders)
        </label>
      </div>
      {roster === null ? <span className="small muted">Loading members</span> : <RosterEditor orgId={orgId} roster={roster} setRoster={setRoster} />}
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={save.isPending || roster === null}
          onClick={async () => {
            try {
              await save.mutateAsync({ orgId, groupId: group?.id, ...f, termEndsOn: f.termEndsOn || null, joinLevel: f.joinRule === "level" ? f.joinLevel.trim() : "", members: (roster ?? []).map((r) => ({ memberId: r.memberId, role: r.role })) });
              await Promise.all([utils.member.admin.groups.invalidate(), utils.member.admin.docs.folders.invalidate()]);
              toast("Saved");
              onDone();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Save
        </button>
        <button className="btn btn-sm btn-w" onClick={onDone}>
          Cancel
        </button>
      </div>
    </>
  );
}

function RosterEditor({ orgId, roster, setRoster }: { orgId: number; roster: RosterRow[]; setRoster: (r: RosterRow[]) => void }) {
  const [q, setQ] = useState("");
  const found = trpc.member.admin.groups.findMembers.useQuery({ orgId, q: q.trim() }, { enabled: q.trim().length >= 2 });
  const options = (found.data ?? []).filter((m) => !roster.some((r) => r.memberId === m.memberId));
  const add = (m: { memberId: number; name: string; email: string }) => {
    setRoster([...roster, { ...m, role: "member" }]);
    setQ("");
  };
  return (
    <div className="col gap-6">
      <span className="small muted strong" style={{ fontWeight: 600 }}>Members ({roster.length})</span>
      {roster.map((r) => (
        <div key={r.memberId} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) 150px 96px", gap: 10, alignItems: "center", fontSize: 13 }}>
          <span className="strong clip">{r.name}</span>
          <span className="clip">{r.email}</span>
          <select className="select" aria-label={`Role for ${r.name}`} value={r.role} style={{ height: 30 }} onChange={(e) => setRoster(roster.map((x) => (x.memberId === r.memberId ? { ...x, role: e.target.value as Role } : x)))}>
            <option value="member">Member</option>
            <option value="co_chair">Co-chair</option>
            <option value="chair">Chair</option>
          </select>
          <button type="button" className="btn btn-xs btn-w" onClick={() => setRoster(roster.filter((x) => x.memberId !== r.memberId))}>
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 96px", gap: 10, alignItems: "center", maxWidth: 520 }}>
        <input
          className="input"
          aria-label="Add a member"
          placeholder="Add a member by name or email"
          value={q}
          style={{ height: 30 }}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && options[0]) {
              e.preventDefault();
              add(options[0]);
            }
          }}
        />
        <button type="button" className="btn btn-xs btn-w" disabled={!options.length} onClick={() => options[0] && add(options[0])}>
          Add
        </button>
      </div>
      {q.trim().length >= 2 ? (
        <div className="col" style={{ gap: 4, maxWidth: 520 }}>
          {options.map((m) => (
            <button key={m.memberId} type="button" className="btn btn-xs" style={{ justifyContent: "flex-start", border: "1px solid var(--line)" }} onClick={() => add(m)}>
              {m.name} · {m.email}
              {m.status !== "active" ? ` · ${STATUS_LABEL[m.status]}` : ""}
            </button>
          ))}
          {found.data && !options.length ? <span className="small muted">No member matches.</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// =====================================================================
// Document library
// =====================================================================

type Folder = Outputs["docs"]["folders"]["folders"][number];
type AccessType = "active_members" | "board" | "group" | "level" | "staff";
type Notify = "push_email" | "push" | "none";
const NOTIFY_LABEL: Record<Notify, string> = { push_email: "Push and email", push: "Push only", none: "Do not notify" };

const ACCESS_HELP: Record<AccessType, string> = {
  active_members: "Visible to anyone with an active membership in the member app",
  board: "Visible to members of the board group",
  group: "Visible to the members of one division or committee",
  level: "Visible to active members at one member level",
  staff: "Visible to organization staff only, never in the member app",
};

export function AdminDocuments() {
  return <NeedsOrg title="Document library">{(orgId) => <DocumentsScreen orgId={orgId} />}</NeedsOrg>;
}

function DocumentsScreen({ orgId }: { orgId: number }) {
  const data = trpc.member.admin.docs.folders.useQuery({ orgId });
  const [folderId, setFolderId] = useState<number | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [uploading, setUploading] = useState(false);
  const folders = data.data?.folders ?? [];
  const current = folders.find((f) => f.id === folderId) ?? folders[0];
  return (
    <AdminPage
      title="Document library"
      sub="Files show in the member app only for the people each folder allows"
      actions={
        <button className="btn btn-primary" disabled={!folders.length} onClick={() => setUploading(true)}>
          Upload files
        </button>
      }
    >
      {data.isLoading ? (
        <PageLoading />
      ) : data.error ? (
        <ErrorNote error={data.error} />
      ) : (
        <div className="row wrap" style={{ gap: 20, alignItems: "flex-start" }}>
          <div className="card" style={{ flex: "0 0 240px", padding: 10, display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="label-caps" style={{ padding: "6px 12px" }}>Folders</span>
            {folders.map((f) => {
              const on = current?.id === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFolderId(f.id)}
                  aria-current={on ? "true" : undefined}
                  style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "9px 12px", borderRadius: 8, fontSize: 14, border: "none", textAlign: "left", cursor: "pointer", background: on ? "var(--brand-tint)" : "transparent", color: on ? "var(--brand)" : "var(--ink)", fontWeight: on ? 700 : 500 }}
                >
                  <span>{f.name}</span>
                  <span className="muted" style={{ fontWeight: 600 }}>{f.count}</span>
                </button>
              );
            })}
            <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setNewFolder(true)}>
              New folder
            </button>
          </div>
          <div className="col grow" style={{ flex: "1 1 600px", gap: 14 }}>
            {current ? <FolderPanel key={current.id} orgId={orgId} folder={current} groups={data.data!.groups} levels={data.data!.levels} folders={folders} /> : <Empty>No folders yet. Click New folder to make the first one.</Empty>}
          </div>
        </div>
      )}
      <FolderModal open={newFolder} onClose={() => setNewFolder(false)} orgId={orgId} groups={data.data?.groups ?? []} levels={data.data?.levels ?? []} onSaved={(id) => setFolderId(id)} />
      {current ? <UploadModal open={uploading} onClose={() => setUploading(false)} orgId={orgId} folders={folders} folderId={current.id} /> : null}
    </AdminPage>
  );
}

function AccessFields({ type, setType, groupId, setGroupId, level, setLevel, groups, levels }: { type: AccessType; setType: (t: AccessType) => void; groupId: number | null; setGroupId: (n: number | null) => void; level: string; setLevel: (s: string) => void; groups: { id: number; name: string }[]; levels: string[] }) {
  return (
    <>
      <Field label="Who can open">
        <select className="select" value={type} onChange={(e) => setType(e.target.value as AccessType)}>
          <option value="active_members">Active members</option>
          <option value="board">Board only</option>
          <option value="group">A division or committee</option>
          <option value="level">Member level</option>
          <option value="staff">Staff only</option>
        </select>
      </Field>
      {type === "group" ? (
        <Field label="Division or committee">
          <select className="select" value={groupId ?? ""} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Pick one</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {type === "level" ? (
        <Field label="Member level">
          <select className="select" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">Pick one</option>
            {levels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
    </>
  );
}

const accessPayload = (type: AccessType, groupId: number | null, level: string) => ({ type, ...(type === "group" && groupId ? { groupId } : {}), ...(type === "level" ? { level } : {}) });

function FolderModal({ open, onClose, orgId, groups, levels, onSaved }: { open: boolean; onClose: () => void; orgId: number; groups: { id: number; name: string }[]; levels: string[]; onSaved: (id: number) => void }) {
  const utils = trpc.useUtils();
  const save = trpc.member.admin.docs.saveFolder.useMutation();
  const [name, setName] = useState("");
  const [type, setType] = useState<AccessType>("active_members");
  const [groupId, setGroupId] = useState<number | null>(null);
  const [level, setLevel] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="New folder">
      <div className="grid-2" style={{ gap: "12px 18px" }}>
        <Field label="Folder name" className="span-all">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <AccessFields type={type} setType={setType} groupId={groupId} setGroupId={setGroupId} level={level} setLevel={setLevel} groups={groups} levels={levels} />
      </div>
      <span className="small muted">{ACCESS_HELP[type]}</span>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={!name.trim() || save.isPending}
          onClick={async () => {
            try {
              const f = await save.mutateAsync({ orgId, name: name.trim(), access: accessPayload(type, groupId, level) });
              await utils.member.admin.docs.folders.invalidate();
              setName("");
              onSaved(f.id);
              onClose();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Save
        </button>
        <button className="btn btn-sm btn-w" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function FolderPanel({ orgId, folder, groups, levels, folders }: { orgId: number; folder: Folder; groups: { id: number; name: string }[]; levels: string[]; folders: Folder[] }) {
  const utils = trpc.useUtils();
  const docs = trpc.member.admin.docs.documents.useQuery({ orgId, folderId: folder.id });
  const save = trpc.member.admin.docs.saveFolder.useMutation();
  const remove = trpc.member.admin.docs.removeFolder.useMutation();
  const [openId, setOpenId] = useState<number | null>(null);
  const reset = () => ({ name: folder.name, type: folder.access.type as AccessType, groupId: folder.access.groupId ?? folder.groupId ?? null, level: folder.access.level ?? "" });
  const [f, setF] = useState(reset);
  const cols = "40px minmax(0, 1.6fr) minmax(0, 1.2fr) 80px 130px 96px";
  return (
    <>
      <div className="card card-pad">
        <EditSection
          title={<span style={{ fontSize: 16 }}>{folder.name}</span>}
          saving={save.isPending}
          onCancel={() => setF(reset())}
          onSave={async () => {
            await save.mutateAsync({ orgId, folderId: folder.id, name: f.name.trim(), access: accessPayload(f.type, f.groupId, f.level) });
            await utils.member.admin.docs.invalidate();
            toast("Saved");
          }}
          actions={
            folder.groupId ? null : (
              <button
                className="btn btn-sm btn-w btn-danger"
                onClick={async () => {
                  if (!confirmAction(`Delete the folder ${folder.name} and its ${plural(folder.count, "file")}?`)) return;
                  try {
                    await remove.mutateAsync({ orgId, folderId: folder.id });
                    await utils.member.admin.docs.invalidate();
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Delete
              </button>
            )
          }
          view={
            <div className="col" style={{ gap: 2 }}>
              <span className="strong">{folder.accessLabel}</span>
              <span className="small muted">{ACCESS_HELP[folder.access.type as AccessType]}</span>
            </div>
          }
          edit={
            <div className="grid-3" style={{ gap: "12px 18px" }}>
              <Field label="Folder name">
                <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </Field>
              <AccessFields type={f.type} setType={(type) => setF({ ...f, type })} groupId={f.groupId} setGroupId={(groupId) => setF({ ...f, groupId })} level={f.level} setLevel={(level) => setF({ ...f, level })} groups={groups} levels={levels} />
            </div>
          }
        />
      </div>
      <div className="table">
        <div className="table-inner">
          <THead cols={cols} labels={["", "File", "Who can open", "Version", "Updated", ""]} />
          {docs.isLoading ? (
            <PageLoading />
          ) : docs.error ? (
            <ErrorNote error={docs.error} />
          ) : !docs.data!.length ? (
            <Empty>No files in this folder yet. Click Upload files.</Empty>
          ) : (
            docs.data!.map((d) => (
              <ExpandRow
                key={d.id}
                cols={cols}
                open={openId === d.id}
                onToggle={() => setOpenId(openId === d.id ? null : d.id)}
                cells={[<FileType ext={d.ext} size="sm" />, <span className="strong clip">{d.title}</span>, <span className="muted clip">{d.accessLabel}</span>, <span>v{d.version}</span>, <span className="muted">{fmtWhen(d.updatedAt)}</span>]}
              >
                <DocumentEditor orgId={orgId} documentId={d.id} folders={folders} onDone={() => setOpenId(null)} />
              </ExpandRow>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function DocumentEditor({ orgId, documentId, folders, onDone }: { orgId: number; documentId: number; folders: Folder[]; onDone: () => void }) {
  const utils = trpc.useUtils();
  const detail = trpc.member.admin.docs.document.useQuery({ orgId, documentId });
  const update = trpc.member.admin.docs.update.useMutation();
  const addVersion = trpc.member.admin.docs.addVersion.useMutation();
  const restore = trpc.member.admin.docs.restore.useMutation();
  const remove = trpc.member.admin.docs.remove.useMutation();
  const [form, setForm] = useState<{ title: string; folderId: number; notify: Notify } | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (detail.data && !form) setForm({ title: detail.data.doc.title, folderId: detail.data.doc.folderId, notify: detail.data.doc.notify });
  }, [detail.data, form]);
  const refresh = () => Promise.all([utils.member.admin.docs.document.invalidate({ orgId, documentId }), utils.member.admin.docs.documents.invalidate(), utils.member.admin.docs.folders.invalidate()]);
  if (detail.isLoading || !form) return <span className="small muted">Loading</span>;
  if (detail.error) return <ErrorNote error={detail.error} />;
  const d = detail.data!;
  return (
    <>
      <div className="grid-3" style={{ gap: "12px 18px" }}>
        <Field label="Title">
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Folder">
          <select className="select" value={form.folderId} onChange={(e) => setForm({ ...form, folderId: Number(e.target.value) })}>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tell members">
          <select className="select" value={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.value as Notify })}>
            {(Object.keys(NOTIFY_LABEL) as Notify[]).map((k) => (
              <option key={k} value={k}>
                {NOTIFY_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="col gap-8">
        <span className="small muted strong" style={{ fontWeight: 600 }}>Version history</span>
        {d.versions.map((v) => (
          <div key={v.id} style={{ display: "grid", gridTemplateColumns: "50px minmax(0, 1fr) 130px 96px 96px", gap: 10, alignItems: "center", fontSize: 13 }}>
            <span className="strong">v{v.version}</span>
            <span className="clip">
              {v.note || "No note"}
              {v.uploadedBy ? ` · ${v.uploadedBy}` : ""}
            </span>
            <span className="muted">{fmtWhen(v.createdAt)}</span>
            {v.url ? (
              <a className="btn btn-xs btn-w" href={v.url} target="_blank" rel="noreferrer">
                Open
              </a>
            ) : (
              <span />
            )}
            {v.current ? (
              <span>
                <Pill>Current</Pill>
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-xs btn-w"
                disabled={restore.isPending}
                onClick={async () => {
                  if (!confirmAction(`Restore version ${v.version}? It becomes a new version; nothing is lost.`)) return;
                  try {
                    const r = await restore.mutateAsync({ orgId, documentId, version: v.version });
                    await refresh();
                    toast(`Restored as version ${r.version}.`);
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Restore
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="row wrap gap-10">
        <input className="input" aria-label="Note for the new version" placeholder="What changed (for the new version)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 320 }} />
        <UploadButton
          label="Upload new version"
          className="btn btn-sm"
          orgId={orgId}
          isPublic={false}
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,image/*"
          onUploaded={async (file) => {
            try {
              const r = await addVersion.mutateAsync({ orgId, documentId, fileId: file.id, note: note.trim() });
              setNote("");
              await refresh();
              toast(r.told ? `Version ${r.version} saved. ${plural(r.told, "member")} told.` : `Version ${r.version} saved.`);
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        />
      </div>
      <div className="row wrap gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={update.isPending || !form.title.trim()}
          onClick={async () => {
            try {
              await update.mutateAsync({ orgId, documentId, title: form.title.trim(), folderId: form.folderId, notify: form.notify });
              await refresh();
              toast("Saved");
              onDone();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Save
        </button>
        <button className="btn btn-sm btn-w" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn btn-sm btn-w btn-danger"
          style={{ marginLeft: "auto" }}
          disabled={remove.isPending}
          onClick={async () => {
            if (!confirmAction(`Delete ${d.doc.title} and all its versions?`)) return;
            try {
              await remove.mutateAsync({ orgId, documentId });
              await refresh();
              onDone();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Delete
        </button>
      </div>
    </>
  );
}

function UploadModal({ open, onClose, orgId, folders, folderId }: { open: boolean; onClose: () => void; orgId: number; folders: Folder[]; folderId: number }) {
  const utils = trpc.useUtils();
  const create = trpc.member.admin.docs.create.useMutation();
  const [target, setTarget] = useState(folderId);
  const [title, setTitle] = useState("");
  const [notify, setNotify] = useState<Notify>("push_email");
  const [file, setFile] = useState<{ id: number; name: string } | null>(null);
  useEffect(() => {
    if (open) setTarget(folderId);
  }, [open, folderId]);
  const close = () => {
    setTitle("");
    setFile(null);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title="Upload a file">
      <div className="grid-2" style={{ gap: "12px 18px" }}>
        <Field label="Folder">
          <select className="select" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tell members">
          <select className="select" value={notify} onChange={(e) => setNotify(e.target.value as Notify)}>
            {(Object.keys(NOTIFY_LABEL) as Notify[]).map((k) => (
              <option key={k} value={k}>
                {NOTIFY_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" className="span-all">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      </div>
      <div className="row gap-10">
        <UploadButton
          label={file ? "Pick another" : "Pick a file"}
          className="btn btn-sm"
          orgId={orgId}
          isPublic={false}
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,image/*"
          onUploaded={(f) => {
            setFile({ id: f.id, name: f.name });
            if (!title.trim()) setTitle(f.name.replace(/\.[a-z0-9]{2,4}$/i, ""));
          }}
        />
        <span className="small muted clip">{file ? file.name : "PDF, Word, Excel, PowerPoint, text or images, up to 15 MB"}</span>
      </div>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={!file || !title.trim() || create.isPending}
          onClick={async () => {
            try {
              const r = await create.mutateAsync({ orgId, folderId: target, title: title.trim(), fileId: file!.id, notify });
              await utils.member.admin.docs.invalidate();
              toast(r.told ? `Saved. ${plural(r.told, "member")} told.` : "Saved");
              close();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Save
        </button>
        <button className="btn btn-sm btn-w" onClick={close}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

// =====================================================================
// Reports across programs
// =====================================================================

type Range = "12m" | "year" | "3y";
const RANGE_LABEL: Record<Range, string> = { "12m": "Last 12 months", year: "This year", "3y": "Last 3 years" };

export function AdminInsights() {
  return <NeedsOrg title="Reports across programs">{(orgId) => <InsightsScreen orgId={orgId} />}</NeedsOrg>;
}

function InsightsScreen({ orgId }: { orgId: number }) {
  const [tab, setTab] = useState<"reports" | "programs">("reports");
  const [range, setRange] = useState<Range>("12m");
  const [level, setLevel] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const report = trpc.member.admin.insights.report.useQuery({ orgId, range, level });
  const exportCsv = trpc.member.admin.insights.exportCsv.useMutation();
  const followUp = trpc.member.admin.insights.followUp.useMutation();
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  const r = report.data;
  const engCols = "minmax(0, 1.4fr) 100px 100px 120px 120px";
  return (
    <AdminPage
      title="Reports across programs"
      sub="Membership, events, CE, and committees in one place"
      actions={
        <button className="btn btn-primary" onClick={() => setScheduling(true)}>
          Schedule a report
        </button>
      }
    >
      <div className="col" style={{ gap: 0 }}>
        <FolderTabs
          tabs={[
            { key: "reports", label: "Reports" },
            { key: "programs", label: "Programs" },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="folder-body" style={{ borderTopLeftRadius: 0, background: "var(--ground)" }}>
          {tab === "programs" ? (
            <ProgramsTab orgId={orgId} />
          ) : (
            <>
              <div className="row wrap gap-10">
                <select className="select" aria-label="Date range" value={range} onChange={(e) => setRange(e.target.value as Range)} style={{ height: 38, width: "auto" }}>
                  {(Object.keys(RANGE_LABEL) as Range[]).map((k) => (
                    <option key={k} value={k}>
                      {RANGE_LABEL[k]}
                    </option>
                  ))}
                </select>
                <select className="select" aria-label="Member level" value={level} onChange={(e) => setLevel(e.target.value)} style={{ height: 38, width: "auto" }}>
                  <option value="">All member levels</option>
                  {(r?.levels ?? []).map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-sm"
                  style={{ height: 38 }}
                  disabled={exportCsv.isPending}
                  onClick={async () => {
                    try {
                      const out = await exportCsv.mutateAsync({ orgId, range, level });
                      downloadText(out.filename, out.csv);
                    } catch (err) {
                      toast(errorText(err), true);
                    }
                  }}
                >
                  Export CSV
                </button>
              </div>
              {report.isLoading ? (
                <PageLoading />
              ) : report.error ? (
                <ErrorNote error={report.error} />
              ) : (
                <>
                  <div className="grid-4">
                    <Kpi label="Active members" value={r!.kpis.activeMembers.toLocaleString("en-US")} note={r!.kpis.joinedInRange ? `${r!.kpis.joinedInRange} joined in this period` : undefined} />
                    <Kpi label="Renewal rate" value={r!.kpis.renewalRate === null ? "None yet" : `${r!.kpis.renewalRate}%`} note={r!.kpis.cohortCount ? `${r!.kpis.renewedCount} of ${r!.kpis.cohortCount} due renewed` : undefined} />
                    <Kpi label="CE hours issued" value={r!.kpis.ceHours.toLocaleString("en-US")} note={r!.kpis.ceChange === null ? undefined : `${r!.kpis.ceChange >= 0 ? "Up" : "Down"} ${Math.abs(r!.kpis.ceChange)}%`} bad={(r!.kpis.ceChange ?? 0) < 0} />
                    <Kpi label="Members with no activity" value={r!.kpis.noActivity.toLocaleString("en-US")} note={r!.kpis.noActivity ? "Follow up" : undefined} bad={r!.kpis.noActivity > 0} />
                  </div>
                  <div className="row wrap" style={{ gap: 16, alignItems: "stretch" }}>
                    <div className="card" style={{ flex: "1 1 420px", padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                      <span style={{ fontSize: 16, fontWeight: 800 }}>Renewal rate by programs used</span>
                      {r!.byPrograms.map((b, i) => (
                        <div key={b.label} style={{ display: "grid", gridTemplateColumns: "110px minmax(0, 1fr) 46px", gap: 10, alignItems: "center", fontSize: 13 }} title={plural(b.members, "member")}>
                          <span style={{ fontWeight: 600 }}>{b.label}</span>
                          <div style={{ height: 22, borderRadius: 6, background: "var(--line-2)", overflow: "hidden" }}>
                            <div style={{ width: `${b.rate ?? 0}%`, height: "100%", background: i === 3 ? "var(--accent)" : "var(--brand)" }} />
                          </div>
                          <span style={{ fontWeight: 800 }}>{b.rate === null ? "None" : `${b.rate}%`}</span>
                        </div>
                      ))}
                    </div>
                    <div className="card" style={{ flex: "1 1 420px", padding: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                      <div className="col" style={{ gap: 2, paddingBottom: 6 }}>
                        <span style={{ fontSize: 16, fontWeight: 800 }}>Renewals at risk</span>
                        <span className="muted" style={{ fontSize: 13 }}>Renewing in 90 days with low engagement</span>
                      </div>
                      {!r!.atRisk.length ? (
                        <span className="muted" style={{ fontSize: 13 }}>No one right now.</span>
                      ) : (
                        r!.atRisk.slice(0, 25).map((a, i, arr) => (
                          <div key={a.memberId} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 130px minmax(0, 1.3fr) 110px", gap: 10, padding: "10px 0", borderBottom: i < arr.length - 1 ? "1px solid var(--line)" : "none", fontSize: 13, alignItems: "center" }}>
                            <span className="strong clip">{a.name}</span>
                            <span className="muted">Renews {fmtDate(a.expiresOn)}</span>
                            <span>{a.reason}</span>
                            <button
                              className="btn btn-xs btn-w"
                              disabled={followed.has(a.memberId) || followUp.isPending}
                              onClick={async () => {
                                try {
                                  const res = await followUp.mutateAsync({ orgId, memberId: a.memberId });
                                  setFollowed(new Set(followed).add(a.memberId));
                                  toast(res.queued ? `${a.name} tagged "renewal at risk" on the LeadDash platform.` : "Connect the LeadDash platform in Settings to send follow-ups.", !res.queued);
                                } catch (err) {
                                  toast(errorText(err), true);
                                }
                              }}
                            >
                              {followed.has(a.memberId) ? "Sent" : "Follow up"}
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="table">
                    <div className="table-inner">
                      <div style={{ padding: "14px 18px 4px", fontSize: 16, fontWeight: 800 }}>Program engagement</div>
                      <THead cols={engCols} labels={["Program", "People", "Members", "Renewed", "Rating"]} />
                      {r!.engagement.map((e) => (
                        <div key={e.key} className="trow" style={{ gridTemplateColumns: engCols }}>
                          <div className="strong">{e.name}</div>
                          <div>{e.people.toLocaleString("en-US")}</div>
                          <div>{e.members.toLocaleString("en-US")}</div>
                          <div>{e.renewed === null ? "None" : `${e.renewed}%`}</div>
                          <div>{e.rating === null ? "Not rated" : `${e.rating} of 5`}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <span className="small muted">
                    {fmtDate(r!.range.start)} to {fmtDate(r!.range.end)}. Renewal rate counts members whose membership expired in this period: active members as renewed, lapsed or cancelled as not. Dues stay on the LeadDash platform.
                  </span>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <ScheduleModal open={scheduling} onClose={() => setScheduling(false)} orgId={orgId} levels={r?.levels ?? []} />
    </AdminPage>
  );
}

function ProgramsTab({ orgId }: { orgId: number }) {
  const utils = trpc.useUtils();
  const list = trpc.member.admin.insights.programs.list.useQuery({ orgId });
  const save = trpc.member.admin.insights.programs.save.useMutation();
  const [openId, setOpenId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const cols = "minmax(0, 1.6fr) 110px 110px minmax(0, 1.2fr) 96px";
  return (
    <>
      <div className="row wrap gap-10">
        <input className="input" aria-label="New program name" placeholder="New program, like Webinar series" value={name} onChange={(e) => setName(e.target.value)} style={{ height: 38, width: 320, maxWidth: "100%" }} />
        <button
          className="btn btn-sm"
          style={{ height: 38 }}
          disabled={name.trim().length < 2 || save.isPending}
          onClick={async () => {
            try {
              const p = await save.mutateAsync({ orgId, name: name.trim() });
              setName("");
              await utils.member.admin.insights.invalidate();
              setOpenId(p.id);
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Add program
        </button>
      </div>
      <div className="table">
        <div className="table-inner">
          <THead cols={cols} labels={["Program", "People", "Visits", "Dates", ""]} />
          {list.isLoading ? (
            <PageLoading />
          ) : list.error ? (
            <ErrorNote error={list.error} />
          ) : !list.data!.length ? (
            <Empty>Add programs outside events, like a webinar series or mentoring, then import who took part.</Empty>
          ) : (
            list.data!.map((p) => (
              <ExpandRow
                key={p.id}
                cols={cols}
                open={openId === p.id}
                onToggle={() => setOpenId(openId === p.id ? null : p.id)}
                cells={[<span className="strong">{p.name}</span>, <span>{p.people}</span>, <span>{p.participants}</span>, <span className="muted">{p.firstDate ? (p.firstDate === p.lastDate ? fmtDate(p.firstDate) : `${fmtDate(p.firstDate)} to ${fmtDate(p.lastDate)}`) : "None yet"}</span>]}
              >
                <ProgramEditor orgId={orgId} program={p} onDone={() => setOpenId(null)} />
              </ExpandRow>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function ProgramEditor({ orgId, program, onDone }: { orgId: number; program: Outputs["insights"]["programs"]["list"][number]; onDone: () => void }) {
  const utils = trpc.useUtils();
  const save = trpc.member.admin.insights.programs.save.useMutation();
  const remove = trpc.member.admin.insights.programs.remove.useMutation();
  const importCsv = trpc.member.admin.insights.programs.importParticipants.useMutation();
  const [name, setName] = useState(program.name);
  const [result, setResult] = useState<{ added: number; skipped: number; errors: string[] } | null>(null);
  return (
    <>
      <EditSection
        title="Program"
        saving={save.isPending}
        onCancel={() => setName(program.name)}
        onSave={async () => {
          await save.mutateAsync({ orgId, programId: program.id, name: name.trim() });
          await utils.member.admin.insights.invalidate();
          toast("Saved");
        }}
        actions={
          <button
            className="btn btn-sm btn-w btn-danger"
            onClick={async () => {
              if (!confirmAction(`Delete ${program.name} and its ${plural(program.participants, "visit")}?`)) return;
              try {
                await remove.mutateAsync({ orgId, programId: program.id });
                await utils.member.admin.insights.invalidate();
                onDone();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Delete
          </button>
        }
        view={<KV label="Name">{program.name}</KV>}
        edit={
          <Field label="Name">
            <input className="input" value={name} style={{ maxWidth: 360 }} onChange={(e) => setName(e.target.value)} />
          </Field>
        }
      />
      <div className="col gap-8">
        <span className="h3" style={{ fontSize: 14 }}>Who took part</span>
        <span className="small muted">CSV columns: email, date, rating (1 to 5, optional). The same email and date are added once.</span>
        <div className="row gap-10">
          <CsvPicker
            label={importCsv.isPending ? "Importing" : "Import CSV"}
            disabled={importCsv.isPending}
            onText={async (csv) => {
              try {
                const r = await importCsv.mutateAsync({ orgId, programId: program.id, csv });
                setResult(r);
                await utils.member.admin.insights.invalidate();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          />
        </div>
        {result ? (
          <div className="col gap-4">
            <span className="strong">
              {plural(result.added, "visit")} added{result.skipped ? `, ${result.skipped} already there` : ""}
            </span>
            {result.errors.map((e) => (
              <span key={e} className="err">
                {e}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

function ScheduleModal({ open, onClose, orgId, levels }: { open: boolean; onClose: () => void; orgId: number; levels: string[] }) {
  const utils = trpc.useUtils();
  const { me } = useAdmin();
  const list = trpc.member.admin.insights.schedules.list.useQuery({ orgId }, { enabled: open });
  const create = trpc.member.admin.insights.schedules.create.useMutation();
  const remove = trpc.member.admin.insights.schedules.remove.useMutation();
  const [email, setEmail] = useState(me.email);
  const [frequency, setFrequency] = useState<"weekly" | "monthly">("monthly");
  const [range, setRange] = useState<Range>("12m");
  const [level, setLevel] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Scheduled reports">
      {list.data?.length ? (
        <div className="col" style={{ gap: 0 }}>
          {list.data.map((s) => (
            <div key={s.id} className="row-between" style={{ padding: "8px 0", borderBottom: "1px solid var(--line-2)", fontSize: 13 }}>
              <div className="col" style={{ gap: 0, minWidth: 0 }}>
                <span className="strong clip">{s.email}</span>
                <span className="small muted">
                  {s.frequency === "weekly" ? "Weekly" : "Monthly"} · {RANGE_LABEL[s.range]}
                  {s.level ? ` · ${s.level}` : ""} · Next {fmtWhen(s.nextSendAt)}
                </span>
              </div>
              <button
                className="btn btn-xs btn-w"
                onClick={async () => {
                  await remove.mutateAsync({ orgId, scheduleId: s.id }).catch((err) => toast(errorText(err), true));
                  utils.member.admin.insights.schedules.list.invalidate();
                }}
              >
                Stop
              </button>
            </div>
          ))}
        </div>
      ) : (
        <span className="small muted">No scheduled reports yet.</span>
      )}
      <div className="grid-2" style={{ gap: "12px 18px" }}>
        <Field label="Send to" className="span-all">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="How often">
          <select className="select" value={frequency} onChange={(e) => setFrequency(e.target.value as "weekly" | "monthly")}>
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>
        <Field label="Date range">
          <select className="select" value={range} onChange={(e) => setRange(e.target.value as Range)}>
            {(Object.keys(RANGE_LABEL) as Range[]).map((k) => (
              <option key={k} value={k}>
                {RANGE_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Member level">
          <select className="select" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">All member levels</option>
            {levels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={!email.trim() || create.isPending}
          onClick={async () => {
            try {
              await create.mutateAsync({ orgId, email: email.trim(), frequency, range, level });
              await utils.member.admin.insights.schedules.list.invalidate();
              toast("Scheduled");
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Schedule
        </button>
        <button className="btn btn-sm btn-w" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
