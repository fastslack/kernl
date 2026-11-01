/**
 * Continuing a run cut by the usage limit on another Claude Code account.
 *
 * The CLI keeps each conversation as `<config dir>/projects/<slug>/<id>.jsonl`
 * and `resume` reloads it from there. Each account has its own config dir, so
 * the next account only finds the conversation once the transcript is copied
 * to the same relative path under its dir (a sandbox needs no copy: every
 * container of the run mounts the same per-run projects dir).
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** What the resumed pass is told in place of the goal. */
export const RESUME_PROMPT =
  "The previous attempt was interrupted by a usage limit. Continue the task from where it stopped. Do not repeat steps that already completed.";

// The CLI caps the dir name and appends a hash of the full path past it.
const MAX_SLUG = 200;

function pathHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return Math.abs(h).toString(36);
}

/** The CLI's per-project dir name: every non-alphanumeric char becomes `-`. */
export function projectSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return slug.length <= MAX_SLUG ? slug : `${slug.slice(0, MAX_SLUG)}-${pathHash(cwd)}`;
}

/** Session ids are UUIDs; anything else must not become a path. */
function safeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(sessionId);
}

export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, "projects", projectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * The transcript of a session under a projects dir, or null. The computed
 * slug is tried first; a scan by session id (unique) covers a CLI that names
 * the dir differently, so a naming change cannot silently turn into a cut.
 */
export function findTranscript(projectsDir: string, cwd: string, sessionId: string): string | null {
  if (!safeSessionId(sessionId)) return null;
  const direct = join(projectsDir, projectSlug(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  try {
    for (const entry of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, entry, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* no projects dir */ }
  return null;
}

/**
 * Copy a session's transcript (and the CLI's side files for it, if any) from
 * one account's config dir to another's. True only when the copy is in place.
 */
export function handOverTranscript(fromDir: string, toDir: string, cwd: string, sessionId: string): boolean {
  const source = findTranscript(join(fromDir, "projects"), cwd, sessionId);
  if (!source) return false;
  try {
    const project = basename(dirname(source));
    const targetDir = join(toDir, "projects", project);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(source, join(targetDir, `${sessionId}.jsonl`));
    const sideDir = join(dirname(source), sessionId);
    if (existsSync(sideDir) && statSync(sideDir).isDirectory()) {
      cpSync(sideDir, join(targetDir, sessionId), { recursive: true });
    }
    return existsSync(join(targetDir, `${sessionId}.jsonl`));
  } catch {
    return false;
  }
}

/** Remove a session's transcript and side files from one config dir. */
export function removeTranscript(configDir: string, cwd: string, sessionId: string): void {
  const file = findTranscript(join(configDir, "projects"), cwd, sessionId);
  if (!file) return;
  rmSync(file, { force: true });
  rmSync(join(dirname(file), sessionId), { recursive: true, force: true });
}

/**
 * Where sandboxed runs keep their per-run transcript dirs: next to the
 * kernel's database, inside the data volume the sandbox driver can mount.
 */
export function transcriptRunsRoot(sqlitePath?: string): string {
  return join(dirname(sqlitePath ?? process.env.SQLITE_PATH ?? resolve("data", "kernel.db")), ".claude-transcripts");
}

/**
 * Remove every per-run transcript dir. No run survives a restart, so at boot
 * whatever is there was left by a run the kernel never got to clean up.
 * Returns how many entries went.
 */
export function sweepTranscriptRunDirs(root: string): number {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    try {
      rmSync(join(root, entry), { recursive: true, force: true });
      removed++;
    } catch { /* left for the next boot */ }
  }
  return removed;
}
