import type {
  DashboardDescriptor,
  ExtensibleModule,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { externalAgentsMigrations } from "./migrations.js";
import { ExternalAgentService } from "./service.js";
import { externalAgentTools } from "./tools.js";
import { registerExternalAgentRoutes } from "./api-routes.js";

export function createExternalAgentsModule(): ExtensibleModule & {
  getService(): ExternalAgentService | null;
} {
  let tools: ToolDefinition[] = [];
  let service: ExternalAgentService | null = null;

  return {
    name: "external-agents",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "external-agents", externalAgentsMigrations);

      service = new ExternalAgentService(ctx.sqlite, ctx.events, ctx.notifier);
      tools = externalAgentTools(service);
    },

    getTools() {
      return tools;
    },

    getService() {
      return service;
    },

    getDashboardDescriptor(): DashboardDescriptor | null {
      if (!service) return null;
      const svc = service;
      return {
        registerRoutes: (server) => registerExternalAgentRoutes(server, svc),
      };
    },

    async shutdown() {},
  };
}
