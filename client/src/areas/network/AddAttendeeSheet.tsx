/**
 * The Add attendee sheet (People > Attendees, and Add person on a sponsor's
 * passes): the person, the ticket and how it is paid, and the welcome email.
 */
import { useEffect, useState } from "react";
import { trpc } from "../../lib/trpc";
import { useAdminEvent } from "../../shells/AdminShell";
import { Field } from "../../ui/components";
import { errorText, toast } from "../../ui/toast";
import { fmtMoney } from "@shared/format";
import { toCents } from "./shared";
import { SideSheet, ordinal, todayIso } from "./sponsor-ui";

export type AddKind = "attendee" | "speaker" | "sponsor" | "vendor" | "volunteer" | "guest";
type Mode = "sponsor_pass" | "comp" | "outside" | "link";
type Method = "check" | "cash" | "invoice" | "other";

const TYPES: { key: AddKind; label: string }[] = [
  { key: "attendee", label: "Attendee" },
  { key: "speaker", label: "Speaker" },
  { key: "sponsor", label: "Sponsor guest" },
  { key: "vendor", label: "Exhibitor staff" },
  { key: "volunteer", label: "Volunteer" },
  { key: "guest", label: "Guest" },
];

const blankPerson = { firstName: "", lastName: "", email: "", phone: "", credentials: "" };
const usesPass = (k: AddKind) => k === "sponsor" || k === "vendor";

export type AddPreset = { kind: AddKind; vendorId: number | null };

