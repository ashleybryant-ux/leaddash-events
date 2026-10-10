/** Screens that belong to the app itself: home, admin events list, association settings, event settings. */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../shells/AdminShell";
import { EditSection, Empty, ErrorNote, Field, KV, Modal, PageLoading, Pill, UploadButton, confirmAction } from "../ui/components";
import { errorText, toast } from "../ui/toast";
import { fmtDates } from "@shared/format";
import { SignIn } from "./SignIn";
import { IconLeaf } from "../ui/icons";

/** "/": where a signed-in person goes (their events, member hubs, admin). */
export function HomeScreen() {
  const auth = trpc.auth.me.useQuery();
  const mine = trpc.core.events.mine.useQuery(undefined, { enabled: !!auth.data });
  const memberships = trpc.core.events.memberships.useQuery(undefined, { enabled: !!auth.data });
  const [, navigate] = useLocation();
  if (auth.isLoading) return <PageLoading />;
  return (
    <div className="app">
      <header className="app-header">
        <div className="row">
          <IconLeaf />
          <div className="wordmark-text">
            <b>LEADDASH</b>
            <span>EVENTS</span>
          </div>
        </div>
      </header>
      <main className="app-body">
        {!auth.data ? (
          <SignIn title="Sign in" subtitle="Enter your email. We will send you a six-digit code." />
        ) : mine.isLoading ? (
          <PageLoading />
        ) : (
          <>
            {auth.data.orgs.length || auth.data.isLeadDashStaff ? (
              <button className="btn btn-block" onClick={() => navigate("/admin")}>
                Open the admin
              </button>
            ) : null}
            <div className="section-title">Your events</div>
            {mine.data?.length ? (
              mine.data.map((e) => (
                <Link key={e.id} href={`/e/${e.slug}`} className="tile">
                  <div className="grow col gap-4" style={{ gap: 2 }}>
                    <span className="strong" style={{ fontSize: 15 }}>{e.name}</span>
                    <span className="small muted">{fmtDates(e.startDate, e.endDate)}</span>
                  </div>
                </Link>
              ))
            ) : (
              <Empty>No events yet for {auth.data.email}.</Empty>
            )}
            {memberships.data?.length ? (
              <>
                <div className="section-title">Member hubs</div>
                {memberships.data.map((m) => (
                  <Link key={m.orgSlug} href={`/m/${m.orgSlug}`} className="tile">
                    <span className="strong grow">{m.orgName}</span>
                  </Link>
                ))}
              </>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

/** /admin: the association's events, plus creating an event. */
export function AdminHomeScreen() {
  const { me, orgId, setOrgId } = useAdmin();
  const events = trpc.core.events.list.useQuery({ orgId: orgId ?? 0 }, { enabled: !!orgId });
  const allOrgs = trpc.core.org.all.useQuery(undefined, { enabled: me.isLeadDashStaff });
  const [creating, setCreating] = useState(false);
  const [newOrg, setNewOrg] = useState(false);

  return (
    <AdminPage
      title="Events"
      actions={
        <>
          {me.isLeadDashStaff ? (
            <button className="btn" onClick={() => setNewOrg(true)}>
              New association
            </button>
          ) : null}
          {orgId ? (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              New event
            </button>
          ) : null}
        </>
      }
    >
      {me.isLeadDashStaff ? (
        <div className="row gap-8">
          <span className="sub">Association</span>
          <select className="select" style={{ maxWidth: 320 }} value={orgId ?? ""} onChange={(e) => setOrgId(Number(e.target.value))}>
            <option value="" disabled>
              Pick an association
            </option>
            {(allOrgs.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <Pill tone="gray">Tech support</Pill>
        </div>
      ) : me.orgs.length > 1 ? (
        <div className="row gap-8">
          <span className="sub">Association</span>
          <select className="select" style={{ maxWidth: 320 }} value={orgId ?? ""} onChange={(e) => setOrgId(Number(e.target.value))}>
            {me.orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {!orgId ? (
        <Empty>{me.isLeadDashStaff ? "Pick an association, or add a new one." : "Your email is not on an association's admin team yet. Ask the association's owner to add you."}</Empty>
      ) : events.isLoading ? (
        <PageLoading />
      ) : events.error ? (
        <ErrorNote error={events.error} />
      ) : !events.data?.length ? (
        <Empty>No events yet. Click New event to set up the first one.</Empty>
      ) : (
        <div className="table">
          <div className="table-inner">
            <div className="trow thead" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1fr) 90px 96px" }}>
              <div>Event</div>
              <div>Dates</div>
              <div>Venue</div>
              <div>Status</div>
              <div />
            </div>
            {events.data.map((e) => (
              <div key={e.id} className="trow" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1fr) 90px 96px" }}>
                <div className="strong">{e.name}</div>
                <div>{fmtDates(e.startDate, e.endDate)}</div>
                <div className="muted clip">{e.venueName || "Not set"}</div>
                <div>
                  <Pill tone={e.status === "live" ? "green" : e.status === "draft" ? "orange" : "gray"}>{e.status === "live" ? "Live" : e.status === "draft" ? "Draft" : "Ended"}</Pill>
                </div>
                <Link className="btn btn-sm btn-w" href={`/admin/e/${e.id}/sessions`}>
                  Open
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
      <NewEventModal open={creating} onClose={() => setCreating(false)} orgId={orgId} />
      <NewOrgModal open={newOrg} onClose={() => setNewOrg(false)} onCreated={(id) => setOrgId(id)} />
    </AdminPage>
  );
}

function NewEventModal({ open, onClose, orgId }: { open: boolean; onClose: () => void; orgId: number | null }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const create = trpc.core.events.create.useMutation();
  const [f, setF] = useState({ name: "", shortName: "", startDate: "", endDate: "", venueName: "", venueAddress: "", city: "", timezone: "America/Chicago" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="New event">
      <div className="grid-2">
        <Field label="Event name" className="span-2">
          <input className="input" value={f.name} onChange={set("name")} placeholder="NABC Annual Conference" />
        </Field>
        <Field label="Short name (app header)">
          <input className="input" value={f.shortName} onChange={set("shortName")} placeholder="NABC 2027" />
        </Field>
        <Field label="Time zone">
          <select className="select" value={f.timezone} onChange={set("timezone")}>
            {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"].map((z) => (
              <option key={z} value={z}>
                {z.replace("America/", "").replace("Pacific/", "").replace("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Starts">
          <input className="input" type="date" value={f.startDate} onChange={set("startDate")} />
        </Field>
        <Field label="Ends">
          <input className="input" type="date" value={f.endDate} onChange={set("endDate")} />
        </Field>
        <Field label="Venue">
          <input className="input" value={f.venueName} onChange={set("venueName")} />
        </Field>
        <Field label="City">
          <input className="input" value={f.city} onChange={set("city")} />
        </Field>
        <Field label="Venue address" className="span-2">
          <input className="input" value={f.venueAddress} onChange={set("venueAddress")} />
        </Field>
      </div>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={create.isPending || !orgId}
          onClick={async () => {
            try {
              const ev = await create.mutateAsync({ orgId: orgId!, ...f });
              await utils.core.events.list.invalidate();
              onClose();
              navigate(`/admin/e/${ev.id}/sessions`);
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Create
        </button>
        <button className="btn btn-sm btn-w" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function NewOrgModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const utils = trpc.useUtils();
  const create = trpc.core.org.create.useMutation();
  const [f, setF] = useState({ name: "", ownerEmail: "", ownerName: "" });
  return (
    <Modal open={open} onClose={onClose} title="New association">
      <div className="grid-2">
        <Field label="Association name" className="span-2">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Owner's name">
          <input className="input" value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} />
        </Field>
        <Field label="Owner's email">
          <input className="input" type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} />
        </Field>
      </div>
      <div className="row gap-10">
        <button
          className="btn btn-sm btn-solid btn-w"
          disabled={create.isPending}
          onClick={async () => {
            try {
              const org = await create.mutateAsync(f);
              await utils.core.org.all.invalidate();
              onCreated(org.id);
              onClose();
            } catch (err) {
              toast(errorText(err), true);
            }
          }}
        >
          Create
        </button>
        <button className="btn btn-sm btn-w" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

/** /admin/settings: association details, admin team, and (LeadDash staff) the platform connection. */
export function OrgSettingsScreen() {
  const { orgId, me } = useAdmin();
  const utils = trpc.useUtils();
  const org = trpc.core.org.get.useQuery({ orgId: orgId ?? 0 }, { enabled: !!orgId });
  const team = trpc.core.org.team.useQuery({ orgId: orgId ?? 0 }, { enabled: !!orgId });
  const update = trpc.core.org.update.useMutation();
  const addAdmin = trpc.core.org.addAdmin.useMutation();
  const removeAdmin = trpc.core.org.removeAdmin.useMutation();
  const platform = trpc.core.platform.status.useQuery(undefined, { enabled: me.isLeadDashStaff });
  const authorize = trpc.core.platform.authorizeUrl.useMutation();
  const setLocation = trpc.core.org.setPlatformLocation.useMutation();
  const [draft, setDraft] = useState<{ name: string; colorPrimary: string; colorAccent: string; logoFileId: number | null; logoUrl: string | null } | null>(null);
  const [invite, setInvite] = useState({ email: "", name: "" });
  const [loc, setLoc] = useState<string | null>(null);
  if (!orgId) return <AdminPage title="Settings"><Empty>Pick an association on the Events screen first.</Empty></AdminPage>;
  if (org.isLoading) return <AdminPage title="Settings"><PageLoading /></AdminPage>;
  if (org.error) return <AdminPage title="Settings"><ErrorNote error={org.error} /></AdminPage>;
  const o = org.data!;
  const d = draft ?? { name: o.name, colorPrimary: o.colorPrimary, colorAccent: o.colorAccent, logoFileId: o.logoFileId, logoUrl: o.logoUrl };
  const params = new URLSearchParams(window.location.search);

  return (
    <AdminPage title="Settings" sub={o.name}>
      {params.get("platform") === "connected" ? <div className="banner banner-ok">The LeadDash platform is connected.</div> : null}
      {params.get("platform") === "failed" ? <div className="banner banner-bad">The LeadDash platform connection did not finish. Try again.</div> : null}
      <div className="card card-pad">
        <EditSection
          title="Association"
          saving={update.isPending}
          onCancel={() => setDraft(null)}
          onSave={async () => {
            await update.mutateAsync({ orgId, name: d.name, colorPrimary: d.colorPrimary, colorAccent: d.colorAccent, logoFileId: d.logoFileId });
            await utils.core.org.get.invalidate();
            setDraft(null);
          }}
          view={
            <div>
              <KV label="Name">{o.name}</KV>
              <KV label="Brand colors">
                <span className="row gap-8">
                  <span style={{ width: 18, height: 18, borderRadius: 4, background: o.colorPrimary, display: "inline-block" }} /> {o.colorPrimary}
                  <span style={{ width: 18, height: 18, borderRadius: 4, background: o.colorAccent, display: "inline-block", marginLeft: 12 }} /> {o.colorAccent}
                </span>
              </KV>
              <KV label="Logo">{o.logoUrl ? <img src={o.logoUrl} alt="Logo" style={{ height: 36 }} /> : null}</KV>
              <KV label="Member hub link">{`${window.location.origin}/m/${o.slug}`}</KV>
            </div>
          }
          edit={
            <div className="grid-3">
              <Field label="Name">
                <input className="input" value={d.name} onChange={(e) => setDraft({ ...d, name: e.target.value })} />
              </Field>
              <Field label="Main color">
                <input className="input" type="color" value={d.colorPrimary} onChange={(e) => setDraft({ ...d, colorPrimary: e.target.value })} />
              </Field>
              <Field label="Button color">
                <input className="input" type="color" value={d.colorAccent} onChange={(e) => setDraft({ ...d, colorAccent: e.target.value })} />
              </Field>
              <div className="field span-3">
                Logo
                <div className="row gap-8">
                  {d.logoUrl ? <img src={d.logoUrl} alt="Logo" style={{ height: 36 }} /> : null}
                  <UploadButton orgId={orgId} label={d.logoUrl ? "Replace" : "Upload"} onUploaded={(f) => setDraft({ ...d, logoFileId: f.id, logoUrl: f.url })} />
                </div>
              </div>
            </div>
          }
        />
      </div>

      <div className="card card-pad col gap-12">
        <div className="row-between">
          <span className="h3" style={{ fontSize: 14 }}>Admin team</span>
        </div>
        <div className="list">
          {(team.data ?? []).map((t) => (
            <div key={t.id} className="row" style={{ padding: "10px 0" }}>
              <span className="strong grow">{t.name || t.email}</span>
              <span className="muted grow">{t.email}</span>
              <Pill tone={t.role === "owner" ? "orange" : "gray"}>{t.role === "owner" ? "Owner" : "Admin"}</Pill>
              {t.role !== "owner" && o.role !== "admin" ? (
                <button
                  className="btn btn-sm btn-w"
                  onClick={async () => {
                    if (!confirmAction(`Remove ${t.email} from the admin team?`)) return;
                    await removeAdmin.mutateAsync({ orgId, memberRowId: t.id }).catch((err) => toast(errorText(err), true));
                    utils.core.org.team.invalidate();
                  }}
                >
                  Remove
                </button>
              ) : (
                <span style={{ width: 96 }} />
              )}
            </div>
          ))}
        </div>
        {o.role !== "admin" ? (
          <div className="row gap-8" style={{ maxWidth: 640 }}>
            <input className="input" placeholder="Name" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
            <input className="input" placeholder="Email" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            <button
              className="btn btn-sm btn-w"
              onClick={async () => {
                try {
                  await addAdmin.mutateAsync({ orgId, ...invite });
                  setInvite({ email: "", name: "" });
                  utils.core.org.team.invalidate();
                  toast("Added. They sign in with their email.");
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Add
            </button>
          </div>
        ) : null}
      </div>

      {me.isLeadDashStaff ? (
        <div className="card card-pad col gap-12">
          <span className="h3" style={{ fontSize: 14 }}>LeadDash platform (LeadDash staff only)</span>
          <KV label="Marketplace app">{platform.data?.configured ? "Set on the server" : "GHL_CLIENT_ID and GHL_CLIENT_SECRET are not set"}</KV>
          <KV label="Agency authorization">{platform.data?.connected ? `Connected (${platform.data.companyId})` : "Not authorized yet"}</KV>
          <KV label="This association's sub-account">{o.platformLocationId || "Not set"}</KV>
          <div className="row gap-8 wrap">
            <button
              className="btn btn-sm"
              onClick={async () => {
                try {
                  const { url } = await authorize.mutateAsync();
                  window.location.href = url;
                } catch (err) {
                  toast(errorText(err), true);
                }
              }}
            >
              Authorize the agency
            </button>
            <input className="input" style={{ maxWidth: 260 }} placeholder="Sub-account (location) ID" value={loc ?? o.platformLocationId ?? ""} onChange={(e) => setLoc(e.target.value)} />
            <button
              className="btn btn-sm btn-w"
              onClick={async () => {
                await setLocation.mutateAsync({ orgId, locationId: (loc ?? "").trim() || null }).catch((err) => toast(errorText(err), true));
                utils.core.org.get.invalidate();
                toast("Saved");
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
    </AdminPage>
  );
}

/** /admin/e/:id/settings: the event's basics. */
export function EventSettingsScreen() {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const update = trpc.core.events.update.useMutation();
  const blank = { name: ev.name, shortName: ev.shortName, startDate: ev.startDate, endDate: ev.endDate, timezone: ev.timezone, venueName: ev.venueName, venueAddress: ev.venueAddress, city: ev.city, capacity: ev.capacity, status: ev.status };
  const [d, setD] = useState(blank);
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const appLink = `${window.location.origin}/e/${ev.slug}`;
  return (
    <AdminPage title="Event settings">
      <div className="card card-pad">
        <EditSection
          title="Event"
          saving={update.isPending}
          onCancel={() => setD(blank)}
          onSave={async () => {
            await update.mutateAsync({ eventId: ev.id, ...d, capacity: d.capacity ? Number(d.capacity) : null });
            await utils.core.events.get.invalidate();
          }}
          view={
            <div>
              <KV label="Name">{ev.name}</KV>
              <KV label="Short name">{ev.shortName}</KV>
              <KV label="Dates">{fmtDates(ev.startDate, ev.endDate)}</KV>
              <KV label="Time zone">{ev.timezone}</KV>
              <KV label="Venue">{[ev.venueName, ev.venueAddress, ev.city].filter(Boolean).join(", ")}</KV>
              <KV label="Capacity">{ev.capacity ? String(ev.capacity) : ""}</KV>
              <KV label="Status">{ev.status === "live" ? "Live" : ev.status === "draft" ? "Draft (attendees cannot open the app yet)" : "Ended"}</KV>
              <KV label="Attendee app link">{appLink}</KV>
            </div>
          }
          edit={
            <div className="grid-3">
              <Field label="Name" className="span-2">
                <input className="input" value={d.name} onChange={set("name")} />
              </Field>
              <Field label="Short name">
                <input className="input" value={d.shortName} onChange={set("shortName")} />
              </Field>
              <Field label="Starts">
                <input className="input" type="date" value={d.startDate} onChange={set("startDate")} />
              </Field>
              <Field label="Ends">
                <input className="input" type="date" value={d.endDate} onChange={set("endDate")} />
              </Field>
              <Field label="Time zone">
                <input className="input" value={d.timezone} onChange={set("timezone")} />
              </Field>
              <Field label="Venue">
                <input className="input" value={d.venueName} onChange={set("venueName")} />
              </Field>
              <Field label="City">
                <input className="input" value={d.city} onChange={set("city")} />
              </Field>
              <Field label="Capacity">
                <input className="input" inputMode="numeric" value={d.capacity ?? ""} onChange={(e) => setD({ ...d, capacity: e.target.value ? Number(e.target.value.replace(/\D/g, "")) : null })} />
              </Field>
              <Field label="Venue address" className="span-2">
                <input className="input" value={d.venueAddress} onChange={set("venueAddress")} />
              </Field>
              <Field label="Status">
                <select className="select" value={d.status} onChange={set("status")}>
                  <option value="draft">Draft</option>
                  <option value="live">Live</option>
                  <option value="ended">Ended</option>
                </select>
              </Field>
            </div>
          }
        />
      </div>
    </AdminPage>
  );
}
