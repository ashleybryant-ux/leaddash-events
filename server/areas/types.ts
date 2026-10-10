import type { Express } from "express";
import type { AnyRouter } from "@trpc/server";

/** A job the scheduler runs every minute. Keep each run short; it must never throw for one bad row. */
export type Job = { name: string; run: () => Promise<void> | void };

/** What each feature area hands to the app. */
export type AreaModule<R extends AnyRouter = AnyRouter> = {
  router: R;
  /** Fills a new event with sensible defaults (ticket types, templates, roles...). */
  seedEvent?: (eventId: number) => Promise<void> | void;
  jobs?: Job[];
  /** Plain Express routes (webhooks, embed script, manifests, printable pages). Registered before tRPC. */
  registerHttp?: (app: Express) => void;
  /** Express routes that need the raw body (Stripe webhooks). Registered before JSON parsing. */
  registerRawHttp?: (app: Express) => void;
};
