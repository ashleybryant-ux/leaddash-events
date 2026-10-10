/** Dining, About your host, branding and app features, and the attendee's alert choices. */
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { protectedProcedure, router } from "../../_core/trpc";
import { getDb, schema } from "../../_core/db";
import { audit, notFound, requireEventAdmin } from "../../_core/access";
import { fileUrl } from "../../_core/files";
import type { EventBranding, HostLink } from "../../../drizzle/schema";
import { LOOK_BACKGROUNDS, LOOK_BUTTON_TEXT, LOOK_FONTS, LOOK_HEADERS, LOOK_SHAPES, LOOK_TEXT_SIZES, lookOf } from "@shared/brand";
import { attendeeViewer, bad, hex, hhmm, isoDate, url, viewer } from "./util";

const DIETARY = ["V", "VG", "GF", "DF", "NF", "H", "K"] as const;
const NEARBY = ["quick", "sitdown", "coffee", ""] as const;

const optTime = z.union([z.literal(""), hhmm]);

const mealInput = z.object({
  date: isoDate,
  meal: z.string().trim().min(1).max(80),
  time: optTime.default(""),
  endTime: optTime.default(""),
  location: z.string().trim().max(120).default(""),
  items: z.array(z.object({ name: z.string().trim().min(1).max(160), dietary: z.array(z.enum(DIETARY)).max(7) })).max(40).default([]),
  note: z.string().trim().max(300).default(""),
  sort: z.number().int().min(0).max(1000).default(0),
});

const placeInput = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.enum(NEARBY).default(""),
  cuisine: z.string().trim().max(80).default(""),
  price: z.enum(["", "$", "$$", "$$$", "$$$$"]).default(""),
  walkMinutes: z.number().int().min(0).max(240).nullable().default(null),
  description: z.string().trim().max(200).default(""),
  address: z.string().trim().max(240).default(""),
  url: url.default(""),
  phone: z.string().trim().max(40).default(""),
  note: z.string().trim().max(120).default(""),
  sort: z.number().int().min(0).max(1000).default(0),
});

function getDining(eventId: number, id: number) {
  const row = getDb().select().from(schema.diningItems).where(eq(schema.diningItems.id, id)).get();
  if (!row || row.eventId !== eventId) throw notFound("That item");
  return row;
}

const byMealTime = (a: { date: string; time: string; sort: number }, b: { date: string; time: string; sort: number }) => (a.date + a.time).localeCompare(b.date + b.time) || a.sort - b.sort;

function checkImage(orgId: number, fileId: number | null | undefined) {
  if (!fileId) return;
  const f = getDb().select().from(schema.files).where(eq(schema.files.id, fileId)).get();
  if (!f || (f.orgId !== null && f.orgId !== orgId) || !f.mime.startsWith("image/")) throw bad("Upload the image again.");
}

/** Host links are kept as labeled links; these labels have their own fields. */
const HOST_LABELS = ["Website", "Email", "Phone", "Instagram", "Facebook", "LinkedIn"] as const;

function hostView(ev: typeof schema.events.$inferSelect) {
  const link = (label: string) => ev.hostLinks.find((l) => l.label === label)?.url ?? "";
  const org = getDb().select({ slug: schema.organizations.slug, name: schema.organizations.name, logoFileId: schema.organizations.logoFileId }).from(schema.organizations).where(eq(schema.organizations.id, ev.orgId)).get()!;
  const join = ev.hostJoinUrl === "website" ? link("Website") : ev.hostJoinUrl === "member" ? "" : ev.hostJoinUrl;
  return {
    name: ev.hostName || org.name,
    about: ev.hostAbout,
    mission: ev.hostMission,
    imageFileId: ev.hostImageFileId,
    imageUrl: fileUrl(ev.hostImageFileId ?? org.logoFileId),
    joinMode: ev.hostJoinUrl === "website" ? "website" : ev.hostJoinUrl && ev.hostJoinUrl !== "member" ? "custom" : "hidden",
    joinUrl: join,
    website: link("Website"),
    email: link("Email").replace(/^mailto:/, ""),
    phone: link("Phone").replace(/^tel:/, ""),
    instagram: link("Instagram"),
    facebook: link("Facebook"),
    linkedin: link("LinkedIn"),
    otherLinks: ev.hostLinks.filter((l) => !(HOST_LABELS as readonly string[]).includes(l.label)),
  };
}

