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
import { resolve } from "node:path";
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
 * Where the CLI actually is.
 *
 * The kernel image does not put `claude` on PATH — the agent SDK ships the
 * binary inside its own platform package — so the command we printed told
 * people to run something that answers "not found", right under a banner
 * saying their sign-in was out of date. A native install normally does have it
 * on PATH, which is the fallback.
 */
const SDK_CLI_PATHS = [
  "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
  "node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
  "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
  "node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude",
];

export function claudeCliPath(cwd: string = process.cwd(), exists: (p: string) => boolean = existsSync): string {
  for (const rel of SDK_CLI_PATHS) {
    const full = resolve(cwd, rel);
    if (exists(full)) return full;
  }
  return "claude";
}

/** What to paste in a terminal to sign in with the official CLI. */
export function claudeCodeLoginCommand(
  env: NodeJS.ProcessEnv = process.env,
  inDocker: boolean = existsSync("/.dockerenv"),
  cli: string = claudeCliPath(),
): string {
  const cmd = `CLAUDE_CONFIG_DIR="${claudeConfigDir(env)}" ${cli}`;
  return inDocker ? `docker compose exec kernel sh -c '${cmd}'` : cmd;
}
