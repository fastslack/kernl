/**
 * Agent Workspace Tools — multi-workspace per office + optional sharing.
 *
 * Each office (flow_id) may own multiple named workspaces. A workspace can be
 * private (default) or shared — shared workspaces are readable by any office.
 * Path on disk: data/workspaces/{workspace_id}/...
 *
 * Tool calls resolve a workspace using one of:
 *   - workspace_id  (exact id)
 *   - workspace     (name, scoped to caller's own flow unless owner_flow_id provided)
 *   - (nothing)     → caller's default workspace (name='main', auto-created)
 *
 * Identity resolution:
 *   The executor injects `__caller_agent_id` into every tool call. Tools use
 *   it to derive the caller's `flow_id`. Explicit `flow_id` argument still wins.
 *
 * Security:
 *   - Path traversal blocked (no ../ escapes).
 *   - write / delete / exec require owner access (workspace.owner_flow_id == caller.flow_id).
 *   - read / list / search allowed for owner OR any office if workspace.shared=1.
 *   - Execution runs in ephemeral containers with no network by default.
 *   - Max file size: 1MB, max execution time: 60s.
 */

import { z } from "zod";
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { checkProtected, formatViolation } from "../../../../../src/core/protected-files.js";
import { resolve, relative, join, normalize, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import { WorkspaceService, WORKSPACE_ROOT, type Workspace } from "./workspace-service.js";
import { composeUp, composeExec, markExec as composeMarkExec } from "./workspace-compose.js";

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 1_048_576; // 1MB
const MAX_EXEC_TIMEOUT = 60_000; // 60s
// Bun-based sandbox: Node+npm scripts run via `bun run`, and `bun install`
// replaces `npm install`. Keeps parity with the host toolchain (this repo is
// Bun-native) and cuts install time for agent scaffolds significantly.
const SANDBOX_IMAGE = "oven/bun:1";
const ANALYSES_DIR = "analyses";
const MAX_SEARCH_RESULTS = 30;
const MAX_SEARCH_FILE_BYTES = 256_000;

/** Resolve a file path inside a workspace safely, blocking traversal attacks. */
function resolveFilePath(workspaceId: string, filePath: string): string | null {
  const workDir = resolve(WORKSPACE_ROOT, workspaceId);
  const target = resolve(workDir, normalize(filePath));
  if (!target.startsWith(workDir)) return null;
  return target;
}

async function ensureWorkspaceDir(workspaceId: string): Promise<string> {
  const dir = resolve(WORKSPACE_ROOT, workspaceId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Derive the caller's flow_id from executor-injected __caller_agent_id. */
function resolveCallerFlowId(
  args: Record<string, unknown>,
  agents: AgentService | null,
): string | null {
  const explicit = typeof args.flow_id === "string" && args.flow_id ? args.flow_id : null;
  if (explicit) return explicit;
  const callerId = typeof args.__caller_agent_id === "string" ? args.__caller_agent_id : null;
  if (callerId && agents) {
    const agent = agents.getAgent(callerId);
    if (agent?.flow_id) return agent.flow_id;
  }
  return null;
}

/** Pull workspace-selector fields out of the generic args bag. */
function extractWorkspaceRef(args: Record<string, unknown>): {
  workspace_id?: string;
  workspace_name?: string;
  workspace_owner_flow_id?: string;
} {
  const ref: ReturnType<typeof extractWorkspaceRef> = {};
  if (typeof args.workspace_id === "string" && args.workspace_id) ref.workspace_id = args.workspace_id;
  if (typeof args.workspace === "string" && args.workspace) ref.workspace_name = args.workspace;
  if (typeof args.workspace_owner_flow_id === "string" && args.workspace_owner_flow_id) {
    ref.workspace_owner_flow_id = args.workspace_owner_flow_id;
  }
  return ref;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "untitled";
}

function dateSlug(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  if (!md.startsWith("---\n")) return { meta: {}, body: md };
  const end = md.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: md };
  const raw = md.slice(4, end);
  const body = md.slice(end + 4).replace(/^\n/, "");
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body };
}

async function walkFiles(
  rootDir: string,
  subdir: string = "",
  out: Array<{ relPath: string; absPath: string; size: number; mtime: number }> = [],
  depth: number = 0,
): Promise<Array<{ relPath: string; absPath: string; size: number; mtime: number }>> {
  if (depth > 10) return out;
  const here = subdir ? join(rootDir, subdir) : rootDir;
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await readdir(here, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "node_modules") continue;
    const relPath = subdir ? join(subdir, e.name) : e.name;
    const abs = join(here, e.name);
    if (e.isDirectory()) {
      await walkFiles(rootDir, relPath, out, depth + 1);
    } else if (e.isFile()) {
      try {
        const s = await stat(abs);
        out.push({ relPath, absPath: abs, size: s.size, mtime: s.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  return out;
}

async function grepFile(
  absPath: string,
  query: string,
  maxLines: number = 3,
): Promise<Array<{ line: number; text: string }>> {
  try {
    const s = await stat(absPath);
    if (s.size > MAX_SEARCH_FILE_BYTES) return [];
    const content = await readFile(absPath, "utf-8");
    const lc = query.toLowerCase();
    const lines = content.split("\n");
    const hits: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length && hits.length < maxLines; i++) {
      if (lines[i].toLowerCase().includes(lc)) {
        hits.push({ line: i + 1, text: lines[i].slice(0, 200) });
      }
    }
    return hits;
  } catch {
    return [];
  }
}

/** Pretty-print a workspace label for agent-facing messages. */
function wsLabel(ws: Workspace, callerFlowId: string): string {
  const ownerTag = ws.owner_flow_id === callerFlowId ? "" : ` (shared from ${ws.owner_flow_id.slice(0, 8)}…)`;
  return `${ws.name}${ownerTag}`;
}

export function workspaceTools(
  agents: AgentService | null = null,
  wsService: WorkspaceService | null = null,
): ToolDefinition[] {
  if (!wsService) {
    log.warn("workspaceTools() called without a WorkspaceService — tools will all error");
  }

  /** Shared helper: resolve a workspace for the given access mode. */
  function resolveWs(
    args: Record<string, unknown>,
    access: "read" | "write",
  ): { ok: true; ws: Workspace; callerFlowId: string } | { ok: false; error: string } {
    if (!wsService) return { ok: false, error: "Workspace service unavailable" };
    const callerFlowId = resolveCallerFlowId(args, agents);
    if (!callerFlowId) return { ok: false, error: "No flow_id — agent is not assigned to an office" };
    const ref = extractWorkspaceRef(args);
    const r = wsService.resolveForCaller({ callerFlowId, access, ...ref });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, ws: r.workspace, callerFlowId };
  }

  const wsSelectorSchema = {
    workspace_id: z.string().optional().describe("Workspace UUID (optional — or use `workspace` name)"),
    workspace: z.string().optional().describe("Workspace name (defaults to your office's 'main' workspace)"),
    workspace_owner_flow_id: z.string().optional().describe("When reading a shared workspace owned by another office, pass that office's flow_id"),
  };

  return [
    // ── kernel_workspace_create ────────────────
    {
      name: "kernel_workspace_create",
      description:
        "Create a new workspace owned by your office. Use to keep per-client or per-project work isolated. " +
        "Set `shared: true` if you want other offices to be able to read it (they still cannot write).",
      inputSchema: z.object({
        name: z.string().describe("Short workspace name, unique within your office (e.g. 'acme-yachts', 'q2-research')"),
        description: z.string().optional().describe("One-liner describing what this workspace holds"),
        shared: z.boolean().optional().describe("If true, other offices can READ (never write)"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        if (!wsService) return errorResult("Workspace service unavailable");
        const callerFlowId = resolveCallerFlowId(a, agents);
        if (!callerFlowId) return errorResult("No flow_id — agent is not assigned to an office");
        const name = String(a.name ?? "").trim();
        if (!name) return errorResult("name required");
        if (name === "main") return errorResult("'main' is reserved for the default workspace");
        const existing = wsService.getByOwnerName(callerFlowId, name);
        if (existing) return textResult(`Workspace already exists: **${name}** (id: \`${existing.id}\`, shared: ${existing.shared ? "yes" : "no"}).`);
        const ws = wsService.create({
          owner_flow_id: callerFlowId,
          name,
          description: typeof a.description === "string" ? a.description : "",
          shared: a.shared === true,
        });
        await ensureWorkspaceDir(ws.id);
        return textResult(
          `Workspace created: **${ws.name}**\n` +
          `- id: \`${ws.id}\`\n` +
          `- owner: this office\n` +
          `- shared: ${ws.shared ? "yes" : "no"}\n\n` +
          `Use it by passing \`workspace: "${ws.name}"\` on every workspace tool call.`,
        );
      },
    },

    // ── kernel_workspace_list_workspaces ───────
    {
      name: "kernel_workspace_list_workspaces",
      description:
        "List workspaces visible to you. `scope: 'mine'` (default) → workspaces your office owns. " +
        "`scope: 'shared'` → workspaces other offices have shared. `scope: 'all'` → both.",
      inputSchema: z.object({
        scope: z.enum(["mine", "shared", "all"]).optional().describe("Default 'all'"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        if (!wsService) return errorResult("Workspace service unavailable");
        const callerFlowId = resolveCallerFlowId(a, agents);
        if (!callerFlowId) return errorResult("No flow_id — agent is not assigned to an office");
        const scope = a.scope === "mine" || a.scope === "shared" || a.scope === "all" ? a.scope : "all";

        const mine = scope !== "shared" ? wsService.listByOwner(callerFlowId) : [];
        const shared = scope !== "mine" ? wsService.listShared(callerFlowId) : [];

        const lines: string[] = [];
        if (mine.length > 0) {
          lines.push("## Your office's workspaces");
          for (const w of mine) {
            lines.push(`- **${w.name}** \`${w.id.slice(0, 8)}…\`${w.shared ? " _(shared)_" : ""}${w.description ? ` — ${w.description}` : ""}`);
          }
        }
        if (shared.length > 0) {
          lines.push(mine.length > 0 ? "\n## Shared by other offices (read-only)" : "## Shared by other offices (read-only)");
          for (const w of shared) {
            lines.push(`- **${w.name}** \`${w.id.slice(0, 8)}…\` — owner: \`${w.owner_flow_id}\`${w.description ? ` (${w.description})` : ""}`);
          }
        }
        if (lines.length === 0) return textResult("No workspaces match. Create one with `kernel_workspace_create`.");
        return textResult(lines.join("\n"));
      },
    },

    // ── kernel_workspace_write ─────────────────
    {
      name: "kernel_workspace_write",
      description:
        "Write or create a file in one of your office's workspaces. Path is relative to the workspace root. " +
        "Directories are auto-created. Target the default 'main' workspace unless you pass `workspace` or `workspace_id`.",
      inputSchema: z.object({
        ...wsSelectorSchema,
        path: z.string().describe("Relative file path (e.g. 'src/index.ts', 'analyses/notes.md')"),
        content: z.string().describe("File content to write"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        const r = resolveWs(a, "write");
        if (!r.ok) return errorResult(r.error);
        const path = String(a.path ?? "");
        const content = String(a.content ?? "");
        if (!path) return errorResult("path required");
        if (content.length > MAX_FILE_SIZE) return errorResult(`File too large (${content.length} bytes, max ${MAX_FILE_SIZE})`);

        // Block kernel-protected paths even when the workspace itself
        // accepts arbitrary subpaths. Catches `.env`, lockfiles, *.test.ts
        // and SSH keys that an agent could otherwise rewrite to bypass
        // tests / leak secrets.
        const violation = checkProtected(path);
        if (violation) {
          log.warn(`Workspace write blocked: ${formatViolation(path, violation)}`);
          return errorResult(formatViolation(path, violation));
        }

        const target = resolveFilePath(r.ws.id, path);
        if (!target) return errorResult("Invalid path (traversal blocked)");

        await ensureWorkspaceDir(r.ws.id);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf-8");
        wsService!.touch(r.ws.id);

        log.info(`Workspace: wrote ${r.ws.id}/${path} (${content.length} bytes) [ws=${r.ws.name}]`);
        return textResult(`Wrote \`${path}\` in workspace **${wsLabel(r.ws, r.callerFlowId)}** (${content.length} bytes)`);
      },
    },

    // ── kernel_workspace_read ──────────────────
    {
      name: "kernel_workspace_read",
      description:
        "Read a file from a workspace. By default reads your office's 'main' workspace. " +
        "To read a shared workspace from another office, pass `workspace_id` (from `kernel_workspace_list_workspaces` scope='shared').",
      inputSchema: z.object({
        ...wsSelectorSchema,
        path: z.string().describe("Relative file path"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        const r = resolveWs(a, "read");
        if (!r.ok) return errorResult(r.error);
        const path = String(a.path ?? "");
        const target = resolveFilePath(r.ws.id, path);
        if (!target) return errorResult("Invalid path");
        try {
          const content = await readFile(target, "utf-8");
          return textResult(`## ${path} _(workspace: ${wsLabel(r.ws, r.callerFlowId)})_\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          return errorResult(`File not found: ${path}`);
        }
      },
    },

    // ── kernel_workspace_list ──────────────────
    {
      name: "kernel_workspace_list",
      description: "List files and directories in a workspace. Defaults to your office's 'main' workspace.",
      inputSchema: z.object({
        ...wsSelectorSchema,
        path: z.string().optional().describe("Subdirectory to list (default: root)"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        const r = resolveWs(a, "read");
        if (!r.ok) return errorResult(r.error);
        const path = typeof a.path === "string" ? a.path : "";
        const dir = resolveFilePath(r.ws.id, path || ".");
        if (!dir) return errorResult("Invalid path");
        await ensureWorkspaceDir(r.ws.id);
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          const lines = entries.map(e => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
          const header = `## ${r.ws.name}${path ? ` / ${path}` : ""} _(workspace)_`;
          if (lines.length === 0) return textResult(`${header}\n\n_(empty)_`);
          return textResult(`${header}\n\n${lines.join("\n")}`);
        } catch {
          return textResult(`Workspace **${r.ws.name}** is empty. Use \`kernel_workspace_write\` to create files.`);
        }
      },
    },

    // ── kernel_workspace_delete ─────────────────
    {
      name: "kernel_workspace_delete",
      description: "Delete a file from your office's workspace. Cannot delete from shared workspaces owned by other offices.",
      inputSchema: z.object({
        ...wsSelectorSchema,
        path: z.string().describe("File to delete"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        const r = resolveWs(a, "write");
        if (!r.ok) return errorResult(r.error);
        const path = String(a.path ?? "");
        const target = resolveFilePath(r.ws.id, path);
        if (!target) return errorResult("Invalid path");
        try {
          await unlink(target);
          wsService!.touch(r.ws.id);
          return textResult(`Deleted \`${path}\` from workspace **${r.ws.name}**`);
        } catch {
          return errorResult(`File not found: ${path}`);
        }
      },
    },

    // ── kernel_workspace_search ─────────────────
    {
      name: "kernel_workspace_search",
      description:
        "Search for text across workspace files (case-insensitive). Defaults to your office's workspaces. " +
        "Pass `scope='shared'` to also search shared workspaces of other offices; `scope='all'` for every readable workspace.",
      inputSchema: z.object({
        query: z.string().describe("Text to find"),
        scope: z.enum(["mine", "shared", "all"]).optional().describe("Default 'all' (your workspaces + shared ones from others)"),
        workspace_id: z.string().optional().describe("Restrict search to one workspace"),
        path_filter: z.string().optional().describe("Only match files whose path contains this string (e.g. 'analyses/', '.md')"),
      }) as z.ZodType<unknown>,
      outputSchema: z.object({
        query: z.string(),
        scope: z.string(),
        truncated: z.boolean(),
        results: z.array(z.object({
          workspace_id: z.string(),
          workspace_name: z.string(),
          shared: z.boolean(),
          rel_path: z.string(),
          hits: z.array(z.object({
            line: z.number().int(),
            text: z.string(),
          })),
        })),
        total: z.number().int(),
      }) as z.ZodType<unknown>,
      tags: ["workspace", "search"],
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        if (!wsService) return errorResult("Workspace service unavailable");
        const callerFlowId = resolveCallerFlowId(a, agents);
        if (!callerFlowId) return errorResult("No flow_id — agent is not assigned to an office");
        const query = String(a.query ?? "").trim();
        if (!query) return errorResult("query required");
        const scope = a.scope === "mine" || a.scope === "shared" || a.scope === "all" ? a.scope : "all";
        const pathFilter = typeof a.path_filter === "string" ? a.path_filter.toLowerCase() : "";
        const singleWsId = typeof a.workspace_id === "string" ? a.workspace_id : "";

        let targets: Workspace[] = [];
        if (singleWsId) {
          const ws = wsService.get(singleWsId);
          if (!ws) return errorResult("Workspace not found");
          if (ws.owner_flow_id !== callerFlowId && !ws.shared) return errorResult("Workspace is private to another office");
          targets = [ws];
        } else {
          if (scope !== "shared") targets.push(...wsService.listByOwner(callerFlowId));
          if (scope !== "mine") targets.push(...wsService.listShared(callerFlowId));
        }

        const results: Array<{ ws: Workspace; relPath: string; hits: Array<{ line: number; text: string }> }> = [];
        outer: for (const ws of targets) {
          const absDir = resolve(WORKSPACE_ROOT, ws.id);
          const files = await walkFiles(absDir);
          for (const f of files) {
            if (pathFilter && !f.relPath.toLowerCase().includes(pathFilter)) continue;
            const hits = await grepFile(f.absPath, query, 2);
            if (hits.length > 0) {
              results.push({ ws, relPath: f.relPath, hits });
              if (results.length >= MAX_SEARCH_RESULTS) break outer;
            }
          }
        }

        const structured = {
          query,
          scope,
          truncated: results.length >= MAX_SEARCH_RESULTS,
          results: results.map((r) => ({
            workspace_id: r.ws.id,
            workspace_name: r.ws.name,
            shared: r.ws.owner_flow_id !== callerFlowId,
            rel_path: r.relPath,
            hits: r.hits.map((h) => ({ line: h.line, text: h.text.trim() })),
          })),
          total: results.length,
        };

        if (results.length === 0) {
          return {
            ...textResult(`No matches for \`${query}\`${pathFilter ? ` (path contains \`${pathFilter}\`)` : ""}.`),
            structuredContent: structured,
          };
        }

        const lines: string[] = [`## Search: \`${query}\` (${scope})`];
        for (const r of results) {
          const own = r.ws.owner_flow_id === callerFlowId ? "" : ` _(shared)_`;
          lines.push(`\n- **${r.ws.name}**${own} → \`${r.relPath}\``);
          for (const h of r.hits) lines.push(`  - L${h.line}: ${h.text.trim()}`);
        }
        if (results.length >= MAX_SEARCH_RESULTS) lines.push(`\n_…results truncated at ${MAX_SEARCH_RESULTS}._`);
        return { ...textResult(lines.join("\n")), structuredContent: structured };
      },
    },

    // ── kernel_workspace_analysis_save ─────────
    {
      name: "kernel_workspace_analysis_save",
      description:
        "Publish an analysis as 'analyses/YYYY-MM-DD-<slug>.md' in a workspace of your choice. " +
        "Frontmatter (title, author, tags, date, workspace) is added automatically. Defaults to your 'main' workspace.",
      inputSchema: z.object({
        ...wsSelectorSchema,
        title: z.string().describe("Short human title (used for slug + frontmatter)"),
        body: z.string().describe("Markdown body of the analysis"),
        tags: z.array(z.string()).optional().describe("Optional tags (e.g. ['security','audit'])"),
        author: z.string().optional().describe("Optional author name (default: agent name)"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        const r = resolveWs(a, "write");
        if (!r.ok) return errorResult(r.error);
        const title = String(a.title ?? "").trim();
        const body = String(a.body ?? "");
        if (!title) return errorResult("title required");
        if (!body) return errorResult("body required");
        const tags = Array.isArray(a.tags) ? (a.tags as unknown[]).map(String) : [];

        let author = typeof a.author === "string" && a.author ? a.author : "";
        if (!author) {
          const callerId = typeof a.__caller_agent_id === "string" ? a.__caller_agent_id : null;
          if (callerId && agents) author = agents.getAgent(callerId)?.name || r.callerFlowId;
          else author = r.callerFlowId;
        }

        const date = dateSlug();
        const fileName = `${date}-${slugify(title)}.md`;
        const relPath = join(ANALYSES_DIR, fileName);
        const target = resolveFilePath(r.ws.id, relPath);
        if (!target) return errorResult("Invalid path");

        const frontmatter =
          `---\n` +
          `title: ${JSON.stringify(title)}\n` +
          `author: ${JSON.stringify(author)}\n` +
          `workspace: ${JSON.stringify(r.ws.name)}\n` +
          `flow: ${JSON.stringify(r.callerFlowId)}\n` +
          `date: ${new Date().toISOString()}\n` +
          `tags: ${JSON.stringify(tags)}\n` +
          `---\n\n`;
        const final = frontmatter + body.trim() + "\n";
        if (final.length > MAX_FILE_SIZE) return errorResult(`Analysis too large (${final.length} bytes, max ${MAX_FILE_SIZE})`);

        await ensureWorkspaceDir(r.ws.id);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, final, "utf-8");
        wsService!.touch(r.ws.id);
        log.info(`Workspace analysis: ${r.ws.id}/${relPath} by ${author}`);

        return textResult(
          `Analysis published: \`${relPath}\` in workspace **${r.ws.name}**\n` +
          `- **title**: ${title}\n` +
          `- **author**: ${author}\n` +
          `- **tags**: ${tags.length ? tags.join(", ") : "_(none)_"}\n\n` +
          (r.ws.shared
            ? "Other offices can find it via `kernel_workspace_search` (scope 'all' or 'shared')."
            : "Workspace is private — other offices will NOT see this. Mark the workspace `shared` if you want fleet-wide discovery."),
        );
      },
    },

    // ── kernel_workspace_analysis_list ─────────
    {
      name: "kernel_workspace_analysis_list",
      description:
        "List analyses (markdown files under analyses/) with their frontmatter. " +
        "scope='mine' (default) searches your workspaces; 'shared' = shared by others; 'all' = both.",
      inputSchema: z.object({
        scope: z.enum(["mine", "shared", "all"]).optional().describe("Default 'all'"),
        workspace_id: z.string().optional().describe("Restrict to one workspace"),
        tag_filter: z.string().optional().describe("Only analyses whose tags include this string"),
        limit: z.number().optional().describe("Max results (default 30)"),
      }) as z.ZodType<unknown>,
      outputSchema: z.object({
        scope: z.string(),
        analyses: z.array(z.object({
          workspace_id: z.string(),
          workspace_name: z.string(),
          shared: z.boolean(),
          file: z.string(),
          rel_path: z.string(),
          title: z.string(),
          author: z.string(),
          tags: z.string(),
          mtime_ms: z.number(),
          uri: z.string().describe("MCP resource URI for resources/read"),
        })),
        total: z.number().int(),
        truncated: z.boolean(),
      }) as z.ZodType<unknown>,
      tags: ["workspace", "analysis", "list"],
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        if (!wsService) return errorResult("Workspace service unavailable");
        const callerFlowId = resolveCallerFlowId(a, agents);
        if (!callerFlowId) return errorResult("No flow_id — agent is not assigned to an office");
        const scope = a.scope === "mine" || a.scope === "shared" || a.scope === "all" ? a.scope : "all";
        const tagFilter = typeof a.tag_filter === "string" ? a.tag_filter.toLowerCase() : "";
        const limit = typeof a.limit === "number" ? Math.min(100, Math.max(1, a.limit)) : 30;
        const singleWsId = typeof a.workspace_id === "string" ? a.workspace_id : "";

        let targets: Workspace[] = [];
        if (singleWsId) {
          const ws = wsService.get(singleWsId);
          if (!ws) return errorResult("Workspace not found");
          if (ws.owner_flow_id !== callerFlowId && !ws.shared) return errorResult("Workspace is private");
          targets = [ws];
        } else {
          if (scope !== "shared") targets.push(...wsService.listByOwner(callerFlowId));
          if (scope !== "mine") targets.push(...wsService.listShared(callerFlowId));
        }

        const rows: Array<{ ws: Workspace; file: string; meta: Record<string, string>; mtime: number }> = [];
        for (const ws of targets) {
          const absDir = resolve(WORKSPACE_ROOT, ws.id, ANALYSES_DIR);
          let entries: Array<{ name: string; isFile: () => boolean }>;
          try { entries = await readdir(absDir, { withFileTypes: true }); } catch { continue; }
          for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith(".md")) continue;
            const abs = join(absDir, e.name);
            try {
              const s = await stat(abs);
              const raw = await readFile(abs, "utf-8");
              const { meta } = parseFrontmatter(raw);
              if (tagFilter) {
                const tagsStr = (meta.tags ?? "").toLowerCase();
                if (!tagsStr.includes(tagFilter)) continue;
              }
              rows.push({ ws, file: e.name, meta, mtime: s.mtimeMs });
            } catch {
              // skip
            }
          }
        }

        rows.sort((a2, b2) => b2.mtime - a2.mtime);
        const trimmed = rows.slice(0, limit);

        const structured = {
          scope,
          analyses: trimmed.map((r) => ({
            workspace_id: r.ws.id,
            workspace_name: r.ws.name,
            shared: r.ws.owner_flow_id !== callerFlowId,
            file: r.file,
            rel_path: `${ANALYSES_DIR}/${r.file}`,
            title: r.meta.title || r.file,
            author: r.meta.author || "",
            tags: r.meta.tags || "[]",
            mtime_ms: r.mtime,
            uri: `kernel-analysis://${r.ws.id}/${r.file}`,
          })),
          total: rows.length,
          truncated: rows.length > trimmed.length,
        };

        if (trimmed.length === 0) {
          return {
            ...textResult(`No analyses found${tagFilter ? ` matching tag \`${tagFilter}\`` : ""}.`),
            structuredContent: structured,
          };
        }

        const lines: string[] = [`## Analyses (${scope})`];
        for (const r of trimmed) {
          const title = r.meta.title || r.file;
          const author = r.meta.author || "_(unknown)_";
          const tags = r.meta.tags || "[]";
          const own = r.ws.owner_flow_id === callerFlowId ? "" : " _(shared)_";
          lines.push(`- **[${r.ws.name}]**${own} ${title} — *${author}* \`${ANALYSES_DIR}/${r.file}\` ${tags !== "[]" ? `tags: ${tags}` : ""}`);
        }
        if (rows.length > trimmed.length) lines.push(`\n_…${rows.length - trimmed.length} more (raise \`limit\`)._`);
        return { ...textResult(lines.join("\n")), structuredContent: structured };
      },
    },

    // ── kernel_workspace_exec ──────────────────
    {
      name: "kernel_workspace_exec",
      description:
        "Execute a shell command inside one of YOUR OWN workspaces (owner-only) using an isolated Docker container. " +
        "The workspace is mounted at /workspace. Bun is the runtime (use `bun install`, `bun run <script>`, `bunx <cli>`). Network disabled by default. Max 60 seconds.",
      inputSchema: z.object({
        ...wsSelectorSchema,
        command: z.string().describe("Shell command to run (e.g. 'bun install', 'bun run build', 'bunx astro build')"),
        network: z.boolean().optional().describe("Enable network access (default: false, required for `bun install` and any other dependency download)"),
        timeout_ms: z.number().optional().describe("Timeout in ms (default 60000, max 60000)"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        const r = resolveWs(a, "write"); // exec requires owner
        if (!r.ok) return errorResult(r.error);
        const command = String(a.command ?? "");
        if (!command) return errorResult("command required");
        const network = a.network === true;
        const timeout_ms = typeof a.timeout_ms === "number" ? a.timeout_ms : undefined;

        const workDir = await ensureWorkspaceDir(r.ws.id);
        const timeout = Math.min(timeout_ms ?? MAX_EXEC_TIMEOUT, MAX_EXEC_TIMEOUT);

        try {
          await execFileAsync("docker", ["version"], { timeout: 5000 });
        } catch {
          log.warn("Workspace exec: Docker not available, refusing to run command without isolation");
          return errorResult(
            "Workspace command execution requires the Docker/sandbox isolation driver, which is not available on this host. " +
              "The unisolated host fallback has been removed for security, so the command was NOT executed. " +
              "Start the Docker daemon (or enable the sandbox driver) and retry.",
          );
        }

        // When the caller asks for network, prefer a long-lived compose stack.
        // It keeps `node_modules` warm across runs — the offline one-shot path
        // below still sees it through the shared bind-mount, so subsequent
        // `bun run build` calls benefit from the cache.
        if (network) {
          const handle = await composeUp(r.ws.id, workDir);
          if (handle) {
            try {
              const { stdout, stderr } = await composeExec(r.ws.id, handle, command, timeout);
              const output = (stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "")).trim();
              log.info(`Workspace compose exec [${r.ws.id.slice(0, 8)}]: ${command.slice(0, 60)} → ${output.length} bytes`);
              wsService!.touch(r.ws.id);
              composeMarkExec(r.ws.id);
              return textResult(`## Output _(ws: ${r.ws.name}, compose)_\n\`\`\`\n${output.slice(0, 5000)}\n\`\`\``);
            } catch (err: unknown) {
              const e = err as { stdout?: string; stderr?: string; message?: string };
              const output = `${e.stdout ?? ""}${e.stderr ? `\n${e.stderr}` : ""}`.trim();
              return errorResult(`Command failed (compose):\n${output || e.message || String(err)}`.slice(0, 3000));
            }
          }
          // compose unavailable → fall through to one-shot docker run (with net)
        }

        const dockerArgs = [
          "run", "--rm",
          "--name", `workspace-${r.ws.id.slice(0, 8)}-${Date.now()}`,
          "-v", `${workDir}:/workspace`,
          "-w", "/workspace",
          "--memory=256m",
          "--cpus=1",
          "--pids-limit=100",
        ];
        if (!network) dockerArgs.push("--network=none");
        dockerArgs.push(SANDBOX_IMAGE, "sh", "-c", command);

        try {
          const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
            timeout,
            maxBuffer: 1024 * 1024,
          });
          const output = (stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "")).trim();
          log.info(`Workspace exec [${r.ws.id.slice(0, 8)}]: ${command.slice(0, 60)} → ${output.length} bytes`);
          wsService!.touch(r.ws.id);
          return textResult(`## Output _(ws: ${r.ws.name})_\n\`\`\`\n${output.slice(0, 5000)}\n\`\`\``);
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          const output = `${e.stdout ?? ""}${e.stderr ? `\n${e.stderr}` : ""}`.trim();
          return errorResult(`Command failed:\n${output || e.message || String(err)}`.slice(0, 3000));
        }
      },
    },
  ];
}
