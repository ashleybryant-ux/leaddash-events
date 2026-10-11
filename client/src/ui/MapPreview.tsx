/** A live Google Maps preview of the event venue (embed, no key needed). */
import { useEffect, useState } from "react";
import { hasPlace, mapEmbedUrl, type VenueLike } from "@shared/address";

/** Waits until typing stops before moving the map, so it does not reload on every key. */
function useSettled<T>(value: T, ms = 700) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function MapPreview({ venue, height = 180, className = "map-preview", title }: { venue: VenueLike; height?: number; className?: string; title?: string }) {
  const src = useSettled(hasPlace(venue) ? mapEmbedUrl(venue) : "");
  if (!src) return <div className={`${className} map-preview-empty`} style={{ height }}>Add the address to see the map.</div>;
  return (
    <div className={className} style={{ height }}>
      <iframe title={title ?? `Map of ${venue.venueName || "the venue"}`} src={src} loading="lazy" referrerPolicy="no-referrer-when-downgrade" allowFullScreen />
    </div>
  );
}
