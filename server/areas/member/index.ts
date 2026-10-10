import { router } from "../../_core/trpc";
import type { AreaModule } from "../types";

export const memberRouter = router({});

export const memberArea: AreaModule<typeof memberRouter> = { router: memberRouter };
