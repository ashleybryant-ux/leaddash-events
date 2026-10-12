/** Screens that belong to the app itself: home, admin events list, organization settings, event settings. */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "../lib/trpc";
import { AdminPage, useAdmin, useAdminEvent } from "../shells/AdminShell";
import { EditSection, Empty, ErrorNote, ExpandRow, Field, KV, Modal, PageLoading, Pill, UploadButton, confirmAction, NumStrip } from "../ui/components";
import { errorText, toast } from "../ui/toast";
import { fmtDate, fmtDates, fmtMoney } from "@shared/format";
import { eventHasEnded } from "@shared/time";
import { US_STATES, addressLines, hasPlace, mapsLink } from "@shared/address";
import { MapPreview } from "../ui/MapPreview";
import { AdminSignInPage } from "./AdminSignIn";
import { IconCheck, IconLock } from "../ui/icons";
import { LeadDashLogo } from "../ui/Logo";

/** "/": where a signed-in person goes (their events, admin). */
export function HomeScreen() {
  const auth = trpc.auth.me.useQuery();
  const mine = trpc.core.events.mine.useQuery(undefined, { enabled: !!auth.data });
  const [, navigate] = useLocation();
  if (auth.isLoading) return <PageLoading />;
  if (!auth.data) return <AdminSignInPage />;
  return (
    <div className="app">
      <header className="app-header">
        <div className="row">
          <LeadDashLogo tone="white" height={44} />
        </div>
      </header>
      <main className="app-body">
        {mine.isLoading ? (
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
          </>
        )}
      </main>
    </div>
  );
}

