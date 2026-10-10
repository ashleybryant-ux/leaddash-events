import { router } from "./_core/trpc";
import { authRouter } from "./core/auth";
import { coreRouter } from "./core/router";
import { AREAS } from "./areas";

export const appRouter = router({
  auth: authRouter,
  core: coreRouter,
  program: AREAS.program.router,
  registration: AREAS.registration.router,
  ce: AREAS.ce.router,
  network: AREAS.network.router,
  agreements: AREAS.agreements.router,
});

export type AppRouter = typeof appRouter;
