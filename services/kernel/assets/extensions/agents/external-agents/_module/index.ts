import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { externalAgentsMigrations } from "./migrations.js";
import { ExternalAgentService } from "./service.js";
import { externalAgentTools } from "./tools.js";
import { registerExternalAgentRoutes } from "./api-routes.js";

export function createExternalAgentsModule(): ExtensibleModule & {
  getService(): ExternalAgentService | null;
} {
  let service: ExternalAgentService | null = null;

  return {
    ...defineModule({
      name: "external-agents",
      migrations: externalAgentsMigrations,
      init(ctx) {
        service = new ExternalAgentService(ctx.sqlite, ctx.events, ctx.notifier);
        return service;
      },
      tools: externalAgentTools,
      dashboard: (svc) => (svc ? { registerRoutes: (server) => registerExternalAgentRoutes(server, svc) } : null),
    }),

    getService() {
      return service;
    },
  };
}
