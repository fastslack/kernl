/**
 * Stage: open SQLite + Neo4j + enforce security gates.
 *
 * Returns the freshly opened DB handles plus the EventBus.
 *
 * Secure-by-default secrets: when KERNEL_AUTH_TOKEN / KERNEL_ENCRYPTION_KEY are
 * empty the kernel does NOT silently fail open. It generates a random secret,
 * persists it next to the SQLite DB (mode 600) so it survives restarts, mutates
 * the (by-reference) config so later stages pick it up, and logs it once. The
 * API only runs unauthenticated when KERNEL_ALLOW_UNAUTH is explicitly enabled.
 */

import { dirname, resolve } from "node:path";
import type { KernelConfig } from "../config.js";
import { log } from "../logger.js";
import { openSqlite } from "../db/sqlite.js";
import { Neo4jClient } from "../db/neo4j.js";
import { EventBus } from "../event-bus.js";
import { systemRegistry } from "../system-registry.js";
import { resolvePersistentSecret } from "./secrets.js";

/** KERNEL_ALLOW_UNAUTH is opt-in: accept "1"/"true" (case-insensitive). */
function unauthAllowed(): boolean {
  const v = (process.env.KERNEL_ALLOW_UNAUTH ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export async function initDatabases(config: KernelConfig): Promise<{
  sqlite: ReturnType<typeof openSqlite>;
  neo4j: Neo4jClient;
  events: EventBus;
}> {
  const sqlite = openSqlite(config.sqlite.path);
  const neo4j = new Neo4jClient();
  await neo4j.connect(config.neo4j);
  if (!config.neo4j.password) {
    log.warn("SECURITY: NEO4J_PASSWORD not set. Set it in .env for production.");
  }

  const events = new EventBus();
  events.setRegistry(systemRegistry);

  // Data dir: persist generated secrets next to the SQLite DB so they survive
  // restarts (and ride along in the same volume). `:memory:` has no dir — fall
  // back to ./data so generation still works in throwaway runs.
  const dataDir = config.sqlite.path === ":memory:"
    ? resolve("data")
    : dirname(resolve(config.sqlite.path));

  // ── API auth token (fail-closed) ──────────────────
  // Empty token no longer means "open". Unless KERNEL_ALLOW_UNAUTH is explicitly
  // set, generate + persist a random token and run authenticated.
  if (!config.auth.token) {
    if (unauthAllowed()) {
      log.warn("SECURITY: KERNEL_ALLOW_UNAUTH enabled — HTTP API runs UNAUTHENTICATED. Only safe when bound to 127.0.0.1; NEVER expose this to a network.");
    } else {
      const secret = resolvePersistentSecret({
        current: "",
        dataDir,
        fileName: ".kernel-auth-token",
        label: "KERNEL_AUTH_TOKEN",
      });
      config.auth.token = secret.value;
      // Publish it back into the environment.
      //
      // `KERNEL_AUTH_TOKEN` is how this process tells its own code — and the
      // child processes it spawns — which token to present when it calls
      // itself over loopback. Extensions read it directly (they have no handle
      // on `config`), and ffmpeg gets it embedded in the URLs they build.
      // Resolving the secret only into `config` left that variable empty on
      // every install that did not pin the token in .env, so those self-calls
      // went out with no Authorization header and came back 401: subtitle
      // generation failed with `ffmpeg exited 1: … 401 Unauthorized` against
      // the kernel's own /stream endpoint. The value is the same secret the
      // process already holds, and it is already passed to ffmpeg on the
      // command line, so this exposes nothing new.
      process.env.KERNEL_AUTH_TOKEN = secret.value;
      if (secret.origin === "generated") {
        log.warn("──────────────────────────────────────────────────────────────");
        log.warn("SECURITY: KERNEL_AUTH_TOKEN was empty — generated a random API token.");
        log.warn(`  Token: ${secret.value}`);
        log.warn(`  Persisted to: ${secret.path} (mode 600)`);
        log.warn("  Authenticate with header:  Authorization: Bearer <token>");
        log.warn("  Pin your own via KERNEL_AUTH_TOKEN in .env, or set KERNEL_ALLOW_UNAUTH=1 for loopback-only unauth.");
        log.warn("──────────────────────────────────────────────────────────────");
      } else {
        log.info(`Auth token loaded from persisted ${secret.path} (KERNEL_AUTH_TOKEN unset).`);
      }
    }
  } else if (config.auth.token.length < 32) {
    log.error(`SECURITY: KERNEL_AUTH_TOKEN is too short (${config.auth.token.length} chars). Use at least 32 chars (openssl rand -hex 32).`);
    process.exit(1);
  }

  // ── Encryption key (secure-by-default) ────────────
  // Empty key no longer means "plaintext at rest". Generate + persist a random
  // 32-byte key so channel/API secrets are encrypted. config.encryption.key is
  // read by reference in the next (registries) stage, so this mutation lands.
  if (!config.encryption.key) {
    const secret = resolvePersistentSecret({
      current: "",
      dataDir,
      fileName: ".kernel-encryption-key",
      label: "KERNEL_ENCRYPTION_KEY",
    });
    config.encryption.key = secret.value;
    if (secret.origin === "generated") {
      log.warn("SECURITY: KERNEL_ENCRYPTION_KEY was empty — generated a random 32-byte key for at-rest encryption.");
      log.warn(`  Persisted to: ${secret.path} (mode 600). BACK THIS UP — losing it makes encrypted secrets unrecoverable.`);
    } else {
      log.info(`Encryption key loaded from persisted ${secret.path} (KERNEL_ENCRYPTION_KEY unset).`);
    }
  }

  return { sqlite, neo4j, events };
}
