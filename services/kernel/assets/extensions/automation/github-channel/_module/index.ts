import { defineModule } from "@kernl/extension-sdk";
import { githubChannelMigrations } from "./migrations.js";
import { GitHubConnectionsService } from "./connections-service.js";
import { GitHubRepoProvider } from "./provider.js";
import { githubChannelTools } from "./tools.js";

const TRIAGE_REGISTER_PROVIDER_EVENT = "triage:register-provider";

export function createGitHubChannelModule() {
  return defineModule({
    name: "github-channel",
    migrations: githubChannelMigrations,
    migrationsKey: "ext:github-channel",
    async init(ctx) {
      const connections = new GitHubConnectionsService(ctx.sqlite, ctx.config.encryption?.key ?? "");
      const provider = new GitHubRepoProvider(connections);

      // Topo sort guarantees triage's listener is in place because we
      // declared dependencies=[triage].
      await ctx.events.emit(TRIAGE_REGISTER_PROVIDER_EVENT, { provider });
      return { connections, provider };
    },
    tools: ({ connections, provider }) => githubChannelTools(connections, provider),
  });
}

export default createGitHubChannelModule;
