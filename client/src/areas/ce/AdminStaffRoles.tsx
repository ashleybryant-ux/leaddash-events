/**
 * /admin/e/:eventId/staff: event staff roles (event admins only). Each row
 * expands in place: name, when access ends, sign-in method, what the role
 * can open, and the people in it.
 */
import { useEffect, useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { AdminPage, useAdminEvent } from "../../shells/AdminShell";
import { Empty, ErrorNote, ExpandRow, Field, PageLoading, THead, confirmAction } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";

type Data = RouterOutputs["ce"]["staff"]["list"];
type Role = Data["roles"][number];
type Level = "edit" | "view" | "none";

const COLS = "minmax(0, 1.1fr) minmax(0, 2fr) 90px 96px";

export function AdminStaffRoles() {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const q = trpc.ce.staff.list.useQuery({ eventId: ev.id });
  const create = trpc.ce.staff.create.useMutation();
  const [open, setOpen] = useState<number | null>(null);
  const [picked, setPicked] = useState(false);

  // Start with the check-in volunteer role open, the one most often changed.
  useEffect(() => {
    if (picked || !q.data) return;
    setPicked(true);
    setOpen(q.data.roles.find((r) => r.kind === "checkin")?.id ?? null);
  }, [q.data, picked]);

  return (
    <AdminPage
      title="Staff roles"
      actions={
        <button
          className="btn btn-primary"
          disabled={create.isPending}
          onClick={async () => {
            try {
              const row = await create.mutateAsync({ eventId: ev.id, name: "New role" });
              await utils.ce.staff.list.invalidate();
              setOpen(row.id);
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Add role
        </button>
      }
    >
      <div className="table">
        {q.isLoading ? (
          <PageLoading />
        ) : q.error ? (
          <ErrorNote error={q.error} />
        ) : (
          <div className="table-inner">
            <THead cols={COLS} labels={["Role", "Can see", "People", ""]} />
            {!q.data!.roles.length ? (
              <Empty>No roles yet.</Empty>
            ) : (
              q.data!.roles.map((r) => (
                <ExpandRow
                  key={r.id}
                  cols={COLS}
                  open={open === r.id}
                  onToggle={() => setOpen(open === r.id ? null : r.id)}
                  cells={[<span className="strong">{r.name}</span>, <span>{r.canSee}</span>, <span>{r.people.length}</span>]}
                >
                  <RoleEditor key={`${r.id}:${r.name}:${JSON.stringify(r.access)}:${r.endsWithEvent}:${r.signInWith}`} role={r} data={q.data!} onDone={() => setOpen(null)} />
                </ExpandRow>
              ))
            )}
          </div>
        )}
      </div>
    </AdminPage>
  );
}

function RoleEditor({ role, data, onDone }: { role: Role; data: Data; onDone: () => void }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const update = trpc.ce.staff.update.useMutation();
  const remove = trpc.ce.staff.remove.useMutation();
  const initial = () => ({
    name: role.name,
    endsWithEvent: role.endsWithEvent,
    signInWith: role.signInWith,
    access: Object.fromEntries(data.areas.map((a) => [a.key, (role.access[a.key] ?? "none") as Level])) as Record<string, Level>,
  });
  const [d, setD] = useState(initial);
  const isAdmin = role.kind === "event_admin";

  return (
    <>
      <div className="row-between">
        <div className="editor-title">Editing role</div>
        {role.kind === "custom" ? (
          <button
            className="btn btn-sm btn-w btn-danger"
            disabled={remove.isPending}
            onClick={async () => {
              if (!confirmAction(`Delete the ${role.name} role? The people in it lose this access.`)) return;
              try {
                await remove.mutateAsync({ eventId: ev.id, roleId: role.id });
                await utils.ce.staff.list.invalidate();
              } catch (err) {
                toast(errorText(err), true);
              }
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
      <div className="grid-3">
        <Field label="Role name">
          <input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </Field>
        <Field label="Access ends">
          <select className="select" value={d.endsWithEvent ? "event" : "never"} onChange={(e) => setD({ ...d, endsWithEvent: e.target.value === "event" })}>
            <option value="event">When the event ends</option>
            <option value="never">Never</option>
          </select>
        </Field>
        <Field label="Sign in with">
          <select className="select" value={d.signInWith} onChange={(e) => setD({ ...d, signInWith: e.target.value as "email" | "text" })}>
            <option value="email">Email code</option>
            <option value="text">Text code</option>
          </select>
        </Field>
      </div>

      <div className="col gap-8">
        <span className="editor-title" style={{ fontSize: 13 }}>What this role can open</span>
        {isAdmin ? (
          <span className="small muted">Event admins can open everything for this event.</span>
        ) : (
          <div className="grid-4">
            {data.areas.map((a) => (
              <Field key={a.key} label={a.label}>
                <select className="select" value={d.access[a.key]} onChange={(e) => setD({ ...d, access: { ...d.access, [a.key]: e.target.value as Level } })}>
                  <option value="edit">Edit</option>
                  <option value="view">View</option>
                  <option value="none">No access</option>
                </select>
              </Field>
            ))}
          </div>
        )}
        {role.kind === "booth" ? <span className="small muted">Booth staff also scan leads and see their own booth's leads.</span> : null}
        {role.kind === "speaker" ? <span className="small muted">Speakers also see their own sessions, poll results, and Q&amp;A.</span> : null}
        {role.kind === "reviewer" ? <span className="small muted">Reviewers only see proposals assigned to them, with names hidden.</span> : null}
      </div>

      <People role={role} vendors={data.vendors} />

      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={update.isPending || !d.name.trim()}
          onClick={async () => {
            try {
              await update.mutateAsync({ eventId: ev.id, roleId: role.id, name: d.name, endsWithEvent: d.endsWithEvent, signInWith: d.signInWith, access: d.access });
              toast("Saved");
              await utils.ce.staff.list.invalidate();
              onDone();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Save
        </button>
        <button
          className="btn btn-sm btn-w"
          onClick={() => {
            setD(initial());
            onDone();
          }}
        >
          Cancel
        </button>
      </div>
    </>
  );
}

function People({ role, vendors }: { role: Role; vendors: Data["vendors"] }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const add = trpc.ce.staff.addPerson.useMutation();
  const remove = trpc.ce.staff.removePerson.useMutation();
  const [email, setEmail] = useState("");
  const [vendorId, setVendorId] = useState("");
  const booth = role.kind === "booth";
  const cols = booth ? "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 96px" : "minmax(0, 1fr) minmax(0, 1fr) 96px";

  const submit = async () => {
    try {
      await add.mutateAsync({ eventId: ev.id, roleId: role.id, email, vendorId: vendorId ? Number(vendorId) : null });
      toast(`Added. We emailed ${email} a sign-in link.`);
      setEmail("");
      setVendorId("");
      await utils.ce.staff.list.invalidate();
    } catch (err) {
      toast(errorText(err), true);
    }
  };

  return (
    <div className="col gap-8">
      <span className="editor-title" style={{ fontSize: 13 }}>People in this role</span>
      {role.people.length ? (
        <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
          {role.people.map((p) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: cols, gap: 12, alignItems: "center", padding: "8px 12px", fontSize: 13 }}>
              <span className="strong clip">{p.name || p.email}</span>
              <span className="clip">{p.email}</span>
              {booth ? <span className="clip">{p.vendor || <span className="muted">No vendor</span>}</span> : null}
              <button
                className="btn btn-sm btn-w"
                disabled={remove.isPending}
                onClick={async () => {
                  if (!confirmAction(`Remove ${p.name || p.email} from ${role.name}?`)) return;
                  try {
                    await remove.mutateAsync({ eventId: ev.id, assignmentId: p.id });
                    await utils.ce.staff.list.invalidate();
                  } catch (err) {
                    toast(errorText(err), true);
                  }
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <span className="small muted">No one in this role yet.</span>
      )}
      <div style={{ display: "grid", gridTemplateColumns: booth ? "minmax(0, 1fr) minmax(0, 1fr) 96px" : "minmax(0, 1fr) 96px", gap: 10, maxWidth: 640 }}>
        <input className="input" type="email" aria-label="Add a person by email" placeholder="Add a person by email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && email.trim() && submit()} />
        {booth ? (
          <select className="select" aria-label="Vendor they work for" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Pick their vendor</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.company}
              </option>
            ))}
          </select>
        ) : null}
        <button className="btn btn-sm btn-w" disabled={!email.trim() || add.isPending || (booth && !vendorId)} onClick={submit}>
          Add
        </button>
      </div>
    </div>
  );
}
