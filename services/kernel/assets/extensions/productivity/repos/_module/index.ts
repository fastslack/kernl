import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { reposMigrations } from "./migrations/001_repos.js";
import { RepoService } from "./service.js";
import { repoTools } from "./tools.js";
import { reposRpcActions } from "./rpc-actions.js";
import { queryRepos } from "./dashboard-queries.js";

export function createReposModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;

  return {
    name: "repos",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "repos", reposMigrations);
      dbRef = ctx.sqlite;
      const service = new RepoService(ctx.sqlite);
      tools = repoTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? reposRpcActions(dbRef) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        channels: [
          { name: "repos", query: (db) => queryRepos(db) },
        ],
        channelMappings: [
          { moduleKey: "repos", channels: ["repos"] },
        ],
        stores: ["repos"],
        fetchEndpoints: [
          { url: "/api/dashboard/repos", store: "repos" },
        ],
      };
    },

    async shutdown() {},
  };
}