/** Badge layout choices kept with the event's branding. */
/** Band color on the badge for each kind of attendee. */
export type BandColors = { attendee: string; speaker: string; vendor: string; staff: string };
export type BadgeLayout = NonNullable<EventBranding["badge"]> & { nameStyle?: "first" | "full"; showQr?: boolean; bandColors?: BandColors };
type BrandingExtra = EventBranding & { iconFileId?: number | null; badge?: BadgeLayout };

const DEFAULT_BANDS: BandColors = { attendee: "#1F5F4A", speaker: "#e88a3a", vendor: "#2F5D8A", staff: "#0F2A23" };
const DEFAULT_BADGE: BadgeLayout = { showCredentials: true, showOrg: false, showCity: true, ribbonByTicket: true, size: "4x3", nameStyle: "first", showQr: true, bandColors: DEFAULT_BANDS };

const FEATURE_KEYS = ["networking", "community", "messaging", "meetings", "polls", "exhibitors", "dining"] as const;

export const diningRouter = router({
  adminList: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => {
    requireEventAdmin(ctx.user, input.eventId);
    const rows = getDb().select().from(schema.diningItems).where(eq(schema.diningItems.eventId, input.eventId)).all();
    return {
      menu: rows.filter((r) => r.kind === "menu").sort(byMealTime),
      nearby: rows.filter((r) => r.kind === "nearby").sort((a, b) => a.sort - b.sort || (a.walkMinutes ?? 999) - (b.walkMinutes ?? 999)),
    };
  }),

  saveMeal: protectedProcedure.input(mealInput.extend({ eventId: z.number(), id: z.number().nullable().default(null) })).mutation(({ ctx, input }) => {
    const ev = requireEventAdmin(ctx.user, input.eventId);
    if (input.date < ev.startDate || input.date > ev.endDate) throw bad("Pick a date during the event.");
    if (input.time && input.endTime && input.endTime <= input.time) throw bad("The meal ends before it starts.");
    const { eventId, id, meal, ...rest } = input;
    const values = { ...rest, eventId, kind: "menu" as const, meal, title: meal, dietary: Array.from(new Set(rest.items.flatMap((i) => i.dietary))) };
    if (id) {
      getDining(eventId, id);
      return getDb().update(schema.diningItems).set(values).where(eq(schema.diningItems.id, id)).returning().get();
    }
    return getDb().insert(schema.diningItems).values(values).returning().get();
  }),

  savePlace: protectedProcedure.input(placeInput.extend({ eventId: z.number(), id: z.number().nullable().default(null) })).mutation(({ ctx, input }) => {
    requireEventAdmin(ctx.user, input.eventId);
    const { eventId, id, ...rest } = input;
    const values = { ...rest, eventId, kind: "nearby" as const };
    if (id) {
      getDining(eventId, id);
      return getDb().update(schema.diningItems).set(values).where(eq(schema.diningItems.id, id)).returning().get();
    }
    return getDb().insert(schema.diningItems).values(values).returning().get();
  }),

  delete: protectedProcedure.input(z.object({ eventId: z.number(), id: z.number() })).mutation(({ ctx, input }) => {
    requireEventAdmin(ctx.user, input.eventId);
    getDining(input.eventId, input.id);
    getDb().delete(schema.diningItems).where(eq(schema.diningItems.id, input.id)).run();
    return { ok: true };
  }),

  /** Attendee app: event meals and places near the venue. */
  list: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const { event } = viewer(ctx.user, input.slug);
    if (!event.features.dining) return { menu: [], nearby: [] };
    const rows = getDb().select().from(schema.diningItems).where(eq(schema.diningItems.eventId, event.id)).all();
    return {
      menu: rows.filter((r) => r.kind === "menu").sort(byMealTime),
      nearby: rows.filter((r) => r.kind === "nearby").sort((a, b) => a.sort - b.sort || (a.walkMinutes ?? 999) - (b.walkMinutes ?? 999)),
    };
  }),
});

