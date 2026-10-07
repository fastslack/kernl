/**
 * Core-owned Nostr identity persistence: the INSTANCE key.
 *
 * The instance key and the Social persona key are different keys by design.
 * The instance key signs what this Kernl installation says as an installation
 * (peering descriptors, friend-to-friend auth, the Social presence beacon,
 * cinema subtitle announcements, and cinema directories when Social is not
 * installed — with Social they go out under the persona). The persona key belongs to the paid `social` extension and
 * signs what the person posts on the social network. Sharing one key between
 * them publicly links the persona with the instance, and makes the instance
 * identity change the moment Social is installed — which breaks every
 * friendship already made under the old instance key.
 *
 * Seed resolution order (all paths end in the SAME derivation used by
 * social — `NostrIdentity.fromEd25519Seed(seed)`, i.e.
 * HMAC-SHA256("mtw/nostr-derive/v1", seed)):
 *
 *  1. A persisted `kernel_nostr_seed` row (this store's own). Always wins,
 *     whatever `social_identity` holds. If it exists but cannot be read, the
 *     store throws InstanceKeyUnreadableError instead of replacing it.
 *  2. Legacy continuity: no instance seed yet, but there are friends in
 *     `kernl_friends` and a `social_identity` seed exists. Older builds used
 *     the persona seed as the instance key, so those friendships were made
 *     under it; the seed is copied into `kernel_nostr_seed` so they keep
 *     working. `instanceKeyIsShared()` reports this case so the UI can offer
 *     to rotate the instance key later. This path exists only to avoid
 *     breaking friendships already made — never to make the keys shared.
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

function tableExists(db: SqliteDb, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

/** The raw (possibly encrypted) seed stored by the social extension. */
function socialStoredSeed(db: SqliteDb): string | null {
  try {
    if (!tableExists(db, "social_identity")) return null;
    const row = db
      .prepare("SELECT seed_hex FROM social_identity WHERE id = 'default'")
      .get() as { seed_hex: string } | undefined;
    return row?.seed_hex || null;
  } catch {
    return null;
  }
}

