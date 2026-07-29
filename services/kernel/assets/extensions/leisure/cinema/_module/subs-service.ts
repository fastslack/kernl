/**
 * CinemaSubsService — owns the SQLite-side subtitle catalog.
 *
 *   cinema_subs        — locally-served subs (we have the file)
 *   cinema_subs_index  — announcements seen via discovery (may not be
 *                        downloaded; one row per provider observation)
 *   cinema_publishers  — trust list (npub → mine|trusted|blocked)
 *
 * Kept separate from CinemaService because the surface is different
 * (subtitles vs catalog) and the data lifecycles are unrelated. Both
 * services share the same `sqlite` handle.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import type { SubAnnouncement } from "./discovery/provider.js";

export interface LocalSub {
  id: string;
  identifier: string;
  src_lang: string;
  tgt_lang: string;
  engine: string;
  engine_version: string;
  origin: "local" | "federated" | "archive_org" | "imported";
  signer_pubkey: string;
  manifest: Record<string, unknown>;
  vtt_path: string;
  srt_path: string;
  sha256: string;
  size_bytes: number;
  magnet: string;
  webseed_url: string;
  generated_at: string;
  published_at: string | null;
}

export interface FederatedSub extends SubAnnouncement {
  /** Internal index row id. Returned so the caller can mark it
   *  downloaded after fetching. */
  rowId: string;
  /** When set, this announcement has already been downloaded into
   *  cinema_subs (FK to cinema_subs.id). */
  downloadedSubId: string | null;
}

export type PublisherTrust = "mine" | "trusted" | "blocked" | "unknown";
export interface Publisher {
  pubkey: string;
  alias: string;
  trust: PublisherTrust;
  added_at: string;
  notes: string;
}

interface LocalSubRow {
  id: string;
  identifier: string;
  src_lang: string;
  tgt_lang: string;
  engine: string;
  engine_version: string;
  origin: LocalSub["origin"];
  signer_pubkey: string;
  manifest_json: string;
  vtt_path: string;
  srt_path: string;
  sha256: string;
  size_bytes: number;
  magnet: string;
  webseed_url: string;
  generated_at: string;
  published_at: string | null;
  deleted_at: string | null;
}

interface IndexRow {
  id: string;
  provider_id: string;
  provider_event_id: string;
  identifier: string;
  src_lang: string;
  tgt_lang: string;
  engine: string;
  signer_pubkey: string;
  magnet: string;
  webseed_url: string;
  sha256: string;
  size_bytes: number;
  content: string;
  seen_at: string;
  downloaded_sub_id: string | null;
}

interface PublisherRow {
  pubkey: string;
  alias: string;
  trust: PublisherTrust;
  added_at: string;
  notes: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const v = JSON.parse(raw);
    return v as T;
  } catch {
    return fallback;
  }
}

export class CinemaSubsService {
  constructor(private db: SqliteDb) {}

  // ── Local subs (we have the bytes) ────────────────────────────

  insertLocal(input: {
    identifier: string;
    src_lang: string;
    tgt_lang: string;
    engine: string;
    engine_version?: string;
    origin?: LocalSub["origin"];
    signer_pubkey?: string;
    manifest?: Record<string, unknown>;
    vtt_path?: string;
    srt_path?: string;
    sha256?: string;
    size_bytes?: number;
    magnet?: string;
    webseed_url?: string;
  }): LocalSub {
    const id = newId();
    const now = isoNow();
    this.db
      .prepare(`
        INSERT INTO cinema_subs (
          id, identifier, src_lang, tgt_lang, engine, engine_version,
          origin, signer_pubkey, manifest_json,
          vtt_path, srt_path, sha256, size_bytes,
          magnet, webseed_url, generated_at, published_at, deleted_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, NULL, NULL
        )
      `)
      .run(
        id,
        input.identifier,
        input.src_lang,
        input.tgt_lang,
        input.engine,
        input.engine_version ?? "",
        input.origin ?? "local",
        input.signer_pubkey ?? "",
        JSON.stringify(input.manifest ?? {}),
        input.vtt_path ?? "",
        input.srt_path ?? "",
        input.sha256 ?? "",
        input.size_bytes ?? 0,
        input.magnet ?? "",
        input.webseed_url ?? "",
        now,
      );
    return this.getLocal(id)!;
  }

  getLocal(id: string): LocalSub | null {
    const row = this.db
      .prepare(`SELECT * FROM cinema_subs WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as LocalSubRow | undefined;
    return row ? this.shapeLocal(row) : null;
  }

  listLocalByVideo(identifier: string): LocalSub[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM cinema_subs
        WHERE identifier = ? AND deleted_at IS NULL
        ORDER BY generated_at DESC
      `)
      .all(identifier) as LocalSubRow[];
    return rows.map((r) => this.shapeLocal(r));
  }

  /** Mark a local sub as published (called after a discovery provider
   *  accepts the announcement). */
  markPublished(id: string): void {
    this.db
      .prepare(`UPDATE cinema_subs SET published_at = ? WHERE id = ?`)
      .run(isoNow(), id);
  }

  // ── Discovery index (announcements from providers) ────────────

