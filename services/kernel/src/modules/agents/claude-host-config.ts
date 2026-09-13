/**
 * Claude Code host config — canonical file layout.
 *
 *   ~/.claude.json                         → user-scope `mcpServers` + OAuth + project history
 *   ~/.claude/settings.json                → user-scope `enabledPlugins`, `permissions`, hooks
 *   ~/.claude/plugins/marketplaces/<name>  → cloned plugin marketplaces (git repos)
 *   ~/.claude/plugins/cache/<mk>/<plug>/…  → cached plugin bundles
 *   ~/.claude/skills/<name>/SKILL.md       → user-scope skills (auto-discovered by SDK)
 *
 * This module reads + writes those files atomically (temp file + rename) so
 * concurrent kernel requests don't corrupt them. NO interactive shell-outs to
 * the `claude` CLI — the files are the contract.
 *
 * Path resolution: honours `HOST_HOME` first (docker bind-mount pattern used by
 * ClaudeCodeExecutor) then `HOME`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { renameWithRetrySync } from "../../core/fs-paths.js";

export function hostHome(): string {
  // os.homedir(), not $HOME: Windows has no HOME, and the old "" fallback put
  // `.claude.json` in the kernel's data dir — read and written silently.
  return process.env.HOST_HOME ?? homedir();
}

export function claudeJsonPath(): string {
  return join(hostHome(), ".claude.json");
}

export function claudeSettingsPath(): string {
  return join(hostHome(), ".claude", "settings.json");
}

// ── MCP server shape ────────────────────────────────────────────────

export type ClaudeMcpServer =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: "http" | "sse";
      url: string;
      env?: Record<string, string>;
    };

export interface ClaudeJson {
  mcpServers?: Record<string, ClaudeMcpServer>;
  [key: string]: unknown;
}

export interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, unknown>;
  mcpServers?: Record<string, ClaudeMcpServer>; // newer Claude Code reads mcpServers from here too
  permissions?: Record<string, unknown>;
  env?: Record<string, string>;
  hooks?: unknown;
  [key: string]: unknown;
}

// ── Readers ─────────────────────────────────────────────────────────

function readJsonSafe<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readClaudeJson(): ClaudeJson {
  return readJsonSafe<ClaudeJson>(claudeJsonPath(), {});
}

export function readClaudeSettings(): ClaudeSettings {
  return readJsonSafe<ClaudeSettings>(claudeSettingsPath(), {});
}

// ── Atomic writer ───────────────────────────────────────────────────

function writeJsonAtomic(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  // Claude Code itself keeps ~/.claude.json open; on Windows that briefly
  // turns the rename into EPERM.
  renameWithRetrySync(tmp, path);
}

export function writeClaudeJson(data: ClaudeJson): void {
  writeJsonAtomic(claudeJsonPath(), data);
}

export function writeClaudeSettings(data: ClaudeSettings): void {
  writeJsonAtomic(claudeSettingsPath(), data);
}

// ── High-level mutations ────────────────────────────────────────────

/** Return the canonical user-scope MCP map. Claude Code reads this both from
 * `~/.claude.json` and (newer) from `~/.claude/settings.json` — we merge them
 * with settings.json winning on collision, matching the SDK's precedence. */
export function readUserScopeMcps(): Record<string, ClaudeMcpServer> {
  const merged: Record<string, ClaudeMcpServer> = {};
  const fromJson = readClaudeJson().mcpServers ?? {};
  const fromSettings = readClaudeSettings().mcpServers ?? {};
  for (const [k, v] of Object.entries(fromJson)) merged[k] = v;
  for (const [k, v] of Object.entries(fromSettings)) merged[k] = v;
  return merged;
}

/** Add (or overwrite) an MCP server at user scope. We write to `.claude.json`
 * — the primary location. If a duplicate exists in settings.json we leave it
 * (the SDK will keep reading settings.json until the user explicitly removes). */
export function upsertUserScopeMcp(name: string, server: ClaudeMcpServer): void {
  const data = readClaudeJson();
  if (!data.mcpServers) data.mcpServers = {};
  data.mcpServers[name] = server;
  writeClaudeJson(data);
}

/** Remove from BOTH files. Idempotent — missing keys are a no-op. */
export function removeUserScopeMcp(name: string): { removedFromJson: boolean; removedFromSettings: boolean } {
  let removedFromJson = false;
  let removedFromSettings = false;

  const j = readClaudeJson();
  if (j.mcpServers && name in j.mcpServers) {
    delete j.mcpServers[name];
    writeClaudeJson(j);
    removedFromJson = true;
  }

  const s = readClaudeSettings();
  if (s.mcpServers && name in s.mcpServers) {
    delete s.mcpServers[name];
    writeClaudeSettings(s);
    removedFromSettings = true;
  }

  return { removedFromJson, removedFromSettings };
}

/** Plugins enablement lives in settings.json under `enabledPlugins`. */
export function readEnabledPlugins(): Record<string, boolean> {
  return readClaudeSettings().enabledPlugins ?? {};
}

export function setPluginEnabled(pluginRef: string, enabled: boolean): void {
  const s = readClaudeSettings();
  if (!s.enabledPlugins) s.enabledPlugins = {};
  s.enabledPlugins[pluginRef] = enabled;
  writeClaudeSettings(s);
}
