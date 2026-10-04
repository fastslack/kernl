/**
 * The job-hunter handlers as agent drivers.
 *
 * Handler ids are the ones these handlers had as kernel builtins
 * (`scraper:jobs:<platform>`, `scraper:jobs:curate`, `scraper:jobs:dispatch`)
 * — existing agent rows resolve by `builtin_handler`, so they must not move.
 *
 * The drivers carry NO `cron` on purpose: the kernel's driver seeder creates
 * an agent row for every driver with a cron, at every boot. These agents were
 * never seeded at boot — the "Jobs Hunter" office is opt-in, created by
 * `scripts/seeds/jobs-office.ts` from `JOB_SCRAPER_DEFS` — so the drivers only
 * contribute the run closures.
 */

import type { AgentDriver } from "@kernl/extension-sdk";
import type { JobHandler, JobHunterContext } from "./context.js";
import { createJobScraperHandler } from "./scrapers.js";
import { PLATFORMS } from "./platforms.js";
import { jobsCurator } from "./curator.js";
import { jobsDispatcher } from "./dispatcher.js";
import { JOB_SCRAPER_DEFS } from "./defs.js";

/** Handler id → handler body, in the order the kernel used to register them. */
export function jobHunterHandlers(ctx: JobHunterContext): Map<string, JobHandler> {
  const map = new Map<string, JobHandler>();
  for (const config of PLATFORMS) {
    map.set(`scraper:jobs:${config.platform}`, createJobScraperHandler(config)(ctx));
  }
  map.set("scraper:jobs:curate", jobsCurator(ctx));
  map.set("scraper:jobs:dispatch", jobsDispatcher(ctx));
  return map;
}

export function jobHunterAgentDrivers(ctx: JobHunterContext): AgentDriver[] {
  const defs = new Map(JOB_SCRAPER_DEFS.map((d) => [d.handler, d]));
  return [...jobHunterHandlers(ctx)].map(([handler, run]) => ({
    handler,
    name: defs.get(handler)?.name ?? handler,
    description: defs.get(handler)?.description ?? "",
    run,
  }));
}
