import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type ToolDefinition, defineTool, errorResult, structuredResult, limitArg } from "@kernl/extension-sdk";
import type { RepoService } from "./service.js";
import type { CodeGraph } from "./code-graph.js";
import { callerAgentId, resolveRepoOrError } from "./tools.js";
import { checkRef } from "./git-args.js";

const execFileAsync = promisify(execFile);

const repoSel = {
  id: z.string().optional().describe("Repo id (uuid). One of `id` or `name` is required."),
  name: z.string().optional().describe("Repo name slug (e.g. `kernl`). One of `id` or `name` is required."),
};

const fail = (e: unknown) => errorResult(e instanceof Error ? e.message : String(e));

/** Hotspots, owners and change impact, read from the repo's history graph (rebuilt when HEAD moves). */
export function codeGraphTools(service: RepoService, code: CodeGraph): ToolDefinition[] {
  const open = async (a: { id?: string; name?: string } & Record<string, unknown>, force = false) => {
    const r = resolveRepoOrError(service, { id: a.id, name: a.name }, callerAgentId(a));
    if (!r.ok) return { error: r.error } as const;
    const built = await code.build(r.repo, { force });
    service.touch(r.repo.id);
    return { repo: r.repo, built } as const;
  };
  const history = (b: { commits: number; head: string }) => `${b.commits} commits of the last year, at ${b.head.slice(0, 10)}`;

  return [
    defineTool({
      name: "kernel_repos_code_hotspots",
      description:
        "The files of a registered repo that change most (last year of history), with how many people touch them and who owns them. " +
        "High commits with one owner (owner_share near 1) is a knowledge risk; high commits with many authors is a coordination risk. " +
        "`prefix` limits it to a directory. Reads a history graph that is rebuilt on its own when the repo's HEAD moves.",
      schema: z.object({
        ...repoSel,
        prefix: z.string().optional().describe("Only files under this repo-relative directory, e.g. `src/modules/`."),
        limit: limitArg(100, "How many files (default 20)."),
        rebuild: z.boolean().optional().describe("Rebuild the history graph even if HEAD did not move."),
      }),
      handler: async (a) => {
        try {
          const o = await open(a, a.rebuild);
          if ("error" in o) return errorResult(o.error);
          const files = await code.hotspots(o.repo.id, { prefix: a.prefix, limit: a.limit ?? 20 });
          const text = files.length
            ? files.map((f) => `- ${f.path} — ${f.commits} commits, ${f.authors} author(s), owner ${f.owner} (${Math.round(f.owner_share * 100)}%)`).join("\n")
            : "No file changed in that window.";
          return structuredResult({ repo: o.repo.name, history: o.built, files }, `### Hotspots — ${o.repo.name} (${history(o.built)})\n\n${text}`);
        } catch (e) {
          return fail(e);
        }
      },
    }),

    defineTool({
      name: "kernel_repos_code_owners",
      description:
        "Who knows a file or a directory of a registered repo: authors ranked by commits in the last year, with their share, lines changed and last touch. " +
        "Use it to pick a reviewer or to find who to ask about a part of the code.",
      schema: z.object({
        ...repoSel,
        path: z.string().describe("Repo-relative file or directory, e.g. `src/server.ts` or `src/modules/brain`. Empty for the whole repo."),
        limit: limitArg(50, "How many authors (default 10)."),
      }),
      handler: async (a) => {
        try {
          const o = await open(a);
          if ("error" in o) return errorResult(o.error);
          const path = a.path.replace(/^\.?\/+/, "");
          const owners = await code.owners(o.repo.id, path, a.limit ?? 10);
          const text = owners.length
            ? owners.map((w) => `- ${w.name} <${w.email}> — ${w.commits} commits (${Math.round(w.share * 100)}%), ${w.files} file(s), last ${w.last_at.slice(0, 10)}`).join("\n")
            : `Nobody changed ${path || "the repo"} in the last year (or the path is not tracked).`;
          return structuredResult({ repo: o.repo.name, path, history: o.built, owners }, `### Owners of ${path || o.repo.name}\n\n${text}`);
        } catch (e) {
          return fail(e);
        }
      },
    }),

    defineTool({
      name: "kernel_repos_change_impact",
      description:
        "What else usually changes when these files change, from the repo's history: files that were committed together with them, " +
        "with a confidence (the share of their commits that also touched the related file) and the related file's owner. " +
        "Pass `paths`, or `ref` to take the files of a diff (e.g. `origin/main...HEAD` for a branch, or a commit sha). " +
        "Use it before a change or in a review to spot the tests, docs or sibling modules that may need the same change.",
      schema: z.object({
        ...repoSel,
        paths: z.array(z.string()).optional().describe("Repo-relative files that change."),
        ref: z.string().optional().describe("Instead of `paths`: a range or commit whose changed files to use."),
        limit: limitArg(100, "How many related files (default 15)."),
      }),
      handler: async (a) => {
        try {
          const o = await open(a);
          if ("error" in o) return errorResult(o.error);
          let paths = (a.paths ?? []).map((p) => p.replace(/^\.?\/+/, "")).filter(Boolean);
          if (!paths.length && a.ref) {
            const bad = checkRef(a.ref);
            if (bad) return errorResult(bad);
            const isRange = a.ref.includes("..");
            const argv = isRange
              ? ["diff", "--name-only", "--end-of-options", a.ref]
              : ["show", "--name-only", "--format=", "--end-of-options", a.ref];
            const { stdout } = await execFileAsync("git", argv, { cwd: o.repo.path, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
            paths = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
          }
          if (!paths.length) return errorResult("Pass `paths` or a `ref` that changes files.");
          const capped = paths.slice(0, 200);
          const out = await code.impact(o.repo.id, capped, a.limit ?? 15);
          const lines = out.related.map(
            (r) => `- ${r.path} — ${Math.round(r.confidence * 100)}% (${r.together}× together with ${r.because.slice(0, 3).join(", ")}${r.because.length > 3 ? "…" : ""}), owner ${r.owner}`,
          );
          const note = out.unknown.length ? `\n\nNo history for: ${out.unknown.slice(0, 10).join(", ")}${out.unknown.length > 10 ? "…" : ""} (new, untracked, or unchanged in the last year).` : "";
          return structuredResult(
            { repo: o.repo.name, paths: capped, history: o.built, ...out },
            `### Change impact — ${capped.length} file(s) in ${o.repo.name}\n\n${lines.length ? lines.join("\n") : "Nothing in the history changes together with these files."}${note}`,
          );
        } catch (e) {
          return fail(e);
        }
      },
    }),
  ];
}
