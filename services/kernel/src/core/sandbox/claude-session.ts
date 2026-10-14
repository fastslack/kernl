/**
 * The Claude session a sandboxed agent runs on — a copy that cannot kill the
 * original.
 *
 * Sandboxes used to get Kernl's `.credentials.json` copied verbatim into a
 * throwaway container. When the access token expired mid-run, the CLI inside
 * refreshed it: the OAuth server rotates the refresh token on every refresh,
 * so the new pair lived only in the container and died with it, while
 * Kernl's file kept a refresh token the server had already retired. The next
 * kernel-side call tried that token, was refused, and the CLI blanked both
 * tokens — every agent then failed "OAuth session expired and could not be
 * refreshed" until someone signed in again (2026-10-08, 2026-10-14).
 *
 * So the kernel is the only process that ever refreshes: the sandbox copy
 * carries the access token and nothing it could rotate, and the kernel makes
 * sure that token outlives the run before handing it over.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { log } from "../logger.js";

/** A sandbox run should never outlast this much token life. */
export const MIN_SANDBOX_TOKEN_MS = 30 * 60 * 1000;

interface OauthBlock {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  [k: string]: unknown;
}

function readCreds(path: string): { claudeAiOauth?: OauthBlock; [k: string]: unknown } | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/** The credentials file a sandbox may hold: the same session minus its refresh token. */
export function sandboxCredentials(raw: string): string | null {
  let parsed: { claudeAiOauth?: OauthBlock; [k: string]: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed.claudeAiOauth;
  if (!o || typeof o.accessToken !== "string" || !o.accessToken) return null;
  const { refreshToken: _dropped, ...rest } = o;
  return JSON.stringify({ ...parsed, claudeAiOauth: rest });
}

/** Write the sandbox's copy next to its wrapper. Null when there is no usable session. */
export function writeSandboxCredentials(src: string, dest: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(src, "utf-8");
  } catch {
    return null;
  }
  const copy = sandboxCredentials(raw);
  if (!copy) return null;
  writeFileSync(dest, copy, { encoding: "utf-8", mode: 0o600 });
  return dest;
}

/**
 * The `.claude.json` a sandbox mounts: a private copy next to its wrapper.
 *
 * The CLI rewrites that file atomically (tmp + rename). A single-file bind of
 * the original pins the inode Docker resolved, and when a concurrent rewrite
 * renames over it before runc mounts, the run dies at start with "error
 * mounting … /mnt/claude.json: no such file or directory" (exit 127). Nobody
 * renames over the copy. Null when there is no original.
 */
export function writeSandboxClaudeJson(src: string, dest: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(src, "utf-8");
  } catch {
    return null;
  }
  writeFileSync(dest, raw, { encoding: "utf-8", mode: 0o600 });
  return dest;
}

/** Does this session need refreshing before a sandbox gets it? */
export function needsRefresh(o: OauthBlock | undefined, now: number, minMs: number): boolean {
  if (!o || typeof o.accessToken !== "string" || !o.accessToken) return false;
  // Nothing to refresh with: a pasted or already-blanked session.
  if (typeof o.refreshToken !== "string" || !o.refreshToken) return false;
  if (typeof o.expiresAt !== "number") return false;
  return o.expiresAt - now < minMs;
}

let inFlight: Promise<void> | null = null;

/**
 * Refresh Kernl's session in place when it would expire during a run.
 *
 * The CLI refreshes only a token it sees as expired, so the file is marked
 * expired and one minimal call made through the kernel's own claude-code link
 * — the CLI then refreshes in Kernl's config dir, under its own lock, and
 * writes the new pair where everyone reads it. Concurrent launches share one
 * refresh. Never throws: a failed refresh leaves the run to fail on its own,
 * and the original session intact.
 */
export function ensureFreshClaudeSession(opts: {
  credsPath: string;
  ping: () => Promise<void>;
  minMs?: number;
  now?: () => number;
}): Promise<void> {
  if (inFlight) return inFlight;
  const now = opts.now ?? Date.now;
  const minMs = opts.minMs ?? MIN_SANDBOX_TOKEN_MS;
  const creds = readCreds(opts.credsPath);
  if (!creds || !needsRefresh(creds.claudeAiOauth, now(), minMs)) return Promise.resolve();

  inFlight = (async () => {
    try {
      const marked = { ...creds, claudeAiOauth: { ...creds.claudeAiOauth, expiresAt: now() - 1000 } };
      const tmp = `${opts.credsPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(marked), { encoding: "utf-8", mode: 0o600 });
      renameSync(tmp, opts.credsPath);
      await opts.ping();
      const after = readCreds(opts.credsPath)?.claudeAiOauth;
      if (needsRefresh(after, now(), minMs) || typeof after?.accessToken !== "string" || !after.accessToken) {
        log.warn("Claude session refresh before a sandbox run did not produce a fresh token");
      } else {
        log.info("Claude session refreshed before a sandbox run");
      }
    } catch (err) {
      log.warn(`Claude session refresh before a sandbox run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** One minimal call on Kernl's claude-code link — enough for the CLI to refresh. */
export async function pingClaudeCode(): Promise<void> {
  // Imported lazily: the LLM client pulls in the whole provider registry,
  // which the sandbox drivers have no other reason to load.
  const { createPinnedLlmClient } = await import("../llm/client.js");
  const client = createPinnedLlmClient("claude-code", "haiku", {} as never);
  if (!client) throw new Error("claude-code link unavailable");
  await client.chat({ user: "ok", maxTokens: 5, caller: "sandbox:session-refresh" });
}

/**
 * The credentials a sandbox mounts: refreshed first if they would expire
 * mid-run, then copied without the refresh token. Null when Kernl has no session.
 */
export async function prepareSandboxCredentials(src: string, dest: string): Promise<string | null> {
  await ensureFreshClaudeSession({ credsPath: src, ping: pingClaudeCode });
  return writeSandboxCredentials(src, dest);
}
