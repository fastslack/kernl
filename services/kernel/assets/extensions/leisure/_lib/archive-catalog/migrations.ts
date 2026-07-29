import type { Migration } from "../../../../../src/core/db/migrations.js";

/**
 * Generate the catalog migrations for a given table prefix.
 *
 * Schema is intentionally a SUBSET of cinema's `cinema_titles` — we
 * dropped media-specific user columns (watchlist, watched_at, user_rating,
 * notes, hidden) since each consumer keeps its own user-state table
 * (music_library, books_watchlist, cinema_watchlist) keyed by `identifier`.
 * The lib never touches user state.
 *
 * Embedding bookkeeping (`embedded_at`, model, dim) IS kept here so the
 * embed runner stays generic across mediatypes.
 *
 * Single migration covers titles + ingest_runs + FTS5 + tags. We don't
 * version-split because there's no production data yet for non-cinema
 * consumers — cinema keeps its own per-version migrations and is
 * unaffected by this lib until Phase 2.
 */
export function archiveCatalogMigrations(prefix: string): Migration[] {
  // Identifier safety — table prefixes flow into raw SQL. Restrict to a
  // strict ASCII identifier shape so a malicious caller can't inject DDL.
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
    throw new Error(`archiveCatalogMigrations: invalid prefix "${prefix}"`);
  }
  const p = prefix;
  return [
    {
      version: 1,
      sql: `
        -- Catalog rows ─ generic shape for any archive.org item.
        CREATE TABLE IF NOT EXISTS ${p}_titles (
          identifier      TEXT PRIMARY KEY,
          title           TEXT NOT NULL DEFAULT '',
          date            TEXT NOT NULL DEFAULT '',
          year            INTEGER NOT NULL DEFAULT 0,
          creator         TEXT NOT NULL DEFAULT '',
          description     TEXT NOT NULL DEFAULT '',
          subject_json    TEXT NOT NULL DEFAULT '[]',
          collection_json TEXT NOT NULL DEFAULT '[]',
          language        TEXT NOT NULL DEFAULT '',
          licenseurl      TEXT NOT NULL DEFAULT '',
          downloads       INTEGER NOT NULL DEFAULT 0,
          week_downloads  INTEGER NOT NULL DEFAULT 0,
          avg_rating      REAL NOT NULL DEFAULT 0,
          num_reviews     INTEGER NOT NULL DEFAULT 0,
          format_json     TEXT NOT NULL DEFAULT '[]',
          addeddate       TEXT NOT NULL DEFAULT '',
          publicdate      TEXT NOT NULL DEFAULT '',
          embedded_at     TEXT,
          embedded_model  TEXT NOT NULL DEFAULT '',
          embedded_dim    INTEGER NOT NULL DEFAULT 0,
          ingested_at     TEXT NOT NULL,
          last_seen_at    TEXT NOT NULL,
          deleted_at      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_${p}_year       ON ${p}_titles(year);
        CREATE INDEX IF NOT EXISTS idx_${p}_addeddate  ON ${p}_titles(addeddate);
        CREATE INDEX IF NOT EXISTS idx_${p}_downloads  ON ${p}_titles(downloads DESC);
        CREATE INDEX IF NOT EXISTS idx_${p}_pending_emb ON ${p}_titles(embedded_at)
          WHERE deleted_at IS NULL AND embedded_at IS NULL;

        -- Ingest run audit + cursor persistence (resume across restarts).
        CREATE TABLE IF NOT EXISTS ${p}_ingest_runs (
          id              TEXT PRIMARY KEY,
          collection      TEXT NOT NULL,
          cursor          TEXT NOT NULL DEFAULT '',
          fetched         INTEGER NOT NULL DEFAULT 0,
          upserted        INTEGER NOT NULL DEFAULT 0,
          status          TEXT NOT NULL DEFAULT 'running'
                          CHECK(status IN ('running','done','failed','paused')),
          error           TEXT NOT NULL DEFAULT '',
          started_at      TEXT NOT NULL,
          finished_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_${p}_runs_coll    ON ${p}_ingest_runs(collection, status);
        CREATE INDEX IF NOT EXISTS idx_${p}_runs_started ON ${p}_ingest_runs(started_at DESC);

        -- FTS5 with own content (lesson learned from cinema's migration 6:
        -- contentless mode forbids DELETE inside triggers).
        CREATE VIRTUAL TABLE IF NOT EXISTS ${p}_titles_fts USING fts5(
          identifier UNINDEXED,
          title,
          creator,
          subject,
          description,
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS ${p}_titles_fts_ai AFTER INSERT ON ${p}_titles
        BEGIN
          INSERT INTO ${p}_titles_fts(rowid, identifier, title, creator, subject, description)
          SELECT NEW.rowid, NEW.identifier, NEW.title, NEW.creator,
                 COALESCE((SELECT group_concat(value, ' ') FROM json_each(NEW.subject_json)), ''),
                 NEW.description
          WHERE NEW.deleted_at IS NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS ${p}_titles_fts_ad AFTER DELETE ON ${p}_titles
        BEGIN
          DELETE FROM ${p}_titles_fts WHERE rowid = OLD.rowid;
        END;

        CREATE TRIGGER IF NOT EXISTS ${p}_titles_fts_au AFTER UPDATE ON ${p}_titles
        BEGIN
          DELETE FROM ${p}_titles_fts WHERE rowid = OLD.rowid;
          INSERT INTO ${p}_titles_fts(rowid, identifier, title, creator, subject, description)
          SELECT NEW.rowid, NEW.identifier, NEW.title, NEW.creator,
                 COALESCE((SELECT group_concat(value, ' ') FROM json_each(NEW.subject_json)), ''),
                 NEW.description
          WHERE NEW.deleted_at IS NULL;
        END;

        -- Normalized tag catalog (re-derived from titles via rebuildTags()).
        CREATE TABLE IF NOT EXISTS ${p}_tags (
          tag_norm     TEXT PRIMARY KEY,
          tag_display  TEXT NOT NULL,
          count        INTEGER NOT NULL DEFAULT 0,
          rank         INTEGER NOT NULL DEFAULT 0,
          updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_${p}_tags_count ON ${p}_tags(count DESC);
        CREATE INDEX IF NOT EXISTS idx_${p}_tags_rank  ON ${p}_tags(rank);
      `,
    },
  ];
}
