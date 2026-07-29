import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { issuesMigrations } from "./migrations.js";
import { IssueService } from "./service.js";
import { issueTools } from "./tools.js";
import { queryIssues } from "./dashboard-queries.js";

export function createIssuesModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];

  return {
    name: "issues",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "issues", issuesMigrations);
      const service = new IssueService(ctx.sqlite);
      tools = issueTools(service, ctx.sqlite);
    },

    getTools() {
      return tools;
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          { id: "issues", label: "Issues", icon: "\u26A0", group: "work", order: 40 },
        ],
        channels: [
          { name: "issues", query: (db) => queryIssues(db) },
        ],
        channelMappings: [
          { moduleKey: "issues", channels: ["issues"] },
        ],
        stores: ["issues"],
        fetchEndpoints: [
          { url: "/api/dashboard/issues", store: "issues" },
        ],
      };
    },

    async shutdown() {},
  };
}
