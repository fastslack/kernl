import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Subtitle marketplace tables.
 *
 * cinema_subs        — subs we can serve (locally generated OR federated
 *                      that we already downloaded). Has the actual file.
 * cinema_subs_index  — announcements seen on discovery providers (Nostr,
 *                      archive.org). Most are NOT downloaded; this is the
 *                      catalog of "what's available out there per video".
 * cinema_publishers  — trust list for signers (npub-keyed). Drives the
 *                      "trusted only" filter in the UI.
 *
 * Naming: `provider_id` distinguishes the discovery channel where the
 * announcement was found. Same announcement may appear via multiple
 * providers — we dedupe by `(provider_id, provider_event_id)` so a sub
 * announced via both Nostr and archive.org appears twice with the same
 * underlying file but different lineage. The UI groups by sha256 to
 * collapse duplicates.
 */
export const cinemaSubsMigration: Migration = {
  version: 2,
  sql: `
    CREATE TABLE IF NOT EXISTS cinema_subs (
      id            TEXT PRIMARY KEY,
      identifier    TEXT NOT NULL,           -- archive.org video id
      src_lang      TEXT NOT NULL DEFAULT '',
      tgt_lang      TEXT NOT NULL,
      engine        TEXT NOT NULL DEFAULT '',
      engine_version TEXT NOT NULL DEFAULT '',
      origin        TEXT NOT NULL DEFAULT 'local'
                    CHECK(origin IN ('local','federated','archive_org','imported')),
      signer_pubkey TEXT NOT NULL DEFAULT '',  -- nostr/x-only secp256k1 hex
      manifest_json TEXT NOT NULL DEFAULT '{}',
      vtt_path      TEXT NOT NULL DEFAULT '',  -- on-disk vtt cache (subs.ts)
      srt_path      TEXT NOT NULL DEFAULT '',
      sha256        TEXT NOT NULL DEFAULT '',
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      magnet        TEXT NOT NULL DEFAULT '',
      webseed_url   TEXT NOT NULL DEFAULT '',
      generated_at  TEXT NOT NULL,
      published_at  TEXT,
      deleted_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cinema_subs_video ON cinema_subs(identifier) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cinema_subs_lang  ON cinema_subs(identifier, tgt_lang) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cinema_subs_sha   ON cinema_subs(sha256) WHERE sha256 <> '';

    -- Discovery index: announcements seen on Nostr / archive.org / future
    -- providers. Dedup key is (provider_id, provider_event_id) so a relay
    -- republishing keeps a single row, while the same sub announced via
    -- Nostr AND archive.org gets two rows (different provenance).
    CREATE TABLE IF NOT EXISTS cinema_subs_index (
      id                TEXT PRIMARY KEY,
      provider_id       TEXT NOT NULL,
      provider_event_id TEXT NOT NULL DEFAULT '',
      identifier        TEXT NOT NULL,
      src_lang          TEXT NOT NULL DEFAULT '',
      tgt_lang          TEXT NOT NULL,
      engine            TEXT NOT NULL DEFAULT '',
      signer_pubkey     TEXT NOT NULL DEFAULT '',
      magnet            TEXT NOT NULL DEFAULT '',
      webseed_url       TEXT NOT NULL DEFAULT '',
      sha256            TEXT NOT NULL DEFAULT '',
      size_bytes        INTEGER NOT NULL DEFAULT 0,
      content           TEXT NOT NULL DEFAULT '',
      seen_at           TEXT NOT NULL,
      downloaded_sub_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_index_dedupe
      ON cinema_subs_index(provider_id, provider_event_id);
    CREATE INDEX IF NOT EXISTS idx_subs_index_video ON cinema_subs_index(identifier);
    CREATE INDEX IF NOT EXISTS idx_subs_index_lang  ON cinema_subs_index(identifier, tgt_lang);
    CREATE INDEX IF NOT EXISTS idx_subs_index_signer ON cinema_subs_index(signer_pubkey);

    -- Trust list. unknown = haven't classified. mine/trusted/blocked drive
    -- the UI's "show all | trusted only" toggle.
    CREATE TABLE IF NOT EXISTS cinema_publishers (
      pubkey   TEXT PRIMARY KEY,
      alias    TEXT NOT NULL DEFAULT '',
      trust    TEXT NOT NULL DEFAULT 'unknown'
               CHECK(trust IN ('mine','trusted','blocked','unknown')),
      added_at TEXT NOT NULL,
      notes    TEXT NOT NULL DEFAULT ''
    );
  `,
};
