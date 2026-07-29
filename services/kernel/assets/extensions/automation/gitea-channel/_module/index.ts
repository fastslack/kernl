import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { giteaChannelMigrations } from "./migrations.js";
import { GiteaConnectionsService } from "./connections-service.js";
import { GiteaRepoProvider } from "./provider.js";
import { giteaChannelTools } from "./tools.js";

const TRIAGE_REGISTER_PROVIDER_EVENT = "triage:register-provider";

export function createGiteaChannelModule(): KernelModule {
  let tools: ToolDefinition[] = [];

  return {
    name: "gitea-channel",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "ext:gitea-channel", giteaChannelMigrations);
      const connections = new GiteaConnectionsService(ctx.sqlite);
      const provider = new GiteaRepoProvider(connections);
      tools = giteaChannelTools(connections, provider);

      // Topo sort guarantees triage's listener is in place because we
      // declared dependencies=[com.kernl.triage].
      await ctx.events.emit(TRIAGE_REGISTER_PROVIDER_EVENT, { provider });
    },

    getTools(): ToolDefinition[] {
      return tools;
    },

    async shutdown() {},
  };
}

export default createGiteaChannelModule;
