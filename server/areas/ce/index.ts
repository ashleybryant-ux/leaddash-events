import { router } from "../../_core/trpc";
import type { AreaModule } from "../types";

export const ceRouter = router({});

export const ceArea: AreaModule<typeof ceRouter> = { router: ceRouter };
