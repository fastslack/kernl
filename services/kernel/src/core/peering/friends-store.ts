/**
 * Friends — the instances this kernel shares with.
 *
 * The model is deliberately `authorized_keys`, not a social network: adding is
 * explicit on both sides, there is no request-over-the-wire a stranger could
 * send, and nothing is trusted until the user says so.
 */
import type { SqliteDb } from "../db/sqlite.js";
import { isoNow } from "../helpers.js";
import { hexOf, npubOf } from "./descriptor.js";

export type Trust = "pending" | "trusted" | "revoked";

export interface Friend {
  npub: string;
  pubkey_hex: string;
  petname: string;
  trust: Trust;
  added_by: "local" | "remote";
  note: string;
  last_seen_at: string | null;
  last_reach: string;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface CachedPresence {
  npub: string;
  descriptor: string;
  fetched_at: string;
  source: "wellknown" | "nostr" | "manual";
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS kernl_friends (
  npub          TEXT PRIMARY KEY,
  pubkey_hex    TEXT NOT NULL,
  petname       TEXT NOT NULL DEFAULT '',
  trust         TEXT NOT NULL DEFAULT 'pending'
                CHECK (trust IN ('pending','trusted','revoked')),
  added_by      TEXT NOT NULL DEFAULT 'local'
                CHECK (added_by IN ('local','remote')),
  note          TEXT NOT NULL DEFAULT '',
  last_seen_at  TEXT,
  last_reach    TEXT NOT NULL DEFAULT '',
  last_error    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kernl_friends_trust ON kernl_friends(trust);

CREATE TABLE IF NOT EXISTS kernl_presence (
  npub          TEXT PRIMARY KEY,
  descriptor    TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  source        TEXT NOT NULL
);
`;

export class FriendsStore {
  constructor(private db: SqliteDb) {
    this.db.exec(MIGRATION);
  }

  // ── Friends ─────────────────────────────────────────────────

  list(): Friend[] {
    return this.db
      .prepare(`SELECT * FROM kernl_friends ORDER BY petname, npub`)
      .all() as Friend[];
  }

  /** Friends we actually share with. */
  trusted(): Friend[] {
    return this.db
      .prepare(`SELECT * FROM kernl_friends WHERE trust = 'trusted' ORDER BY petname, npub`)
      .all() as Friend[];
  }

  get(npub: string): Friend | undefined {
    return (
      (this.db.prepare(`SELECT * FROM kernl_friends WHERE npub = ?`).get(npub) as Friend | null) ??
      undefined
    );
  }

  /** Look up by the signing key, which is what arrives on the wire. */
  getByPubkey(pubkeyHex: string): Friend | undefined {
    return (
      (this.db
        .prepare(`SELECT * FROM kernl_friends WHERE pubkey_hex = ?`)
        .get(pubkeyHex.toLowerCase()) as Friend | null) ?? undefined
    );
  }

  /** True only for a friend explicitly marked trusted. The gate for everything. */
  isTrusted(pubkeyHex: string): boolean {
    return this.getByPubkey(pubkeyHex)?.trust === "trusted";
  }

  /**
   * Add a friend. Returns undefined when the npub is malformed. A revoked
   * friend is never silently resurrected — the user has to un-revoke it.
   */
  add(opts: {
    npub: string;
    petname?: string;
    note?: string;
    trust?: Trust;
    added_by?: "local" | "remote";
  }): Friend | undefined {
    const pubkeyHex = hexOf(opts.npub);
    if (!pubkeyHex) return undefined;
    const npub = npubOf(pubkeyHex); // normalise whatever casing came in
    const existing = this.get(npub);
    if (existing) return existing;

    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO kernl_friends
           (npub, pubkey_hex, petname, trust, added_by, note, last_reach, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?)`,
      )
      .run(
        npub,
        pubkeyHex,
        opts.petname ?? "",
        opts.trust ?? "pending",
        opts.added_by ?? "local",
        opts.note ?? "",
        now,
        now,
      );
    return this.get(npub);
  }

  update(npub: string, patch: { petname?: string; note?: string; trust?: Trust }): Friend | undefined {
    const existing = this.get(npub);
    if (!existing) return undefined;
    this.db
      .prepare(`UPDATE kernl_friends SET petname=?, note=?, trust=?, updated_at=? WHERE npub=?`)
      .run(
        patch.petname ?? existing.petname,
        patch.note ?? existing.note,
        patch.trust ?? existing.trust,
        isoNow(),
        npub,
      );
    return this.get(npub);
  }

  remove(npub: string): void {
    this.db.prepare(`DELETE FROM kernl_friends WHERE npub = ?`).run(npub);
    this.db.prepare(`DELETE FROM kernl_presence WHERE npub = ?`).run(npub);
  }

  /** Record a successful contact and the transport that worked. */
  markSeen(npub: string, reachUrl: string): void {
    this.db
      .prepare(`UPDATE kernl_friends SET last_seen_at=?, last_reach=?, last_error='', updated_at=? WHERE npub=?`)
      .run(isoNow(), reachUrl, isoNow(), npub);
  }

  /** Record why we could not reach them. Never throws into the caller's path. */
  markError(npub: string, message: string): void {
    this.db
      .prepare(`UPDATE kernl_friends SET last_error=?, updated_at=? WHERE npub=?`)
      .run(message.slice(0, 300), isoNow(), npub);
  }

  // ── Presence cache ──────────────────────────────────────────

  cachePresence(npub: string, descriptorJson: string, source: CachedPresence["source"]): void {
    this.db
      .prepare(
        `INSERT INTO kernl_presence (npub, descriptor, fetched_at, source)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(npub) DO UPDATE SET descriptor=excluded.descriptor,
                                         fetched_at=excluded.fetched_at,
                                         source=excluded.source`,
      )
      .run(npub, descriptorJson, isoNow(), source);
  }

  presence(npub: string): CachedPresence | undefined {
    return (
      (this.db.prepare(`SELECT * FROM kernl_presence WHERE npub = ?`).get(npub) as
        | CachedPresence
        | null) ?? undefined
    );
  }
}
