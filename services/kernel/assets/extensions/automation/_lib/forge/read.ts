/**
 * Reading one issue or one merge request in full: its description, the
 * latest human comments and, for an MR/PR, the files it changes (with the
 * patch when asked). The triage RepoItem carries only a snapshot of the item;
 * an agent that has to reason about a decision needs what the team wrote.
 *
 * Read-only by construction: these tools only GET.
 */

import { z } from "zod";
import { defineTool, textResult, errorResult, type ToolDefinition } from "@kernl/extension-sdk";
import type { ForgeConnectionRow } from "./connections.js";

export interface ItemNote {
  author: string;
  created_at: string;
  body: string;
}

export interface ChangedFile {
  path: string;
  /** Previous path when the file was renamed. */
  old_path?: string;
  status: "added" | "deleted" | "renamed" | "modified";
  additions: number;
  deletions: number;
  /** The unified diff of this file, when it was asked for and the forge returned it. */
  patch?: string;
}

export interface ItemDetail {
  kind: "issue" | "merge_request";
  number: number;
  title: string;
  state: string;
  url: string;
  author: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  body: string;
  /** Latest human comments first-to-last (system notes left out). */
  notes: ItemNote[];
  /** How many human comments exist in total (notes may be the last N of them). */
  notes_total: number;
  // Merge requests only.
  source_branch?: string;
  target_branch?: string;
  head_sha?: string;
  merged?: boolean;
  draft?: boolean;
  files?: ChangedFile[];
}

export interface ReadOptions {
  /** How many of the latest comments to bring (default 15, max 50). */
  notes?: number;
  /** MR/PR: include each file's patch (capped). */
  patch?: boolean;
}

/** A forge provider that can read items in full (GitLab, GitHub). */
export interface ForgeReader {
  readIssue(project: string, number: number, connectionId: string, opts: ReadOptions): Promise<ItemDetail>;
  readChange(project: string, number: number, connectionId: string, opts: ReadOptions): Promise<ItemDetail>;
}

/**
 * `group/sub/project` out of whatever an agent has at hand: the path itself, a
 * web URL (`https://gitlab.com/heural/web/-/issues/2595`), or a git remote
 * (`git@gitlab.com:heural/web.git`, `https://gitlab.com/heural/web.git`).
 */
export function parseForgeProject(input: string): { host: string; path: string } | null {
  const s = input.trim();
  if (!s) return null;
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(s);
  if (scp) return { host: scp[1].toLowerCase(), path: scp[2] };
  if (/^(https?|ssh):\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    // GitLab puts "/-/" between the project and its pages; GitHub has /issues|/pull after owner/repo.
    let path = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/-/")[0];
    const gh = /^([^/]+\/[^/]+)\/(issues|pull|pulls|tree|blob|commit|compare)(\/|$)/.exec(path);
    if (gh) path = gh[1];
    path = path.replace(/\/+$/, "");
    return path ? { host: u.hostname.toLowerCase(), path } : null;
  }
  if (/^[\w.-]+(\/[\w.-]+)+$/.test(s)) return { host: "", path: s.replace(/\.git$/, "") };
  return null;
}

const MAX_BODY = 12_000;
const MAX_NOTE = 3_000;
const MAX_PATCHES = 60_000;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/** The item as markdown for an agent: header, description, comments, files. */
export function formatItemDetail(d: ItemDetail): string {
  const kind = d.kind === "issue" ? "Issue" : "Merge request";
  const lines = [
    `### ${kind} #${d.number}: ${d.title}`,
    `${d.url}`,
    `state: ${d.state}${d.draft ? " (draft)" : ""}${d.merged ? " (merged)" : ""} · author: ${d.author || "?"} · created ${d.created_at} · updated ${d.updated_at}`,
  ];
  if (d.labels.length) lines.push(`labels: ${d.labels.join(", ")}`);
  if (d.source_branch) lines.push(`branch: ${d.source_branch} → ${d.target_branch}${d.head_sha ? ` @ ${d.head_sha.slice(0, 8)}` : ""}`);
  lines.push("", "#### Description", d.body.trim() ? cut(d.body.trim(), MAX_BODY) : "(empty)");
  lines.push("", `#### Comments (${d.notes.length} of ${d.notes_total}, oldest first)`);
  if (d.notes.length === 0) lines.push("(none)");
  for (const n of d.notes) lines.push("", `— ${n.author}, ${n.created_at}:`, cut(n.body.trim(), MAX_NOTE));
  if (d.files) {
    lines.push("", `#### Files (${d.files.length})`);
    for (const f of d.files) {
      lines.push(`- ${f.status} ${f.old_path && f.old_path !== f.path ? `${f.old_path} → ` : ""}${f.path} (+${f.additions} −${f.deletions})`);
    }
    let budget = MAX_PATCHES;
    const patched = d.files.filter((f) => f.patch);
    if (patched.length) lines.push("", "#### Patch");
    for (const f of patched) {
      if (budget <= 0) { lines.push(`… patches of the remaining files left out (budget of ${MAX_PATCHES} characters used)`); break; }
      const p = f.patch!.length > budget ? `${f.patch!.slice(0, budget)}\n… (cut)` : f.patch!;
      budget -= p.length;
      lines.push("", `--- ${f.path}`, "```diff", p, "```");
    }
  }
  return lines.join("\n");
}

