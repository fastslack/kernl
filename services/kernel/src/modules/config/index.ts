import type { KernelModule, ModuleContext, ToolDefinition } from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";
import { configMigrations } from "./migrations/001_config.js";
import { ConfigService } from "./service.js";
import { configTools } from "./tools.js";
import { modelTools } from "./model-tools.js";

export { ConfigService } from "./service.js";

export interface ConfigModule extends KernelModule {
  getService(): ConfigService | null;
}

export function createConfigModule(): ConfigModule {
  let tools: ToolDefinition[] = [];
  let service: ConfigService | null = null;

  return {
    name: "config",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "config", configMigrations);
      service = new ConfigService(ctx.sqlite, ctx.config, ctx.events);
      service.seed();
      tools = [
        ...configTools(service),
        ...modelTools(service, ctx.sqlite, ctx.config, ctx.events),
      ];

      // Listen for config:changed events from external sources (e.g. HTTP routes)
      // so the DB stays in sync even when changes come from outside the module
      ctx.events.on("config:changed", (payload: unknown) => {
        const { key, value } = payload as { key: string; value: string };
        // Only update the DB record's value + timestamp; don't re-trigger everything
        ctx.sqlite.prepare(
          "UPDATE app_settings SET value=?, updated_at=datetime('now'), updated_by='external' WHERE key=?"
        ).run(value, key);
      });
    },

    getTools() {
      return tools;
    },

    getService() {
      return service;
    },

    async shutdown() {},
  };
}
