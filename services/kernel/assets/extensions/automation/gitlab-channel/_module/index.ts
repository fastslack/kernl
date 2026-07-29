import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { gitlabChannelMigrations } from "./migrations.js";
import { GitLabConnectionsService } from "./connections-service.js";
import { GitLabRepoProvider } from "./provider.js";
import { gitlabChannelTools } from "./tools.js";

const TRIAGE_REGISTER_PROVIDER_EVENT = "triage:register-provider";

export function createGitLabChannelModule(): KernelModule {
  let tools: ToolDefinition[] = [];
  let provider: GitLabRepoProvider | null = null;

  return {
    name: "gitlab-channel",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "ext:gitlab-channel", gitlabChannelMigrations);
      const connections = new GitLabConnectionsService(ctx.sqlite);
      provider = new GitLabRepoProvider(connections);
      tools = gitlabChannelTools(connections, provider);

      await ctx.events.emit(TRIAGE_REGISTER_PROVIDER_EVENT, { provider });
    },

    getTools(): ToolDefinition[] {
      return tools;
    },

    async shutdown() {},
  };
}

export default createGitLabChannelModule;
