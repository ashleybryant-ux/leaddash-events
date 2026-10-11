/** The LeadDash Events logo. "white" is for dark backgrounds (the admin sidebar). */
export function LeadDashLogo({ tone = "color", height = 40 }: { tone?: "color" | "white"; height?: number }) {
  return <img src={tone === "white" ? "/brand/leaddash-events-white.svg" : "/brand/leaddash-events.svg"} alt="LeadDash Events" style={{ height, width: "auto", display: "block" }} />;
}

/** The small "Powered by" line on attendee-facing pages. */
export function PoweredByLogo() {
  return (
    <div className="col small strong muted" style={{ alignItems: "center", gap: 4, paddingTop: 6 }}>
      <span>Powered by</span>
      <LeadDashLogo height={26} />
    </div>
  );
}
