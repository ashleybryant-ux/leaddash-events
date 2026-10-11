/**
 * /e/:slug/home: the app's Home tab. A cover with the event name, dates and
 * host, the attendee's next session, a row of main shortcuts, the attendee's
 * pass (badge, profile and their other events), the venue with a live map,
 * a list of every other page the event has turned on, and a sponsor banner.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { trpc } from "../../lib/trpc";
import { AppScreen, useEventApp } from "../../shells/AttendeeShell";
import { Sheet } from "../../ui/components";
import { MapPreview } from "../../ui/MapPreview";
import { IconAward, IconBadge, IconBell, IconBookmark, IconChevron, IconFood, IconHelp, IconImage, IconInfo, IconMap, IconMic, IconPin, IconQr, IconSearch, IconStore, IconUser, IconCalendar, IconStar } from "../../ui/icons";
import { fmtDate, fmtDates, fmtTime, initials } from "@shared/format";
import { addressLines, directionsLink, hasPlace } from "@shared/address";
import { dateToZoned, dayOfEvent } from "@shared/time";
import { VendorLightbox } from "../network/booths";
import { photosSeenAt } from "../network/photos";
import { ceLabel } from "./shared";

function todayIn(tz: string) {
  try {
    return dateToZoned(new Date(), tz).date;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

const KIND_LABELS: Record<string, string> = { attendee: "Attendee", speaker: "Speaker", vendor: "Exhibitor", staff: "Staff", guest: "Guest", volunteer: "Volunteer", sponsor: "Sponsor" };

function HomeHero() {
  const { event } = useEventApp();
  const day = dayOfEvent(todayIn(event.timezone), event.startDate, event.endDate);
  const appName = event.branding.appName || event.shortName;
  const monogram = appName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <div className="home-hero" style={event.coverUrl ? { backgroundImage: `url("${event.coverUrl.replace(/"/g, "%22")}")` } : undefined}>
      <div className="home-hero-in">
        <div className="host">
          <span className="mark">{event.logoUrl ? <img src={event.logoUrl} alt="" /> : monogram}</span>
          Hosted by {event.orgName}
        </div>
        <h1>{event.name}</h1>
        <div className="when">
          <span>{fmtDates(event.startDate, event.endDate)}</span>
          {day ? <span className="day">{day}</span> : null}
        </div>
      </div>
    </div>
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

/** The attendee's pass: who they are, their badge, their profile, and their other events when they have some. */
function PassCard() {
  const { slug, me, base } = useEventApp();
  const mine = trpc.core.events.mine.useQuery();
  const [open, setOpen] = useState(false);
  const a = me.attendee;
  if (!a) return null;
  const events = (mine.data ?? []).filter((e) => e.isAttendee);
  const line = [KIND_LABELS[a.kind] ?? "Attendee", a.organization].filter(Boolean).join(" · ");
  return (
    <>
      <div className="home-lab">Your pass</div>
      <div className="home-pass">
        <Link href={`${base}/badge`} className="who" aria-label="Show my badge">
          <span className="face">{a.photoUrl ? <img src={a.photoUrl} alt="" /> : initials(a.firstName, a.lastName)}</span>
          <span className="col" style={{ minWidth: 0, gap: 2 }}>
            <b className="clip">{a.firstName} {a.lastName}</b>
            {line ? <small className="clip">{line}</small> : null}
          </span>
          <span className="qr" aria-hidden="true"><IconQr size={26} /></span>
        </Link>
        <div className="acts" style={{ gridTemplateColumns: events.length > 1 ? "1fr 1fr 1fr" : "1fr 1fr" }}>
          <Link href={`${base}/badge`}><IconBadge size={16} />My badge</Link>
          <Link href={`${base}/profile`}><IconUser size={16} />Edit profile</Link>
          {events.length > 1 ? (
            <button type="button" onClick={() => setOpen(true)}><IconCalendar size={16} />My events ({events.length})</button>
          ) : null}
        </div>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} label="My events">
        <div className="col" style={{ gap: 4 }}>
          <b style={{ fontSize: 17, margin: "4px 0 6px" }}>My events</b>
          {events.map((e) => (
            <a key={e.id} className="home-evrow" href={`/e/${e.slug}/home`} aria-current={e.slug === slug ? "page" : undefined} onClick={(ev) => (e.slug === slug ? (ev.preventDefault(), setOpen(false)) : undefined)}>
              <span className="mark">{e.logoUrl ? <img src={e.logoUrl} alt="" /> : e.shortName.slice(0, 2).toUpperCase()}</span>
              <span className="col" style={{ minWidth: 0, gap: 2 }}>
                <b className="clip">{e.name}</b>
                <small className="clip">{[fmtDates(e.startDate, e.endDate), e.city].filter(Boolean).join(" · ")}</small>
              </span>
              <span className="go">{e.slug === slug ? "Open now" : "Switch"}</span>
            </a>
          ))}
        </div>
      </Sheet>
    </>
  );
}

