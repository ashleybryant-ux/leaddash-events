/**
 * Built-in starting templates (sponsor, exhibitor, speaker, blank), the fields
 * each kind can use, and sample values for the admin preview.
 */

export type AgreementKind = "sponsor" | "exhibitor" | "speaker";
export type StarterKey = AgreementKind | "blank";

const html = (lines: [string, string][]) =>
  lines.map(([tag, text]) => (tag === "h" ? `<h2>${text}</h2>` : `<p>${text.replace(/<b>/g, "<strong>").replace(/<\/b>/g, "</strong>")}</p>`)).join("");

const SPONSOR: [string, string][] = [
  ["h", "Sponsor Agreement"],
  ["p", "This agreement is between {Organization name} and {Company name} (the Sponsor) for {Event name}, {Event dates}, at {Venue}."],
  ["p", "<b>1. Package.</b> The Sponsor is buying the {Package name} package for {Package price}. It includes: {Package benefits}."],
  ["p", "<b>2. Payment.</b> {Payment terms}. Benefits begin once the first payment is received."],
  ["p", "<b>3. Cancellation.</b> If the Sponsor cancels in writing before {Cancel by date}, payments are refunded less a {Cancel fee} fee. After that date, payments are not refunded."],
  ["p", "<b>4. Name and logo.</b> The Sponsor allows {Organization name} to use its name and logo in the event app, the program and event signs, and confirms it has the right to share them."],
  ["p", "<b>5. Conduct.</b> The Sponsor and its staff follow the event code of conduct."],
  ["p", "<b>6. Event changes.</b> If the event moves or is canceled for reasons outside {Organization name}'s control, the Sponsor may keep the package for the new date or receive a refund."],
  ["p", "<b>7. Responsibility.</b> Each party is responsible for its own staff and property at the event."],
];

const EXHIBITOR: [string, string][] = [
  ["h", "Exhibitor Agreement"],
  ["p", "This agreement is between {Organization name} and {Company name} (the Exhibitor) for {Event name}, {Event dates}, at {Venue}."],
  ["p", "<b>1. Booth.</b> The Exhibitor is buying the {Package name} for {Package price}, plus these add-ons: {Add-ons}. Booth spots are assigned by {Organization name}."],
  ["p", "<b>2. Payment.</b> {Payment terms}."],
  ["p", "<b>3. Setup and teardown.</b> Booths are set up {Setup time} and taken down {Teardown time}. The booth stays staffed during exhibit hours."],
  ["p", "<b>4. Booth rules.</b> The Exhibitor may not share or sublet the booth, and keeps displays inside the booth space."],
  ["p", "<b>5. Cancellation.</b> If the Exhibitor cancels in writing before {Cancel by date}, payments are refunded less a {Cancel fee} fee. After that date, payments are not refunded."],
  ["p", "<b>6. Responsibility.</b> The Exhibitor is responsible for its own staff, products and property at the event."],
];

const SPEAKER: [string, string][] = [
  ["h", "Speaker Agreement"],
  ["p", "This agreement is between {Organization name} and {Speaker name} (the Speaker) for {Event name}, {Event dates}, at {Venue}."],
  ["p", '<b>1. Session.</b> The Speaker will present "{Session title}" on {Session time} in {Room}.'],
  ["p", "<b>2. What we provide.</b> {Speaker benefits}."],
  ["p", "<b>3. Materials.</b> Slides and handouts are due by {Materials due date}. {Organization name} may share them with attendees in the event app."],
  ["p", "<b>4. CE requirements.</b> The Speaker will provide learning objectives, disclose any financial relationships related to the content, and keep the session free of product promotion."],
  ["p", "<b>5. Name, photo and bio.</b> The Speaker allows {Organization name} to use their name, photo and bio in the event app and in event promotion."],
  ["p", "<b>6. Recording.</b> The session is recorded only if the Speaker allows it below."],
  ["p", "<b>7. Changes.</b> If the Speaker cannot present, they will tell {Organization name} as soon as possible so the session can be covered or moved."],
];

