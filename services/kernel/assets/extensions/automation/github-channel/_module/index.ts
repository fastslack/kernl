import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { githubChannelMigrations } from "./migrations.js";
import { GitHubConnectionsService } from "./connections-service.js";
import { GitHubRepoProvider } from "./provider.js";
import { githubChannelTools } from "./tools.js";

const TRIAGE_REGISTER_PROVIDER_EVENT = "triage:register-provider";

export function createGitHubChannelModule(): KernelModule {
  let tools: ToolDefinition[] = [];

  return {
    name: "github-channel",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "ext:github-channel", githubChannelMigrations);
      const connections = new GitHubConnectionsService(ctx.sqlite);
      const provider = new GitHubRepoProvider(connections);
      tools = githubChannelTools(connections, provider);

      // Topo sort guarantees triage's listener is in place because we
      // declared dependencies=[triage].
      await ctx.events.emit(TRIAGE_REGISTER_PROVIDER_EVENT, { provider });
    },

    getTools(): ToolDefinition[] {
      return tools;
    },

    async shutdown() {},
  };
}

export default createGitHubChannelModule;
