/**
 * Audit tools — read-only code access + log analysis for the Security Auditor agent.
 *
 * These tools are deliberately restricted:
 *   - Code read: path whitelist (project src only), no .env / credentials / node_modules
 *   - Code search: grep within project src only
 *   - Log query: agent_event_log read-only
 *   - Cost analysis: token consumption patterns
 */

import { z } from "zod";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative, join, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { textResult, errorResult } from "../../core/helpers.js";
import { isPathInside, toPosixPath } from "../../core/fs-paths.js";
import type { ToolDefinition } from "../../core/types.js";
import type { AgentService } from "./service.js";
import { defineTool } from "../../core/tool-builder.js";

const execFileAsync = promisify(execFile);

/** Project root — code access is restricted to src/ under this path. */
const PROJECT_ROOT = resolve(process.cwd());

/**
 * Paths that are never readable (secrets, binaries, deps). Matched against the
 * project-relative path with forward slashes: on Windows `relative()` returns
 * backslashes, and `/data\//` then never matched — `data\kernel.db` and the
 * auth token became readable there while Linux blocked them.
 */
const BLOCKED_PATTERNS = [
  /\.env/i,
  /credentials/i,
  /secret/i,
  /\.pem$/i,
  /\.key$/i,
  /node_modules/,
  /\.git\//,
  /dist\//,
  /data\//,
];

export function isPathAllowed(filePath: string, root: string = PROJECT_ROOT): boolean {
  const abs = resolve(root, filePath);
  // Must stay inside project root
  if (!isPathInside(root, abs)) return false;
  // Trailing slash so a bare directory ("data") matches its `data/` pattern too.
  const rel = toPosixPath(relative(root, abs)) + "/";
  // Must not match any blocked pattern
  for (const p of BLOCKED_PATTERNS) {
    if (p.test(rel)) return false;
  }
  return true;
}

/**
 * Plain JS search, for hosts without ripgrep — every native Windows install and
 * most fresh macOS ones. Same exclusions and per-file cap as the rg call.
 */
async function searchWithoutRg(
  pattern: string,
  searchDir: string,
  glob: string | undefined,
  limit: number,
): Promise<string[]> {
  const re = new RegExp(pattern);
  const globRe = glob
    ? new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
    : null;
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "data"]);
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (skip.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (globRe && !globRe.test(e.name)) continue;
      const s = await stat(full).catch(() => null);
      if (!s || s.size > 500 * 1024) continue;
      const text = await readFile(full, "utf-8").catch(() => "");
      let perFile = 0;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && perFile < 5 && out.length < limit; i++) {
        if (re.test(lines[i])) {
          out.push(`${full}:${i + 1}:${lines[i]}`);
          perFile++;
        }
      }
    }
  }
  await walk(searchDir);
  return out;
}

