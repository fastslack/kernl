/**
 * Moves LLM provider credentials out of `.env`, the process environment and
 * `app_settings` into the encrypted provider registry — once.
 *
 * After it has run, a credential that reappears in the environment (a compose
 * file still passing it, a shell export) is ignored and reported, not imported:
 * otherwise removing a provider in Settings would be undone by the next boot.
 *
 * `OLLAMA_BASE_URL` is copied but left in place — subtitle translation still
 * reads it, and it is not a secret.
 *
 * The `.env` rewrite is optimistic, not required. On the full compose stack
 * `.env` is a bind mount that can be root-owned while the kernel runs as an
 * unprivileged user: the file is still readable (import works) but not
 * writable. `backupDir` is therefore a separate, kernel-owned directory (the
 * one holding the sqlite database) rather than `.env`'s own — writing a new
 * file next to an unwritable `.env` would fail the same way. If the rewrite
 * still fails, the old keys stay in `.env` and are picked up by the "already
 * migrated" branch above, which ignores and reports them instead of
 * re-importing — the registry copy this run already made keeps working.
 */

import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDb } from "../db/sqlite.js";
import { log } from "../logger.js";
import { PROVIDER_CATALOG, getCatalogEntry } from "./provider-catalog.js";
import type { CredentialSource } from "./credentials.js";
import { LEGACY_CREDENTIAL_ENV, legacyToStoredPatch } from "./credentials-legacy.js";

export interface MigrationDeps {
  db: SqliteDb;
  registry: CredentialSource;
  env: NodeJS.ProcessEnv;
  envFilePath: string;
  /** Where the `.env` backup goes — must not depend on `.env`'s own directory being writable. */
  backupDir: string;
  hasClaudeSession: () => boolean;
  now?: () => string;
}

export interface MigrationReport {
  skipped: boolean;
  imported: string[];
  conflicts: string[];
  envLinesRemoved: string[];
  settingsRemoved: string[];
  ignoredEnv: string[];
  frozenChain: Array<{ provider: string; model: string }> | null;
  backupPath: string | null;
  /** Set when `.env` could not be backed up/rewritten; the import itself still happened. */
  envFileError: string | null;
}

const MARKER_ID = "v1";
const COPY_ONLY: Record<string, { slug: string; field: string }> = {
  OLLAMA_BASE_URL: { slug: "ollama", field: "baseUrl" },
};

function readEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    out.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

