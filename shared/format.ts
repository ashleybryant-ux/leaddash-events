/** Formatting shared by the server (emails) and the client. Dates always include the year. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2027-04-22" -> "Apr 22, 2027" */
export function fmtDate(iso: string | null | undefined) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "2027-04-22" -> "Thu, Apr 22, 2027" */
export function fmtDayDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]}, ${fmtDate(iso)}`;
}

/** "2027-04-22" -> "Thu 22" (agenda day tabs) */
export function fmtDayTab(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]} ${d}`;
}

/** "13:30" -> "1:30 PM" */
export function fmtTime(hhmm: string | null | undefined) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export const fmtRange = (start: string, end: string) => `${fmtTime(start)} to ${fmtTime(end)}`;

/** Event dates: "Apr 22, 2027 to Apr 24, 2027" */
export const fmtDates = (start: string, end: string) => (start === end ? fmtDate(start) : `${fmtDate(start)} to ${fmtDate(end)}`);

/** A Date (or ms) -> "Oct 9, 2026" */
export function fmtWhen(value: Date | number | string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** A Date -> "Oct 9, 2026, 2:14 PM" */
export function fmtWhenTime(value: Date | number | string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  return `${fmtWhen(d)}, ${fmtTime(`${d.getHours()}:${d.getMinutes()}`)}`;
}

/** Cents -> "$249.00" (or "Free") */
export function fmtMoney(cents: number | null | undefined, freeLabel = "Free") {
  if (!cents) return freeLabel;
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export const fmtHours = (h: number) => `${Number.isInteger(h) ? h.toFixed(1) : h.toFixed(h * 10 === Math.round(h * 10) ? 1 : 2)} CE hour${h === 1 ? "" : "s"}`;

/** All dates between two ISO dates, inclusive. */
export function eachDay(start: string, end: string) {
  const out: string[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  while (d <= last && out.length < 31) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export const initials = (first: string, last: string) => `${(first || "?")[0] ?? ""}${(last || "")[0] ?? ""}`.toUpperCase();

export const fullName = (p: { firstName: string; lastName: string; credentials?: string | null }) =>
  `${p.firstName} ${p.lastName}${p.credentials ? `, ${p.credentials}` : ""}`.trim();

export function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