export const hostRouter = router({
  adminGet: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => hostView(requireEventAdmin(ctx.user, input.eventId))),

  update: protectedProcedure
    .input(
      z.object({
        eventId: z.number(),
        name: z.string().trim().max(160),
        about: z.string().max(5000),
        mission: z.string().max(2000).default(""),
        imageFileId: z.number().int().nullable(),
        joinMode: z.enum(["website", "custom", "hidden"]),
        joinUrl: url.default(""),
        website: url,
        email: z.union([z.literal(""), z.string().trim().email().max(200)]),
        phone: z.string().trim().max(40),
        instagram: url,
        facebook: url,
        linkedin: url,
      })
    )
    .mutation(({ ctx, input }) => {
      const ev = requireEventAdmin(ctx.user, input.eventId);
      checkImage(ev.orgId, input.imageFileId);
      if (input.joinMode === "website" && !input.website) throw bad("Add the website first.");
      if (input.joinMode === "custom" && !/^https:\/\//.test(input.joinUrl)) throw bad("Add the join link (https://).");
      const links: HostLink[] = [
        { label: "Website", url: input.website },
        { label: "Email", url: input.email ? `mailto:${input.email}` : "" },
        { label: "Phone", url: input.phone ? `tel:${input.phone}` : "" },
        { label: "Instagram", url: input.instagram },
        { label: "Facebook", url: input.facebook },
        { label: "LinkedIn", url: input.linkedin },
      ].filter((l) => l.url);
      const keep = ev.hostLinks.filter((l) => !(HOST_LABELS as readonly string[]).includes(l.label));
      getDb()
        .update(schema.events)
        .set({
          hostName: input.name,
          hostAbout: input.about,
          hostMission: input.mission,
          hostImageFileId: input.imageFileId,
          hostLinks: [...links, ...keep],
          hostJoinUrl: input.joinMode === "hidden" ? "" : input.joinMode === "custom" ? input.joinUrl : input.joinMode,
        })
        .where(eq(schema.events.id, ev.id))
        .run();
      audit(ctx.user, { orgId: ev.orgId, eventId: ev.id, action: "host.update" });
      return { ok: true };
    }),

  /** Attendee app: About your host. */
  get: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const { event } = viewer(ctx.user, input.slug);
    const v = hostView(event);
    return { ...v, imageFileId: undefined };
  }),
});

