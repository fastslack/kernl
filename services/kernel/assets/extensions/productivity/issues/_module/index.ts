import { defineModule, dashboardChannel } from "@kernl/extension-sdk";
import { issuesMigrations } from "./migrations.js";
import { IssueService } from "./service.js";
import { issueTools } from "./tools.js";
import { queryIssues } from "./dashboard-queries.js";

export function createIssuesModule() {
  return defineModule({
    name: "issues",
    migrations: issuesMigrations,
    init: (ctx) => new IssueService(ctx.sqlite),
    tools: (service, ctx) => issueTools(service, ctx.sqlite),
    dashboard: dashboardChannel("issues", (db) => queryIssues(db), {
      nav: [
        { id: "issues", label: "Issues", icon: "⚠", group: "work", order: 40 },
      ],
    }),
  });
}
