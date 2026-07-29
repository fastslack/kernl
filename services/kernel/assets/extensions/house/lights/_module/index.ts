/**
 * Lights module - Control LED devices via WLED, Tasmota, etc.
 */

import type {
  DashboardDescriptor,
  ExtensibleModule,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { lightsMigrations } from "./migrations/001_lights.js";
import { LightsService } from "./service.js";
import { lightsTools } from "./tools.js";
import { registerLightsRoutes } from "./api-routes.js";

export interface LightsModule extends ExtensibleModule {
  getService(): LightsService | null;
}

export function createLightsModule(): LightsModule {
  let tools: ToolDefinition[] = [];
  let serviceRef: LightsService | null = null;

  return {
    name: "lights",

    async initialize(ctx: ModuleContext) {
      // Run SQLite migrations
      runMigrations(ctx.sqlite, "lights", lightsMigrations);

      // Create service
      const service = new LightsService(ctx.sqlite);
      serviceRef = service;

      // Register tools
      tools = lightsTools(service);
    },

    getTools() {
      return tools;
    },

    getService() {
      return serviceRef;
    },

    getDashboardDescriptor(): DashboardDescriptor | null {
      if (!serviceRef) return null;
      const service = serviceRef;
      return {
        registerRoutes: (server) => registerLightsRoutes(server, service),
      };
    },

    async shutdown() {
      // No cleanup needed
    },
  };
}

// Re-export types for external use
export type { LightsService } from "./service.js";
export type {
  LightDevice,
  LightState,
  LightScene,
  LightZone,
  LightSchedule,
  RgbColor,
} from "./types.js";
