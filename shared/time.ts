/**
 * Event times are stored as local calendar date + "HH:MM" in the event's time
 * zone. These helpers turn them into real moments (for reminders and jobs)
 * and back.
 */

/** Offset of a time zone from UTC at a given moment, in minutes. */
function tzOffsetMinutes(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") === 24 ? 0 : get("hour"), get("minute"), get("second"));
  return (asUtc - at.getTime()) / 60_000;
}

/** "2027-04-22", "10:30", "America/Chicago" -> the exact moment as a Date. */
export function zonedToDate(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let offset = tzOffsetMinutes(new Date(guess), timeZone);
  let result = guess - offset * 60_000;
  // Correct once more around daylight-saving changes.
  const offset2 = tzOffsetMinutes(new Date(result), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    result = guess - offset * 60_000;
  }
  return new Date(result);
}

/** The local date ("2027-04-22") and time ("10:30") of a moment in a time zone. */
export function dateToZoned(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}` };
}

/** Minutes between two "HH:MM" times on the same day. */
export function minutesBetween(start: string, end: string) {
  const [a, b] = start.split(":").map(Number);
  const [c, d] = end.split(":").map(Number);
  return c * 60 + d - (a * 60 + b);
}

const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T12:00:00Z`) / 86_400_000);

/** "Day 2 of 3" while the event runs, nothing before or after. Dates are "2027-04-22". */
export function dayOfEvent(today: string, start: string, end: string) {
  if (today < start || today > end) return "";
  return `Day ${dayNumber(today) - dayNumber(start) + 1} of ${dayNumber(end) - dayNumber(start) + 1}`;
}
