/**
 * Lights module - Control LED devices via WLED, Tasmota, etc.
 */

import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { lightsMigrations } from "./migrations/001_lights.js";
import { LightsService } from "./service.js";
import { lightsTools } from "./tools.js";
import { registerLightsRoutes } from "./api-routes.js";

export interface LightsModule extends ExtensibleModule {
  getService(): LightsService | null;
}

export function createLightsModule(): LightsModule {
  let serviceRef: LightsService | null = null;

  const mod = defineModule({
    name: "lights",
    migrations: lightsMigrations,
    init(ctx) {
      serviceRef = new LightsService(ctx.sqlite);
      return serviceRef;
    },
    tools: lightsTools,
    // No descriptor until the service exists.
    dashboard: (service) =>
      service ? { registerRoutes: (server) => registerLightsRoutes(server, service) } : null,
  });
  return Object.assign(mod, { getService: () => serviceRef });
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
