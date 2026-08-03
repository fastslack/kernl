/**
 * Authentication for the Claude Code provider — the one provider that runs on
 * your Claude subscription instead of a metered API key.
 *
 * Three problems this solves, all of them observed rather than imagined:
 *
 *  1. **The session did not survive.** The bundled CLI stores credentials under
 *     $HOME, which in a container is the image's writable layer: a
 *     `docker compose up --force-recreate` silently threw the login away and
 *     every LLM feature started failing with "Not logged in". We point the CLI
 *     at the same XDG location the license already uses, which is persistent by
 *     definition on every install method.
 *
 *  2. **There was no way to log in.** `claude setup-token` renders an Ink TUI
 *     and aborts with "Raw mode is not supported" unless it gets a real TTY, so
 *     a plain `spawn` cannot drive it. It does print the OAuth URL even with no
 *     browser available, so a PTY plus a URL scrape is enough to run the whole
 *     flow from a dialog.
 *
 *  3. **A dead session poisoned the whole chain.** `materializeLink` treats the
 *     provider as usable whenever the binary exists, so an unauthenticated CLI
 *     still becomes the primary link and takes every other provider down with
 *     it. Callers reset the caches here after a login so the kernel recovers
 *     without a restart.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** What `claude auth status --json` reports. */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  /** "none" | "oauth_token" | "claudeai" | … — whatever the CLI calls it. */
  authMethod: string;
  apiProvider?: string;
}

/**
 * Where the CLI keeps its credentials.
 *
 * Same XDG rule as the license (see license/service.ts): honour
 * XDG_CONFIG_HOME when the launcher sets it, else ~/.config. Under Docker that
 * resolves inside the data volume, so the login outlives the container; on a
 * native install it is the user's own config directory, so it outlives an
 * upgrade. No per-platform branch is needed for either.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : resolve(homedir(), ".config");
  return resolve(base, "kernl", "claude");
}

/** Create the directory on first use; the CLI will not create the parent. */
export function ensureClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = claudeConfigDir(env);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Environment additions for every `claude` child process.
 *
 * `oauthToken` is the escape hatch for hosts where the interactive flow cannot
 * run at all (no PTY — Windows without ConPTY, locked-down sandboxes): the
 * operator pastes a token minted by `claude setup-token` anywhere else and it
 * is injected here instead. Verified against the CLI: with the variable set,
 * `auth status` reports authMethod "oauth_token".
 */
export function claudeAuthEnv(opts: { oauthToken?: string; env?: NodeJS.ProcessEnv } = {}): Record<string, string> {
  const out: Record<string, string> = {
    CLAUDE_CONFIG_DIR: claudeConfigDir(opts.env ?? process.env),
  };
  // Fall back to the environment. The adapter that makes real calls is built
  // with no config (client.ts constructs it zero-arg), so a token that lived
  // only in the provider registry never reached it: the dialog verified fine
  // and every actual request still failed "Not logged in".
  const token = (opts.oauthToken ?? (opts.env ?? process.env).CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  if (token) out.CLAUDE_CODE_OAUTH_TOKEN = token;
  return out;
}

/**
 * Read `claude auth status --json`.
 *
 * NOTE the sharp edge, confirmed by experiment: the CLI reports
 * `loggedIn: true` for a syntactically-valid but entirely fake token — it
 * checks presence, not validity. So this answers "is a credential configured",
 * never "does the credential work". Anything that wants the latter has to make
 * a real call; the dialog does exactly that before reporting success.
 */
export function parseAuthStatus(raw: string): ClaudeAuthStatus {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      loggedIn: o.loggedIn === true,
      authMethod: typeof o.authMethod === "string" ? o.authMethod : "none",
      apiProvider: typeof o.apiProvider === "string" ? o.apiProvider : undefined,
    };
  } catch {
    // A non-JSON reply means the CLI could not run at all (missing binary,
    // crashed). Treat it as logged out rather than throwing: the caller's job
    // is to offer a login, and an exception here would just hide the dialog.
    return { loggedIn: false, authMethod: "none" };
  }
}

/** Strip the ANSI/TUI noise `script` faithfully records so text can be matched. */
export function stripAnsi(s: string): string {
  return s
    // Cursor-forward becomes the whitespace it represents. Ink lays text out by
    // moving the cursor rather than emitting spaces, so deleting these ran the
    // words together — a real error came back as "Invalidcode. Please makesure
    // the fullcde wascopied", which is what the operator would have read.
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => " ".repeat(Math.min(Number(n) || 1, 200)))
    // Everything else CSI: colours, other cursor moves, bracketed-paste toggles.
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // OSC sequences (window titles), terminated by BEL or ST.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Two-character escapes: charset selection, keypad mode.
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\x1b[=>78]/g, "");
}

/**
 * Pull the OAuth URL out of the CLI's terminal output.
 *
 * Deliberately matches the URL and nothing else. The surrounding TUI is a
 * React-rendered box whose wording and layout change between CLI releases; the
 * authorize URL is a stable, well-formed token in that stream. Anchoring on the
 * URL alone is what keeps this from breaking on the next version bump.
 *
 * Ink also hard-wraps its output to the terminal width, so the URL can arrive
 * split across lines — the joins are undone before matching.
 */
export function extractLoginUrl(output: string): string | null {
  const flat = stripAnsi(output).replace(/\r/g, "\n");
  // Undo Ink's wrapping: a newline inside a URL never has surrounding spaces.
  const unwrapped = flat.replace(/\n(?=[^\s])/g, "");
  const m = /https?:\/\/[^\s"'<>]*oauth[^\s"'<>]*/i.exec(unwrapped);
  const url = m ? m[0] : /https?:\/\/(?:claude|console)\.[^\s"'<>]+/i.exec(unwrapped)?.[0];
  if (!url) return null;
  // Hold back anything that looks cut off. Observed for real: at the default
  // 80-column width Ink wrapped the URL and we produced
  // `…client_id=9d1c250a-e61b-44d9-88` — a link that loads a broken page rather
  // than failing honestly. The caller widens the terminal to stop the wrap;
  // this turns a regression into a timeout instead of a dead link.
  return isCompleteLoginUrl(url) ? url : null;
}

/**
 * Does this look like a whole OAuth URL rather than a truncated one?
 *
 * `state` is the last parameter the CLI emits and is fundamental to the OAuth
 * handshake, so its presence is a reliable "nothing was cut off" signal.
 */
export function isCompleteLoginUrl(url: string): boolean {
  return /[?&]state=[^&\s]+/.test(url);
}

/**
 * Does this host look capable of giving the CLI a TTY?
 *
 * `script` (util-linux) is the dependency-free way to lend a PTY to a child —
 * no native module, nothing to compile, and it is already present in the
 * kernel image. Where it is missing the caller falls back to asking for a
 * pasted token, which needs no terminal at all.
 */
export function ptyCommand(which: (cmd: string) => string | null): string[] | null {
  const script = which("script");
  if (script) {
    // -q quiet, -e propagate the child's exit status, -c run this command.
    // /dev/null discards the typescript file we do not want.
    return [script, "-qec", "%CMD%", "/dev/null"];
  }
  const socat = which("socat");
  if (socat) {
    // socat can also allocate a pty; kept as a second option because some
    // minimal images ship it without util-linux.
    return [socat, "-", "EXEC:%CMD%,pty,setsid,ctty,stderr"];
  }
  return null;
}
