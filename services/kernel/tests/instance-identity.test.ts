/**
 * Instance Nostr identity vs. the Social persona.
 *
 * The instance key (kernel_nostr_seed) and the Social persona key
 * (social_identity) are separate by design. Installing Social must never
 * swap the instance identity; the only time the instance adopts the persona
 * seed is the legacy-continuity case (no instance seed yet, friendships
 * already made under the persona key).
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { encrypt, generateKey } from "../src/core/crypto.js";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import {
  InstanceKeyUnreadableError,
  instanceKeyIsShared,
  loadOrCreateCoreNostrIdentity,
} from "../src/core/nostr/identity-store.js";

const PLAINTEXT_SEED_RE = /^[0-9a-f]{64}$/i;

function seedHex(): string {
  return randomBytes(32).toString("hex");
}

function npubOfSeed(hex: string): string {
  return NostrIdentity.fromEd25519Seed(Buffer.from(hex, "hex")).npub();
}

function wrap(hex: string, key: string): string {
  return key ? encrypt(hex, key) : hex;
}

function addSocialIdentity(db: Database, hex: string, key: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS social_identity (" +
      "id TEXT PRIMARY KEY, pubkey TEXT, seed_hex TEXT NOT NULL, display_name TEXT, created_at TEXT)",
  );
  const pubkey = NostrIdentity.fromEd25519Seed(Buffer.from(hex, "hex")).npub();
  db.prepare(
    "INSERT OR REPLACE INTO social_identity (id, pubkey, seed_hex, display_name, created_at) VALUES ('default', ?, ?, 'persona', ?)",
  ).run(pubkey, wrap(hex, key), new Date().toISOString());
}

function addKernelSeed(db: Database, hex: string, key: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS kernel_nostr_seed (" +
      "id TEXT PRIMARY KEY CHECK (id = 'default'), seed_hex TEXT NOT NULL, created_at TEXT NOT NULL)",
  );
  db.prepare(
    "INSERT OR REPLACE INTO kernel_nostr_seed (id, seed_hex, created_at) VALUES ('default', ?, ?)",
  ).run(wrap(hex, key), new Date().toISOString());
}

function addFriend(db: Database, npub: string): void {
  db.exec("CREATE TABLE IF NOT EXISTS kernl_friends (npub TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO kernl_friends (npub) VALUES (?)").run(npub);
}

for (const key of ["", generateKey()]) {
  const label = key ? "encrypted" : "plaintext";

  describe(`instance Nostr identity (${label})`, () => {
    it("a) an existing kernel_nostr_seed wins over social_identity", () => {
      const db = new Database(":memory:");
      const a = seedHex();
      const b = seedHex();
      addKernelSeed(db, a, key);
      addSocialIdentity(db, b, key);

      const id = loadOrCreateCoreNostrIdentity(db, key);
      expect(id?.npub()).toBe(npubOfSeed(a));
      expect(instanceKeyIsShared(db, key)).toBe(false);
    });

    it("b) installing Social after the instance seed exists does not swap the identity", () => {
      const db = new Database(":memory:");
      const first = loadOrCreateCoreNostrIdentity(db, key);
      expect(first).not.toBeNull();

      const b = seedHex();
      addSocialIdentity(db, b, key);
      const again = loadOrCreateCoreNostrIdentity(db, key);
      expect(again?.npub()).toBe(first!.npub());
      expect(again?.npub()).not.toBe(npubOfSeed(b));
      expect(instanceKeyIsShared(db, key)).toBe(false);
    });

    it("c) legacy continuity: no instance seed, social seed and friends → adopt the social seed", () => {
      const db = new Database(":memory:");
      const b = seedHex();
      addSocialIdentity(db, b, key);
      addFriend(db, "npub1friend");

      const id = loadOrCreateCoreNostrIdentity(db, key);
      expect(id?.npub()).toBe(npubOfSeed(b));
      expect(instanceKeyIsShared(db)).toBe(true);

      // Persisted: the next load returns the same identity from kernel_nostr_seed.
      const row = db
        .prepare("SELECT seed_hex FROM kernel_nostr_seed WHERE id = 'default'")
        .get() as { seed_hex: string } | undefined;
      expect(row?.seed_hex).toBeTruthy();
      expect(loadOrCreateCoreNostrIdentity(db, key)?.npub()).toBe(npubOfSeed(b));
    });

    it("d) no instance seed, social seed but no friends → fresh seed, not shared", () => {
      const db = new Database(":memory:");
      const b = seedHex();
      addSocialIdentity(db, b, key);

      const id = loadOrCreateCoreNostrIdentity(db, key);
      expect(id).not.toBeNull();
      expect(id!.npub()).not.toBe(npubOfSeed(b));
      expect(instanceKeyIsShared(db)).toBe(false);
      expect(instanceKeyIsShared(db, key)).toBe(false);
    });

    it("d') an empty kernl_friends table counts as no friends", () => {
      const db = new Database(":memory:");
      const b = seedHex();
      addSocialIdentity(db, b, key);
      db.exec("CREATE TABLE kernl_friends (npub TEXT PRIMARY KEY)");

      const id = loadOrCreateCoreNostrIdentity(db, key);
      expect(id!.npub()).not.toBe(npubOfSeed(b));
      expect(instanceKeyIsShared(db)).toBe(false);
    });
  });
}

describe("instance Nostr identity at rest", () => {
  it("e) with an encryption key the stored seed is not plaintext hex", () => {
    const key = generateKey();
    const db = new Database(":memory:");
    loadOrCreateCoreNostrIdentity(db, key);
    const row = db
      .prepare("SELECT seed_hex FROM kernel_nostr_seed WHERE id = 'default'")
      .get() as { seed_hex: string };
    expect(PLAINTEXT_SEED_RE.test(row.seed_hex)).toBe(false);
  });

  it("e') legacy copy of a plaintext social seed is wrapped when a key is set", () => {
    const key = generateKey();
    const db = new Database(":memory:");
    const b = seedHex();
    addSocialIdentity(db, b, ""); // social stored it in plaintext
    addFriend(db, "npub1friend");

    const id = loadOrCreateCoreNostrIdentity(db, key);
    expect(id?.npub()).toBe(npubOfSeed(b));
    const row = db
      .prepare("SELECT seed_hex FROM kernel_nostr_seed WHERE id = 'default'")
      .get() as { seed_hex: string };
    expect(PLAINTEXT_SEED_RE.test(row.seed_hex)).toBe(false);
    // Different ciphertexts: detectable only with the key.
    expect(instanceKeyIsShared(db, key)).toBe(true);
  });

  it("f) an instance seed sealed with key A, loaded with key B → throws, row unchanged", () => {
    const keyA = generateKey();
    const keyB = generateKey();
    const db = new Database(":memory:");
    addKernelSeed(db, seedHex(), keyA);
    const before = db.prepare("SELECT seed_hex, created_at FROM kernel_nostr_seed").all();

    expect(() => loadOrCreateCoreNostrIdentity(db, keyB)).toThrow(InstanceKeyUnreadableError);
    expect(() => loadOrCreateCoreNostrIdentity(db, "")).toThrow(/refusing to replace/);
    expect(db.prepare("SELECT seed_hex, created_at FROM kernel_nostr_seed").all()).toEqual(before);
  });

  it("f') a corrupt instance seed row → throws, row unchanged", () => {
    const db = new Database(":memory:");
    addKernelSeed(db, "not-a-seed", "");
    expect(() => loadOrCreateCoreNostrIdentity(db, generateKey())).toThrow(InstanceKeyUnreadableError);
    const row = db.prepare("SELECT seed_hex FROM kernel_nostr_seed").get() as { seed_hex: string };
    expect(row.seed_hex).toBe("not-a-seed");
  });

  it("g) friends exist but the social seed is unreadable → throws, no key minted", () => {
    const db = new Database(":memory:");
    addSocialIdentity(db, seedHex(), generateKey()); // sealed with a key we don't have
    addFriend(db, "npub1friend");

    expect(() => loadOrCreateCoreNostrIdentity(db, generateKey())).toThrow(InstanceKeyUnreadableError);
    const row = db
      .prepare("SELECT seed_hex FROM kernel_nostr_seed WHERE id = 'default'")
      .get();
    expect(row).toBeNull();
  });

  it("instanceKeyIsShared is false on a DB without either table", () => {
    const db = new Database(":memory:");
    expect(instanceKeyIsShared(db)).toBe(false);
  });
});

describe("instance seed persistence races and read errors (F4)", () => {
  /**
   * Wraps a db so that statements matching `match` run `hook` once, right
   * before they are prepared. Lets a test inject a read error or a competing
   * writer at an exact point of the load sequence.
   */
  function withHook(db: Database, match: RegExp, hook: () => void): Database {
    let fired = false;
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (!fired && match.test(sql)) {
              fired = true;
              hook();
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Database;
  }

  it("a read error other than 'no such table' throws and mints nothing", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE kernel_nostr_seed (id TEXT PRIMARY KEY CHECK (id = 'default'), seed_hex TEXT NOT NULL, created_at TEXT NOT NULL)",
    );
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/SELECT seed_hex FROM kernel_nostr_seed/.test(sql)) throw new Error("database is locked");
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Database;

    expect(() => loadOrCreateCoreNostrIdentity(failing, "")).toThrow(InstanceKeyUnreadableError);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM kernel_nostr_seed").get() as { n: number };
    expect(rows.n).toBe(0);
    // instanceKeyIsShared keeps its never-throws contract.
    expect(instanceKeyIsShared(failing, "")).toBe(false);
  });

  it("a missing table is still 'no seed yet' (fresh mint)", () => {
    const db = new Database(":memory:");
    expect(loadOrCreateCoreNostrIdentity(db, "")).not.toBeNull();
    const rows = db.prepare("SELECT COUNT(*) AS n FROM kernel_nostr_seed").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  for (const key of ["", generateKey()]) {
    it(`concurrent first mint converges on the stored key (${key ? "encrypted" : "plaintext"})`, () => {
      const db = new Database(":memory:");
      const winner = seedHex();
      // Another boot wins the race: its row lands between our read and our insert.
      const racing = withHook(db, /INSERT .*INTO kernel_nostr_seed/, () => addKernelSeed(db, winner, key));
      const id = loadOrCreateCoreNostrIdentity(racing, key);
      expect(id?.npub()).toBe(npubOfSeed(winner));
      // And the stored row is the winner's, untouched.
      expect(loadOrCreateCoreNostrIdentity(db, key)?.npub()).toBe(npubOfSeed(winner));
    });
  }

  it("legacy adoption racing a fresh mint also converges on the stored row", () => {
    const db = new Database(":memory:");
    const persona = seedHex();
    const winner = seedHex();
    addSocialIdentity(db, persona, "");
    addFriend(db, "npub1friend");
    const racing = withHook(db, /INSERT .*INTO kernel_nostr_seed/, () => addKernelSeed(db, winner, ""));
    expect(loadOrCreateCoreNostrIdentity(racing, "")?.npub()).toBe(npubOfSeed(winner));
  });
});