/** +/− line counts of a unified diff. */
export function countDiff(patch: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) additions++;
    else if (l.startsWith("-") && !l.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

export interface ForgeReadToolsSpec<C extends ForgeConnectionRow & { host?: string }> {
  /** Tool-name segment: "github", "gitlab". */
  prefix: string;
  label: string;
  /** What a merge request is called here: "mr" (GitLab) or "pr" (GitHub). */
  changeNoun: "mr" | "pr";
  reader: ForgeReader;
  connections: () => C[];
  /** The forge's host for a connection, to match a project URL to it ("gitlab.com"). */
  hostOf: (c: C) => string;
}

/**
 * Pick the connection: the one named, else the only one, else the one whose
 * host matches the project URL. Several candidates and nothing to choose by
 * is an error that lists them.
 */
export function pickConnection<C extends ForgeConnectionRow>(
  all: C[], wanted: string | undefined, host: string, hostOf: (c: C) => string, label: string,
): { ok: true; conn: C } | { ok: false; error: string } {
  if (all.length === 0) return { ok: false, error: `No ${label} connection is configured: add one (a read-only token is enough).` };
  if (wanted) {
    const c = all.find((x) => x.id === wanted || x.name === wanted);
    return c ? { ok: true, conn: c } : { ok: false, error: `No ${label} connection "${wanted}". Configured: ${all.map((x) => x.name).join(", ")}` };
  }
  if (all.length === 1) return { ok: true, conn: all[0] };
  const byHost = host ? all.filter((c) => hostOf(c) === host) : [];
  if (byHost.length === 1) return { ok: true, conn: byHost[0] };
  return { ok: false, error: `Several ${label} connections (${all.map((x) => x.name).join(", ")}): pass \`connection\`.` };
}

export function forgeReadTools<C extends ForgeConnectionRow & { host?: string }>(spec: ForgeReadToolsSpec<C>): ToolDefinition[] {
  const { prefix, label, changeNoun } = spec;
  const projectArg = z.string().describe(
    `The ${label} project: \`group/project\`, its web URL, or its git remote (the \`remote_url\` kernel_repos_get shows).`,
  );
  const common = {
    project: projectArg,
    number: z.number().int().positive().describe("The issue/MR number (the iid in GitLab)."),
    notes: z.number().int().min(0).max(50).optional().describe("How many of the latest comments (default 15)."),
    connection: z.string().optional().describe(`${label} connection id or name; only needed when there are several.`),
  };
  const run = async (which: "issue" | "change", a: { project: string; number: number; notes?: number; connection?: string; patch?: boolean }) => {
    const parsed = parseForgeProject(a.project);
    if (!parsed) return errorResult(`Not a ${label} project: ${a.project}`);
    const picked = pickConnection(spec.connections(), a.connection, parsed.host, spec.hostOf, label);
    if (!picked.ok) return errorResult(picked.error);
    const opts: ReadOptions = { notes: a.notes ?? 15, patch: a.patch === true };
    try {
      const d = which === "issue"
        ? await spec.reader.readIssue(parsed.path, a.number, picked.conn.id, opts)
        : await spec.reader.readChange(parsed.path, a.number, picked.conn.id, opts);
      return textResult(formatItemDetail(d));
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
  return [
    defineTool({
      name: `kernel_${prefix}_issue_read`,
      description: `Read one ${label} issue in full: description, labels and the latest comments (system notes left out). Read-only.`,
      schema: z.object(common),
      handler: (a) => run("issue", a),
    }),
    defineTool({
      name: `kernel_${prefix}_${changeNoun}_read`,
      description:
        `Read one ${label} ${changeNoun === "mr" ? "merge request" : "pull request"} in full: description, branches, head sha, ` +
        "the latest comments and the files it changes; `patch: true` adds each file's diff (capped). Read-only.",
      schema: z.object({ ...common, patch: z.boolean().optional().describe("Include each file's diff.") }),
      handler: (a) => run("change", a),
    }),
  ];
}
