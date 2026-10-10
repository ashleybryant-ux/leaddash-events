import type { Express } from "express";
import { programArea } from "./program";
import { registrationArea } from "./registration";
import { ceArea } from "./ce";
import { networkArea } from "./network";
import { agreementsArea } from "./agreements";
import type { Job } from "./types";

export const AREAS = { program: programArea, registration: registrationArea, ce: ceArea, network: networkArea, agreements: agreementsArea };
const list = Object.values(AREAS);

/** Runs every area's defaults for a new event. */
export async function seedEvent(eventId: number) {
  for (const a of list) await a.seedEvent?.(eventId);
}

export const allJobs = (): Job[] => list.flatMap((a) => a.jobs ?? []);
export const registerAreaRawHttp = (app: Express) => list.forEach((a) => a.registerRawHttp?.(app));
export const registerAreaHttp = (app: Express) => list.forEach((a) => a.registerHttp?.(app));
