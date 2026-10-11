/** The LeadDash Events logo. "white" is for dark backgrounds (the admin sidebar). */
export function LeadDashLogo({ tone = "color", height = 40 }: { tone?: "color" | "white"; height?: number }) {
  return <img src={tone === "white" ? "/brand/leaddash-events-white.svg" : "/brand/leaddash-events.svg"} alt="LeadDash Events" style={{ height, width: "auto", display: "block" }} />;
}

/** The small "Powered by" line on attendee-facing pages. */
export function PoweredByLogo() {
  return (
    <div className="row small strong muted" style={{ justifyContent: "center", gap: 8, paddingTop: 6 }}>
      Powered by
      <LeadDashLogo height={24} />
    </div>
  );
}