function tableExists(db: SqliteDb, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** A value that lived only in `app_settings`/`.env` must not be lost silently. */
function saveOrThrow(registry: CredentialSource, slug: string, cfg: Record<string, unknown>): void {
  if (!registry.saveConfig(slug, cfg)) {
    throw new Error(`could not save "${slug}" into the provider registry`);
  }
}

export function migrateLlmCredentials(d: MigrationDeps): MigrationReport {
  const now = d.now ?? (() => new Date().toISOString());
  const report: MigrationReport = {
    skipped: false, imported: [], conflicts: [], envLinesRemoved: [], settingsRemoved: [],
    ignoredEnv: [], frozenChain: null, backupPath: null, envFileError: null,
  };
  const legacyKeys = Object.keys(LEGACY_CREDENTIAL_ENV);

  d.db.exec("CREATE TABLE IF NOT EXISTS llm_credential_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  if (d.db.prepare("SELECT 1 FROM llm_credential_migrations WHERE id = ?").get(MARKER_ID)) {
    report.skipped = true;
    for (const k of legacyKeys) {
      if ((d.env[k] ?? "").trim()) { report.ignoredEnv.push(k); delete d.env[k]; }
    }
    return report;
  }

  const file = readEnvFile(d.envFilePath);
  const hasSettings = tableExists(d.db, "app_settings");
  const settings = new Map<string, string>();
  if (hasSettings) {
    for (const row of d.db.prepare("SELECT key, value FROM app_settings").all() as Array<{ key: string; value: string }>) {
      settings.set(row.key, row.value ?? "");
    }
  }
  const pick = (k: string): string => (d.env[k] ?? "").trim() || (file.get(k) ?? "").trim() || (settings.get(k) ?? "").trim();

  // 1. Import.
  const touched = new Set<string>();
  const importValue = (slug: string, patch: Record<string, unknown>) => {
    const stored = d.registry.loadConfig(slug);
    const next = { ...stored };
    let changed = false;
    for (const [field, value] of Object.entries(patch)) {
      if (field === "connectedAt") continue;
      const current = typeof stored[field] === "string" ? (stored[field] as string) : "";
      if (current && current !== value) { report.conflicts.push(`${slug}.${field}`); continue; }
      if (!current) { next[field] = value; changed = true; }
    }
    if (changed) { saveOrThrow(d.registry, slug, next); touched.add(slug); }
  };
  for (const k of legacyKeys) {
    const v = pick(k);
    const mapped = v ? legacyToStoredPatch(k, v) : undefined;
    if (mapped) importValue(mapped.slug, mapped.patch);
  }
  for (const [k, target] of Object.entries(COPY_ONLY)) {
    const v = pick(k);
    if (v) importValue(target.slug, { [target.field]: v });
  }
  report.imported = [...touched];

  // 2. Everything usable in the registry counts as connected.
  for (const entry of PROVIDER_CATALOG) {
    const stored = d.registry.loadConfig(entry.slug);
    if (typeof stored.connectedAt === "string" && stored.connectedAt) continue;
    // LM Studio's URL was only ever set to chat with it. Ollama's URL is the
    // subtitle translator's, so importing it must not make Ollama a chat
    // fallback nobody asked for.
    const usable = entry.needsKey ? !!stored.apiKey : (entry.slug === "lmstudio" && !!stored.baseUrl);
    if (usable) saveOrThrow(d.registry, entry.slug, { ...stored, connectedAt: now() });
  }

  // 3. Freeze the chain the install was implicitly running on.
  const chainRaw = pick("AGENTS_DEFAULT_MODEL_CHAIN");
  let chainSet = false;
  try { chainSet = Array.isArray(JSON.parse(chainRaw || "[]")) && JSON.parse(chainRaw || "[]").length > 0; } catch { chainSet = false; }
  if (!chainSet) {
    let provider = pick("CHAT_DEFAULT_PROVIDER");
    // The old built-in default was claude_code; only an install with a CLI
    // session was actually using it.
    if (!provider && d.hasClaudeSession()) provider = "claude-code";
    const entry = provider ? getCatalogEntry(provider) : undefined;
    if (entry) {
      report.frozenChain = [{ provider: entry.slug, model: pick("CHAT_DEFAULT_MODEL") }];
      const value = JSON.stringify(report.frozenChain);
      d.env.AGENTS_DEFAULT_MODEL_CHAIN = value;
      if (hasSettings) {
        d.db.prepare(
          `INSERT INTO app_settings (key, value, type, label, description, category, sensitive, readonly, updated_at, updated_by)
           VALUES ('AGENTS_DEFAULT_MODEL_CHAIN', ?, 'json', 'AGENTS_DEFAULT_MODEL_CHAIN', '', 'agents', 0, 0, ?, 'system')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(value, now());
      }
      if (entry.slug === "claude-code") {
        const stored = d.registry.loadConfig("claude-code");
        if (!stored.connectedAt) saveOrThrow(d.registry, "claude-code", { ...stored, connectedAt: now() });
      }
    }
  }

  // 4. Remove the old copies. Backup + rewrite are one unit: if either step
  // fails (unwritable `.env`), neither is reported as done and the file is
  // left exactly as it was — see the header comment for why this is optimistic
  // rather than fatal.
  if (file.size > 0 && legacyKeys.some((k) => file.has(k))) {
    try {
      const backupPath = join(d.backupDir, `.env.bak-${now().replace(/[:.]/g, "-")}`);
      copyFileSync(d.envFilePath, backupPath);
      chmodSync(backupPath, 0o600);
      const removed: string[] = [];
      const kept = readFileSync(d.envFilePath, "utf-8").split("\n").filter((line) => {
        const t = line.trim();
        const eq = t.indexOf("=");
        const key = eq > 0 && !t.startsWith("#") ? t.slice(0, eq).trim() : "";
        if (key && LEGACY_CREDENTIAL_ENV[key]) { removed.push(key); return false; }
        return true;
      });
      writeFileSync(d.envFilePath, kept.join("\n"), { encoding: "utf-8", mode: 0o600 });
      report.backupPath = backupPath;
      report.envLinesRemoved = removed;
    } catch (err) {
      report.envFileError = err instanceof Error ? err.message : String(err);
      log.warn(
        `LLM credential migration: could not rewrite ${d.envFilePath} (${report.envFileError}). ` +
          "The old keys are still in that file; they will be ignored on every future boot.",
      );
    }
  }
  if (hasSettings) {
    for (const k of legacyKeys) {
      if (settings.has(k)) {
        d.db.prepare("DELETE FROM app_settings WHERE key = ?").run(k);
        report.settingsRemoved.push(k);
      }
    }
  }
  for (const k of legacyKeys) delete d.env[k];

  d.db.prepare("INSERT INTO llm_credential_migrations (id, applied_at) VALUES (?, ?)").run(MARKER_ID, now());
  log.info(
    `LLM credentials migrated into the provider registry: imported [${report.imported.join(", ")}]` +
      (report.conflicts.length ? `, kept registry values for [${report.conflicts.join(", ")}]` : "") +
      (report.backupPath ? `, .env backup at ${report.backupPath}` : ""),
  );
  return report;
}
