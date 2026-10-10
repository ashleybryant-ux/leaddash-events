/**
 * The member hub (association-branded member app) and the association admin
 * screens: Membership, Divisions and committees, Documents, Reports across
 * programs. The LeadDash platform stays the record for dues and payments.
 */
import { router } from "../../_core/trpc";
import type { AreaModule } from "../types";
import { hubRouter, membersAdminRouter } from "./members";
import { groupsAdminRouter, groupsHubRouter } from "./groups";
import { docsAdminRouter, docsHubRouter } from "./docs";
import { insightsJobs, insightsRouter } from "./insights";
import { registerWalletRoutes } from "./wallet";

export const memberRouter = router({
  /** What members see (memberFor). */
  hub: hubRouter,
  groups: groupsHubRouter,
  docs: docsHubRouter,
  /** Association admins (requireOrgAdmin). */
  admin: router({
    members: membersAdminRouter,
    groups: groupsAdminRouter,
    docs: docsAdminRouter,
    insights: insightsRouter,
  }),
});

export const memberArea: AreaModule<typeof memberRouter> = { router: memberRouter, jobs: insightsJobs, registerHttp: registerWalletRoutes };
