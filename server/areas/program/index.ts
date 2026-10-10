import { router } from "../../_core/trpc";
import type { AreaModule } from "../types";

export const programRouter = router({});

export const programArea: AreaModule<typeof programRouter> = { router: programRouter };
