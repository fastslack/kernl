/**
 * Job Hunter — job-board scrapers, a deterministic curator and a dispatcher
 * that hands the best hits to an LLM drafter.
 *
 * Contributes no tools, only agent drivers: the kernel merges their run
 * closures into its builtin-handler map, so any agent row whose
 * `builtin_handler` is one of the `scraper:jobs:*` ids runs this code. The
 * agents themselves are created by `scripts/seeds/jobs-office.ts`.
 */

import { defineModule, type ExtensibleModule, type ModuleContext } from "@kernl/extension-sdk";
import type { JobHunterContext } from "./context.js";
import { jobHunterAgentDrivers } from "./drivers.js";

export { JOB_SCRAPER_DEFS } from "./defs.js";

/** The handler context, from the kernel's module context. */
function handlerContext(ctx: ModuleContext): JobHunterContext {
  return {
    db: ctx.sqlite,
    notifier: ctx.notifier,
    config: ctx.config,
    // Looked up per run, not captured at init: agent-advanced registers the
    // WorkspaceService on the agents module when it loads.
    workspaceService: () =>
      (ctx.getModule?.("agents") as { getWorkspaceService?: () => unknown } | null)
        ?.getWorkspaceService?.() ?? null,
  };
}

export function createJobHunterModule(): ExtensibleModule {
  return defineModule({
    name: "job-hunter",
    init: (ctx) => handlerContext(ctx),
    agentDrivers: (ctx) => jobHunterAgentDrivers(ctx),
  });
}
