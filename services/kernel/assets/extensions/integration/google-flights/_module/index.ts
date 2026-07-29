/**
 * Google Flights module — live fare search via Google Flights' internal
 * API. Loaded as an extension (assets/extensions/google-flights/) but the
 * factory is also exported here for direct use in tests.
 */

import { runMigrations } from "../../../../../src/core/db/migrations.js";
import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { googleFlightsMigrations } from "./migrations.js";
import { GoogleFlightsService } from "./service.js";
import { googleFlightsTools } from "./tools.js";
import { seedFlightsAgent } from "../../../agents/agent-advanced/_module/seed-flights-agent.js";
import { log } from "../../../../../src/core/logger.js";

export interface GoogleFlightsModule extends KernelModule {
  getService(): GoogleFlightsService;
}

export function createGoogleFlightsModule(): GoogleFlightsModule {
  let tools: ToolDefinition[] = [];
  let service: GoogleFlightsService | null = null;

  return {
    name: "google-flights",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "google-flights", googleFlightsMigrations);
      service = new GoogleFlightsService(ctx.sqlite);
      tools = googleFlightsTools(service);

      // Flights Concierge agent seeding is disabled — during the fleet
      // consolidation pass the agent was migrated into a different office.
      // Re-running the seeder would recreate the Flights flow and overwrite
      // that move on every boot.
      // try {
      //   const agentsHandle = ctx.getModule?.("agents") as
      //     | { getService?: () => unknown }
      //     | null;
      //   const agentService = agentsHandle?.getService?.() as
      //     | Parameters<typeof seedFlightsAgent>[1]
      //     | undefined;
      //   if (agentService) {
      //     seedFlightsAgent(ctx.sqlite, agentService);
      //   }
      // } catch (err) {
      //   log.warn(`google-flights: Flights Concierge seed skipped: ${err}`);
      // }
      void seedFlightsAgent; // keep import alive (re-enable to restore)
    },
    getTools() {
      return tools;
    },
    getService() {
      if (!service) throw new Error("google-flights module not initialized");
      return service;
    },
    async shutdown() {},
  };
}

export type { GoogleFlightsService } from "./service.js";
export type { SimpleSearchInput, SearchOutcome } from "./service.js";
export type * from "./types.js";