export const brandingRouter = router({
  get: protectedProcedure.input(z.object({ eventId: z.number() })).query(({ ctx, input }) => {
    const ev = requireEventAdmin(ctx.user, input.eventId);
    const b = ev.branding as BrandingExtra;
    const types = getDb().select({ id: schema.ticketTypes.id, name: schema.ticketTypes.name, ribbon: schema.ticketTypes.ribbon }).from(schema.ticketTypes).where(eq(schema.ticketTypes.eventId, ev.id)).orderBy(asc(schema.ticketTypes.sort)).all();
    return {
      slug: ev.slug,
      name: ev.name,
      shortName: ev.shortName,
      appName: b.appName || ev.shortName || ev.name,
      colorPrimary: b.colorPrimary,
      colorAccent: b.colorAccent,
      look: lookOf(b),
      logoFileId: b.logoFileId ?? null,
      logoUrl: fileUrl(b.logoFileId),
      coverFileId: b.coverFileId ?? null,
      coverUrl: fileUrl(b.coverFileId),
      iconFileId: b.iconFileId ?? null,
      iconUrl: fileUrl(b.iconFileId),
      badge: { ...DEFAULT_BADGE, ...(b.badge ?? {}), bandColors: { ...DEFAULT_BANDS, ...(b.badge?.bandColors ?? {}) } },
      features: ev.features,
      ticketTypes: types,
    };
  }),

  update: protectedProcedure
    .input(
      z.object({
        eventId: z.number(),
        appName: z.string().trim().max(60),
        colorPrimary: hex,
        colorAccent: hex,
        /** How attendee-facing pages look. Left out by older screens: the saved look stays. */
        look: z
          .object({
            header: z.enum(LOOK_HEADERS),
            buttonShape: z.enum(LOOK_SHAPES),
            font: z.enum(LOOK_FONTS),
            buttonText: z.enum(LOOK_BUTTON_TEXT),
            background: z.enum(LOOK_BACKGROUNDS),
            textSize: z.enum(LOOK_TEXT_SIZES),
          })
          .optional(),
        logoFileId: z.number().int().nullable(),
        coverFileId: z.number().int().nullable(),
        iconFileId: z.number().int().nullable(),
        badge: z.object({
          showCredentials: z.boolean(),
          showOrg: z.boolean(),
          showCity: z.boolean(),
          ribbonByTicket: z.boolean(),
          size: z.enum(["4x3", "4x6"]),
          nameStyle: z.enum(["first", "full"]),
          showQr: z.boolean(),
          bandColors: z.object({ attendee: hex, speaker: hex, vendor: hex, staff: hex }).optional(),
        }),
        features: z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<(typeof FEATURE_KEYS)[number], z.ZodBoolean>),
      })
    )
    .mutation(({ ctx, input }) => {
      const ev = requireEventAdmin(ctx.user, input.eventId);
      for (const id of [input.logoFileId, input.coverFileId, input.iconFileId]) checkImage(ev.orgId, id);
      const branding: BrandingExtra = {
        ...(ev.branding as BrandingExtra),
        appName: input.appName,
        colorPrimary: input.colorPrimary,
        colorAccent: input.colorAccent,
        ...lookOf(input.look ?? (ev.branding as BrandingExtra)),
        logoFileId: input.logoFileId,
        coverFileId: input.coverFileId,
        iconFileId: input.iconFileId,
        badge: input.badge,
      };
      getDb().update(schema.events).set({ branding, features: input.features }).where(eq(schema.events.id, ev.id)).run();
      audit(ctx.user, { orgId: ev.orgId, eventId: ev.id, action: "branding.update" });
      return { ok: true };
    }),
});

export const alertsRouter = router({
  /** The attendee's push choices. */
  prefs: protectedProcedure.input(z.object({ slug: z.string().max(120) })).query(({ ctx, input }) => {
    const v = viewer(ctx.user, input.slug);
    if (!v.attendee) return null;
    const row = getDb().select().from(schema.alertPrefs).where(eq(schema.alertPrefs.attendeeId, v.attendee.id)).get();
    return { reminders: row?.reminders ?? true, evaluations: row?.evaluations ?? true, changes: row?.changes ?? true, announcements: row?.announcements ?? true };
  }),

  setPrefs: protectedProcedure
    .input(z.object({ slug: z.string().max(120), reminders: z.boolean(), evaluations: z.boolean(), changes: z.boolean(), announcements: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const { attendee } = attendeeViewer(ctx.user, input.slug);
      const { slug, ...prefs } = input;
      void slug;
      getDb()
        .insert(schema.alertPrefs)
        .values({ attendeeId: attendee.id, ...prefs, updatedAt: new Date() })
        .onConflictDoUpdate({ target: schema.alertPrefs.attendeeId, set: { ...prefs, updatedAt: new Date() } })
        .run();
      return { ok: true };
    }),
});

/** Used by tests and other areas: does this attendee want push for this kind of notice? */
export function wantsPush(attendeeId: number, kind: "reminders" | "evaluations" | "changes" | "announcements") {
  const row = getDb().select().from(schema.alertPrefs).where(and(eq(schema.alertPrefs.attendeeId, attendeeId))).get();
  return row ? row[kind] : true;
}
