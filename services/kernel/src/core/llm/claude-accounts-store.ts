/**
 * Store for the Claude Code subscription accounts.
 *
 * The list lives in the `claude-code` provider config under `accounts`; the SDK
 * reads it through the resolver registered by `initClaudeAccounts`. An absent
 * list means the single legacy "default" account, so upgrading needs no write.
 */

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { getProviderConfig, getStoredConfig, saveProviderConfig } from "./credentials.js";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  claudeAccountDir,
  isClaudeAccountConnected,
  primaryClaudeAccountId,
  readClaudeIdentity,
  setClaudeAccountResolver,
  setClaudePrimaryTokenProbe,
  type ClaudeAccount,
  type ClaudeAccountIdentity,
} from "../../sdk/claude-accounts.js";
import { newId } from "../../sdk/helpers.js";
import { log } from "../../sdk/log.js";

const SLUG = "claude-code";

export interface ClaudeAccountView extends ClaudeAccount {
  connected: boolean;
  identity: ClaudeAccountIdentity | null;
  primary: boolean;
}

const VALID_ID = /^(default|[0-9a-f]{8})$/;

let onChange: ((why: string) => void) | null = null;

function readList(): ClaudeAccount[] {
  const raw = getStoredConfig(SLUG).accounts;
  if (!Array.isArray(raw)) return [{ id: DEFAULT_CLAUDE_ACCOUNT, label: "" }];
  const out: ClaudeAccount[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const { id, label } = a as { id?: unknown; label?: unknown };
    // The id becomes a directory name that removeAccount deletes: only ids this
    // store could have minted are honoured, never `..` or anything with a slash.
    if (typeof id !== "string" || !VALID_ID.test(id) || out.some((x) => x.id === id)) continue;
    out.push({ id, label: typeof label === "string" ? label : "" });
  }
  return out.length > 0 ? out : [{ id: DEFAULT_CLAUDE_ACCOUNT, label: "" }];
}

function writeList(list: ClaudeAccount[]): void {
  if (!saveProviderConfig(SLUG, { accounts: list })) throw new Error("Could not save the Claude accounts");
  try {
    onChange?.("Claude accounts changed");
  } catch (err) {
    // The list is already persisted; a failing refresh hook must not report the mutation as failed.
    log.warn(`Claude accounts: change hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Attach the refresh hook (HTTP bootstrap); every mutation calls it after persisting. */
export function setClaudeAccountsOnChange(fn: ((why: string) => void) | null): void {
  onChange = fn;
}

/** Register the resolver and the pasted-token probe the SDK consults; call once at boot, whatever the transport. */
export function initClaudeAccounts(opts: { onChange?: (why: string) => void } = {}): void {
  if (opts.onChange) onChange = opts.onChange;
  setClaudeAccountResolver(readList);
  setClaudePrimaryTokenProbe(() => !!getProviderConfig(SLUG).oauthToken || !!process.env.CLAUDE_CODE_OAUTH_TOKEN);
}

export function listAccounts(): ClaudeAccountView[] {
  const primary = primaryClaudeAccountId();
  return readList().map((a) => ({
    ...a,
    connected: isClaudeAccountConnected(a.id),
    identity: readClaudeIdentity(claudeAccountDir(a.id)),
    primary: a.id === primary,
  }));
}

export function addAccount(label = ""): ClaudeAccount {
  const list = readList();
  let id: string;
  // Eight hex chars keep the directory name short; a clash is unlikely but cheap to rule out.
  do { id = newId().replace(/-/g, "").slice(0, 8); } while (list.some((a) => a.id === id));
  const account = { id, label: label.trim() };
  // Persist first: a failed save must not leave an orphan directory behind.
  writeList([...list, account]);
  const dir = claudeAccountDir(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return account;
}

export function renameAccount(id: string, label: string): void {
  const list = readList();
  const a = list.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown Claude account: ${id}`);
  a.label = label.trim();
  writeList(list);
}

export function moveAccount(id: string, direction: "up" | "down"): void {
  const list = readList();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`Unknown Claude account: ${id}`);
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
  writeList(list);
}

export function removeAccount(id: string): void {
  const list = readList();
  if (!list.some((x) => x.id === id)) throw new Error(`Unknown Claude account: ${id}`);
  if (list.length === 1) throw new Error("Cannot remove the last Claude account: there must always be at least one");
  writeList(list.filter((x) => x.id !== id));
  // The default account's directory is the legacy login; dropping it from the list keeps the files.
  if (id !== DEFAULT_CLAUDE_ACCOUNT) {
    const dir = resolve(claudeAccountDir(id));
    const root = resolve(dirname(dir));
    // Belt and braces on top of the id check: never delete outside the accounts directory.
    if (root === resolve(claudeAccountDir("probe"), "..") && dir.startsWith(root + sep)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Another account signed in as the same person in the same organization. */
export function duplicateOf(id: string): ClaudeAccount | null {
  const mine = readClaudeIdentity(claudeAccountDir(id));
  if (!mine?.accountUuid || !mine.organizationUuid) return null;
  for (const a of readList()) {
    if (a.id === id) continue;
    const other = readClaudeIdentity(claudeAccountDir(a.id));
    if (other?.accountUuid === mine.accountUuid && other.organizationUuid === mine.organizationUuid) return a;
  }
  return null;
}
