import { defineModule } from "@kernl/extension-sdk";
import { gitlabChannelMigrations } from "./migrations.js";
import { GitLabConnectionsService } from "./connections-service.js";
import { GitLabRepoProvider } from "./provider.js";
import { gitlabChannelTools } from "./tools.js";

const TRIAGE_REGISTER_PROVIDER_EVENT = "triage:register-provider";

export function createGitLabChannelModule() {
  return defineModule({
    name: "gitlab-channel",
    migrations: gitlabChannelMigrations,
    migrationsKey: "ext:gitlab-channel",
    async init(ctx) {
      const connections = new GitLabConnectionsService(ctx.sqlite, ctx.config.encryption?.key ?? "");
      const provider = new GitLabRepoProvider(connections);

      await ctx.events.emit(TRIAGE_REGISTER_PROVIDER_EVENT, { provider });
      return { connections, provider };
    },
    tools: ({ connections, provider }) => gitlabChannelTools(connections, provider),
  });
}

export default createGitLabChannelModule;
