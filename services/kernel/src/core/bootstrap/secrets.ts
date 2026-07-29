/**
 * Secure-by-default secret resolution.
 *
 * Resolves a 32-byte hex secret (auth token / encryption key) with a strict
 * priority order so the kernel never silently runs with an insecure default:
 *
 *   1. explicit value (from env / config) — used verbatim
 *   2. a previously generated value persisted next to the SQLite DB
 *   3. a freshly generated `randomBytes(32)` value, persisted with mode 600
 *
 * Persisting (instead of regenerating each boot) keeps the value stable across
 * restarts — essential for the encryption key (otherwise stored secrets become
 * unrecoverable) and convenient for the auth token (operators can reuse it).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { log } from "../logger.js";

export type SecretOrigin = "explicit" | "persisted" | "generated";

export interface ResolvedSecret {
  value: string;
  origin: SecretOrigin;
  /** Absolute path the secret was read from / written to (null when explicit). */
  path: string | null;
}

/**
 * Resolve a persistent hex secret. Generates + persists one (mode 600) when no
 * explicit value is provided and none has been persisted yet.
 */
export function resolvePersistentSecret(opts: {
  /** Current value from env/config — wins when non-empty. */
  current: string;
  /** Directory the secret file lives in (typically the data dir). */
  dataDir: string;
  /** Dotfile name, e.g. `.kernel-auth-token`. */
  fileName: string;
  /** Human label for logs, e.g. `KERNEL_AUTH_TOKEN`. */
  label: string;
}): ResolvedSecret {
  const current = opts.current.trim();
  if (current) return { value: current, origin: "explicit", path: null };

  const filePath = resolve(opts.dataDir, opts.fileName);

  // Reuse a previously generated value so it survives restarts.
  if (existsSync(filePath)) {
    try {
      const persisted = readFileSync(filePath, "utf8").trim();
      if (persisted) {
        try { chmodSync(filePath, 0o600); } catch { /* best-effort hardening */ }
        return { value: persisted, origin: "persisted", path: filePath };
      }
    } catch (err) {
      log.warn(`Could not read persisted ${opts.label} at ${filePath}: ${String(err)} — generating a new one.`);
    }
  }

  // Generate + persist a fresh secret.
  const generated = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, generated, { mode: 0o600 });
    try { chmodSync(filePath, 0o600); } catch { /* best-effort hardening */ }
  } catch (err) {
    log.error(`Could not persist generated ${opts.label} to ${filePath}: ${String(err)} — it will NOT survive a restart.`);
  }
  return { value: generated, origin: "generated", path: filePath };
}
