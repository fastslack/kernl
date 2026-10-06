/**
 * Claude Code runs on the user's own Claude subscription, through the
 * official CLI. Kernl does not sign anyone in and does not keep their token:
 * the CLI holds its session, Kernl only checks that it exists.
 *
 * Earlier versions stored a token from an in-app sign-in. That token is still
 * honoured so nobody loses service on upgrade, and deleted the moment the CLI
 * has a session of its own.
 */

import { existsSync } from "node:fs";
import { findClaudeCli } from "../../sdk/claude-cli.js";
import { claudeConfigDir, hasCliSession } from "./claude-code-auth.js";
import { getProviderConfig, getStoredConfig, saveProviderConfig } from "./credentials.js";
import { resetClaudeCodeSdkCache } from "./client.js";

export type ClaudeCodeTransition = "cli" | "legacy-token" | "none";

export function applyClaudeCodeTransition(
  d: { hasCliSession?: () => boolean; onCredentialChanged?: () => void } = {},
): ClaudeCodeTransition {
  const session = (d.hasCliSession ?? (() => hasCliSession()))();
  const onCredentialChanged = d.onCredentialChanged ?? resetClaudeCodeSdkCache;
  const token = getStoredConfig("claude-code").oauthToken;
  const hasToken = typeof token === "string" && token.trim() !== "";
  if (session) {
    if (hasToken) {
      saveProviderConfig("claude-code", { oauthToken: undefined });
      // The llm() singleton memoised a provider built with the token we just
      // deleted — without this every `claude` subprocess it spawns keeps
      // receiving credentials that no longer exist until a restart.
      onCredentialChanged();
    }
    return "cli";
  }
  return hasToken ? "legacy-token" : "none";
}

export function hasClaudeCodeCredential(): boolean {
  if (hasCliSession()) return true;
  if (getProviderConfig("claude-code").oauthToken) return true;
  return (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim() !== "";
}

/**
 * Where the CLI actually is — the same binary the provider will run.
 *
 * Printing a bare `claude` told people to run something that answers "not
 * found": the kernel image keeps no `claude` on PATH, and the .dmg ships the
 * CLI inside the agent SDK's platform package, never on PATH. A bare `claude`
 * is left only for when nothing is found at all.
 */
export function claudeCliPath(find: () => string | null = () => findClaudeCli()): string {
  return find() ?? "claude";
}

/** What to paste in a terminal to sign in with the official CLI. */
export function claudeCodeLoginCommand(
  env: NodeJS.ProcessEnv = process.env,
  inDocker: boolean = existsSync("/.dockerenv"),
  cli: string = claudeCliPath(),
  platform: string = process.platform,
): string {
  // A portable .app can be unpacked under a folder with spaces in its name.
  const bin = /\s/.test(cli) ? `"${cli}"` : cli;
  // cmd.exe has no `VAR=value command` prefix: it read CLAUDE_CONFIG_DIR as
  // the program name and answered "no se reconoce como un comando". This form
  // is cmd's own; quoting the whole assignment keeps a trailing space out.
  if (platform === "win32" && !inDocker) {
    return `set "CLAUDE_CONFIG_DIR=${claudeConfigDir(env)}" && ${bin}`;
  }
  const cmd = `CLAUDE_CONFIG_DIR="${claudeConfigDir(env)}" ${bin}`;
  return inDocker ? `docker compose exec kernel sh -c '${cmd}'` : cmd;
}
