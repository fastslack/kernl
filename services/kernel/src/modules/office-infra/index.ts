import type {
  ExtensibleModule,
  DashboardDescriptor,
  ModuleContext,
  ToolDefinition,
} from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";
import { officeInfraMigrations } from "./migrations.js";
import { OfficeEnvironmentService } from "./office-environment-service.js";
import { officeEnvTools } from "./office-environment-tools.js";
import { registerOfficeInfraRoutes } from "./api-routes.js";

export function createOfficeInfraModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let service: OfficeEnvironmentService | null = null;

  return {
    name: "office-infra",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "office-infra", officeInfraMigrations);
      // Pass the event bus so lifecycle actions emit `office:infra:changed`
      // (bootstrap forwards it to the 3D office as an agentFlow event).
      service = new OfficeEnvironmentService(ctx.sqlite, undefined, ctx.events);
      tools = officeEnvTools(service);
    },
    getTools() {
      return tools;
    },
    getDashboardDescriptor(): DashboardDescriptor | null {
      return {
        registerRoutes: (server) => {
          if (service) registerOfficeInfraRoutes(server, service);
        },
      };
    },
    async shutdown() {},
  };
}