/** The four starting points in "Start from a template". */
export const STARTERS: Record<StarterKey, { kind: AgreementKind; name: string; summary: string; body: string; values: Record<string, string> }> = {
  sponsor: { kind: "sponsor", name: "Sponsor agreement", summary: "Package, payment, cancellation, name and logo use, conduct, event changes", body: html(SPONSOR), values: { "Cancel by date": "", "Cancel fee": "" } },
  exhibitor: { kind: "exhibitor", name: "Exhibitor agreement", summary: "Booth, add-ons, payment, setup and teardown, booth rules, cancellation", body: html(EXHIBITOR), values: { "Cancel by date": "", "Cancel fee": "", "Setup time": "", "Teardown time": "" } },
  speaker: { kind: "speaker", name: "Speaker agreement", summary: "Session, what you provide, materials, CE requirements, recording, name and photo use", body: html(SPEAKER), values: { "Speaker benefits": "", "Materials due date": "" } },
  blank: { kind: "sponsor", name: "Blank", summary: "Start with an empty page", body: "", values: {} },
};

const COMMON = ["Organization name", "Event name", "Event dates", "Venue"];

/** Fields that can be inserted, by kind, in the order the "Insert a field" list shows them. */
export const FIELDS: Record<AgreementKind, string[]> = {
  sponsor: [...COMMON, "Company name", "Package name", "Package price", "Package benefits", "Add-ons", "Payment terms", "Cancel by date", "Cancel fee"],
  exhibitor: [...COMMON, "Company name", "Package name", "Package price", "Package benefits", "Add-ons", "Payment terms", "Cancel by date", "Cancel fee", "Setup time", "Teardown time"],
  speaker: [...COMMON, "Speaker name", "Session title", "Session time", "Room", "Speaker benefits", "Materials due date"],
};

/** Fields the organization types once on the template (the rest fill from the event, the buyer or the speaker). */
export const ORG_VALUES: Record<AgreementKind, string[]> = {
  sponsor: ["Cancel by date", "Cancel fee"],
  exhibitor: ["Cancel by date", "Cancel fee", "Setup time", "Teardown time"],
  speaker: ["Speaker benefits", "Materials due date"],
};

/** Organization values that are calendar dates (native date inputs, shown with the year). */
export const DATE_VALUES = new Set(["Cancel by date", "Materials due date"]);

/** Sample buyer and speaker details for the admin preview (generic, never a customer's details). */
export const SAMPLE: Record<AgreementKind, Record<string, string>> = {
  sponsor: {
    "Company name": "Brightpath Health",
    "Package name": "Gold",
    "Package price": "$10,000.00",
    "Package benefits": "4 event passes, a booth in the exhibit hall, logo on the app welcome screen, a stage mention at the opening session and a full page ad in the program",
    "Add-ons": "none",
    "Payment terms": "A deposit of $5,000.00 is paid today and the remaining $5,000.00 is charged automatically to the same payment method on Mar 1, 2027",
  },
  exhibitor: {
    "Company name": "Cedar Counseling Supply",
    "Package name": "Standard booth",
    "Package price": "$950.00",
    "Package benefits": "1 booth staff pass",
    "Add-ons": "1 extra booth staff pass and electricity",
    "Payment terms": "The full amount of $1,175.00 is paid today",
  },
  speaker: {
    "Speaker name": "Dr. Renee Carter",
    "Session title": "Trauma-Informed Care in Group Settings",
    "Session time": "Apr 23, 2027 at 10:30 AM",
    Room: "Ballroom B",
  },
};

/** "Sponsor checkout, before paying" and the like, for the list's Used on column. */
export function usedOn(t: { kind: AgreementKind; signWhen: "checkout" | "email"; sendOnAccept: boolean; sendOnAdd: boolean }) {
  if (t.kind === "speaker") return t.sendOnAccept ? "Emailed on acceptance" : t.sendOnAdd ? "Emailed when added" : "Sent by hand";
  const who = t.kind === "sponsor" ? "Sponsor" : "Exhibitor";
  return t.signWhen === "checkout" ? `${who} checkout, before paying` : `Emailed after paying`;
}
