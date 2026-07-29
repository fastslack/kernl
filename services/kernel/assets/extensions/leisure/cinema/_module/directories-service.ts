/**
 * CinemaDirectoriesService — local store of community movie directories.
 *
 * Owns three responsibilities:
 *   1. CRUD for directories created on this kernel (origin='local').
 *   2. Mirror of directories pulled from Nostr (origin='federated').
 *   3. Subscription bookkeeping (which federated dirs we follow).
 *
 * Co-sign validation lives here too. When a Nostr event arrives:
 *   - if no local mirror → only owner_pubkey can be the signer (NEW dir).
 *   - if local mirror exists → signer ∈ {owner_pubkey, ...prevCollaborators}
 *   - last-write-wins by event.created_at (≥, not >, to handle clock drift).
 *
 * Items are stored as JSON ([{identifier, note?, added_at}]) — identifiers
 * only, hydration to full title metadata happens at read time via the
 * caller (CinemaService.getByIdentifier) so federated dirs work even
 * when the local catalog hasn't ingested some items yet.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export type DirectoryVisibility = "public" | "unlisted" | "private";
export type DirectoryOrigin = "local" | "federated";

export interface DirectoryItem {
  identifier: string;
  note?: string;
  added_at: string;
}

export interface CinemaDirectory {
  id: string;
  owner_pubkey: string;
  title: string;
  description: string;
  category: string;
  cover_identifier: string;
  visibility: DirectoryVisibility;
  items: DirectoryItem[];
  collaborators: string[];      // pubkeys
  origin: DirectoryOrigin;
  nostr_event_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface CreateDirectoryInput {
  owner_pubkey: string;
  title: string;
  description?: string;
  category?: string;
  cover_identifier?: string;
  visibility?: DirectoryVisibility;
  collaborators?: string[];
  initial_items?: DirectoryItem[];
}

export interface UpdateDirectoryInput {
  title?: string;
  description?: string;
  category?: string;
  cover_identifier?: string;
  visibility?: DirectoryVisibility;
  collaborators?: string[];
}

export interface DirectoryListFilter {
  origin?: DirectoryOrigin;
  category?: string;
  ownerPubkey?: string;
  /** Only directories the local user is following or owns. */
  subscribedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface Subscription {
  directory_id: string;
  owner_pubkey: string;
  subscribed_at: string;
  last_synced_at: string | null;
}

interface DirectoryRow {
  id: string;
  owner_pubkey: string;
  title: string;
  description: string;
  category: string;
  cover_identifier: string;
  visibility: DirectoryVisibility;
  items_json: string;
  collaborators_json: string;
  origin: DirectoryOrigin;
  nostr_event_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  deleted_at: string | null;
}

interface SubscriptionRow {
  directory_id: string;
  owner_pubkey: string;
  subscribed_at: string;
  last_synced_at: string | null;
}

function parseJsonArray<T = unknown>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch { return []; }
}

export class CinemaDirectoriesService {
  constructor(private db: SqliteDb) {}

  // ── CRUD (local) ──────────────────────────────────────────────

  create(input: CreateDirectoryInput): CinemaDirectory {
    const id = newId();
    const now = isoNow();
    const items = input.initial_items ?? [];
    this.db
      .prepare(`
        INSERT INTO cinema_directories (
          id, owner_pubkey, title, description, category, cover_identifier,
          visibility, items_json, collaborators_json, origin,
          nostr_event_id, version, created_at, updated_at, published_at, deleted_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, 'local',
          '', 1, ?, ?, NULL, NULL
        )
      `)
      .run(
        id, input.owner_pubkey, input.title,
        input.description ?? "", input.category ?? "", input.cover_identifier ?? "",
        input.visibility ?? "public",
        JSON.stringify(items),
        JSON.stringify(input.collaborators ?? []),
        now, now,
      );
    return this.get(id)!;
  }

