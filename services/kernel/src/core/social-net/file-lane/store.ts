import type { SqliteDb } from "../../db/sqlite.js";
import { newId, isoNow } from "../../helpers.js";
import { chunkCount, emptyBitmap, setBit, hasBit, chunkRange } from "./chunks.js";

export type TransferState =
  | "staging" | "pending" | "accepted" | "sending"
  | "done" | "rejected" | "cancelled" | "failed" | "expired";
export type Direction = "in" | "out";

export const FINAL_STATES: TransferState[] = ["done", "rejected", "cancelled", "failed", "expired"];

export interface Transfer {
  id: string;
  direction: Direction;
  peer_npub: string;
  remote_id: string;
  text: string;
  state: TransferState;
  error: string;
  total_bytes: number;
  done_bytes: number;
  attempts: number;
  polls: number;
  next_attempt_at: string | null;
  unreachable_since: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface TransferFile {
  transfer_id: string;
  n: number;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  path: string;
  have: Uint8Array;
  bad_hashes: number;
}

export interface NewFile { name: string; size: number; mime?: string; sha256?: string; path?: string }

const MIGRATION = `
CREATE TABLE IF NOT EXISTS transfers (
  id                TEXT PRIMARY KEY,
  direction         TEXT NOT NULL CHECK (direction IN ('in','out')),
  peer_npub         TEXT NOT NULL,
  remote_id         TEXT NOT NULL,
  text              TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL,
  error             TEXT NOT NULL DEFAULT '',
  total_bytes       INTEGER NOT NULL DEFAULT 0,
  done_bytes        INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  polls             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT,
  unreachable_since TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  finished_at       TEXT,
  UNIQUE (direction, peer_npub, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_transfers_state ON transfers(state);
CREATE TABLE IF NOT EXISTS transfer_files (
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  n           INTEGER NOT NULL,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mime        TEXT NOT NULL DEFAULT '',
  sha256      TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL DEFAULT '',
  have        BLOB NOT NULL,
  bad_hashes  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (transfer_id, n)
);
`;

type FileRow = Omit<TransferFile, "have"> & { have: Uint8Array | Buffer };

export class TransferStore {
  constructor(private db: SqliteDb) {
    this.db.exec(MIGRATION);
  }