  /** Upsert one announcement. Dedup key: (provider_id, provider_event_id).
   *  Returns the existing row id when an upsert hit an existing row. */
  upsertIndex(ann: SubAnnouncement): string {
    const existing = this.db
      .prepare(`
        SELECT id FROM cinema_subs_index
        WHERE provider_id = ? AND provider_event_id = ?
      `)
      .get(ann.providerId, ann.providerEventId) as { id: string } | undefined;
    const seenAt = ann.observedAt || isoNow();

    if (existing) {
      this.db
        .prepare(`
          UPDATE cinema_subs_index SET
            identifier = ?,
            src_lang = ?,
            tgt_lang = ?,
            engine = ?,
            signer_pubkey = ?,
            magnet = ?,
            webseed_url = ?,
            sha256 = ?,
            size_bytes = ?,
            content = ?,
            seen_at = ?
          WHERE id = ?
        `)
        .run(
          ann.identifier,
          ann.srcLang,
          ann.tgtLang,
          ann.engine,
          ann.signerPubkey,
          ann.magnet,
          ann.webseedUrl,
          ann.sha256,
          ann.sizeBytes,
          ann.content,
          seenAt,
          existing.id,
        );
      return existing.id;
    }

    const id = newId();
    this.db
      .prepare(`
        INSERT INTO cinema_subs_index (
          id, provider_id, provider_event_id, identifier,
          src_lang, tgt_lang, engine, signer_pubkey,
          magnet, webseed_url, sha256, size_bytes, content,
          seen_at, downloaded_sub_id
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, NULL
        )
      `)
      .run(
        id, ann.providerId, ann.providerEventId, ann.identifier,
        ann.srcLang, ann.tgtLang, ann.engine, ann.signerPubkey,
        ann.magnet, ann.webseedUrl, ann.sha256, ann.sizeBytes, ann.content,
        seenAt,
      );
    return id;
  }

  getIndex(rowId: string): FederatedSub | null {
    const row = this.db
      .prepare(`SELECT * FROM cinema_subs_index WHERE id = ?`)
      .get(rowId) as IndexRow | undefined;
    return row ? this.shapeIndex(row) : null;
  }

  /** Federated announcements for a video. Joins the trust list so the
   *  UI can highlight mine/trusted/blocked rows without a second query. */
  listIndexByVideo(identifier: string): FederatedSub[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM cinema_subs_index
        WHERE identifier = ?
        ORDER BY seen_at DESC
      `)
      .all(identifier) as IndexRow[];
    return rows.map((r) => this.shapeIndex(r));
  }

  markDownloaded(rowId: string, localSubId: string): void {
    this.db
      .prepare(`UPDATE cinema_subs_index SET downloaded_sub_id = ? WHERE id = ?`)
      .run(localSubId, rowId);
  }

  // ── Publisher trust list ──────────────────────────────────────

  setTrust(pubkey: string, trust: PublisherTrust, alias?: string, notes?: string): Publisher {
    const existing = this.db
      .prepare(`SELECT * FROM cinema_publishers WHERE pubkey = ?`)
      .get(pubkey) as PublisherRow | undefined;
    const now = isoNow();
    if (existing) {
      this.db
        .prepare(`
          UPDATE cinema_publishers SET trust = ?,
            alias = COALESCE(NULLIF(?, ''), alias),
            notes = COALESCE(NULLIF(?, ''), notes)
          WHERE pubkey = ?
        `)
        .run(trust, alias ?? "", notes ?? "", pubkey);
    } else {
      this.db
        .prepare(`
          INSERT INTO cinema_publishers (pubkey, alias, trust, added_at, notes)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(pubkey, alias ?? "", trust, now, notes ?? "");
    }
    return this.getPublisher(pubkey)!;
  }

  getPublisher(pubkey: string): Publisher | null {
    const row = this.db
      .prepare(`SELECT * FROM cinema_publishers WHERE pubkey = ?`)
      .get(pubkey) as PublisherRow | undefined;
    return row ? { ...row } : null;
  }

  listPublishers(): Publisher[] {
    const rows = this.db
      .prepare(`SELECT * FROM cinema_publishers ORDER BY trust, alias, pubkey`)
      .all() as PublisherRow[];
    return rows.map((r) => ({ ...r }));
  }

  // ── shaping ───────────────────────────────────────────────────

  private shapeLocal(row: LocalSubRow): LocalSub {
    return {
      id: row.id,
      identifier: row.identifier,
      src_lang: row.src_lang,
      tgt_lang: row.tgt_lang,
      engine: row.engine,
      engine_version: row.engine_version,
      origin: row.origin,
      signer_pubkey: row.signer_pubkey,
      manifest: parseJson<Record<string, unknown>>(row.manifest_json, {}),
      vtt_path: row.vtt_path,
      srt_path: row.srt_path,
      sha256: row.sha256,
      size_bytes: row.size_bytes,
      magnet: row.magnet,
      webseed_url: row.webseed_url,
      generated_at: row.generated_at,
      published_at: row.published_at,
    };
  }

  private shapeIndex(row: IndexRow): FederatedSub {
    return {
      rowId: row.id,
      providerId: row.provider_id,
      providerEventId: row.provider_event_id,
      identifier: row.identifier,
      srcLang: row.src_lang,
      tgtLang: row.tgt_lang,
      engine: row.engine,
      engineVersion: "",
      signerPubkey: row.signer_pubkey,
      magnet: row.magnet,
      webseedUrl: row.webseed_url,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      content: row.content,
      observedAt: row.seen_at,
      downloadedSubId: row.downloaded_sub_id,
    };
  }
}
