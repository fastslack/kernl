import { defineModule } from "@kernl/extension-sdk";
import { githubChannelMigrations } from "./migrations.js";
import { GitHubConnectionsService } from "./connections-service.js";
import { GitHubRepoProvider } from "./provider.js";
import { githubChannelTools } from "./tools.js";
import { forgeConnectionRpc } from "../../_lib/forge/index.js";

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
      return { connections, provider, db: ctx.sqlite };
    },
    tools: ({ connections, provider, db }) => githubChannelTools(connections, provider, db),
    rpc: ({ connections, provider, db }) => forgeConnectionRpc({
      prefix: "github",
      label: "GitHub",
      connections,
      provider,
      db,
      hostOf: () => "github.com",
      addInput: (a) => ({
        name: String(a.name ?? ""),
        token: typeof a.token === "string" ? a.token : undefined,
        app_id: typeof a.app_id === "string" ? a.app_id : undefined,
        installation_id: typeof a.installation_id === "string" ? a.installation_id : undefined,
        private_key_pem: typeof a.private_key_pem === "string" ? a.private_key_pem : undefined,
      }),
    }),
  });
}

export default createGitHubChannelModule;
