/**
 * Claude Code subscription accounts.
 *
 * Kernl can hold several Claude subscriptions and rotate between them when one
 * hits its usage limit. This module is the foundation the rest builds on: where
 * each account keeps its CLI session, which account is "primary", and who is
 * signed in. It deliberately imports nothing from claude-cli.ts (which depends
 * on it) nor from src/core, so the SDK stays a leaf.
 *
 * The account list lives in the kernel's store; the SDK only sees it through a
 * resolver registered at boot, on a globalThis symbol so every bundled copy of
 * this module (kernel and extensions) reads the same one.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { log } from "./log.js";

export interface ClaudeAccount {
  id: string;
  label: string;
}

/** The pre-multi-account login: keeps its legacy directory so nobody re-logs in. */
export const DEFAULT_CLAUDE_ACCOUNT = "default";

export interface ClaudeAccountIdentity {
  email?: string;
  accountUuid?: string;
  organizationUuid?: string;
  organizationName?: string;
}

const RESOLVER_KEY = Symbol.for("kernl.claudeAccounts");
const PROBE_KEY = Symbol.for("kernl.claudePrimaryTokenProbe");

type Slot = Record<symbol, unknown>;

/** Register where the account list comes from; `null` goes back to the single default account. */
export function setClaudeAccountResolver(fn: (() => ClaudeAccount[]) | null): void {
  (globalThis as unknown as Slot)[RESOLVER_KEY] = fn;
}

/**
 * Register how to tell whether a pasted token (not a CLI session) is configured.
 * A pasted token is not tied to any directory, so it can only belong to the
 * first account. Without a probe the environment variable decides.
 */
export function setClaudePrimaryTokenProbe(fn: (() => boolean) | null): void {
  (globalThis as unknown as Slot)[PROBE_KEY] = fn;
}

/** Accounts in rotation order. */
export function listClaudeAccounts(): ClaudeAccount[] {
  const fn = (globalThis as unknown as Slot)[RESOLVER_KEY] as (() => ClaudeAccount[]) | null | undefined;
  let list: ClaudeAccount[] = [];
  try {
    list = fn ? fn() : [];
  } catch (err) {
    // Callers like claudeConfigDir were total before accounts existed; a broken
    // store must not make every provider listing and spawn throw.
    try {
      log.warn(`Claude accounts: resolver failed, using the default account: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // No host installed yet (early boot, tests): nothing to log to.
    }
  }
  return list.length > 0 ? list : [{ id: DEFAULT_CLAUDE_ACCOUNT, label: "" }];
}

function tokenConfigured(): boolean {
  const probe = (globalThis as unknown as Slot)[PROBE_KEY] as (() => boolean) | null | undefined;
  if (probe) return probe();
  return (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim().length > 0;
}

/**
 * Same XDG rule as the license: XDG_CONFIG_HOME when set, else ~/.config.
 * "default" keeps the legacy `kernl/claude`; the rest live side by side.
 */
export function claudeAccountDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : resolve(homedir(), ".config");
  if (id === DEFAULT_CLAUDE_ACCOUNT) return resolve(base, "kernl", "claude");
  return resolve(base, "kernl", "claude-accounts", id);
}

/**
 * Is a CLI login in this directory? Presence only, never validity: a stat plus
 * at most one small JSON parse, cheap enough for every provider listing.
 */
export function claudeSessionPresent(dir: string): boolean {
  if (existsSync(resolve(dir, ".credentials.json"))) return true;
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, ".claude.json"), "utf-8")) as Record<string, unknown>;
    return parsed.oauthAccount != null;
  } catch {
    // Missing, unreadable or malformed all mean the same thing here.
    return false;
  }
}

/**
 * Session in the account's dir, or (first account only) the pasted token.
 * `pastedToken` lets a caller that holds a token the probe cannot see (one that
 * lives only in provider config) vouch for the first account.
 */
export function isClaudeAccountConnected(id: string, env: NodeJS.ProcessEnv = process.env, pastedToken = false): boolean {
  // Through claudeAccountDir, not claudeConfigDir: that one delegates to the primary.
  if (claudeSessionPresent(claudeAccountDir(id, env))) return true;
  return listClaudeAccounts()[0]?.id === id && (pastedToken || tokenConfigured());
}

/** First connected account, else the first one. */
export function primaryClaudeAccountId(env: NodeJS.ProcessEnv = process.env, pastedToken = false): string {
  const accounts = listClaudeAccounts();
  for (const a of accounts) {
    if (isClaudeAccountConnected(a.id, env, pastedToken)) return a.id;
  }
  return accounts[0]!.id;
}

/** Who is signed in, from the CLI's own `.claude.json`. No network. */
export function readClaudeIdentity(dir: string): ClaudeAccountIdentity | null {
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, ".claude.json"), "utf-8")) as Record<string, unknown>;
    const oa = parsed.oauthAccount;
    if (!oa || typeof oa !== "object") return null;
    const o = oa as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const out: ClaudeAccountIdentity = {};
    const email = str(o.emailAddress);
    const accountUuid = str(o.accountUuid);
    const organizationUuid = str(o.organizationUuid);
    const organizationName = str(o.organizationName);
    if (email) out.email = email;
    if (accountUuid) out.accountUuid = accountUuid;
    if (organizationUuid) out.organizationUuid = organizationUuid;
    if (organizationName) out.organizationName = organizationName;
    return out;
  } catch {
    return null;
  }
}
