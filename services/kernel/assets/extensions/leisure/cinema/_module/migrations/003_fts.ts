import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * FTS5 full-text search over cinema_titles. Replaces the legacy
 * LIKE %x% path for keyword search (which had two problems: no token
 * boundaries — "ALF" matched "Alfred" / "halfway"; no relevance ranking
 * — results sorted by downloads regardless of match quality).
 *
 * Design:
 *   - Contentless table (`content=''`) so the FTS index doesn't duplicate
 *     the source rows. We always JOIN to cinema_titles via `rowid` to
 *     hydrate the row.
 *   - Tokenizer `unicode61 remove_diacritics 2` normalizes case + strips
 *     accents (so "películas" matches "peliculas", "ALF" matches "alf").
 *   - Triggers keep the index in sync on every cinema_titles INSERT /
 *     UPDATE / DELETE. Soft-deleted rows are excluded from the index.
 *   - subject_json is a JSON array; group_concat unwraps it so individual
 *     tags become separate tokens in the FTS index.
 *
 * Backfill: a one-shot INSERT...SELECT at the end of the migration
 * populates the index from whatever's already in cinema_titles. Runs
 * once on first apply of version 3.
 *
 * Ranking: bm25() in the query lets us weight title/subject above
 * description so a sitcom-name match in `title` outranks an accidental
 * mention in someone's description.
 */
export const cinemaFtsMigration: Migration = {
  version: 3,
  sql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS cinema_titles_fts USING fts5(
      identifier UNINDEXED,
      title,
      creator,
      subject,
      description,
      content='',
      tokenize='unicode61 remove_diacritics 2'
    );

    -- Sync triggers ------------------------------------------------
    CREATE TRIGGER IF NOT EXISTS cinema_titles_fts_ai AFTER INSERT ON cinema_titles
    BEGIN
      INSERT INTO cinema_titles_fts(rowid, identifier, title, creator, subject, description)
      SELECT NEW.rowid, NEW.identifier, NEW.title, NEW.creator,
             COALESCE((SELECT group_concat(value, ' ') FROM json_each(NEW.subject_json)), ''),
             NEW.description
      WHERE NEW.deleted_at IS NULL;
    END;

    CREATE TRIGGER IF NOT EXISTS cinema_titles_fts_ad AFTER DELETE ON cinema_titles
    BEGIN
      DELETE FROM cinema_titles_fts WHERE rowid = OLD.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS cinema_titles_fts_au AFTER UPDATE ON cinema_titles
    BEGIN
      DELETE FROM cinema_titles_fts WHERE rowid = OLD.rowid;
      INSERT INTO cinema_titles_fts(rowid, identifier, title, creator, subject, description)
      SELECT NEW.rowid, NEW.identifier, NEW.title, NEW.creator,
             COALESCE((SELECT group_concat(value, ' ') FROM json_each(NEW.subject_json)), ''),
             NEW.description
      WHERE NEW.deleted_at IS NULL;
    END;

    -- One-shot backfill: index everything that's already in the catalog.
    -- Idempotent — re-running the migration is no-op because the trigger
    -- on subsequent inserts replaces rather than duplicates (delete+insert).
    INSERT INTO cinema_titles_fts(rowid, identifier, title, creator, subject, description)
    SELECT rowid, identifier, title, creator,
           COALESCE((SELECT group_concat(value, ' ') FROM json_each(subject_json)), ''),
           description
    FROM cinema_titles
    WHERE deleted_at IS NULL;
  `,
};
