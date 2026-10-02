/**
 * Materialize a WorkspaceSpec into a folder.
 *
 * "Prepared once" is decided by what is on disk, not by a marker: a repo is
 * cloned only when its folder does not exist, and an existing checkout is
 * never fetched, reset or re-cloned — agents work inside it, and their edits
 * are the point. A seeded file is written when missing, or always when the
 * spec says `overwrite`. So running this before every run is cheap and safe,
 * and a step that failed simply runs again next time.
 *
 * git runs as an async child process with a timeout so a slow clone never
 * blocks the kernel's event loop, with no shell, no terminal prompt, and
 * arguments that parseWorkspaceSpec already vetted.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { WorkspaceSpec } from "./workspace-spec.js";

export interface WorkspaceSetupResult {
  ready: boolean;
  /** Repo paths cloned by this call (relative to the workspace). */
  cloned: string[];
  /** File paths written by this call. */
  written: string[];
  /** One line per step that failed; empty when ready. */
  errors: string[];
}

export interface PrepareOptions {
  /** Clone attempts per repo. Default 3. */
  attempts?: number;
  /** Per-clone timeout. Default KERNEL_WORKSPACE_GIT_TIMEOUT_MS or 10 minutes. */
  timeoutMs?: number;
}

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call for the same key has settled. */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(fn);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}

function gitTimeoutMs(): number {
  const n = Number(process.env.KERNEL_WORKSPACE_GIT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60_000;
}

function runGit(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error((err as NodeJS.ErrnoException).code === "ENOENT" ? "git is not installed" : err.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolvePromise();
      if (signal === "SIGKILL") return reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
      const lastLine = stderr.trim().split("\n").filter(Boolean).pop() ?? `exit ${code}`;
      reject(new Error(lastLine));
    });
  });
}

/** Resolve `rel` under `root`, refusing anything that lands outside it. */
function inside(root: string, rel: string): string {
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`"${rel}" escapes the workspace`);
  return full;
}

async function cloneRepo(
  root: string,
  repo: WorkspaceSpec["git"][number],
  opts: Required<PrepareOptions>,
): Promise<"cloned" | "present"> {
  const dest = inside(root, repo.path);
  if (existsSync(dest)) {
    if (existsSync(join(dest, ".git"))) return "present";
    if (readdirSync(dest).length > 0) {
      throw new Error(`${repo.path}: the folder exists and is not a git checkout — not cloning over it`);
    }
  }
  mkdirSync(dirname(dest), { recursive: true });
  const args = ["clone", "--quiet"];
  if (repo.branch) args.push("--branch", repo.branch);
  if (repo.depth) args.push("--depth", String(repo.depth));
  args.push("--", repo.repo, dest);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      await runGit(args, root, opts.timeoutMs);
      return "cloned";
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < opts.attempts) await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }
  throw new Error(`${repo.path}: clone of ${repo.repo} failed — ${lastError?.message}`);
}

export function prepareWorkspace(
  dir: string,
  spec: WorkspaceSpec,
  options: PrepareOptions = {},
): Promise<WorkspaceSetupResult> {
  const root = resolve(dir);
  const opts: Required<PrepareOptions> = {
    attempts: Math.max(1, options.attempts ?? 3),
    timeoutMs: options.timeoutMs ?? gitTimeoutMs(),
  };
  return withLock(root, async () => {
    const result: WorkspaceSetupResult = { ready: false, cloned: [], written: [], errors: [] };
    mkdirSync(root, { recursive: true });

    for (const repo of spec.git) {
      try {
        if ((await cloneRepo(root, repo, opts)) === "cloned") result.cloned.push(repo.path);
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    for (const file of spec.files) {
      try {
        const full = inside(root, file.path);
        if (existsSync(full) && !file.overwrite) continue;
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, file.content, "utf8");
        result.written.push(file.path);
      } catch (err) {
        result.errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    result.ready = result.errors.length === 0;
    return result;
  });
}