/** /admin: the organization's events, plus creating an event. */
export function AdminHomeScreen() {
  const { me, orgId, setOrgId } = useAdmin();
  const events = trpc.core.events.list.useQuery({ orgId: orgId ?? 0 }, { enabled: !!orgId });
  const allOrgs = trpc.core.org.all.useQuery(undefined, { enabled: me.isLeadDashStaff });
  const org = trpc.core.org.get.useQuery({ orgId: orgId ?? 0 }, { enabled: !!orgId });
  const [creating, setCreating] = useState(false);
  const [atLimit, setAtLimit] = useState(false);
  const [newOrg, setNewOrg] = useState(false);
  const included = org.data?.eventAllowance ?? 1;
  const used = events.data?.length ?? 0;

  return (
    <AdminPage
      title="Events"
      actions={
        <>
          {me.isLeadDashStaff ? (
            <button className="btn" onClick={() => setNewOrg(true)}>
              New organization
            </button>
          ) : null}
          {orgId ? (
            <button className="btn btn-primary" disabled={!events.data || !org.data} onClick={() => (used >= included ? setAtLimit(true) : setCreating(true))}>
              New event
            </button>
          ) : null}
        </>
      }
    >
      {me.isLeadDashStaff ? (
        <div className="row gap-8">
          <span className="sub">Organization</span>
          <select className="select" style={{ maxWidth: 320 }} value={orgId ?? ""} onChange={(e) => setOrgId(Number(e.target.value))}>
            <option value="" disabled>
              Pick an organization
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
          <span className="sub">Organization</span>
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
        <Empty>{me.isLeadDashStaff ? "Pick an organization, or add a new one." : "Your email is not on an organization's admin team yet. Ask the organization's owner to add you."}</Empty>
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
                  {e.status === "ended" || eventHasEnded(e.endDate, e.timezone) ? <Pill tone="gray">Ended</Pill> : <Pill tone={e.status === "live" ? "green" : "orange"}>{e.status === "live" ? "Live" : "Draft"}</Pill>}
                </div>
                <Link className="btn btn-sm btn-w" href={`/admin/e/${e.id}`}>
                  Open
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
      <NewEventModal open={creating} onClose={() => setCreating(false)} orgId={orgId} />
      <EventLimitModal open={atLimit} onClose={() => setAtLimit(false)} included={included} orgName={org.data?.name ?? ""} events={events.data ?? []} />
      <NewOrgModal open={newOrg} onClose={() => setNewOrg(false)} onCreated={(id) => setOrgId(id)} />
    </AdminPage>
  );
}

/** Shown instead of the new event form once the organization has added every event its account includes. */
function EventLimitModal({ open, onClose, included, orgName, events }: { open: boolean; onClose: () => void; included: number; orgName: string; events: { id: number; name: string; startDate: string; endDate: string }[] }) {
  const one = included === 1;
  const mail = `mailto:info@leaddash.io?subject=${encodeURIComponent(`Add an event for ${orgName || "our organization"}`)}`;
  return (
    <Modal open={open} onClose={onClose} title={`Your account includes ${included} event${one ? "" : "s"}`}>
      <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
        {one ? "Your included event is already set up." : "Your included events are already set up."} To add another event, contact LeadDash and we will add it to your account.
      </p>
      <div className="col gap-8">
        {events.map((e) => (
          <div key={e.id} className="limit-event">
            <span className="strong">{e.name}</span>
            <span className="small muted">{fmtDates(e.startDate, e.endDate)}</span>
          </div>
        ))}
      </div>
      <div className="row gap-10" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-sm" style={{ width: 140 }} onClick={onClose}>
          Close
        </button>
        <a className="btn btn-sm btn-solid" style={{ width: 140 }} href={mail}>
          Email LeadDash
        </a>
      </div>
    </Modal>
  );
}

function NewEventModal({ open, onClose, orgId }: { open: boolean; onClose: () => void; orgId: number | null }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const create = trpc.core.events.create.useMutation();
  const [f, setF] = useState({ name: "", shortName: "", startDate: "", endDate: "", venueName: "", venueAddress: "", city: "", state: "", zip: "", timezone: "America/Chicago" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="New event">
      <div className="grid-2">
        <Field label="Event name" className="span-2">
          <input className="input" value={f.name} onChange={set("name")} placeholder="Annual Conference" />
        </Field>
        <Field label="Short name (app header)">
          <input className="input" value={f.shortName} onChange={set("shortName")} placeholder="Conference 2027" />
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
        <Field label="Venue or hotel name" className="span-2">
          <input className="input" value={f.venueName} onChange={set("venueName")} />
        </Field>
        <Field label="Street address" className="span-2">
          <input className="input" value={f.venueAddress} onChange={set("venueAddress")} />
        </Field>
        <Field label="City">
          <input className="input" value={f.city} onChange={set("city")} />
        </Field>
        <div className="grid-2" style={{ gap: 10 }}>
          <Field label="State">
            <select className="select" value={f.state} onChange={set("state")}>
              <option value="">Pick</option>
              {US_STATES.map(([code]) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
          </Field>
          <Field label="ZIP code">
            <input className="input" inputMode="numeric" maxLength={10} value={f.zip} onChange={set("zip")} />
          </Field>
        </div>
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
              navigate(`/admin/e/${ev.id}`);
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
    <Modal open={open} onClose={onClose} title="New organization">
      <div className="grid-2">
        <Field label="Organization name" className="span-2">
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

/** /admin/settings: organization details and the admin team. Organizations see exactly this page. */
export function OrgSettingsScreen() {
  const { orgId, me } = useAdmin();
  const utils = trpc.useUtils();
  const org = trpc.core.org.get.useQuery({ orgId: orgId ?? 0 }, { enabled: !!orgId });
  const team = trpc.core.org.team.useQuery({ orgId: orgId ?? 0 }, { enabled: !!orgId });
  const update = trpc.core.org.update.useMutation();
  const addAdmin = trpc.core.org.addAdmin.useMutation();
  const removeAdmin = trpc.core.org.removeAdmin.useMutation();
  const transfer = trpc.core.org.transferOwner.useMutation();
  const [handing, setHanding] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ name: string; colorPrimary: string; colorAccent: string; colorHighlight: string; logoFileId: number | null; logoUrl: string | null; allEvents?: boolean } | null>(null);
  const [invite, setInvite] = useState({ email: "", name: "" });
  if (!orgId) return <AdminPage title="Organization settings"><Empty>Pick an organization on the Events screen first.</Empty></AdminPage>;
  if (org.isLoading) return <AdminPage title="Organization settings"><PageLoading /></AdminPage>;
  if (org.error) return <AdminPage title="Organization settings"><ErrorNote error={org.error} /></AdminPage>;
  const o = org.data!;
  const d = draft ?? { name: o.name, colorPrimary: o.colorPrimary, colorAccent: o.colorAccent, colorHighlight: o.colorHighlight, logoFileId: o.logoFileId, logoUrl: o.logoUrl, allEvents: false };
  return (
    <AdminPage title="Organization settings" sub={o.name}>
      <div className="card card-pad">
        <EditSection
          title="Organization"
          saving={update.isPending}
          onCancel={() => setDraft(null)}
          onSave={async () => {
            const res = await update.mutateAsync({ orgId, name: d.name, colorPrimary: d.colorPrimary, colorAccent: d.colorAccent, colorHighlight: d.colorHighlight, logoFileId: d.logoFileId, allEvents: !!d.allEvents });
            await Promise.all([utils.core.org.get.invalidate(), utils.core.org.all.invalidate(), utils.auth.me.invalidate(), utils.core.events.invalidate(), utils.program.branding.invalidate()]);
            setDraft(null);
            toast(res.eventsUpdated ? `Saved. ${res.eventsUpdated === 1 ? "1 event uses" : `${res.eventsUpdated} events use`} the new look.` : "Saved");
          }}
          view={
            <div>
              <KV label="Name">{o.name}</KV>
              <KV label="Brand colors">
                <span className="row gap-16" style={{ flexWrap: "wrap" }}>
                  <Swatch label="Main" color={o.colorPrimary} />
                  <Swatch label="Buttons" color={o.colorAccent} />
                  <Swatch label="Highlight" color={o.colorHighlight} empty="Same as main" />
                </span>
              </KV>
              <KV label="Logo">{o.logoUrl ? <img src={o.logoUrl} alt="Logo" style={{ height: 36 }} /> : null}</KV>
            </div>
          }
          edit={
            <div className="grid-3">
              <Field label="Name" className="span-3">
                <input className="input" value={d.name} onChange={(e) => setDraft({ ...d, name: e.target.value })} />
              </Field>
              <Field label="Main color">
                <input className="input" type="color" value={d.colorPrimary} onChange={(e) => setDraft({ ...d, colorPrimary: e.target.value })} />
              </Field>
              <Field label="Button color">
                <input className="input" type="color" value={d.colorAccent} onChange={(e) => setDraft({ ...d, colorAccent: e.target.value })} />
              </Field>
              <Field label="Highlight color">
                <div className="row gap-8">
                  <input className="input" type="color" value={d.colorHighlight || d.colorPrimary} onChange={(e) => setDraft({ ...d, colorHighlight: e.target.value })} style={{ flex: 1 }} />
                  {d.colorHighlight ? (
                    <button type="button" className="btn btn-sm" onClick={() => setDraft({ ...d, colorHighlight: "" })}>
                      Same as main
                    </button>
                  ) : null}
                </div>
              </Field>
              <span className="small muted span-3">Main color: headers. Button color: buttons. Highlight color: tags, links and the selected tab.</span>
              <div className="field span-3">
                Logo
                <div className="row gap-8">
                  {d.logoUrl ? <img src={d.logoUrl} alt="Logo" style={{ height: 36 }} /> : null}
                  <UploadButton orgId={orgId} label={d.logoUrl ? "Replace" : "Upload"} onUploaded={(f) => setDraft({ ...d, logoFileId: f.id, logoUrl: f.url })} />
                </div>
              </div>
              <div className="col gap-6 span-3">
                <span className="small muted">Events using the organization's colors and logo change with them. An event with its own look keeps it.</span>
                <label className="check">
                  <input type="checkbox" checked={!!d.allEvents} onChange={(e) => setDraft({ ...d, allEvents: e.target.checked })} />
                  Use these colors and logo on every event
                </label>
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
          {(team.data ?? []).map((t) => {
            const who = t.name || t.email;
            const open = handing === t.id;
            return (
              <div key={t.id} className="col">
                <div className="row team-row" style={{ padding: "10px 0" }}>
                  <span className="strong grow">{who}</span>
                  <span className="muted grow team-email">{t.email}</span>
                  <Pill tone={t.role === "owner" ? "orange" : "gray"}>{t.role === "owner" ? "Owner" : "Admin"}</Pill>
                  {/* Only the owner hands the organization on; LeadDash staff do it from LeadDash tools. */}
                  {t.role !== "owner" && o.role === "owner" ? (
                    <button className="btn btn-sm btn-w-lg" aria-expanded={open} onClick={() => setHanding(open ? null : t.id)}>
                      {open ? "Close" : "Make owner"}
                    </button>
                  ) : o.role === "owner" ? (
                    <span style={{ width: 120 }} />
                  ) : null}
                  {t.role !== "owner" && o.role !== "admin" ? (
                    <button
                      className="btn btn-sm btn-w-lg"
                      onClick={async () => {
                        if (!confirmAction(`Remove ${t.email} from the admin team?`)) return;
                        await removeAdmin.mutateAsync({ orgId, memberRowId: t.id }).catch((err) => toast(errorText(err), true));
                        utils.core.org.team.invalidate();
                      }}
                    >
                      Remove
                    </button>
                  ) : (
                    <span style={{ width: 120 }} />
                  )}
                </div>
                {open ? (
                  <div className="owner-confirm">
                    <div className="col gap-6">
                      <span className="strong">Make {who} the owner?</span>
                      <ul>
                        <li>{who} can add and remove admins, including you, and transfer ownership again.</li>
                        <li>You stay on the team as an admin.</li>
                        <li>Payment notices and replies from vendors go to {who}, unless a checkout page has its own notice email.</li>
                      </ul>
                    </div>
                    <div className="row gap-8 wrap">
                      <button
                        className="btn btn-sm btn-solid btn-w-lg"
                        style={{ width: 170 }}
                        disabled={transfer.isPending}
                        onClick={async () => {
                          try {
                            await transfer.mutateAsync({ orgId, memberRowId: t.id });
                            setHanding(null);
                            await Promise.all([utils.core.org.team.invalidate(), utils.core.org.get.invalidate(), utils.auth.me.invalidate()]);
                            toast(`${who} is the owner now.`);
                          } catch (err) {
                            toast(errorText(err), true);
                          }
                        }}
                      >
                        Transfer ownership
                      </button>
                      <button className="btn btn-sm btn-w-lg" onClick={() => setHanding(null)}>Cancel</button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
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

    </AdminPage>
  );
}

/** /admin/leaddash: LeadDash staff tools for the organization picked on the Events screen. Organizations never see this page. */
export function LeadDashToolsScreen() {
  const { me, orgId } = useAdmin();
  const utils = trpc.useUtils();
  const org = trpc.core.org.get.useQuery({ orgId: orgId ?? 0 }, { enabled: !!orgId && me.isLeadDashStaff });
  const platform = trpc.core.platform.status.useQuery(undefined, { enabled: me.isLeadDashStaff });
  const authorize = trpc.core.platform.authorizeUrl.useMutation();
  const setLocation = trpc.core.org.setPlatformLocation.useMutation();
  const [loc, setLoc] = useState<string | null>(null);
  if (!me.isLeadDashStaff) return <AdminPage title="LeadDash tools"><Empty>This page is for LeadDash staff.</Empty></AdminPage>;
  if (!orgId) return <AdminPage title="LeadDash tools"><Empty>Pick an organization on the Events screen first.</Empty></AdminPage>;
  if (org.isLoading) return <AdminPage title="LeadDash tools"><PageLoading /></AdminPage>;
  if (org.error) return <AdminPage title="LeadDash tools"><ErrorNote error={org.error} /></AdminPage>;
  const o = org.data!;
  const params = new URLSearchParams(window.location.search);
  return (
    <AdminPage title="LeadDash tools" sub={`${o.name} · Only LeadDash staff see this page`}>
      {params.get("platform") === "connected" ? <div className="banner banner-ok">The LeadDash platform is connected.</div> : null}
      {params.get("platform") === "failed" ? <div className="banner banner-bad">The LeadDash platform connection did not finish. Try again.</div> : null}
        <StaffEventsCard orgId={orgId} allowance={o.eventAllowance} />
        <StaffOwnerCard orgId={orgId} />
        <div className="card card-pad col gap-12">
          <span className="h3" style={{ fontSize: 14 }}>LeadDash platform</span>
          <KV label="Marketplace app">{platform.data?.configured ? "Set on the server" : "GHL_CLIENT_ID and GHL_CLIENT_SECRET are not set"}</KV>
          <KV label="Agency authorization">{platform.data?.connected ? `Connected (${platform.data.companyId})` : "Not authorized yet"}</KV>
          <KV label="This organization's sub-account">{o.platformLocationId || "Not set"}</KV>
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
    </AdminPage>
  );
}

/** LeadDash tools: who owns the organization, for when an owner leaves without handing it on. */
function StaffOwnerCard({ orgId }: { orgId: number }) {
  const utils = trpc.useUtils();
  const team = trpc.core.org.team.useQuery({ orgId });
  const transfer = trpc.core.org.transferOwner.useMutation();
  const owner = (team.data ?? []).find((t) => t.role === "owner");
  const admins = (team.data ?? []).filter((t) => t.role !== "owner");
  const [pick, setPick] = useState<number | "">("");
  return (
    <div className="card card-pad col gap-12">
      <EditSection
        title="Owner"
        saving={transfer.isPending}
        onCancel={() => setPick("")}
        onSave={async () => {
          if (!pick) throw new Error("Pick someone on the admin team.");
          await transfer.mutateAsync({ orgId, memberRowId: pick });
          await Promise.all([utils.core.org.team.invalidate(), utils.core.org.get.invalidate()]);
          setPick("");
          toast("Saved");
        }}
        view={<KV label="Owner">{owner ? `${owner.name || owner.email} · ${owner.email}` : "No owner"}</KV>}
        edit={
          admins.length ? (
            <Field label="New owner">
              <select className="input" style={{ maxWidth: 360 }} value={pick} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Pick someone on the admin team</option>
                {admins.map((a) => (
                  <option key={a.id} value={a.id}>{`${a.name || a.email} · ${a.email}`}</option>
                ))}
              </select>
            </Field>
          ) : (
            <span className="small muted">Add the new owner to the admin team on Organization settings first.</span>
          )
        }
      />
    </div>
  );
}

/** LeadDash tools: how many events the organization may add, its events, and moving an ended event's dates. */
function StaffEventsCard({ orgId, allowance }: { orgId: number; allowance: number }) {
  const utils = trpc.useUtils();
  const events = trpc.core.events.list.useQuery({ orgId });
  const setAllowance = trpc.core.org.setEventAllowance.useMutation();
  const setDates = trpc.core.events.setDates.useMutation();
  const [n, setN] = useState(String(allowance));
  const [openId, setOpenId] = useState<number | null>(null);
  const [dates, setDatesForm] = useState({ startDate: "", endDate: "" });
  const used = events.data?.length ?? 0;
  const cols = "minmax(0, 1fr) 80px 120px";
  return (
    <div className="card card-pad col gap-12">
      <EditSection
        title="Events"
        saving={setAllowance.isPending}
        onCancel={() => setN(String(allowance))}
        onSave={async () => {
          await setAllowance.mutateAsync({ orgId, eventAllowance: Number(n) });
          await utils.core.org.get.invalidate();
          toast("Saved");
        }}
        view={
          <div>
            <KV label="Events included">{String(allowance)}</KV>
            <KV label="Events added">{events.data ? `${used} of ${allowance}` : ""}</KV>
          </div>
        }
        edit={
          <div className="row gap-10" style={{ alignItems: "flex-end" }}>
            <Field label="Events included">
              <input className="input" style={{ width: 90 }} inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <span className="small muted" style={{ paddingBottom: 10 }}>They have {used} event{used === 1 ? "" : "s"} now</span>
          </div>
        }
      />
      {events.data?.length ? (
        <div className="table">
          <div className="table-inner">
            {events.data.map((e) => {
              const ended = eventHasEnded(e.endDate, e.timezone);
              const cells = [
                <div key="n" className="col" style={{ gap: 2 }}>
                  <span className="strong">{e.name}</span>
                  <span className="small muted">{fmtDates(e.startDate, e.endDate)}</span>
                </div>,
                <div key="s">
                  <Pill tone={ended ? "gray" : e.status === "live" ? "green" : e.status === "draft" ? "orange" : "gray"}>{ended || e.status === "ended" ? "Ended" : e.status === "live" ? "Live" : "Draft"}</Pill>
                </div>,
              ];
              if (!ended) {
                return (
                  <div key={e.id} className="trow" style={{ gridTemplateColumns: cols }}>
                    {cells}
                    <button type="button" className="btn btn-sm btn-w" disabled title="Organizations change dates themselves until the event ends.">
                      Change dates
                    </button>
                  </div>
                );
              }
              return (
                <ExpandRow
                  key={e.id}
                  cols={cols}
                  cells={cells}
                  open={openId === e.id}
                  closedLabel="Change dates"
                  onToggle={() => {
                    setOpenId(openId === e.id ? null : e.id);
                    setDatesForm({ startDate: e.startDate, endDate: e.endDate });
                  }}
                >
                  <div className="col gap-10">
                    <div className="row gap-10">
                      <Field label="Starts">
                        <input className="input" type="date" value={dates.startDate} onChange={(x) => setDatesForm({ ...dates, startDate: x.target.value })} />
                      </Field>
                      <Field label="Ends">
                        <input className="input" type="date" value={dates.endDate} onChange={(x) => setDatesForm({ ...dates, endDate: x.target.value })} />
                      </Field>
                    </div>
                    <div className="row gap-10">
                      <button
                        className="btn btn-sm btn-solid btn-w"
                        disabled={setDates.isPending}
                        onClick={async () => {
                          try {
                            await setDates.mutateAsync({ eventId: e.id, ...dates });
                            await utils.core.events.list.invalidate();
                            setOpenId(null);
                            toast("Saved");
                          } catch (err) {
                            toast(errorText(err), true);
                          }
                        }}
                      >
                        Save
                      </button>
                      <button className="btn btn-sm btn-w" onClick={() => setOpenId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                </ExpandRow>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** /admin/e/:id: the event home. Four numbers, then what is left to set up. Every page is in the menu. */
export function EventHomeScreen() {
  const ev = useAdminEvent();
  const home = trpc.core.events.home.useQuery({ eventId: ev.id });
  const c = home.data?.counts;
  const today = new Date().toISOString().slice(0, 10);
  const daysTo = Math.round((Date.parse(`${ev.startDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400_000);
  const when = daysTo > 0 ? { label: "Days to go", value: String(daysTo) } : today <= ev.endDate ? { label: "Event", value: "Today" } : { label: "Event", value: "Ended" };
  const steps = home.data?.steps ?? [];
  const left = steps.filter((x) => !x.done).length;
  return (
    <AdminPage title={ev.name} sub={`${fmtDates(ev.startDate, ev.endDate)}${ev.venueName ? ` · ${ev.venueName}` : ""}`}>
      {home.error ? <ErrorNote error={home.error} /> : null}
      <NumStrip
        items={[
          { label: "Registered", value: c ? c.registered : "" },
          ...(c?.sales !== null ? [{ label: "Sales", value: c ? fmtMoney(c.sales, "$0.00") : "" }] : []),
          { label: "Sessions", value: c ? c.sessions : "" },
          { label: when.label, value: when.value },
        ]}
      />
      {steps.length && left ? (
        <div className="card card-pad col gap-8">
          <div className="row-between">
            <span className="h3">Getting ready</span>
            <span className="small muted strong">
              {steps.length - left} of {steps.length} done
            </span>
          </div>
          {steps
            .filter((x) => !x.done)
            .map((x) => (
              <div key={x.key} className="step">
                <span className="step-dot" />
                <span className="step-label grow">{x.label}</span>
                <Link className="btn btn-sm btn-w" href={x.href}>
                  Open
                </Link>
              </div>
            ))}
        </div>
      ) : null}
    </AdminPage>
  );
}

/** /admin/e/:id/settings: the event's basics and its location. */
export function EventSettingsScreen() {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const update = trpc.core.events.update.useMutation();
  const basics = { name: ev.name, shortName: ev.shortName, startDate: ev.startDate, endDate: ev.endDate, timezone: ev.timezone, capacity: ev.capacity, status: ev.status };
  const place = { venueName: ev.venueName, venueAddress: ev.venueAddress, venueAddress2: ev.venueAddress2, city: ev.city, state: ev.state, zip: ev.zip };
  const [d, setD] = useState(basics);
  const [l, setL] = useState(place);
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const setP = (k: keyof typeof l) => (e: { target: { value: string } }) => setL({ ...l, [k]: e.target.value });
  const appLink = `${window.location.origin}/e/${ev.slug}`;
  const lines = addressLines(place);
  const save = async (next: { basics?: typeof d; place?: typeof l }) => {
    const b = next.basics ?? basics;
    await update.mutateAsync({ eventId: ev.id, ...b, ...(next.place ?? place), capacity: b.capacity ? Number(b.capacity) : null });
    await utils.core.events.get.invalidate();
  };
  const locked = ev.ended;
  const lockedBox = (text: string) => (
    <div className="input input-locked">
      <IconLock size={13} />
      {text}
    </div>
  );
  const statusLabel = (s: string) => (s === "live" ? "Live" : s === "draft" ? "Draft" : "Ended");
  return (
    <AdminPage title="Event settings">
      {locked ? (
        <div className="banner banner-warn" style={{ justifyContent: "flex-start" }}>
          <IconLock size={16} />
          This event ended on {fmtDate(ev.endDate)}, so its dates are locked. To run another event, add a new one from Events.
        </div>
      ) : null}
      <div className="card card-pad">
        <EditSection
          title="Event"
          saving={update.isPending}
          onCancel={() => setD(basics)}
          onSave={() => save({ basics: d })}
          view={
            <div>
              <KV label="Name">{ev.name}</KV>
              <KV label="Short name">{ev.shortName}</KV>
              <KV label="Dates">{fmtDates(ev.startDate, ev.endDate)}</KV>
              <KV label="Time zone">{ev.timezone}</KV>
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
                {locked ? lockedBox(fmtDate(ev.startDate)) : <input className="input" type="date" value={d.startDate} onChange={set("startDate")} />}
              </Field>
              <Field label="Ends">
                {locked ? lockedBox(fmtDate(ev.endDate)) : <input className="input" type="date" value={d.endDate} onChange={set("endDate")} />}
              </Field>
              <Field label="Time zone">
                <input className="input" value={d.timezone} onChange={set("timezone")} />
              </Field>
              <Field label="Capacity">
                <input className="input" inputMode="numeric" value={d.capacity ?? ""} onChange={(e) => setD({ ...d, capacity: e.target.value ? Number(e.target.value.replace(/\D/g, "")) : null })} />
              </Field>
              <Field label="Status">
                {locked && ev.status === "ended" ? (
                  lockedBox("Ended")
                ) : locked ? (
                  <select className="select" value={d.status} onChange={set("status")}>
                    <option value={ev.status}>{statusLabel(ev.status)}</option>
                    <option value="ended">Ended</option>
                  </select>
                ) : (
                  <select className="select" value={d.status} onChange={set("status")}>
                    <option value="draft">Draft</option>
                    <option value="live">Live</option>
                    <option value="ended">Ended</option>
                  </select>
                )}
              </Field>
              {locked ? <span className="small muted span-3">Dates and status lock after the event ends.</span> : null}
            </div>
          }
        />
      </div>
      <div className="card card-pad">
        <EditSection
          title="Location"
          saving={update.isPending}
          onCancel={() => setL(place)}
          onSave={() => save({ place: l })}
          view={
            <div className="location-grid">
              <div>
                <KV label="Venue">{ev.venueName}</KV>
                <KV label="Address">
                  {lines.length ? lines.map((line, i) => <div key={i}>{line}</div>) : ""}
                </KV>
                <KV label="In the app">Home shows the name, address and map. Directions opens Google Maps.</KV>
              </div>
              <div className="col gap-8">
                <MapPreview venue={place} />
                {hasPlace(place) ? (
                  <a className="btn btn-sm" style={{ alignSelf: "flex-start" }} href={mapsLink(place)} target="_blank" rel="noopener noreferrer">
                    Open in Google Maps
                  </a>
                ) : null}
              </div>
            </div>
          }
          edit={
            <div className="location-grid">
              <div className="col gap-10">
                <Field label="Venue or hotel name">
                  <input className="input" value={l.venueName} onChange={setP("venueName")} />
                </Field>
                <Field label="Street address">
                  <input className="input" value={l.venueAddress} onChange={setP("venueAddress")} autoComplete="address-line1" />
                </Field>
                <Field label="Suite, building or floor (optional)">
                  <input className="input" value={l.venueAddress2} onChange={setP("venueAddress2")} autoComplete="address-line2" />
                </Field>
                <div className="location-csz">
                  <Field label="City">
                    <input className="input" value={l.city} onChange={setP("city")} autoComplete="address-level2" />
                  </Field>
                  <Field label="State">
                    <select className="select" value={l.state} onChange={setP("state")}>
                      <option value="">Pick one</option>
                      {US_STATES.map(([code, name]) => (
                        <option key={code} value={code}>{name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="ZIP code">
                    <input className="input" inputMode="numeric" maxLength={10} value={l.zip} onChange={setP("zip")} autoComplete="postal-code" />
                  </Field>
                </div>
                <div className="fill-note">The map updates as you type. The app Home shows the hotel name, the full address and this map.</div>
              </div>
              <div className="col gap-6">
                <MapPreview venue={l} />
                <span className="small muted">Preview from Google Maps</span>
              </div>
            </div>
          }
        />
      </div>
    </AdminPage>
  );
}

/** One brand color: a small square, its label and its hex (or a note when it is not set). */
function Swatch({ label, color, empty }: { label: string; color: string; empty?: string }) {
  return (
    <span className="row gap-6" style={{ flexWrap: "wrap", minWidth: 0 }}>
      <span style={{ width: 18, height: 18, borderRadius: 4, background: color || "transparent", border: color ? "none" : "1px dashed var(--line)", display: "inline-block" }} />
      <span className="muted small">{label}</span>
      <span>{color || <span className="muted">{empty}</span>}</span>
    </span>
  );
}