  create(opts: { direction: Direction; peerNpub: string; remoteId?: string; text?: string; state: TransferState; files: NewFile[] }): Transfer {
    const id = newId();
    const now = isoNow();
    const total = opts.files.reduce((a, f) => a + f.size, 0);
    this.db.prepare(
      `INSERT INTO transfers (id, direction, peer_npub, remote_id, text, state, total_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, opts.direction, opts.peerNpub, opts.remoteId ?? id, opts.text ?? "", opts.state, total, now, now);
    const ins = this.db.prepare(
      `INSERT INTO transfer_files (transfer_id, n, name, size, mime, sha256, path, have) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    opts.files.forEach((f, n) =>
      ins.run(id, n, f.name, f.size, f.mime ?? "", f.sha256 ?? "", f.path ?? "", emptyBitmap(chunkCount(f.size))),
    );
    return this.get(id)!;
  }

  get(id: string): Transfer | undefined {
    return (this.db.prepare(`SELECT * FROM transfers WHERE id = ?`).get(id) as Transfer | null) ?? undefined;
  }

  getByRemote(direction: Direction, peerNpub: string, remoteId: string): Transfer | undefined {
    return (this.db
      .prepare(`SELECT * FROM transfers WHERE direction = ? AND peer_npub = ? AND remote_id = ?`)
      .get(direction, peerNpub, remoteId) as Transfer | null) ?? undefined;
  }

  list(limit = 200): Transfer[] {
    return this.db.prepare(`SELECT * FROM transfers ORDER BY created_at DESC LIMIT ?`).all(limit) as Transfer[];
  }

  files(id: string): TransferFile[] {
    return (this.db.prepare(`SELECT * FROM transfer_files WHERE transfer_id = ? ORDER BY n`).all(id) as FileRow[])
      .map((r) => ({ ...r, have: new Uint8Array(r.have) }));
  }

  file(id: string, n: number): TransferFile | undefined {
    const r = this.db.prepare(`SELECT * FROM transfer_files WHERE transfer_id = ? AND n = ?`).get(id, n) as FileRow | null;
    return r ? { ...r, have: new Uint8Array(r.have) } : undefined;
  }

  setState(id: string, state: TransferState, error = ""): void {
    const now = isoNow();
    const finished = FINAL_STATES.includes(state) ? now : null;
    this.db.prepare(
      `UPDATE transfers SET state = ?, error = ?, updated_at = ?, finished_at = COALESCE(?, finished_at),
         next_attempt_at = CASE WHEN ? IS NULL THEN next_attempt_at ELSE NULL END
       WHERE id = ?`,
    ).run(state, error.slice(0, 300), now, finished, finished, id);
  }

  /** Record part k of file n; returns the new bitmap. Idempotent. */
  markChunk(id: string, n: number, k: number, bytes: number): Uint8Array {
    const f = this.file(id, n);
    if (!f) throw new Error("no such file");
    if (hasBit(f.have, k)) return f.have;
    setBit(f.have, k);
    this.db.prepare(`UPDATE transfer_files SET have = ? WHERE transfer_id = ? AND n = ?`).run(f.have, id, n);
    this.db.prepare(`UPDATE transfers SET done_bytes = done_bytes + ?, updated_at = ? WHERE id = ?`).run(bytes, isoNow(), id);
    return f.have;
  }

  /** Forget every part of file n (its full hash did not match). */
  resetFile(id: string, n: number): void {
    const f = this.file(id, n);
    if (!f) return;
    let had = 0;
    for (let k = 0; k < chunkCount(f.size); k++) if (hasBit(f.have, k)) { const r = chunkRange(f.size, k); had += r.end - r.start; }
    this.db.prepare(`UPDATE transfer_files SET have = ? WHERE transfer_id = ? AND n = ?`).run(emptyBitmap(chunkCount(f.size)), id, n);
    this.db.prepare(`UPDATE transfers SET done_bytes = MAX(0, done_bytes - ?), updated_at = ? WHERE id = ?`).run(had, isoNow(), id);
  }

  setFile(id: string, n: number, patch: { path?: string; sha256?: string }): void {
    const f = this.file(id, n);
    if (!f) return;
    this.db.prepare(`UPDATE transfer_files SET path = ?, sha256 = ? WHERE transfer_id = ? AND n = ?`)
      .run(patch.path ?? f.path, patch.sha256 ?? f.sha256, id, n);
  }

  bumpBadHash(id: string, n: number): number {
    this.db.prepare(`UPDATE transfer_files SET bad_hashes = bad_hashes + 1 WHERE transfer_id = ? AND n = ?`).run(id, n);
    return this.file(id, n)?.bad_hashes ?? 0;
  }

  schedule(id: string, patch: { attempts?: number; polls?: number; nextAt?: number | null; unreachableSince?: string | null }): void {
    const t = this.get(id);
    if (!t) return;
    const next = patch.nextAt === undefined ? t.next_attempt_at : patch.nextAt === null ? null : new Date(patch.nextAt).toISOString();
    this.db.prepare(
      `UPDATE transfers SET attempts = ?, polls = ?, next_attempt_at = ?, unreachable_since = ?, updated_at = ? WHERE id = ?`,
    ).run(
      patch.attempts ?? t.attempts, patch.polls ?? t.polls, next,
      patch.unreachableSince === undefined ? t.unreachable_since : patch.unreachableSince, isoNow(), id,
    );
  }

  /** Outgoing transfers the worker should act on now. */
  due(now: number): Transfer[] {
    return this.db.prepare(
      `SELECT * FROM transfers WHERE direction = 'out' AND state IN ('pending','accepted','sending')
         AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at`,
    ).all(new Date(now).toISOString()) as Transfer[];
  }

  pendingIncomingCount(peerNpub: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM transfers WHERE direction = 'in' AND peer_npub = ? AND state = 'pending'`)
      .get(peerNpub) as { c: number }).c;
  }

  /** Offers nobody answered within the TTL (both directions). */
  staleOffers(now: number, ttlMs: number): Transfer[] {
    return this.db.prepare(`SELECT * FROM transfers WHERE state = 'pending' AND created_at <= ?`)
      .all(new Date(now - ttlMs).toISOString()) as Transfer[];
  }

  /** Not-yet-final transfers with a friend, both directions. */
  activeWith(peerNpub: string): Transfer[] {
    return this.db.prepare(
      `SELECT * FROM transfers WHERE peer_npub = ? AND state IN ('staging','pending','accepted','sending')`,
    ).all(peerNpub) as Transfer[];
  }

  finishedBefore(cutoffIso: string): Transfer[] {
    return this.db.prepare(
      `SELECT * FROM transfers WHERE state IN ('failed','expired','cancelled','rejected') AND finished_at <= ?`,
    ).all(cutoffIso) as Transfer[];
  }
}
