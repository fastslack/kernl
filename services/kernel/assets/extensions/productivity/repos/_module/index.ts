import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { reposMigrations } from "./migrations/001_repos.js";
import { repoAccessMigrations } from "./migrations/002_repo_access.js";
import { RepoService } from "./service.js";
import { repoTools } from "./tools.js";
import { reposRpcActions } from "./rpc-actions.js";
import { queryRepos } from "./dashboard-queries.js";

export function createReposModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;
  // The roots the kernel can actually reach. Kept so the register path can
  // tell an operator why a path they know exists is invisible from in here.
  let visibleRoots: string[] = [];

  return {
    name: "repos",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "repos", [...reposMigrations, ...repoAccessMigrations]);
      dbRef = ctx.sqlite;
      visibleRoots = ctx.config?.fsCommander?.allowedRoots ?? [];
      const service = new RepoService(ctx.sqlite);
      tools = repoTools(service, visibleRoots);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? reposRpcActions(dbRef, visibleRoots) : [];
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
