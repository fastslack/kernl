import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { IssueService } from "./service.js";
import { IssueClient } from "./client.js";
import { syncGitHubIssues } from "./github-sync.js";
import { syncGitLabIssues } from "./gitlab-sync.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

function fmtDuration(secs: number): string {
  if (secs === 0) return "0m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function issueTools(service: IssueService, db: SqliteDb): ToolDefinition[] {
  return [
    {
      name: "kernel_issues_configure",
      description:
        "Configure a PAT (Personal Access Token) for GitHub or GitLab issue tracking. " +
        "For GitLab self-hosted, provide base_url (e.g. https://gitlab.mycompany.com).",
      inputSchema: z.object({
        provider: z.enum(["github", "gitlab"]).describe("The provider to configure"),
        token: z.string().describe("Personal Access Token"),
        base_url: z.string().optional().describe("Base URL for GitLab self-hosted (omit for gitlab.com)"),
        username: z.string().optional().describe("Username (for display purposes)"),
      }),
      handler: async (args) => {
        const { provider, token, base_url, username } = args as {
          provider: "github" | "gitlab";
          token: string;
          base_url?: string;
          username?: string;
        };
        service.setToken(provider, token, base_url, username);
        return textResult(
          `${provider} configured successfully.\n` +
          (base_url ? `Base URL: ${base_url}\n` : "") +
          `Use kernel_issues_sync to sync repos.`,
        );
      },
    },

    {
      name: "kernel_issues_sync",
      description:
        "Sync issues from configured providers. Provide specific repos or omit to re-sync all previously synced repos.",
      inputSchema: z.object({
        provider: z.enum(["github", "gitlab"]).optional().describe("Limit sync to one provider"),
        repos: z
          .array(z.string())
          .optional()
          .describe('Repos to sync (e.g. ["owner/repo"]). Omit to re-sync all tracked repos.'),
      }),
      handler: async (args) => {
        const { provider, repos: inputRepos } = args as {
          provider?: "github" | "gitlab";
          repos?: string[];
        };

        const providers = provider
          ? [provider]
          : service.getConfiguredProviders();

        if (providers.length === 0) {
          return errorResult("No providers configured. Use kernel_issues_configure first.");
        }

        const results: string[] = [];

        for (const prov of providers) {
          const tokenRow = service.getToken(prov);
          if (!tokenRow) {
            results.push(`${prov}: not configured, skipping`);
            continue;
          }

          // Determine repos to sync
          let repos = inputRepos;
          if (!repos || repos.length === 0) {
            const tracked = service.getTrackedRepos()
              .filter((r) => r.provider === prov)
              .map((r) => r.repo);
            repos = tracked;
          }

          if (repos.length === 0) {
            results.push(`${prov}: no repos to sync. Provide repos in the request.`);
            continue;
          }

          const client = new IssueClient(
            prov as "github" | "gitlab",
            tokenRow.token,
            tokenRow.base_url || undefined,
          );

          const syncFn = prov === "github" ? syncGitHubIssues : syncGitLabIssues;
          const result = await syncFn(client, db, repos);
          results.push(
            `${prov}: synced ${result.synced} items from ${repos.length} repo(s)` +
            (result.errors.length > 0 ? `\nErrors:\n${result.errors.join("\n")}` : ""),
          );
        }

        return textResult(results.join("\n\n"));
      },
    },

    {
      name: "kernel_issues_list",
      description:
        "List issues with optional filters. Returns most recently updated first.",
      inputSchema: z.object({
        repo: z.string().optional().describe("Filter by repo (e.g. owner/repo)"),
        state: z.enum(["open", "closed", "merged"]).optional().describe("Filter by state"),
        provider: z.enum(["github", "gitlab"]).optional().describe("Filter by provider"),
        label: z.string().optional().describe("Filter by label name"),
        assignee: z.string().optional().describe("Filter by assignee username"),
        is_pr: z.boolean().optional().describe("Filter PRs/MRs only (true) or issues only (false)"),
        limit: z.number().optional().describe("Max results (default 50)"),
      }),
      handler: async (args) => {
        const filters = args as {
          repo?: string; state?: string; provider?: string;
          label?: string; assignee?: string; is_pr?: boolean; limit?: number;
        };
        const issues = service.listIssues(filters);
        if (issues.length === 0) return textResult("No issues found.");

        const lines = issues.map((i) => {
          const type = i.is_pull_request ? "PR" : "Issue";
          const labels = (() => {
            try {
              const parsed = JSON.parse(
                (db.prepare(`SELECT GROUP_CONCAT(label, ', ') as labels FROM issue_labels WHERE issue_id = ?`)
                  .get(i.id) as { labels: string | null })?.labels ?? "",
              );
              return parsed;
            } catch {
              return (
                (db.prepare(`SELECT GROUP_CONCAT(label, ', ') as labels FROM issue_labels WHERE issue_id = ?`)
                  .get(i.id) as { labels: string | null })?.labels ?? ""
              );
            }
          })();
          return (
            `- [${i.state}] #${i.external_number} ${i.title} (${type}, ${i.provider}:${i.repo})` +
            (labels ? ` [${labels}]` : "") +
            ` — ${i.id}`
          );
        });
        return textResult(`Issues (${issues.length}):\n${lines.join("\n")}`);
      },
    },

    {
      name: "kernel_issues_get",
      description: "Get full details of an issue including labels and time entries.",
      inputSchema: z.object({
        id: z.string().describe("Issue ID (local UUID)"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const issue = service.getIssue(id);
        if (!issue) return errorResult(`Issue not found: ${id}`);

        const type = issue.is_pull_request ? "PR/MR" : "Issue";
        const assignees = (() => {
          try { return JSON.parse(issue.assignees); }
          catch { return []; }
        })() as string[];

        let text =
          `# ${type} #${issue.external_number}: ${issue.title}\n\n` +
          `- **State**: ${issue.state}\n` +
          `- **Provider**: ${issue.provider}\n` +
          `- **Repo**: ${issue.repo}\n` +
          `- **Author**: ${issue.author}\n` +
          (assignees.length > 0 ? `- **Assignees**: ${assignees.join(", ")}\n` : "") +
          (issue.milestone ? `- **Milestone**: ${issue.milestone}\n` : "") +
          `- **URL**: ${issue.url}\n` +
          `- **Created**: ${issue.created_at}\n` +
          `- **Updated**: ${issue.updated_at}\n` +
          (issue.closed_at ? `- **Closed**: ${issue.closed_at}\n` : "");

        if (issue.labels.length > 0) {
          text += `- **Labels**: ${issue.labels.map((l) => l.label).join(", ")}\n`;
        }

        if (issue.time_estimate > 0 || issue.time_spent > 0) {
          text += `\n## Time Tracking\n`;
          text += `- Estimate: ${fmtDuration(issue.time_estimate)}\n`;
          text += `- Spent: ${fmtDuration(issue.time_spent)}\n`;
        }

        if (issue.timeEntries.length > 0) {
          text += `\n## Time Entries\n`;
          for (const te of issue.timeEntries) {
            text += `- ${fmtDuration(te.duration)} — ${te.description || "(no description)"} (${te.logged_at})\n`;
          }
        }

        if (issue.body) {
          text += `\n## Body\n${issue.body.slice(0, 2000)}`;
          if (issue.body.length > 2000) text += "\n...(truncated)";
        }

        return textResult(text);
      },
    },

    {
      name: "kernel_issues_stats",
      description: "Get aggregated statistics: by repo, provider, label, state, and assignee.",
      inputSchema: z.object({}),
      handler: async () => {
        const stats = service.getStats();
        let text =
          `# Issue Statistics\n\n` +
          `- **Total**: ${stats.total}\n` +
          `- **Open**: ${stats.open}\n` +
          `- **Closed**: ${stats.closed}\n` +
          `- **Merged**: ${stats.merged}\n` +
          `- **PRs/MRs**: ${stats.prs}\n`;

        if (stats.byRepo.length > 0) {
          text += `\n## By Repository\n`;
          for (const r of stats.byRepo) {
            text += `- ${r.repo}: ${r.open} open, ${r.closed} closed, ${r.merged} merged\n`;
          }
        }

        if (stats.byProvider.length > 0) {
          text += `\n## By Provider\n`;
          for (const p of stats.byProvider) {
            text += `- ${p.provider}: ${p.count}\n`;
          }
        }

        if (stats.byLabel.length > 0) {
          text += `\n## Top Labels\n`;
          for (const l of stats.byLabel) {
            text += `- ${l.label}: ${l.count}\n`;
          }
        }

        return textResult(text);
      },
    },

    {
      name: "kernel_issues_time_log",
      description: "Log time spent on an issue. Duration in minutes.",
      inputSchema: z.object({
        issue_id: z.string().describe("Issue ID"),
        minutes: z.number().describe("Duration in minutes"),
        description: z.string().optional().describe("What was done"),
      }),
      handler: async (args) => {
        const { issue_id, minutes, description } = args as {
          issue_id: string; minutes: number; description?: string;
        };

        const issue = service.getIssue(issue_id);
        if (!issue) return errorResult(`Issue not found: ${issue_id}`);

        const entry = service.logTime(issue_id, minutes * 60, description ?? "");
        return textResult(
          `Time logged: ${fmtDuration(entry.duration)}\n` +
          `Issue: #${issue.external_number} ${issue.title}\n` +
          `Total spent: ${fmtDuration(issue.time_spent + entry.duration)}`,
        );
      },
    },

    {
      name: "kernel_issues_time_report",
      description: "Time tracking report: estimated vs spent, by issue. Optionally filter by repo.",
      inputSchema: z.object({
        repo: z.string().optional().describe("Filter by repo"),
      }),
      handler: async (args) => {
        const { repo } = args as { repo?: string };
        const report = service.getTimeReport(repo);

        let text =
          `# Time Report${repo ? ` — ${repo}` : ""}\n\n` +
          `- **Total Estimated**: ${fmtDuration(report.totalEstimate)}\n` +
          `- **Total Spent**: ${fmtDuration(report.totalSpent)}\n`;

        if (report.byIssue.length > 0) {
          text += `\n## By Issue\n`;
          for (const i of report.byIssue) {
            text += `- ${i.title} (${i.repo}): est ${fmtDuration(i.estimate)}, spent ${fmtDuration(i.spent)}\n`;
          }
        }

        return textResult(text);
      },
    },

    {
      name: "kernel_issues_repos",
      description: "List all tracked repos with their last sync time and item counts.",
      inputSchema: z.object({}),
      handler: async () => {
        const repos = service.getTrackedRepos();
        if (repos.length === 0) return textResult("No repos tracked yet. Use kernel_issues_sync first.");

        const summary = service.getRepoSummary();
        const summaryMap = new Map(summary.map((s) => [`${s.provider}:${s.repo}`, s]));

        const lines = repos.map((r) => {
          const s = summaryMap.get(`${r.provider}:${r.repo}`);
          const stats = s ? ` (${s.open} open, ${s.closed} closed, avg close: ${s.avgCloseTimeDays.toFixed(1)}d)` : "";
          return `- [${r.provider}] ${r.repo}${stats} — synced ${r.lastSync} (${r.itemsSynced} items)`;
        });
        return textResult(`Tracked Repositories (${repos.length}):\n${lines.join("\n")}`);
      },
    },

    {
      name: "kernel_issues_velocity",
      description: "Velocity chart: opened vs closed issues per week over a time period.",
      inputSchema: z.object({
        days: z.number().optional().describe("Lookback period in days (default 30)"),
      }),
      handler: async (args) => {
        const { days } = args as { days?: number };
        const velocity = service.getVelocity(days ?? 30);

        if (velocity.length === 0) return textResult("No data for velocity report.");

        let text = `# Velocity Report (last ${days ?? 30} days)\n\n`;
        text += `| Week of | Opened | Closed | Net |\n`;
        text += `|---------|--------|--------|-----|\n`;
        for (const v of velocity) {
          const net = v.netChange > 0 ? `+${v.netChange}` : String(v.netChange);
          text += `| ${v.period} | ${v.opened} | ${v.closed} | ${net} |\n`;
        }

        const totalOpened = velocity.reduce((s, v) => s + v.opened, 0);
        const totalClosed = velocity.reduce((s, v) => s + v.closed, 0);
        text += `\n**Totals**: ${totalOpened} opened, ${totalClosed} closed, net ${totalOpened - totalClosed}`;

        return textResult(text);
      },
    },
  ];
}