export function AddAttendeeSheet({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: AddPreset }) {
  const ev = useAdminEvent();
  const utils = trpc.useUtils();
  const tickets = trpc.ce.attendees.tickets.useQuery({ eventId: ev.id }, { enabled: open });
  const vendors = trpc.ce.attendees.vendors.useQuery({ eventId: ev.id }, { enabled: open });
  const add = trpc.ce.attendees.add.useMutation();
  const [person, setPerson] = useState(blankPerson);
  const [kind, setKind] = useState<AddKind>("attendee");
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [ticketId, setTicketId] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("comp");
  const [outside, setOutside] = useState({ amount: "", method: "check" as Method, paidOn: todayIso(), reference: "" });
  const [welcome, setWelcome] = useState(true);

  // Each time the sheet opens, start from the preset (Add person on a sponsor) or a plain attendee.
  useEffect(() => {
    if (!open) return;
    setPerson(blankPerson);
    setKind(preset?.kind ?? "attendee");
    setVendorId(preset?.vendorId ?? null);
    setMode(preset && usesPass(preset.kind) ? "sponsor_pass" : "comp");
    setOutside({ amount: "", method: "check", paidOn: todayIso(), reference: "" });
    setWelcome(true);
    setTicketId(null);
  }, [open, preset]);

  const ticketList = tickets.data ?? [];
  const vendorList = (vendors.data ?? []).filter((v) => (kind === "sponsor" ? v.kind !== "exhibitor" : v.kind !== "sponsor"));
  const vendor = vendorList.find((v) => v.id === vendorId);
  const ticket = ticketList.find((t) => t.id === ticketId);

  // Pick a ticket once the list loads: the sponsor package's pass ticket, else the first active one.
  useEffect(() => {
    if (!open || ticketId || !ticketList.length) return;
    const pass = vendor?.passTicketTypeId && ticketList.some((t) => t.id === vendor.passTicketTypeId) ? vendor.passTicketTypeId : null;
    setTicketId(pass ?? (ticketList.find((t) => t.active) ?? ticketList[0]).id);
  }, [open, ticketId, ticketList, vendor]);

  const changeKind = (k: AddKind) => {
    setKind(k);
    if (usesPass(k)) {
      setMode("sponsor_pass");
      if (vendorId && !(vendors.data ?? []).some((v) => v.id === vendorId && (k === "sponsor" ? v.kind !== "exhibitor" : v.kind !== "sponsor"))) setVendorId(null);
    } else {
      setVendorId(null);
      if (mode === "sponsor_pass") setMode("comp");
    }
  };

  const changeVendor = (id: number | null) => {
    setVendorId(id);
    const v = (vendors.data ?? []).find((x) => x.id === id);
    if (v?.passTicketTypeId && ticketList.some((t) => t.id === v.passTicketTypeId)) setTicketId(v.passTicketTypeId);
  };

  const changeMode = (m: Mode) => {
    setMode(m);
    if (m === "outside" && !outside.amount && ticket) setOutside({ ...outside, amount: fmtMoney(ticket.priceCents, "") });
  };

  const who = kind === "vendor" ? "Exhibitor" : "Sponsor";
  const pkgLabel = vendor?.packageName ? `the ${vendor.packageName} package` : "the package";

  async function submit(again: boolean) {
    try {
      await add.mutateAsync({
        eventId: ev.id,
        firstName: person.firstName,
        lastName: person.lastName,
        email: person.email,
        phone: person.phone,
        credentials: person.credentials,
        ticketTypeId: ticketId,
        kind,
        vendorId: usesPass(kind) ? vendorId : null,
        payment: { mode, amountCents: mode === "outside" ? toCents(outside.amount) : 0, method: outside.method, paidOn: mode === "outside" ? outside.paidOn : "", reference: mode === "outside" ? outside.reference : "" },
        sendWelcome: welcome,
      });
      toast(mode === "link" ? `${person.firstName} ${person.lastName} added. Payment link sent.` : `${person.firstName} ${person.lastName} added`);
      await Promise.all([utils.ce.attendees.list.invalidate(), utils.ce.attendees.vendors.invalidate(), utils.network.vendors.list.invalidate()]);
      if (again) setPerson(blankPerson);
      else onClose();
    } catch (err) {
      toast(errorText(err), true);
    }
  }

  const choice = (m: Mode, title: string, sub: string) => (
    <label className={`pay-choice${mode === m ? " on" : ""}`}>
      <input type="radio" name="add-payment" checked={mode === m} onChange={() => changeMode(m)} />
      <span className="grow">
        <b>{title}</b>
        <span>{sub}</span>
      </span>
    </label>
  );

  const set = (k: keyof typeof blankPerson) => (e: { target: { value: string } }) => setPerson({ ...person, [k]: e.target.value });
  const ready = person.firstName.trim() && person.lastName.trim() && person.email.trim() && (!usesPass(kind) || mode !== "sponsor_pass" || vendorId);

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      title="Add attendee"
      footer={
        <>
          <button className="btn btn-sm btn-solid btn-w-lg" disabled={!ready || add.isPending} onClick={() => submit(false)}>
            Add
          </button>
          <button className="btn btn-sm btn-w-lg" disabled={!ready || add.isPending} onClick={() => submit(true)}>
            Add another
          </button>
          <button className="btn btn-sm btn-w-lg" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <span className="sp-caps">Person</span>
      <div className="grid-2">
        <Field label="First name">
          <input className="input" value={person.firstName} maxLength={80} onChange={set("firstName")} />
        </Field>
        <Field label="Last name">
          <input className="input" value={person.lastName} maxLength={80} onChange={set("lastName")} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={person.email} maxLength={200} onChange={set("email")} />
        </Field>
        <Field label="Mobile">
          <input className="input" type="tel" value={person.phone} maxLength={40} onChange={set("phone")} />
        </Field>
        <Field label="Credentials">
          <input className="input" value={person.credentials} maxLength={80} placeholder="LPC" onChange={set("credentials")} />
        </Field>
        <Field label="Type">
          <select className="select" value={kind} onChange={(e) => changeKind(e.target.value as AddKind)}>
            {TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {usesPass(kind) ? (
        <>
          <Field label={who}>
            <select className="select" value={vendorId ?? ""} onChange={(e) => changeVendor(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Pick a {who.toLowerCase()}</option>
              {vendorList.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.company}
                </option>
              ))}
            </select>
          </Field>
          {vendor ? (
            vendor.passesUsed < vendor.passesTotal ? (
              <div className="sp-ok">
                {vendor.packageName ? `${vendor.packageName} ${who.toLowerCase()}` : who} · {vendor.passesUsed} of {vendor.passesTotal} passes used · this adds the {ordinal(vendor.passesUsed + 1)}
              </div>
            ) : (
              <div className="sp-warn">No passes left; this adds one over the package</div>
            )
          ) : null}
        </>
      ) : null}

      <span className="sp-caps" style={{ marginTop: 4 }}>Ticket and payment</span>
      <Field label="Ticket">
        <select className="select" value={ticketId ?? ""} onChange={(e) => setTicketId(e.target.value ? Number(e.target.value) : null)}>
          {!ticketList.length ? <option value="">No tickets yet</option> : null}
          {ticketList.map((t) => (
            <option key={t.id} value={t.id}>
              {mode === "sponsor_pass" ? t.name : `${t.name} (${fmtMoney(t.priceCents)})`}
            </option>
          ))}
        </select>
      </Field>
      {usesPass(kind) ? choice("sponsor_pass", usesPass(kind) && kind === "vendor" ? "Booth staff pass" : "Sponsor pass", `Included in ${pkgLabel}. No charge.`) : null}
      {choice("comp", "Complimentary", "No charge.")}
      {choice("outside", "Paid outside the app", "Check, cash or invoice.")}
      {mode === "outside" ? (
        <div className="pay-more">
          <div className="grid-3" style={{ gap: 10 }}>
            <Field label="Amount">
              <input className="input" inputMode="decimal" value={outside.amount} onChange={(e) => setOutside({ ...outside, amount: e.target.value })} />
            </Field>
            <Field label="How paid">
              <select className="select" value={outside.method} onChange={(e) => setOutside({ ...outside, method: e.target.value as Method })}>
                <option value="check">Check</option>
                <option value="cash">Cash</option>
                <option value="invoice">Invoice</option>
                <option value="other">Other</option>
              </select>
            </Field>
            <Field label="Paid on">
              <input className="input" type="date" value={outside.paidOn} onChange={(e) => setOutside({ ...outside, paidOn: e.target.value })} />
            </Field>
          </div>
          <Field label="Check or invoice number">
            <input className="input" value={outside.reference} maxLength={60} onChange={(e) => setOutside({ ...outside, reference: e.target.value })} />
          </Field>
        </div>
      ) : null}
      {choice("link", "Send a payment link", "We email the checkout link for this ticket. Shows as Unpaid until they pay.")}

      <span className="sp-caps" style={{ marginTop: 4 }}>After adding</span>
      <label className="check" style={{ fontSize: 14 }}>
        <input type="checkbox" checked={welcome} onChange={(e) => setWelcome(e.target.checked)} />
        Send the welcome email with the app link
      </label>
    </SideSheet>
  );
}
