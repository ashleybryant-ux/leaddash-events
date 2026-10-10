import { router } from "../../_core/trpc";
import type { AreaModule } from "../types";

export const registrationRouter = router({});

export const registrationArea: AreaModule<typeof registrationRouter> = { router: registrationRouter };
