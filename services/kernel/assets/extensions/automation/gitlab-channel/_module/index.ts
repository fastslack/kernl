import { defineModule } from "@kernl/extension-sdk";
import { gitlabChannelMigrations } from "./migrations.js";
import { GitLabConnectionsService } from "./connections-service.js";
import { GitLabRepoProvider } from "./provider.js";
import { gitlabChannelTools } from "./tools.js";
import { forgeConnectionRpc } from "../../_lib/forge/index.js";

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
      return { connections, provider, db: ctx.sqlite };
    },
    tools: ({ connections, provider, db }) => gitlabChannelTools(connections, provider, db),
    rpc: ({ connections, provider, db }) => forgeConnectionRpc({
      prefix: "gitlab",
      label: "GitLab",
      connections,
      provider,
      db,
      hostOf: (c) => { try { return new URL(c.host).hostname.toLowerCase(); } catch { return ""; } },
      // The token's user has to be a member of each project: its members page, one per repo.
      fixHint: (c, missing) => {
        const base = (c.host || "https://gitlab.com").replace(/\/+$/, "");
        const pages = missing.map((p) => `${base}/${p}/-/project_members`).join(" ");
        return `sumá al usuario del token como miembro (rol Reporter o más) y probá de nuevo: ${pages}`;
      },
      addInput: (a) => ({
        name: String(a.name ?? ""),
        token: String(a.token ?? ""),
        host: typeof a.host === "string" && a.host.trim() ? a.host.trim() : undefined,
      }),
    }),
  });
}

export default createGitLabChannelModule;
