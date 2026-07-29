import { z } from "zod";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { RepoService } from "./service.js";
import { RepoService as RepoServiceClass } from "./service.js";
import type { Repo } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_EXEC_TIMEOUT = 120_000;       // 2 min hard ceiling
const MAX_READ_BYTES = 200_000;          // 200 KB per read call
const MAX_LIST_ENTRIES = 500;            // entries per list call
const MAX_SEARCH_RESULTS = 200;          // results per search
const MAX_OUTPUT_BYTES = 20_000;         // truncate exec/search output

// Files we never traverse — keep search and list responsive.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo",
  ".venv", "venv", "__pycache__", "target", ".cache", "coverage",
  ".pnpm-store", "vendor",
]);

const repoSelectorSchema = {
  id: z.string().optional().describe("Repo id (uuid). One of `id` or `name` is required."),
  name: z.string().optional().describe("Repo name slug (e.g. `kernl`). One of `id` or `name` is required."),
};

function resolveRepoOrError(service: RepoService, args: { id?: string; name?: string }): { ok: true; repo: Repo } | { ok: false; error: string } {
  if (!args.id && !args.name) return { ok: false, error: "Either `id` or `name` is required" };
  const repo = service.resolve(args);
  if (!repo) return { ok: false, error: `Repo not found: ${args.id ?? args.name}` };
  return { ok: true, repo };
}

function formatRepoLine(r: Repo): string {
  const parts = [r.name, `\`${r.path}\``];
  if (r.language) parts.push(`(${r.language})`);
  if (r.default_branch) parts.push(`[${r.default_branch}]`);
  return parts.join(" ");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[... output truncated at ${max} bytes — ${s.length - max} more bytes follow]`;
}

function listDir(absRoot: string, relStart: string, depth: number, glob?: RegExp): Array<{ rel: string; type: "file" | "dir"; size: number }> {
  const out: Array<{ rel: string; type: "file" | "dir"; size: number }> = [];
  const startAbs = join(absRoot, relStart);
  const stack: Array<{ abs: string; rel: string; remaining: number }> = [
    { abs: startAbs, rel: relStart, remaining: depth },
  ];
  while (stack.length && out.length < MAX_LIST_ENTRIES) {
    const cur = stack.pop()!;
    let entries;
    try { entries = readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_LIST_ENTRIES) break;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const childRel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      const childAbs = join(cur.abs, e.name);
      if (e.isDirectory()) {
        if (!glob || glob.test(childRel)) out.push({ rel: childRel, type: "dir", size: 0 });
        if (cur.remaining > 1) stack.push({ abs: childAbs, rel: childRel, remaining: cur.remaining - 1 });
      } else if (e.isFile()) {
        if (glob && !glob.test(childRel)) continue;
        let size = 0;
        try { size = statSync(childAbs).size; } catch { /* unreadable, skip size */ }
        out.push({ rel: childRel, type: "file", size });
      }
    }
  }
  return out;
}

function globToRegex(glob: string): RegExp {
  // Minimal glob → regex: supports `*` (within a segment), `**` (any depth),
  // `?` (single char), and literal chars. Operator-only tool so we keep it
  // permissive instead of importing a full glob lib.
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${esc}$`);
}