  update(id: string, patch: UpdateDirectoryInput): CinemaDirectory | null {
    const existing = this.getRow(id);
    if (!existing || existing.origin !== "local") return null;
    const now = isoNow();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
    if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
    if (patch.category !== undefined) { sets.push("category = ?"); params.push(patch.category); }
    if (patch.cover_identifier !== undefined) { sets.push("cover_identifier = ?"); params.push(patch.cover_identifier); }
    if (patch.visibility !== undefined) { sets.push("visibility = ?"); params.push(patch.visibility); }
    if (patch.collaborators !== undefined) { sets.push("collaborators_json = ?"); params.push(JSON.stringify(patch.collaborators)); }
    if (sets.length === 0) return this.shape(existing);
    sets.push("updated_at = ?");
    params.push(now);
    sets.push("version = version + 1");
    params.push(id);
    this.db.prepare(`UPDATE cinema_directories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  delete(id: string): boolean {
    const r = this.db
      .prepare(`UPDATE cinema_directories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(isoNow(), id);
    return r.changes > 0;
  }

  // ── Items ─────────────────────────────────────────────────────

  /** Add a movie to a directory. Idempotent — re-adding bumps the
   *  added_at timestamp instead of duplicating. Bumps version. */
  addItem(id: string, identifier: string, note?: string): CinemaDirectory | null {
    const dir = this.get(id);
    if (!dir) return null;
    const idx = dir.items.findIndex((it) => it.identifier === identifier);
    const now = isoNow();
    if (idx >= 0) {
      dir.items[idx] = { ...dir.items[idx], note: note ?? dir.items[idx].note, added_at: now };
    } else {
      dir.items.push({ identifier, note, added_at: now });
    }
    return this.writeItems(id, dir.items);
  }

  removeItem(id: string, identifier: string): CinemaDirectory | null {
    const dir = this.get(id);
    if (!dir) return null;
    const next = dir.items.filter((it) => it.identifier !== identifier);
    if (next.length === dir.items.length) return dir;     // not present, no-op
    return this.writeItems(id, next);
  }

  reorderItems(id: string, identifiers: string[]): CinemaDirectory | null {
    const dir = this.get(id);
    if (!dir) return null;
    // Preserve metadata; reorder by the new ordering, append unknown items.
    const byId = new Map(dir.items.map((it) => [it.identifier, it]));
    const next: DirectoryItem[] = [];
    for (const ident of identifiers) {
      const it = byId.get(ident);
      if (it) { next.push(it); byId.delete(ident); }
    }
    for (const it of byId.values()) next.push(it);
    return this.writeItems(id, next);
  }

  private writeItems(id: string, items: DirectoryItem[]): CinemaDirectory | null {
    const row = this.getRow(id);
    if (!row || row.origin !== "local") return null;
    this.db
      .prepare(`UPDATE cinema_directories SET items_json = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(JSON.stringify(items), isoNow(), id);
    return this.get(id);
  }

  // ── Reads ─────────────────────────────────────────────────────

  get(id: string): CinemaDirectory | null {
    const row = this.getRow(id);
    return row ? this.shape(row) : null;
  }

  list(filter: DirectoryListFilter = {}): CinemaDirectory[] {
    const where: string[] = ["d.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (filter.origin) { where.push("d.origin = ?"); params.push(filter.origin); }
    if (filter.category) { where.push("d.category = ?"); params.push(filter.category); }
    if (filter.ownerPubkey) { where.push("d.owner_pubkey = ?"); params.push(filter.ownerPubkey); }

    let sql: string;
    if (filter.subscribedOnly) {
      // Subscribed = either local-owned OR has a subscription row.
      sql = `
        SELECT DISTINCT d.* FROM cinema_directories d
        LEFT JOIN cinema_directory_subscriptions s
               ON s.directory_id = d.id
        WHERE ${where.join(" AND ")}
          AND (d.origin = 'local' OR s.directory_id IS NOT NULL)
        ORDER BY d.updated_at DESC
        LIMIT ? OFFSET ?
      `;
    } else {
      sql = `
        SELECT * FROM cinema_directories d
        WHERE ${where.join(" AND ")}
        ORDER BY d.updated_at DESC
        LIMIT ? OFFSET ?
      `;
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 500));
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = this.db.prepare(sql).all(...params, limit, offset) as DirectoryRow[];
    return rows.map((r) => this.shape(r));
  }

  // ── Subscriptions ────────────────────────────────────────────

  follow(directoryId: string, ownerPubkey: string): Subscription {
    const now = isoNow();
    this.db
      .prepare(`
        INSERT INTO cinema_directory_subscriptions (directory_id, owner_pubkey, subscribed_at, last_synced_at)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT(directory_id, owner_pubkey) DO NOTHING
      `)
      .run(directoryId, ownerPubkey, now);
    return this.getSubscription(directoryId, ownerPubkey)!;
  }

  unfollow(directoryId: string, ownerPubkey: string): boolean {
    const r = this.db
      .prepare(`DELETE FROM cinema_directory_subscriptions WHERE directory_id = ? AND owner_pubkey = ?`)
      .run(directoryId, ownerPubkey);
    return r.changes > 0;
  }

  getSubscription(directoryId: string, ownerPubkey: string): Subscription | null {
    const r = this.db
      .prepare(`SELECT * FROM cinema_directory_subscriptions WHERE directory_id = ? AND owner_pubkey = ?`)
      .get(directoryId, ownerPubkey) as SubscriptionRow | undefined;
    return r ? { ...r } : null;
  }

  listSubscriptions(): Subscription[] {
    const rows = this.db
      .prepare(`SELECT * FROM cinema_directory_subscriptions ORDER BY subscribed_at DESC`)
      .all() as SubscriptionRow[];
    return rows.map((r) => ({ ...r }));
  }

  markSynced(directoryId: string, ownerPubkey: string): void {
    this.db
      .prepare(`UPDATE cinema_directory_subscriptions SET last_synced_at = ? WHERE directory_id = ? AND owner_pubkey = ?`)
      .run(isoNow(), directoryId, ownerPubkey);
  }

  // ── Federated upsert (called by Nostr provider) ──────────────

  /**
   * Apply a federated event. Validates co-sign rules against the local
   * mirror (if any) and writes only when the event is newer.
   *
   * @returns 'created' | 'updated' | 'rejected:reason' | 'stale'
   */
  applyFederated(input: {
    directoryId: string;
    signerPubkey: string;
    eventId: string;
    eventCreatedAtSec: number;
    payload: {
      owner_pubkey: string;
      title: string;
      description: string;
      category: string;
      cover_identifier: string;
      visibility: DirectoryVisibility;
      items: DirectoryItem[];
      collaborators: string[];
      version: number;
      created_at: string;
      updated_at: string;
    };
  }): "created" | "updated" | "stale" | `rejected:${string}` {
    const existing = this.getRow(input.directoryId);
    const isNew = !existing;

    // Co-sign rule
    if (isNew) {
      if (input.signerPubkey !== input.payload.owner_pubkey) {
        return "rejected:signer-not-owner-on-create";
      }
    } else {
      const allowed = new Set([
        existing!.owner_pubkey,
        ...parseJsonArray<string>(existing!.collaborators_json),
      ]);
      if (!allowed.has(input.signerPubkey)) {
        return "rejected:signer-not-authorised";
      }
      // Last-write-wins by event ts vs current updated_at (parsed back).
      const localTs = Math.floor(new Date(existing!.updated_at).getTime() / 1000);
      if (input.eventCreatedAtSec < localTs) return "stale";
    }

    const now = isoNow();
    if (isNew) {
      this.db
        .prepare(`
          INSERT INTO cinema_directories (
            id, owner_pubkey, title, description, category, cover_identifier,
            visibility, items_json, collaborators_json, origin,
            nostr_event_id, version, created_at, updated_at, published_at, deleted_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, 'federated',
            ?, ?, ?, ?, NULL, NULL
          )
        `)
        .run(
          input.directoryId, input.payload.owner_pubkey, input.payload.title,
          input.payload.description, input.payload.category, input.payload.cover_identifier,
          input.payload.visibility,
          JSON.stringify(input.payload.items),
          JSON.stringify(input.payload.collaborators),
          input.eventId, input.payload.version,
          input.payload.created_at, input.payload.updated_at,
        );
      return "created";
    }
    this.db
      .prepare(`
        UPDATE cinema_directories SET
          title = ?, description = ?, category = ?, cover_identifier = ?,
          visibility = ?, items_json = ?, collaborators_json = ?,
          nostr_event_id = ?, version = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.payload.title, input.payload.description, input.payload.category,
        input.payload.cover_identifier, input.payload.visibility,
        JSON.stringify(input.payload.items),
        JSON.stringify(input.payload.collaborators),
        input.eventId, input.payload.version,
        input.payload.updated_at,
        input.directoryId,
      );
    void now;
    return "updated";
  }

  /** Stamp publish bookkeeping after broadcasting a local directory. */
  markPublished(id: string, eventId: string): void {
    this.db
      .prepare(`UPDATE cinema_directories SET published_at = ?, nostr_event_id = ? WHERE id = ?`)
      .run(isoNow(), eventId, id);
  }

  // ── internal ─────────────────────────────────────────────────

  private getRow(id: string): DirectoryRow | undefined {
    return this.db
      .prepare(`SELECT * FROM cinema_directories WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as DirectoryRow | undefined;
  }

  private shape(row: DirectoryRow): CinemaDirectory {
    return {
      id: row.id,
      owner_pubkey: row.owner_pubkey,
      title: row.title,
      description: row.description,
      category: row.category,
      cover_identifier: row.cover_identifier,
      visibility: row.visibility,
      items: parseJsonArray<DirectoryItem>(row.items_json),
      collaborators: parseJsonArray<string>(row.collaborators_json),
      origin: row.origin,
      nostr_event_id: row.nostr_event_id,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      published_at: row.published_at,
    };
  }
}
