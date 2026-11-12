import { defineModule, dashboardChannel } from "@kernl/extension-sdk";
import { reposMigrations } from "./migrations/001_repos.js";
import { repoAccessMigrations } from "./migrations/002_repo_access.js";
import { RepoService } from "./service.js";
import { repoTools } from "./tools.js";
import { CodeGraph } from "./code-graph.js";
import { codeGraphTools } from "./code-graph-tools.js";
import { reposRpcActions } from "./rpc-actions.js";
import { queryRepos } from "./dashboard-queries.js";

export function createReposModule() {
  return defineModule({
    name: "repos",
    migrations: [...reposMigrations, ...repoAccessMigrations],
    init: (ctx) => ({
      db: ctx.sqlite,
      // The roots the kernel can actually reach. Kept so the register path can
      // tell an operator why a path they know exists is invisible from in here.
      visibleRoots: ctx.config?.fsCommander?.allowedRoots ?? [],
      service: new RepoService(ctx.sqlite),
      // Hotspots, owners and co-change, derived from git history on demand.
      code: new CodeGraph(() => ctx.graph),
    }),
    tools: (s) => [...repoTools(s.service, s.visibleRoots), ...codeGraphTools(s.service, s.code)],
    rpc: (s) => reposRpcActions(s.db, s.visibleRoots),
    dashboard: dashboardChannel("repos", (db) => queryRepos(db)),
  });
}