export function repoTools(service: RepoService): ToolDefinition[] {
  return [
    // ── kernel_repos_register ─────────────────────────────────
    {
      name: "kernel_repos_register",
      description:
        "Register an existing local repository (or any project directory) into the kernel registry. " +
        "The repo stays where it is on disk — only its path + metadata are stored. " +
        "On register we probe `.git/` for the remote URL and default branch (best-effort).",
      inputSchema: z.object({
        name: z.string().describe("Short slug, lowercase + digits + `-`/`_`. Used as a friendly handle in later calls."),
        path: z.string().describe("ABSOLUTE filesystem path to the repo root."),
        description: z.string().optional(),
        tags: z.string().optional().describe("Comma-separated free-form tags."),
        shared: z.boolean().optional().describe("If false, only the Repos Office sees this repo. Default true."),
      }),
      handler: async (args) => {
        const a = args as { name: string; path: string; description?: string; tags?: string; shared?: boolean };
        const res = service.create(a);
        if (!res.ok) return errorResult(res.error);
        const r = res.repo;
        const lines = [
          `Registered repo **${r.name}**`,
          `  Path:    \`${r.path}\``,
          r.remote_url ? `  Remote:  ${r.remote_url}` : null,
          r.default_branch ? `  Branch:  ${r.default_branch}` : null,
          r.language ? `  Language: ${r.language}` : null,
          `  Shared:  ${r.shared ? "yes (any office)" : "no (private)"}`,
          `  ID:      ${r.id}`,
        ].filter(Boolean);
        return textResult(lines.join("\n"));
      },
    },

    // ── kernel_repos_list ─────────────────────────────────────
    {
      name: "kernel_repos_list",
      description:
        "List registered repos. Filter by tag or substring query (matches name/description/path). " +
        "Returns ID + name + path for each result.",
      inputSchema: z.object({
        tag: z.string().optional(),
        query: z.string().optional().describe("Substring match across name, description, path."),
        limit: z.number().optional().describe("Default 50."),
      }),
      handler: async (args) => {
        const a = args as { tag?: string; query?: string; limit?: number };
        const rows = service.list({ tag: a.tag, query: a.query, limit: a.limit ?? 50 });
        if (rows.length === 0) return textResult("No repos registered. Use `kernel_repos_register` to add one.");
        const lines = rows.map((r) => `- ${formatRepoLine(r)} — id=${r.id}${r.description ? `\n    ${r.description}` : ""}`);
        return textResult(`${rows.length} repo(s):\n\n${lines.join("\n")}`);
      },
    },

    // ── kernel_repos_get ──────────────────────────────────────
    {
      name: "kernel_repos_get",
      description: "Get full details + a freshly probed git status (branch, head sha, dirty flag) for one repo.",
      inputSchema: z.object({ ...repoSelectorSchema }),
      handler: async (args) => {
        const r = resolveRepoOrError(service, args as { id?: string; name?: string });
        if (!r.ok) return errorResult(r.error);
        const repo = r.repo;
        let branch = "", head = "", dirty: "clean" | "dirty" | "unknown" = "unknown";
        try {
          branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo.path, timeout: 3000 })).stdout.trim();
          head = (await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo.path, timeout: 3000 })).stdout.trim();
          const status = (await execFileAsync("git", ["status", "--porcelain"], { cwd: repo.path, timeout: 3000 })).stdout.trim();
          dirty = status.length > 0 ? "dirty" : "clean";
        } catch { /* not a git repo — leave fields blank */ }
        service.touch(repo.id);
        const lines = [
          `# ${repo.name}`,
          `Path: \`${repo.path}\``,
          repo.description ? `Description: ${repo.description}` : null,
          repo.tags ? `Tags: ${repo.tags}` : null,
          repo.language ? `Language: ${repo.language}` : null,
          repo.remote_url ? `Remote: ${repo.remote_url}` : null,
          repo.default_branch ? `Default branch: ${repo.default_branch}` : null,
          branch ? `Current branch: ${branch} (${head})` : null,
          dirty !== "unknown" ? `Working tree: ${dirty}` : null,
          `Shared: ${repo.shared ? "yes" : "no"} | Registered: ${repo.created_at}`,
          `ID: ${repo.id}`,
        ].filter(Boolean);
        return textResult(lines.join("\n"));
      },
    },

    // ── kernel_repos_update ───────────────────────────────────
    {
      name: "kernel_repos_update",
      description: "Update editable metadata (name, description, tags, shared flag). Path is immutable — re-register to move.",
      inputSchema: z.object({
        ...repoSelectorSchema,
        name: z.string().optional(),
        description: z.string().optional(),
        tags: z.string().optional(),
        shared: z.boolean().optional(),
      }),
      handler: async (args) => {
        const a = args as { id?: string; name?: string; description?: string; tags?: string; shared?: boolean };
        const r = resolveRepoOrError(service, { id: a.id, name: a.name });
        if (!r.ok) return errorResult(r.error);
        try {
          const updated = service.update(r.repo.id, {
            name: a.name,
            description: a.description,
            tags: a.tags,
            shared: a.shared,
          });
          if (!updated) return errorResult("Update failed (race condition?)");
          return textResult(`Repo **${updated.name}** updated.`);
        } catch (e) {
          return errorResult(String((e as Error).message ?? e));
        }
      },
    },

    // ── kernel_repos_unregister ───────────────────────────────
    {
      name: "kernel_repos_unregister",
      description:
        "Remove a repo from the registry. Files on disk are NEVER touched — this only forgets the pointer. " +
        "Re-register with the same path to bring it back.",
      inputSchema: z.object({ ...repoSelectorSchema }),
      handler: async (args) => {
        const r = resolveRepoOrError(service, args as { id?: string; name?: string });
        if (!r.ok) return errorResult(r.error);
        service.unregister(r.repo.id);
        return textResult(`Unregistered repo **${r.repo.name}** (path \`${r.repo.path}\` untouched).`);
      },
    },

    // ── kernel_repos_list_files ───────────────────────────────
    {
      name: "kernel_repos_list_files",
      description:
        "List files inside a registered repo, relative to its root. Skips `node_modules`, `.git`, `dist`, `build`, virtualenvs etc. " +
        "Use a glob like `src/**/*.ts` to filter.",
      inputSchema: z.object({
        ...repoSelectorSchema,
        path: z.string().optional().describe("Subdirectory inside the repo. Default: repo root."),
        depth: z.number().optional().describe("Max recursion depth. Default 3, max 8."),
        glob: z.string().optional().describe("Optional glob (`*`, `**`, `?`) matched against the relative path."),
      }),
      handler: async (args) => {
        const a = args as { id?: string; name?: string; path?: string; depth?: number; glob?: string };
        const r = resolveRepoOrError(service, { id: a.id, name: a.name });
        if (!r.ok) return errorResult(r.error);
        const jailed = RepoServiceClass.jailPath(r.repo, a.path ?? "");
        if (!jailed.ok) return errorResult(jailed.error);
        if (!existsSync(jailed.abs)) return errorResult(`subdirectory does not exist: ${a.path}`);
        const depth = Math.min(8, Math.max(1, a.depth ?? 3));
        const glob = a.glob ? globToRegex(a.glob) : undefined;
        const relStart = relative(r.repo.path, jailed.abs) || "";
        const entries = listDir(r.repo.path, relStart, depth, glob);
        service.touch(r.repo.id);
        if (entries.length === 0) return textResult(`No files matched in \`${r.repo.name}/${relStart || ""}\`.`);
        const lines = entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.rel}${e.type === "file" && e.size > 0 ? ` (${e.size}B)` : ""}`);
        const more = entries.length >= MAX_LIST_ENTRIES ? `\n\n_…stopped at ${MAX_LIST_ENTRIES} entries. Narrow with \`glob\` or \`path\`._` : "";
        return textResult(`### ${r.repo.name}/${relStart || ""}\n\n${lines.join("\n")}${more}`);
      },
    },

    // ── kernel_repos_read ─────────────────────────────────────
    {
      name: "kernel_repos_read",
      description:
        "Read a file from a registered repo, relative to its root. " +
        "Large files (>200 KB) are returned in chunks — pass `offset` to page.",
      inputSchema: z.object({
        ...repoSelectorSchema,
        file: z.string().describe("Repo-relative path, e.g. `src/index.ts`."),
        offset: z.number().optional().describe("Starting byte offset (default 0)."),
      }),
      handler: async (args) => {
        const a = args as { id?: string; name?: string; file: string; offset?: number };
        const r = resolveRepoOrError(service, { id: a.id, name: a.name });
        if (!r.ok) return errorResult(r.error);
        const jailed = RepoServiceClass.jailPath(r.repo, a.file);
        if (!jailed.ok) return errorResult(jailed.error);
        if (!existsSync(jailed.abs)) return errorResult(`file not found: ${a.file}`);
        let st;
        try { st = statSync(jailed.abs); } catch (e) { return errorResult(`stat failed: ${String(e)}`); }
        if (!st.isFile()) return errorResult(`not a file: ${a.file}`);
        let raw;
        try { raw = readFileSync(jailed.abs, "utf8"); } catch (e) { return errorResult(`read failed: ${String(e)}`); }
        const total = raw.length;
        const start = Math.max(0, Math.min(total, Math.floor(a.offset ?? 0)));
        const end = Math.min(total, start + MAX_READ_BYTES);
        const chunk = raw.slice(start, end) || "(empty)";
        let suffix = "";
        if (end < total) suffix = `\n\n[... ${total - end} more bytes — call again with offset=${end}. Total: ${total} chars.]`;
        service.touch(r.repo.id);
        return textResult(`### ${r.repo.name}:${a.file}${start > 0 ? ` (chars ${start}–${end} of ${total})` : ""}\n\n\`\`\`\n${chunk}${suffix}\n\`\`\``);
      },
    },

    // ── kernel_repos_write ────────────────────────────────────
    {
      name: "kernel_repos_write",
      description:
        "Write (or overwrite) a file in a registered repo. Creates intermediate directories. " +
        "The repo MUST exist; the file path must stay inside the repo root.",
      inputSchema: z.object({
        ...repoSelectorSchema,
        file: z.string().describe("Repo-relative path."),
        content: z.string().describe("Full file content. Replaces existing content if the file exists."),
      }),
      handler: async (args) => {
        const a = args as { id?: string; name?: string; file: string; content: string };
        const r = resolveRepoOrError(service, { id: a.id, name: a.name });
        if (!r.ok) return errorResult(r.error);
        const jailed = RepoServiceClass.jailPath(r.repo, a.file);
        if (!jailed.ok) return errorResult(jailed.error);
        try {
          mkdirSync(dirname(jailed.abs), { recursive: true });
          writeFileSync(jailed.abs, a.content, "utf8");
        } catch (e) {
          return errorResult(`write failed: ${String(e)}`);
        }
        service.touch(r.repo.id);
        return textResult(`Wrote ${a.content.length} bytes to **${r.repo.name}**:${a.file}.`);
      },
    },

    // ── kernel_repos_search ───────────────────────────────────
    {
      name: "kernel_repos_search",
      description:
        "Search for a string inside a registered repo. Uses `rg` (ripgrep) when available, falls back to `grep -rE`. " +
        "Output is truncated at ~20 KB.",
      inputSchema: z.object({
        ...repoSelectorSchema,
        query: z.string().describe("Pattern. Treated as a regex by ripgrep/grep."),
        glob: z.string().optional().describe("Restrict to files matching this glob (e.g. `*.ts`)."),
        max_results: z.number().optional().describe("Default 100, max 200."),
      }),
      handler: async (args) => {
        const a = args as { id?: string; name?: string; query: string; glob?: string; max_results?: number };
        const r = resolveRepoOrError(service, { id: a.id, name: a.name });
        if (!r.ok) return errorResult(r.error);
        if (!a.query) return errorResult("query required");
        const cap = Math.min(MAX_SEARCH_RESULTS, Math.max(1, a.max_results ?? 100));
        // Try ripgrep first — order of magnitude faster, respects .gitignore.
        try {
          const rgArgs = ["-n", "--max-count", String(cap), "--no-heading", "--color", "never"];
          if (a.glob) rgArgs.push("--glob", a.glob);
          rgArgs.push("--", a.query, ".");
          const { stdout } = await execFileAsync("rg", rgArgs, { cwd: r.repo.path, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
          service.touch(r.repo.id);
          const out = stdout.trim();
          if (!out) return textResult(`No matches for \`${a.query}\` in **${r.repo.name}**.`);
          return textResult(`### Matches in ${r.repo.name}\n\n\`\`\`\n${truncate(out, MAX_OUTPUT_BYTES)}\n\`\`\``);
        } catch (rgErr) {
          // exit code 1 from rg = "no matches", which throws here. Distinguish.
          const code = (rgErr as { code?: number }).code;
          if (code === 1) {
            service.touch(r.repo.id);
            return textResult(`No matches for \`${a.query}\` in **${r.repo.name}**.`);
          }
          // rg not found or other error → fall back to grep.
        }
        try {
          const grepArgs = ["-rnE", "--color=never", "-m", String(cap)];
          if (a.glob) grepArgs.push("--include", a.glob);
          grepArgs.push("--", a.query, ".");
          const { stdout } = await execFileAsync("grep", grepArgs, { cwd: r.repo.path, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
          service.touch(r.repo.id);
          const out = stdout.trim();
          if (!out) return textResult(`No matches for \`${a.query}\` in **${r.repo.name}**.`);
          return textResult(`### Matches in ${r.repo.name} (grep)\n\n\`\`\`\n${truncate(out, MAX_OUTPUT_BYTES)}\n\`\`\``);
        } catch (grepErr) {
          const code = (grepErr as { code?: number }).code;
          if (code === 1) return textResult(`No matches for \`${a.query}\` in **${r.repo.name}**.`);
          return errorResult(`search failed: ${String((grepErr as Error).message ?? grepErr)}`);
        }
      },
    },

    // ── kernel_repos_exec ─────────────────────────────────────
    {
      name: "kernel_repos_exec",
      description:
        "Run a shell command in a registered repo's working directory (HOST exec, NOT sandboxed). " +
        "Default timeout 60s (max 120s). Output is truncated at ~20 KB. " +
        "Use for builds, tests, linters, git commands. The operator has authorized exec access for any repo in the registry.",
      inputSchema: z.object({
        ...repoSelectorSchema,
        command: z.string().describe("Full shell command, e.g. `bun install`, `bun test`, `git status`."),
        timeout_ms: z.number().optional().describe("Default 60000, max 120000."),
      }),
      handler: async (args) => {
        const a = args as { id?: string; name?: string; command: string; timeout_ms?: number };
        const r = resolveRepoOrError(service, { id: a.id, name: a.name });
        if (!r.ok) return errorResult(r.error);
        const cmd = (a.command ?? "").trim();
        if (!cmd) return errorResult("command required");
        const timeout = Math.min(MAX_EXEC_TIMEOUT, a.timeout_ms ?? 60_000);
        try {
          const { stdout, stderr } = await execFileAsync("sh", ["-c", cmd], {
            cwd: r.repo.path,
            timeout,
            maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env },
          });
          service.touch(r.repo.id);
          const combined = (stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "")).trim();
          return textResult(`### Exec in ${r.repo.name}\n\`$ ${cmd}\`\n\n\`\`\`\n${truncate(combined || "(no output)", MAX_OUTPUT_BYTES)}\n\`\`\``);
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
          const combined = `${e.stdout ?? ""}${e.stderr ? `\n${e.stderr}` : ""}`.trim();
          return errorResult(`Command failed (exit ${e.code ?? "?"}):\n${truncate(combined || e.message || String(err), MAX_OUTPUT_BYTES)}`);
        }
      },
    },

    // ── kernel_repos_git ──────────────────────────────────────
    {
      name: "kernel_repos_git",
      description:
        "Run a read-only git operation against a registered repo. Supported ops: `status`, `diff`, `log`, `branch`, `show`. " +
        "Use `kernel_repos_exec` with `git ...` for anything that mutates (commit, push, checkout).",
      inputSchema: z.object({
        ...repoSelectorSchema,
        op: z.enum(["status", "diff", "log", "branch", "show"]).describe("Which git op to run."),
        ref: z.string().optional().describe("For `diff`/`log`/`show`: the ref/range (default: HEAD)."),
        path: z.string().optional().describe("For `diff`/`log`: restrict to this path."),
        limit: z.number().optional().describe("For `log`: max commits (default 20)."),
      }),
      handler: async (args) => {
        const a = args as { id?: string; name?: string; op: string; ref?: string; path?: string; limit?: number };
        const r = resolveRepoOrError(service, { id: a.id, name: a.name });
        if (!r.ok) return errorResult(r.error);
        const cwd = r.repo.path;
        let argv: string[];
        switch (a.op) {
          case "status": argv = ["status", "--short", "--branch"]; break;
          case "diff": {
            argv = ["diff", "--stat"];
            if (a.ref) argv.push(a.ref);
            if (a.path) {
              const j = RepoServiceClass.jailPath(r.repo, a.path);
              if (!j.ok) return errorResult(j.error);
              argv.push("--", a.path);
            }
            break;
          }
          case "log": {
            const limit = Math.max(1, Math.min(200, a.limit ?? 20));
            argv = ["log", "--oneline", "--decorate", `-${limit}`];
            if (a.ref) argv.push(a.ref);
            if (a.path) {
              const j = RepoServiceClass.jailPath(r.repo, a.path);
              if (!j.ok) return errorResult(j.error);
              argv.push("--", a.path);
            }
            break;
          }
          case "branch": argv = ["branch", "-a", "--no-color"]; break;
          case "show": argv = ["show", "--stat", a.ref ?? "HEAD"]; break;
          default: return errorResult(`unsupported op: ${a.op}`);
        }
        try {
          const { stdout, stderr } = await execFileAsync("git", argv, { cwd, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
          service.touch(r.repo.id);
          const combined = (stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "")).trim();
          return textResult(`### git ${a.op} — ${r.repo.name}\n\n\`\`\`\n${truncate(combined || "(no output)", MAX_OUTPUT_BYTES)}\n\`\`\``);
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          const combined = `${e.stdout ?? ""}${e.stderr ? `\n${e.stderr}` : ""}`.trim();
          return errorResult(`git ${a.op} failed:\n${truncate(combined || e.message || String(err), MAX_OUTPUT_BYTES)}`);
        }
      },
    },
  ];
}
