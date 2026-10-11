/**
 * /e/:slug/home: the app's Home tab. Cover image with the event logo, the
 * event name, city and dates, the venue with a map link, the attendee's next
 * session, a grid of every other page the event has turned on, and a sponsor
 * banner above the bottom bar.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { trpc } from "../../lib/trpc";
import { AppScreen, ProfileChip, useEventApp } from "../../shells/AttendeeShell";
import { IconAward, IconBadge, IconBell, IconBookmark, IconFood, IconHelp, IconImage, IconInfo, IconMap, IconMic, IconPin, IconQr, IconSearch, IconStore, IconUser } from "../../ui/icons";
import { fmtDate, fmtDates, fmtTime } from "@shared/format";
import { dateToZoned } from "@shared/time";
import { VendorLightbox } from "../network/booths";
import { photosSeenAt } from "../network/photos";
import { ceLabel } from "./shared";

/** "Dallas, TX" from "650 S Griffin St, Dallas, TX 75202" (or the event's city when it is set). */
export function cityOf(city: string, address: string) {
  if (city.trim()) return city.trim();
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  const last = parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, "").trim();
  if (parts.length === 2) return last;
  return last ? `${parts[parts.length - 2]}, ${last}` : parts[parts.length - 2];
}

export const mapsLink = (venueName: string, address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([venueName, address].filter(Boolean).join(", "))}`;

function todayIn(tz: string) {
  try {
    return dateToZoned(new Date(), tz).date;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function SwitchEvent() {
  const { slug } = useEventApp();
  const mine = trpc.core.events.mine.useQuery();
  const [open, setOpen] = useState(false);
  const events = (mine.data ?? []).filter((e) => e.isAttendee);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (events.length < 2) return <span />;
  return (
    <>
      <button type="button" className="switch" aria-expanded={open} onClick={() => setOpen(!open)}>
        Switch event
      </button>
      {open ? (
        <div className="event-switch" role="menu" aria-label="Your events">
          {events.map((e) => (
            <a key={e.id} role="menuitem" href={`/e/${e.slug}/home`} aria-current={e.slug === slug}>
              <span className="strong" style={{ fontSize: 14 }}>{e.name}</span>
              <span className="small muted">{fmtDates(e.startDate, e.endDate)}</span>
            </a>
          ))}
        </div>
      ) : null}
    </>
  );
}

function UpNext() {
  const { slug, event, me, base } = useEventApp();
  const my = trpc.program.sessions.my.useQuery({ slug }, { enabled: !!me.attendee });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const next = (my.data?.items ?? []).filter((i) => i.endsAt > now).sort((a, b) => a.startsAt - b.startsAt)[0];
  if (!next) return null;
  // The time goes in the label; a session on another day adds its date to the line under the title.
  const day = next.date === todayIn(event.timezone) ? "" : fmtDate(next.date);
  const line = [day, next.room, next.ceHours > 0 ? ceLabel(next.ceHours) : ""].filter(Boolean).join(" · ");
  return (
    <div className="home-next">
      <div style={{ minWidth: 0 }}>
        <span className="k">Up next for you · {fmtTime(next.startTime)}</span>
        <b>{next.title}</b>
        {line ? <small>{line}</small> : null}
      </div>
      {next.canCheckIn ? (
        <Link href={`${base}/checkin/${next.id}`} className="btn btn-primary">Check in</Link>
      ) : (
        <Link href={`${base}/session/${next.id}`} className="btn btn-primary">View</Link>
      )}
    </div>
  );
}

function SponsorBanner() {
  const { slug, event } = useEventApp();
  const list = trpc.network.exhibitors.list.useQuery({ slug }, { enabled: event.features.exhibitors });
  const [i, setI] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const pool = useMemo(() => {
    const sponsors = (list.data ?? []).filter((v) => v.sponsor);
    const welcome = sponsors.filter((v) => v.logoSpots.welcome);
    if (welcome.length) return welcome;
    // The list comes sponsors first in package order, so the first sponsor's level is the top package.
    return sponsors.filter((v) => (v.level || "") === (sponsors[0]?.level || ""));
  }, [list.data]);
  useEffect(() => {
    if (pool.length < 2) return;
    const t = setInterval(() => setI((n) => n + 1), 6000);
    return () => clearInterval(t);
  }, [pool.length]);
  if (!pool.length) return null;
  const v = pool[i % pool.length];
  return (
    <>
      <button type="button" className="home-sponsor" aria-label={`About ${v.company}`} onClick={() => setOpenId(v.id)}>
        <span className="col" style={{ minWidth: 0 }}>
          <span className="lv">{v.level ? `${v.level}${/sponsor/i.test(v.level) ? "" : " sponsor"}` : "Sponsor"}</span>
          <b className="clip">{v.company}</b>
        </span>
        {v.logoUrl ? (
          <span className="logo">
            <img src={v.logoUrl} alt="" />
          </span>
        ) : (
          <span className="logo none">{v.company.slice(0, 14)}</span>
        )}
      </button>
      <VendorLightbox vendorId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

type Tile = { label: string; href: string; icon: ReactNode; show: boolean; dot?: boolean; external?: boolean };

export function HomeScreen() {
  const { slug, event, me, base } = useEventApp();
  const f = event.features;
  const photosLatest = trpc.network.photos.latest.useQuery({ slug }, { enabled: f.photos });
  const maps = trpc.network.maps.list.useQuery({ slug }, { retry: false });
  const speakerPage = trpc.program.slides.mySpeakerPage.useQuery({ slug });
  const isBooth = me.staff.kinds.includes("booth") || me.staff.vendorIds.length > 0;
  const seenAt = photosSeenAt(event.id, me.attendee?.id ?? 0);
  const city = cityOf(event.city, event.venueAddress);
  const appName = event.branding.appName || event.shortName;
  const monogram = appName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

  const tiles: Tile[] = [
    { label: "My agenda", href: `${base}/my`, icon: <IconBookmark size={22} />, show: !!me.attendee },
    { label: "Speakers", href: `${base}/speakers`, icon: <IconMic size={22} />, show: true },
    { label: "Sponsors", href: `${base}/exhibitors`, icon: <IconStore size={22} />, show: f.exhibitors },
    { label: "Photos", href: `${base}/photos`, icon: <IconImage size={22} />, show: f.photos, dot: (photosLatest.data ?? 0) > seenAt },
    { label: "Venue map", href: `${base}/map`, icon: <IconMap size={22} />, show: !!maps.data?.length },
    { label: "CE credits", href: `${base}/credits`, icon: <IconAward size={22} />, show: !!me.attendee },
    { label: "My badge", href: `${base}/badge`, icon: <IconBadge size={22} />, show: !!me.attendee },
    { label: "Dining", href: `${base}/dining`, icon: <IconFood size={22} />, show: f.dining },
    { label: "Nearby", href: `${base}/nearby`, icon: <IconPin size={22} />, show: true },
    { label: "Help", href: `${base}/help`, icon: <IconHelp size={22} />, show: true },
    { label: "Lost and found", href: `${base}/lost-found`, icon: <IconSearch size={22} />, show: true },
    { label: "About host", href: `${base}/host`, icon: <IconInfo size={22} />, show: true },
    { label: "My profile", href: `${base}/profile`, icon: <IconUser size={22} />, show: !!me.attendee },
    { label: "Alerts", href: `${base}/alerts`, icon: <IconBell size={22} />, show: true, dot: me.unread > 0 },
    { label: "Speaker page", href: speakerPage.data?.url ?? "", icon: <IconMic size={22} />, show: !!speakerPage.data?.url, external: true },
    { label: "Scan leads", href: `${base}/leads`, icon: <IconQr size={22} />, show: isBooth },
  ];

  return (
    <AppScreen
      nav="home"
      header={
        <header className="home-top">
          <ProfileChip />
          <div className="title">Home</div>
          <SwitchEvent />
        </header>
      }
      bodyStyle={{ padding: 0, gap: 0 }}
    >
      <div className="home-cover" style={event.coverUrl ? { backgroundImage: `url("${event.coverUrl.replace(/"/g, "%22")}")` } : undefined}>
        <div className="home-logo">{event.logoUrl ? <img src={event.logoUrl} alt={`${event.orgName} logo`} /> : <span aria-label={appName}>{monogram}</span>}</div>
      </div>
      <div className="home-event">
        <h1>{event.name}</h1>
        <div className="meta">
          {city ? (
            <>
              {city}
              <br />
            </>
          ) : null}
          {fmtDates(event.startDate, event.endDate)}
        </div>
      </div>
      {event.venueName || event.venueAddress ? (
        <a className="home-venue" href={mapsLink(event.venueName, event.venueAddress)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${event.venueName || "the venue"} in Google Maps`}>
          <em className="pin" aria-hidden="true" />
          <span>{event.venueName || event.venueAddress} →</span>
        </a>
      ) : null}
      <UpNext />
      <div className="home-sect">Explore</div>
      <div className="home-grid">
        {tiles
          .filter((t) => t.show)
          .map((t) =>
            t.external ? (
              <a key={t.label} href={t.href} className="home-tile2">
                {t.icon}
                {t.label}
              </a>
            ) : (
              <Link key={t.label} href={t.href} className="home-tile2" aria-label={t.dot ? `${t.label}, new` : undefined}>
                {t.icon}
                {t.label}
                {t.dot ? <span className="home-dot" aria-hidden="true" /> : null}
              </Link>
            )
          )}
      </div>
      <div style={{ flex: 1 }} />
      <SponsorBanner />
    </AppScreen>
  );
}
