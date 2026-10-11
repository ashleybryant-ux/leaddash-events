/** Event location: the address lines, Google Maps links and US states. */

export type VenueLike = { venueName: string; venueAddress: string; venueAddress2?: string; city: string; state?: string; zip?: string };

export const US_STATES: [string, string][] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"],
  ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"], ["PR", "Puerto Rico"],
];

/** "Dallas, TX 75201" (any part may be missing). */
export function cityLine(v: VenueLike) {
  const stateZip = [v.state ?? "", v.zip ?? ""].map((s) => s.trim()).filter(Boolean).join(" ");
  return [v.city.trim(), stateZip].filter(Boolean).join(", ");
}

/** The street line and the city line, empty lines left out. */
export function addressLines(v: VenueLike) {
  const street = [v.venueAddress.trim(), (v.venueAddress2 ?? "").trim()].filter(Boolean).join(", ");
  const city = cityLine(v);
  // Older events kept the whole address in one line; skip the city line when it is already in there.
  if (street && city && street.toLowerCase().includes(v.city.trim().toLowerCase()) && !v.state && !v.zip) return [street];
  return [street, city].filter(Boolean);
}

/** What Google Maps searches for: the name and the full address (the suite is left out, it confuses the search). */
export function mapQuery(v: VenueLike) {
  const city = cityLine(v);
  const street = v.venueAddress.trim();
  const withCity = street && city && street.toLowerCase().includes(v.city.trim().toLowerCase()) && !v.state && !v.zip ? street : [street, city].filter(Boolean).join(", ");
  return [v.venueName.trim(), withCity].filter(Boolean).join(", ");
}

/** Opens the place in Google Maps. */
export const mapsLink = (v: VenueLike) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery(v))}`;

/** Directions to the place in Google Maps. */
export const directionsLink = (v: VenueLike) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapQuery(v))}`;

/** A map preview for an iframe (Google Maps embed, no key needed). */
export const mapEmbedUrl = (v: VenueLike) => `https://maps.google.com/maps?q=${encodeURIComponent(mapQuery(v))}&z=15&output=embed`;

/** True when there is enough to put on a map. */
export const hasPlace = (v: VenueLike) => !!(v.venueAddress.trim() || (v.venueName.trim() && v.city.trim()));