function isNoSuchTable(err: unknown): boolean {
  return /no such table/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * The raw (possibly encrypted) instance seed, or null when there is none yet.
 * Only a missing table means "none yet": any other SQLite error (locked, I/O,
 * corruption) propagates, because reading it as "no seed" would mint a new
 * instance key over the real one.
 */
function instanceStoredSeed(db: SqliteDb): string | null {
  try {
    const row = db
      .prepare("SELECT seed_hex FROM kernel_nostr_seed WHERE id = 'default'")
      .get() as { seed_hex: string } | undefined;
    return row?.seed_hex || null;
  } catch (err) {
    if (isNoSuchTable(err)) return null;
    throw err;
  }
}

function hasFriends(db: SqliteDb): boolean {
  try {
    if (!tableExists(db, "kernl_friends")) return false;
    const row = db.prepare("SELECT COUNT(*) AS n FROM kernl_friends").get() as
      | { n: number }
      | undefined;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Persist `stored` unless another boot got there first, and return the seed
 * that is actually stored (ours or the winner's). INSERT OR IGNORE never
 * replaces an existing row, so two kernels racing on a fresh DB converge on
 * one key instead of the last writer silently swapping it.
 */
function persistInstanceSeed(db: SqliteDb, stored: string): string {
  db.prepare(
    "INSERT OR IGNORE INTO kernel_nostr_seed (id, seed_hex, created_at) VALUES ('default', ?, ?)",
  ).run(stored, new Date().toISOString());
  const actual = instanceStoredSeed(db);
  if (!actual) throw new Error("kernel_nostr_seed row missing right after insert");
  return actual;
}

/** Derive from the row that ended up stored; unreadable means refuse, never re-mint. */
function identityFromStored(stored: string, encryptionKey: string): NostrIdentity {
  const seedHex = unwrapSeed(stored, encryptionKey);
  if (!seedHex) {
    throw new InstanceKeyUnreadableError(
      "instance key exists but cannot be decrypted — check KERNEL_ENCRYPTION_KEY; refusing to replace it",
    );
  }
  return NostrIdentity.fromEd25519Seed(Buffer.from(seedHex, "hex"));
}

/**
 * True when the instance key is the same seed as the Social persona key —
 * i.e. the legacy-continuity path was taken (or an older build left them
 * equal). Comparing the stored values covers the usual case (the legacy copy
 * keeps social's ciphertext verbatim); pass `encryptionKey` to also detect
 * equal seeds stored under different ciphertexts. Never throws.
 */
export function instanceKeyIsShared(db: SqliteDb, encryptionKey?: string): boolean {
  let instance: string | null;
  try {
    instance = instanceStoredSeed(db);
  } catch {
    return false;
  }
  const social = socialStoredSeed(db);
  if (!instance || !social) return false;
  if (instance === social) return true;
  if (!encryptionKey) return false;
  const a = unwrapSeed(instance, encryptionKey);
  const b = unwrapSeed(social, encryptionKey);
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Thrown when a key this store depends on exists but cannot be read (wrong or
 * missing KERNEL_ENCRYPTION_KEY, or a corrupt row). Minting a replacement
 * would silently give the instance a different identity and break every
 * friendship, so the store refuses and leaves the stored row untouched.
 */
export class InstanceKeyUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceKeyUnreadableError";
  }
}

/**
 * Load (or create + persist) the kernel's instance Nostr identity.
 * Deterministic across boots. Returns null when SQLite is unusable so callers
 * can degrade to read-only Nostr providers. Throws InstanceKeyUnreadableError
 * when an existing key cannot be read: the caller must run without peering
 * rather than with a different identity.
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

    // 1. Our own persisted seed. Always wins over the Social persona, and is
    //    never replaced: an unreadable one is an error, not a reason to mint.
    let stored: string | null;
    try {
      stored = instanceStoredSeed(db);
    } catch (err) {
      // A transient read failure is not "no seed": minting now would replace
      // the real key on the next successful write.
      throw new InstanceKeyUnreadableError(
        `instance key could not be read (${err instanceof Error ? err.message : String(err)}); refusing to mint a new one`,
      );
    }
    if (stored) return identityFromStored(stored, encryptionKey);

    if (hasFriends(db)) {
      // 2. Legacy continuity: friendships were made under the persona seed
      //    that older builds used as the instance key. Keep that key.
      const socialStored = socialStoredSeed(db);
      if (socialStored) {
        const socialHex = unwrapSeed(socialStored, encryptionKey);
        if (!socialHex) {
          throw new InstanceKeyUnreadableError(
            "friends exist but the Social seed they were made with cannot be decrypted — check KERNEL_ENCRYPTION_KEY; refusing to mint a new instance key",
          );
        }
        // Keep social's ciphertext verbatim when it is already encrypted (so
        // instanceKeyIsShared can tell without the key); wrap a plaintext one.
        const toStore = PLAINTEXT_SEED_RE.test(socialStored)
          ? wrapSeed(socialHex, encryptionKey)
          : socialStored;
        const actual = persistInstanceSeed(db, toStore);
        if (actual !== toStore) return identityFromStored(actual, encryptionKey);
        log.warn(
          "nostr: instance key adopted from the Social persona to keep existing friendships — the two identities stay linked until the instance key is rotated.",
        );
        return NostrIdentity.fromEd25519Seed(Buffer.from(socialHex, "hex"));
      }
    }

    // 3. First run: generate + persist.
    const seed = randomBytes(32);
    const seedHex = seed.toString("hex");
    const toStore = wrapSeed(seedHex, encryptionKey);
    const actual = persistInstanceSeed(db, toStore);
    // Another boot won the race: use its key, not ours.
    if (actual !== toStore) return identityFromStored(actual, encryptionKey);
    if (!encryptionKey) {
      log.warn("SECURITY: kernel Nostr seed stored in plaintext — set KERNEL_ENCRYPTION_KEY.");
    }
    return NostrIdentity.fromEd25519Seed(new Uint8Array(seed));
  } catch (err) {
    if (err instanceof InstanceKeyUnreadableError) throw err;
    log.warn("nostr: failed to load/create core Nostr identity", err);
    return null;
  }
}
