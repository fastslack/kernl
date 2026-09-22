import { defineModule } from "@kernl/extension-sdk";
import { giteaChannelMigrations } from "./migrations.js";
import { GiteaConnectionsService } from "./connections-service.js";
import { GiteaRepoProvider } from "./provider.js";
import { giteaChannelTools } from "./tools.js";

const TRIAGE_REGISTER_PROVIDER_EVENT = "triage:register-provider";

export function createGiteaChannelModule() {
  return defineModule({
    name: "gitea-channel",
    migrations: giteaChannelMigrations,
    migrationsKey: "ext:gitea-channel",
    async init(ctx) {
      const connections = new GiteaConnectionsService(ctx.sqlite);
      const provider = new GiteaRepoProvider(connections);

      // Topo sort guarantees triage's listener is in place because we
      // declared dependencies=[com.kernl.triage].
      await ctx.events.emit(TRIAGE_REGISTER_PROVIDER_EVENT, { provider });
      return { connections, provider };
    },
    tools: ({ connections, provider }) => giteaChannelTools(connections, provider),
  });
}

export default createGiteaChannelModule;