export function auditTools(service: AgentService): ToolDefinition[] {
  return [
    // ── kernel_code_read ──────────────────────────
    defineTool({
      name: "kernel_code_read",
      description:
        "Read a source file from the project (read-only). " +
        "Restricted to project src — cannot read .env, credentials, node_modules, or data.",
      schema: z.object({
        path: z.string().describe("Relative path from project root (e.g. 'src/core/logger.ts')"),
        offset: z.number().optional().describe("Start line (1-based, default: 1)"),
        limit: z.number().optional().describe("Max lines to return (default: 200)"),
      }),
      handler: async ({ path, offset, limit }) => {
        if (!isPathAllowed(path)) {
          return errorResult(`Access denied: ${path} (blocked by security policy)`);
        }

        const abs = resolve(PROJECT_ROOT, path);
        try {
          const content = await readFile(abs, "utf-8");
          const lines = content.split("\n");
          const start = Math.max(0, (offset ?? 1) - 1);
          const end = start + (limit ?? 200);
          const slice = lines.slice(start, end);

          return textResult(
            `## ${path} (lines ${start + 1}–${start + slice.length} of ${lines.length})\n\`\`\`\n${slice.join("\n")}\n\`\`\``,
          );
        } catch (err) {
          return errorResult(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    }),

    // ── kernel_code_search ────────────────────────
    defineTool({
      name: "kernel_code_search",
      description:
        "Search for a pattern in the project source code (grep). " +
        "Returns matching lines with file paths. Restricted to src/ directory.",
      schema: z.object({
        pattern: z.string().describe("Search pattern (regex supported)"),
        glob: z.string().optional().describe("File glob filter (e.g. '*.ts', '*.svelte'). Default: all files"),
        max_results: z.number().optional().describe("Max results (default: 30)"),
      }),
      handler: async ({ pattern, glob, max_results }) => {
        const limit = Math.min(max_results ?? 30, 100);
        const searchDir = resolve(PROJECT_ROOT, "src");

        // Paths come back absolute from both searchers; show them project-relative.
        const toRel = (l: string) =>
          l.startsWith(PROJECT_ROOT + sep) ? toPosixPath(l.slice(PROJECT_ROOT.length + 1)) : l;

        try {
          const rgArgs = [
            "--no-heading", "--line-number", "--color=never",
            "--max-count=5", // max matches per file
            `--max-filesize=500K`,
            "-g", `!node_modules`,
            "-g", `!.git`,
            "-g", `!dist`,
            "-g", `!data`,
          ];
          if (glob) {
            rgArgs.push("-g", glob);
          }
          rgArgs.push(pattern, searchDir);

          let lines: string[];
          try {
            const { stdout } = await execFileAsync("rg", rgArgs, {
              timeout: 10_000,
              maxBuffer: 1024 * 1024,
            });
            lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, limit);
          } catch (rgErr: unknown) {
            if ((rgErr as { code?: unknown }).code !== "ENOENT") throw rgErr;
            lines = await searchWithoutRg(pattern, searchDir, glob, limit);
            if (lines.length === 0) return textResult(`No matches found for \`${pattern}\``);
          }
          // Make paths relative
          const results = lines.map(toRel);

          return textResult(
            `## Search: \`${pattern}\`${glob ? ` (${glob})` : ""}\n\nFound ${results.length} matches:\n\`\`\`\n${results.join("\n")}\n\`\`\``,
          );
        } catch (err: unknown) {
          const e = err as { code?: number; stdout?: string; message?: string };
          // rg exit code 1 = no matches (not an error)
          if (e.code === 1) return textResult(`No matches found for \`${pattern}\``);
          return errorResult(`Search failed: ${e.message ?? String(err)}`);
        }
      },
    }),

    // ── kernel_audit_logs ─────────────────────────
    defineTool({
      name: "kernel_audit_logs",
      description:
        "Query the agent event log for security analysis. " +
        "Shows agent activity, errors, tool calls, token consumption, and failure patterns.",
      schema: z.object({
        agent_id: z.string().optional().describe("Filter by agent ID"),
        event_type: z.string().optional().describe("Filter by event type (e.g. 'run', 'step')"),
        event_subtype: z.string().optional().describe("Filter by subtype (e.g. 'error', 'tool_call', 'completed')"),
        since: z.string().optional().describe("Only events after this ISO timestamp (default: last 6 hours)"),
        limit: z.number().optional().describe("Max results (default: 50, max: 200)"),
      }),
      handler: async (input) => {
        const events = service.getEventLog({
          agent_id: input.agent_id,
          event_type: input.event_type,
          since: input.since || new Date(Date.now() - 6 * 3600_000).toISOString(),
          limit: Math.min(input.limit ?? 50, 200),
        }) as Array<Record<string, unknown>>;

        // Filter by subtype if provided (getEventLog may not support it natively)
        const filtered = input.event_subtype
          ? events.filter(e => e.event_subtype === input.event_subtype)
          : events;

        if (filtered.length === 0) {
          return textResult("No matching events found.");
        }

        const lines = [`## Audit Log (${filtered.length} events)\n`];
        for (const e of filtered) {
          const ts = String(e.created_at ?? "").slice(11, 19);
          const agent = String(e.agent_name ?? "unknown");
          const type = `${e.event_type}:${e.event_subtype}`;
          const tokens = Number(e.tokens_used ?? 0);
          const detail = String(e.detail ?? "").slice(0, 100);
          lines.push(`[${ts}] **${agent}** ${type}${tokens ? ` (${tokens}tk)` : ""} — ${detail}`);
        }
        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_audit_cost_report ──────────────────
    defineTool({
      name: "kernel_audit_cost_report",
      description:
        "Token consumption and cost analysis. Shows which agents burn the most tokens, " +
        "failure rates, and wasted spend. Critical for budget monitoring.",
      schema: z.object({
        hours: z.number().optional().describe("Look back period in hours (default: 24)"),
      }),
      handler: async ({ hours }) => {
        const since = new Date(Date.now() - (hours ?? 24) * 3600_000).toISOString();

        const db = (service as unknown as { db: import("better-sqlite3").Database }).db;

        const rows = db.prepare(`
          SELECT
            a.name,
            COUNT(r.id) as runs,
            SUM(r.tokens_used) as total_tokens,
            SUM(CASE WHEN r.status='failed' THEN r.tokens_used ELSE 0 END) as wasted_tokens,
            SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END) as fail_count,
            ROUND(AVG(r.tokens_used)) as avg_tokens
          FROM agent_runs r
          JOIN agents a ON a.id = r.agent_id
          WHERE r.created_at > ?
          GROUP BY a.name
          ORDER BY total_tokens DESC
        `).all(since) as Array<Record<string, unknown>>;

        if (rows.length === 0) {
          return textResult("No runs found in the specified period.");
        }

        const lines = [
          `## Cost Report (last ${hours ?? 24}h)\n`,
          "| Agent | Runs | Total Tokens | Wasted (fails) | Fail % | Avg/Run |",
          "|-------|------|-------------|----------------|--------|---------|",
        ];

        let totalTokens = 0;
        let totalWasted = 0;
        for (const r of rows) {
          const total = Number(r.total_tokens ?? 0);
          const wasted = Number(r.wasted_tokens ?? 0);
          const runs = Number(r.runs ?? 0);
          const fails = Number(r.fail_count ?? 0);
          const failPct = runs > 0 ? Math.round((fails / runs) * 100) : 0;
          totalTokens += total;
          totalWasted += wasted;
          lines.push(
            `| ${r.name} | ${runs} | ${(total / 1000).toFixed(0)}k | ${(wasted / 1000).toFixed(0)}k | ${failPct}% | ${(Number(r.avg_tokens ?? 0) / 1000).toFixed(1)}k |`,
          );
        }

        lines.push("");
        lines.push(`**Total: ${(totalTokens / 1_000_000).toFixed(1)}M tokens | Wasted: ${(totalWasted / 1_000_000).toFixed(1)}M (${Math.round((totalWasted / totalTokens) * 100)}%)**`);

        // Flag critical issues
        const criticals: string[] = [];
        for (const r of rows) {
          const runs = Number(r.runs ?? 0);
          const fails = Number(r.fail_count ?? 0);
          if (runs > 5 && fails / runs > 0.5) {
            criticals.push(`⚠ **${r.name}**: ${Math.round((fails / runs) * 100)}% failure rate (${fails}/${runs} runs)`);
          }
          if (Number(r.total_tokens ?? 0) > 5_000_000) {
            criticals.push(`💰 **${r.name}**: ${(Number(r.total_tokens) / 1_000_000).toFixed(1)}M tokens — review schedule frequency`);
          }
        }
        if (criticals.length > 0) {
          lines.push("\n### Critical Alerts");
          lines.push(...criticals);
        }

        return textResult(lines.join("\n"));
      },
    }),
  ];
}
