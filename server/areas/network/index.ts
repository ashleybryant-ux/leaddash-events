import { z } from "zod";
import { protectedProcedure, router } from "../../_core/trpc";
import type { AreaModule } from "../types";

export const networkRouter = router({
  /** Unread direct messages for the bottom nav badge. (Placeholder until the messaging area is built.) */
  unreadMessages: protectedProcedure.input(z.object({ slug: z.string() })).query(() => 0),
});

export const networkArea: AreaModule<typeof networkRouter> = { router: networkRouter };
