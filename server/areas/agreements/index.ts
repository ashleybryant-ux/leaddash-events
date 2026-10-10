/**
 * Agreements: sponsor, exhibitor and speaker agreement templates, sending,
 * signing (on the checkout page or from an emailed link), and the signed copy.
 */
import { router } from "../../_core/trpc";
import type { AreaModule } from "../types";

export const agreementsRouter = router({});

export const agreementsArea: AreaModule<typeof agreementsRouter> = {
  router: agreementsRouter,
};
