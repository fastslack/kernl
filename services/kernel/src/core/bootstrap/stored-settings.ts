/**
 * Settings saved from the dashboard live in `app_settings`, but the config
 * object is built from the environment before the database is even open. A
 * value saved there was live until the next restart and then gone, unless the
 * `.env` write also happened to succeed (it doesn't in a container whose
 * working dir is read-only).
 *
 * This runs right after the database opens — before any module or extension
 * initializes and copies config values — so they see what the operator saved.
 * Real environment variables still win: only unset keys are filled in.
 * Provider credentials are skipped; the provider registry owns those.
 */

import type { SqliteDb } from "../db/sqlite.js";
import type { KernelConfig } from "../config.js";
import { legacyCredentialTarget } from "../llm/credentials-legacy.js";

/** Fill unset environment keys from stored settings; returns how many were restored. */
export function rehydrateStoredSettings(sqlite: SqliteDb, config: KernelConfig): number {
  let stored: Array<{ key: string; value: string }>;
  try {
    stored = sqlite
      .prepare("SELECT key, value FROM app_settings WHERE value <> ''")
      .all() as Array<{ key: string; value: string }>;
  } catch {
    return 0; // fresh install: the config module creates the table later
  }
  let restored = 0;
  for (const { key, value } of stored) {
    if (legacyCredentialTarget(key)) continue;
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
      restored++;
    }
  }

  // Config fields read once from the environment, which modules copy at init.
  if (!config.google.clientId) config.google.clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  if (!config.google.clientSecret) config.google.clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";

  return restored;
}