/** Hotel name, full address and a live map. */
function VenueCard({ hasMaps }: { hasMaps: boolean }) {
  const { event, base } = useEventApp();
  if (!event.venueName && !hasPlace(event)) return null;
  const lines = addressLines(event);
  return (
    <>
      <div className="home-lab">Where</div>
      <div className="home-venue2">
        {hasPlace(event) ? <MapPreview venue={event} height={84} className="map" /> : null}
        <div className="info">
          {event.venueName ? <b>{event.venueName}</b> : null}
          {lines.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
        <div className="acts" style={{ gridTemplateColumns: hasMaps ? "1fr 1fr" : "1fr" }}>
          <a className="btn btn-primary" href={directionsLink(event)} target="_blank" rel="noopener noreferrer"><IconPin size={16} />Directions</a>
          {hasMaps ? <Link className="btn" href={`${base}/map`}><IconMap size={16} />Venue map</Link> : null}
        </div>
      </div>
    </>
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

type Item = { label: string; href: string; icon: ReactNode; show: boolean; dot?: boolean; badge?: number; external?: boolean };

export function HomeScreen() {
  const { slug, event, me, base } = useEventApp();
  const f = event.features;
  const photosLatest = trpc.network.photos.latest.useQuery({ slug }, { enabled: f.photos });
  const maps = trpc.network.maps.list.useQuery({ slug }, { retry: false });
  const speakerPage = trpc.program.slides.mySpeakerPage.useQuery({ slug });
  const isBooth = me.staff.kinds.includes("booth") || me.staff.vendorIds.length > 0;
  const seenAt = photosSeenAt(event.id, me.attendee?.id ?? 0);

  const hasMaps = !!maps.data?.length;
  // Up to eight round shortcuts in rows of four; everything else goes in the list under More.
  const shortcuts: Item[] = [
    { label: "My agenda", href: `${base}/my`, icon: <IconBookmark size={24} />, show: !!me.attendee },
    { label: "Speakers", href: `${base}/speakers`, icon: <IconMic size={24} />, show: true },
    { label: "Sponsors", href: `${base}/exhibitors?tab=sponsors`, icon: <IconStar size={24} />, show: f.exhibitors },
    { label: "Exhibitors", href: `${base}/exhibitors?tab=exhibitors`, icon: <IconStore size={24} />, show: f.exhibitors },
    { label: "Photos", href: `${base}/photos`, icon: <IconImage size={24} />, show: f.photos, dot: (photosLatest.data ?? 0) > seenAt },
    { label: "CE credits", href: `${base}/credits`, icon: <IconAward size={24} />, show: !!me.attendee },
    { label: "Dining", href: `${base}/dining`, icon: <IconFood size={24} />, show: f.dining },
    { label: "Venue map", href: `${base}/map`, icon: <IconMap size={24} />, show: hasMaps },
    { label: "Nearby", href: `${base}/nearby`, icon: <IconPin size={24} />, show: true },
    { label: "About host", href: `${base}/host`, icon: <IconInfo size={24} />, show: true },
  ];
  const shownRail = shortcuts.filter((r) => r.show).slice(0, 8);
  const inRail = new Set(shownRail.map((r) => r.label));
  const more: Item[] = [
    { label: "Alerts", href: `${base}/alerts`, icon: <IconBell size={20} />, show: true, badge: me.unread },
    { label: "CE credits", href: `${base}/credits`, icon: <IconAward size={20} />, show: !!me.attendee },
    { label: "Dining", href: `${base}/dining`, icon: <IconFood size={20} />, show: f.dining },
    { label: "Nearby", href: `${base}/nearby`, icon: <IconPin size={20} />, show: true },
    { label: "About host", href: `${base}/host`, icon: <IconInfo size={20} />, show: true },
    { label: "Help", href: `${base}/help`, icon: <IconHelp size={20} />, show: true },
    { label: "Lost and found", href: `${base}/lost-found`, icon: <IconSearch size={20} />, show: true },
    { label: "Speaker page", href: speakerPage.data?.url ?? "", icon: <IconMic size={20} />, show: !!speakerPage.data?.url, external: true },
    { label: "Scan leads", href: `${base}/leads`, icon: <IconQr size={20} />, show: isBooth },
  ].filter((m) => !inRail.has(m.label));

  return (
    <AppScreen nav="home" bodyStyle={{ padding: 0, gap: 0 }}>
      <HomeHero />
      <div className="home-wrap">
        <UpNext />
        {shownRail.length ? (
          <div className="home-rail">
            {shownRail.map((r) => (
              <Link key={r.label} href={r.href} aria-label={r.dot ? `${r.label}, new` : undefined}>
                <span className="ring">
                  {r.icon}
                  {r.dot ? <i className="home-dot" aria-hidden="true" /> : null}
                </span>
                {r.label}
              </Link>
            ))}
          </div>
        ) : null}
        <PassCard />
        <VenueCard hasMaps={hasMaps} />
        <div className="home-lab">More</div>
        <div className="home-list">
          {more
            .filter((m) => m.show)
            .map((m) => {
              const inner = (
                <>
                  {m.icon}
                  <span className="grow">{m.label}</span>
                  {m.badge ? <em>{m.badge > 99 ? "99+" : m.badge}</em> : null}
                  <IconChevron size={16} />
                </>
              );
              return m.external ? (
                <a key={m.label} href={m.href}>{inner}</a>
              ) : (
                <Link key={m.label} href={m.href}>{inner}</Link>
              );
            })}
        </div>
      </div>
      <div style={{ flex: 1 }} />
      <SponsorBanner />
    </AppScreen>
  );
}
