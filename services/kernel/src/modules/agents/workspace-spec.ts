/**
 * Declarative workspace spec: what an office's home must contain before any
 * of its agents start working in it. Declared once per office, applied to
 * every run that inherits the home.
 *
 *   git          repos cloned into subfolders of the home, at a branch
 *   files        files seeded into the home (AGENTS.md, conventions…)
 *   mcp_servers  MCP servers every agent of the office gets, under its own
 *   skills       skills every agent of the office gets, besides its own
 *
 * Paths and git arguments come from users and from agents, so they are
 * validated here, before anything touches the disk or a command line.
 */

import { posix } from "node:path";
import { z } from "zod";

/** A relative path that stays inside the workspace. */
const insidePath = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) => {
      if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) return false;
      const norm = posix.normalize(p.replace(/\\/g, "/"));
      return norm !== "." && norm !== ".." && !norm.startsWith("../");
    },
    { message: "path must stay inside the workspace (relative, no ..)" },
  );

// Anything git could read as an option is refused, so a spec can't smuggle flags.
const repoUrl = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => !v.startsWith("-"), { message: "repo must not start with '-'" })
  .refine((v) => /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[\w.-]+@[\w.-]+:)/.test(v), {
    message: "repo must be an https://, ssh://, git://, file:// or user@host: URL",
  });

const GitRepoSchema = z.object({
  repo: repoUrl,
  branch: z
    .string()
    .max(200)
    .regex(/^[\w./-]+$/, "branch has invalid characters")
    .refine((v) => !v.startsWith("-"), { message: "branch must not start with '-'" })
    .optional(),
  /** Subfolder of the workspace; defaults to the repo's name. */
  path: insidePath.optional(),
  /** Shallow clone depth; omit for full history. */
  depth: z.number().int().positive().max(100_000).optional(),
});

const FileSchema = z.object({
  path: insidePath,
  content: z.string().max(200_000),
  /** Replace the file when it already exists. Default false: an agent's edits win. */
  overwrite: z.boolean().optional(),
});

export const WorkspaceSpecSchema = z.object({
  git: z.array(GitRepoSchema).max(20).optional(),
  files: z.array(FileSchema).max(50).optional(),
  mcp_servers: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.record(z.string(), z.unknown())).optional(),
  skills: z.array(z.string().min(1).max(100)).max(50).optional(),
});

export interface WorkspaceSpec {
  git: Array<{ repo: string; branch?: string; path: string; depth?: number }>;
  files: Array<{ path: string; content: string; overwrite: boolean }>;
  mcp_servers: Record<string, Record<string, unknown>>;
  skills: string[];
}

/** Folder name git itself would pick for a repo URL. */
export function repoDirName(repo: string): string {
  const last = repo.replace(/\/+$/, "").split(/[/:]/).pop() ?? "repo";
  return last.replace(/\.git$/, "") || "repo";
}

/** Validate and normalize a spec; throws with every problem listed. */
export function parseWorkspaceSpec(input: unknown): WorkspaceSpec {
  const raw = typeof input === "string" ? JSON.parse(input || "{}") : input ?? {};
  const parsed = WorkspaceSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`);
    throw new Error(`Invalid workspace spec — ${problems.join("; ")}`);
  }
  const spec: WorkspaceSpec = {
    git: (parsed.data.git ?? []).map((g) => ({
      ...g,
      path: posix.normalize((g.path ?? repoDirName(g.repo)).replace(/\\/g, "/")),
    })),
    files: (parsed.data.files ?? []).map((f) => ({
      path: posix.normalize(f.path.replace(/\\/g, "/")),
      content: f.content,
      overwrite: f.overwrite ?? false,
    })),
    mcp_servers: parsed.data.mcp_servers ?? {},
    skills: parsed.data.skills ?? [],
  };
  const seen = new Set<string>();
  for (const p of [...spec.git.map((g) => g.path), ...spec.files.map((f) => f.path)]) {
    if (seen.has(p)) throw new Error(`Invalid workspace spec — two entries use the same path "${p}"`);
    seen.add(p);
  }
  return spec;
}

/** True when the spec asks for nothing at all. */
export function isEmptySpec(spec: WorkspaceSpec): boolean {
  return spec.git.length === 0 && spec.files.length === 0
    && Object.keys(spec.mcp_servers).length === 0 && spec.skills.length === 0;
}
