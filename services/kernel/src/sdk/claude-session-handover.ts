/**
 * Keeping a chat's Claude Code session reachable when its turns move between
 * subscription accounts.
 *
 * The CLI stores a conversation as `<config dir>/projects/<project>/<id>.jsonl`
 * and `resume` only looks under the config dir of the account it runs on. A
 * chat whose first turns ran on one account and whose next turn rotates to
 * another (the first hit its usage limit) would resume nothing and lose the
 * conversation, so before each turn the newest copy of the transcript, from
 * whichever account wrote it last, is put under the account about to run.
 *
 * In the SDK, beside claude-accounts: extensions that run Claude Code (the
 * agent executor in agent-advanced) bundle the adapter, and a kernel file
 * outside src/sdk/ in their bundle fails the extension boundary gate.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claudeAccountDir, listClaudeAccounts } from "./claude-accounts.js";
import { log } from "./log.js";

/** Session ids are UUIDs; anything else must not become a path. */
function safeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(sessionId);
}

/** The transcript of `sessionId` under one config dir, or null. */
export function findSessionTranscript(configDir: string, sessionId: string): string | null {
  if (!safeSessionId(sessionId)) return null;
  const projects = join(configDir, "projects");
  let entries: string[];
  try { entries = readdirSync(projects); } catch { return null; }
  for (const entry of entries) {
    const candidate = join(projects, entry, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function mtime(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/**
 * Make `sessionId` resumable on `accountId`: when another account holds a
 * newer transcript of it, copy that one (and the CLI's side files) over. True
 * when the target account ends up with a transcript, false when no account has
 * one (a new or foreign session: resume as before and let the CLI decide).
 */
export function ensureSessionOnAccount(
  sessionId: string,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!safeSessionId(sessionId)) return false;
  const targetDir = claudeAccountDir(accountId, env);
  const existing = findSessionTranscript(targetDir, sessionId);
  let newest: string | null = null;
  for (const a of listClaudeAccounts()) {
    if (a.id === accountId) continue;
    const found = findSessionTranscript(claudeAccountDir(a.id, env), sessionId);
    if (found && (!newest || mtime(found) > mtime(newest))) newest = found;
  }
  if (!newest || (existing && mtime(existing) >= mtime(newest))) return existing !== null;
  try {
    const project = basename(dirname(newest));
    const dest = join(targetDir, "projects", project);
    mkdirSync(dest, { recursive: true });
    copyFileSync(newest, join(dest, `${sessionId}.jsonl`));
    const side = join(dirname(newest), sessionId);
    if (existsSync(side) && statSync(side).isDirectory()) cpSync(side, join(dest, sessionId), { recursive: true });
    return true;
  } catch (err) {
    log.warn(`Claude Code: could not hand session ${sessionId} over to account ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
    return existing !== null;
  }
}
