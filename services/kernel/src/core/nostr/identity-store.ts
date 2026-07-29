/**
 * Core-owned Nostr identity persistence.
 *
 * The paid `social` extension owns the canonical social seed; when it is
 * installed the bootstrap derives cinema's publishing identity from it
 * (`socialModule.deriveNostrIdentity()`) so social posts and subtitle
 * announcements share one npub. Without social, the kernel still needs a
 * stable Nostr identity for cinema's subs/directories publishing — this
 * store provides it.
 *
 * Seed resolution order (all paths end in the SAME derivation used by
 * social — `NostrIdentity.fromEd25519Seed(seed)`, i.e.
 * HMAC-SHA256("mtw/nostr-derive/v1", seed)):
 *
 *  1. A leftover `social_identity` row from a previously-installed social
 *     extension. Reusing its seed keeps the npub the kernel was already
 *     broadcasting under, so uninstalling social doesn't orphan published
 *     subtitle announcements.
 *  2. A previously persisted `kernel_nostr_seed` row (this store's own).
 *  3. A freshly generated 32-byte seed, persisted for future boots.
 *
 * The seed is stored encrypted-at-rest when KERNEL_ENCRYPTION_KEY is set,
 * mirroring the social extension's wrap/unwrap behavior (plaintext seed =
 * exactly 64 hex chars; anything else is treated as ciphertext).
 */

import { randomBytes } from "node:crypto";
import type { SqliteDb } from "../db/sqlite.js";
import { decrypt, encrypt, isEncrypted } from "../crypto.js";
import { log } from "../logger.js";
import { NostrIdentity } from "./nostr-identity.js";

const PLAINTEXT_SEED_RE = /^[0-9a-f]{64}$/i;

function unwrapSeed(stored: string, encryptionKey: string): string | null {
  if (PLAINTEXT_SEED_RE.test(stored)) return stored;
  if (!isEncrypted(stored)) return null;
  if (!encryptionKey) {
    log.warn(
      "nostr: stored seed looks encrypted but KERNEL_ENCRYPTION_KEY is not set — cannot unwrap.",
    );
    return null;
  }
  try {
    const seedHex = decrypt(stored, encryptionKey);
    return PLAINTEXT_SEED_RE.test(seedHex) ? seedHex : null;
  } catch {
    return null;
  }
}

function wrapSeed(seedHex: string, encryptionKey: string): string {
  return encryptionKey ? encrypt(seedHex, encryptionKey) : seedHex;
}

/** Read the seed left behind by a (possibly uninstalled) social extension. */
function socialSeedHex(db: SqliteDb, encryptionKey: string): string | null {
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'social_identity'")
      .get() as { name: string } | undefined;
    if (!table) return null;
    const row = db
      .prepare("SELECT seed_hex FROM social_identity WHERE id = 'default'")
      .get() as { seed_hex: string } | undefined;
    if (!row?.seed_hex) return null;
    return unwrapSeed(row.seed_hex, encryptionKey);
  } catch {
    return null;
  }
}

/**
 * Load (or create + persist) the kernel's core-owned Nostr identity.
 * Deterministic across boots. Never throws — returns null when SQLite is
 * unusable so callers can degrade to read-only Nostr providers.
 */
export function loadOrCreateCoreNostrIdentity(
  db: SqliteDb,
  encryptionKey: string,
): NostrIdentity | null {
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS kernel_nostr_seed (\n" +
        "  id TEXT PRIMARY KEY CHECK (id = 'default'),\n" +
        "  seed_hex TEXT NOT NULL,\n" +
        "  created_at TEXT NOT NULL\n" +
        ")",
    );

    // 1. Continuity with a previous social install: same seed → same npub.
    const fromSocial = socialSeedHex(db, encryptionKey);
    if (fromSocial) {
      return NostrIdentity.fromEd25519Seed(Buffer.from(fromSocial, "hex"));
    }

    // 2. Our own previously persisted seed.
    const row = db
      .prepare("SELECT seed_hex FROM kernel_nostr_seed WHERE id = 'default'")
      .get() as { seed_hex: string } | undefined;
    if (row?.seed_hex) {
      const seedHex = unwrapSeed(row.seed_hex, encryptionKey);
      if (seedHex) return NostrIdentity.fromEd25519Seed(Buffer.from(seedHex, "hex"));
      log.warn("nostr: persisted kernel seed is unreadable — generating a fresh identity.");
    }

    // 3. First run: generate + persist.
    const seed = randomBytes(32);
    const seedHex = seed.toString("hex");
    db.prepare(
      "INSERT OR REPLACE INTO kernel_nostr_seed (id, seed_hex, created_at) VALUES ('default', ?, ?)",
    ).run(wrapSeed(seedHex, encryptionKey), new Date().toISOString());
    if (!encryptionKey) {
      log.warn("SECURITY: kernel Nostr seed stored in plaintext — set KERNEL_ENCRYPTION_KEY.");
    }
    return NostrIdentity.fromEd25519Seed(new Uint8Array(seed));
  } catch (err) {
    log.warn("nostr: failed to load/create core Nostr identity", err);
    return null;
  }
}
