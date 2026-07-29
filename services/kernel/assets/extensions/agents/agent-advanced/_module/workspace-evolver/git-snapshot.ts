/**
 * Git snapshot primitives for workspace evolution.
 *
 * Each workspace gets its own git repo at data/workspaces/{id}/.git. We use
 * git as the snapshot/revert engine because it is already installed in every
 * sandbox image we ship and because diff/merge are useful affordances when
 * a human reviews what an agent changed.
 *
 * Identity: commits are authored as "Kernl <evolver@kernl.local>".
 * This is intentional — the commits are kernel artefacts, not the user's.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { isoNow } from "../../../../../../src/core/helpers.js";
import type { WorkspaceSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const COMMIT_AUTHOR_NAME = "Kernl";
const COMMIT_AUTHOR_EMAIL = "evolver@kernl.local";

async function git(workspaceDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", workspaceDir, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
      // Confine the repo discovery to this workspace. Without this, when
      // data/workspaces/{id}/ sits below a parent git repo (typical during
      // tests, but also true when the kernel itself is a checkout), git
      // commands silently scale up and operate on the parent — corrupting
      // history and yielding misleading HEAD reads.
      GIT_CEILING_DIRECTORIES: dirname(workspaceDir),
    },
  });
}

/** Returns true if the workspace already has a .git directory. */
export async function isInitialised(workspaceDir: string): Promise<boolean> {
  try {
    await access(join(workspaceDir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialise a fresh repo and write a minimal .gitignore. Idempotent: if
 * already initialised, returns the current HEAD without re-init.
 */
export async function ensureRepo(workspaceDir: string): Promise<WorkspaceSnapshot> {
  await mkdir(workspaceDir, { recursive: true });
  if (!(await isInitialised(workspaceDir))) {
    await git(workspaceDir, ["init", "-q", "--initial-branch=main"]);
    const ignorePath = resolve(workspaceDir, ".gitignore");
    try {
      await access(ignorePath);
    } catch {
      await writeFile(
        ignorePath,
        ["node_modules/", ".DS_Store", "*.log", ".env", ".env.local", ""].join("\n"),
        "utf8",
      );
    }
    await git(workspaceDir, ["add", "-A"]);
    // --allow-empty handles the case where .gitignore was the only thing and
    // gets ignored on a re-run. Better to have an anchor commit than to leave
    // HEAD undefined.
    await git(workspaceDir, [
      "commit", "-q", "--allow-empty",
      "-m", `evolve: initial baseline (${isoNow()})`,
    ]);
  }
  return getHead(workspaceDir);
}

/** Stage everything and commit if there are changes. Returns the new ref or
 *  the current HEAD when the working tree was clean. */
export async function snapshot(workspaceDir: string, label: string): Promise<WorkspaceSnapshot> {
  await git(workspaceDir, ["add", "-A"]);
  const dirty = await isDirty(workspaceDir);
  if (dirty) {
    const safeLabel = label.replace(/[^\w.\-/+ ]/g, " ").slice(0, 200);
    await git(workspaceDir, [
      "commit", "-q",
      "-m", `evolve: ${safeLabel}`,
    ]);
  }
  return { ...(await getHead(workspaceDir)), label };
}

/** True iff `git status --porcelain` reports any change. */
export async function isDirty(workspaceDir: string): Promise<boolean> {
  const { stdout } = await git(workspaceDir, ["status", "--porcelain"]);
  return stdout.trim().length > 0;
}

/** Read HEAD as a snapshot record. */
export async function getHead(workspaceDir: string): Promise<WorkspaceSnapshot> {
  const { stdout } = await git(workspaceDir, ["rev-parse", "HEAD"]);
  return { ref: stdout.trim(), taken_at: isoNow(), label: "" };
}

/** Hard reset the working tree back to a previous ref. Destructive. */
export async function revertTo(workspaceDir: string, ref: string): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
    throw new Error(`refusing to reset to suspicious ref "${ref}"`);
  }
  await git(workspaceDir, ["reset", "--hard", ref]);
  await git(workspaceDir, ["clean", "-fd"]);
}

/** List file paths changed between two refs. Returns [] when refs are equal. */
export async function listChangedFiles(workspaceDir: string, fromRef: string, toRef: string): Promise<string[]> {
  if (fromRef === toRef) return [];
  const { stdout } = await git(workspaceDir, ["diff", "--name-only", fromRef, toRef]);
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Unified diff between two refs, capped to keep prompt sizes sane. */
export async function diff(workspaceDir: string, fromRef: string, toRef: string, maxBytes = 64_000): Promise<string> {
  if (fromRef === toRef) return "";
  const { stdout } = await git(workspaceDir, ["diff", fromRef, toRef]);
  if (stdout.length > maxBytes) {
    return stdout.slice(0, maxBytes) + "\n\n[…diff truncated]";
  }
  return stdout;
}
