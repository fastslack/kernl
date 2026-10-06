import type { Migration } from "@kernl/extension-sdk";

/**
 * Rebuild `cinema_titles_fts` as a contentless index (`content=''`,
 * `contentless_delete=1`), so it stops storing its own copy of every row.
 *
 * Since migration 6 the FTS table kept a full copy of identifier, title,
 * creator, subject and description — around 200 MB of `_content` on the live
 * catalogue, duplicating text that already lives in `cinema_titles`. Nothing
 * ever reads it back: every search (`fullTextSearch`, `list`, `countAll`) only
 * runs `MATCH`, ranks with `bm25()` and joins `cinema_titles` on rowid to
 * hydrate. No `snippet()`, no `highlight()`, no `f.<column>` read. bm25 works
 * off the index and the per-row size table, both of which a contentless table
 * keeps, so rankings are identical.
 *
 * Why contentless and not external content (`content='cinema_titles'`):
 *   - The indexed `subject` is derived (subject_json unwrapped with
 *     json_each), so external content would need a view exposing it, and its
 *     'delete' command must be fed the exact old values — re-deriving them in a
 *     trigger is the kind of mismatch that silently corrupts the index.
 *   - `contentless_delete=1` (SQLite >= 3.43; the runtime ships 3.50) accepts
 *     a plain `DELETE ... WHERE rowid = ?`, which is the original problem that
 *     made migration 6 abandon `content=''`. The triggers stay as trivial as
 *     they were.
 *
 * Column layout is unchanged — including the UNINDEXED identifier, which
 * stores nothing now — because bm25() weights are positional and the search
 * queries pass them by column index.
 *
 * The UPDATE trigger now fires only when an indexed input actually changes.
 * Before, any write to the row (embedded_at, watchlist, description_es, an
 * ingest refresh that rewrote the same text) rewrote its index entry for
 * nothing.
 *
 * Writers: nothing writes to the FTS table except these triggers, so there is
 * no other path to adapt. The rebuild runs once, inside this migration's
 * transaction; `optimize` merges the backfill into a single segment.
 */
export const cinemaFtsContentlessMigration: Migration = {
  version: 20,
  sql: `
    DROP TRIGGER IF EXISTS cinema_titles_fts_ai;
    DROP TRIGGER IF EXISTS cinema_titles_fts_ad;
    DROP TRIGGER IF EXISTS cinema_titles_fts_au;
    DROP TABLE IF EXISTS cinema_titles_fts;

    CREATE VIRTUAL TABLE cinema_titles_fts USING fts5(
      identifier UNINDEXED,
      title,
      creator,
      subject,
      description,
      content='',
      contentless_delete=1,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER cinema_titles_fts_ai AFTER INSERT ON cinema_titles
    BEGIN
      INSERT INTO cinema_titles_fts(rowid, identifier, title, creator, subject, description)
      SELECT NEW.rowid, NEW.identifier, NEW.title, NEW.creator,
             COALESCE((SELECT group_concat(value, ' ') FROM json_each(NEW.subject_json)), ''),
             NEW.description
      WHERE NEW.deleted_at IS NULL;
    END;

    CREATE TRIGGER cinema_titles_fts_ad AFTER DELETE ON cinema_titles
    BEGIN
      DELETE FROM cinema_titles_fts WHERE rowid = OLD.rowid;
    END;

    CREATE TRIGGER cinema_titles_fts_au
    AFTER UPDATE OF title, creator, subject_json, description, deleted_at ON cinema_titles
    WHEN OLD.title IS NOT NEW.title OR OLD.creator IS NOT NEW.creator
      OR OLD.subject_json IS NOT NEW.subject_json OR OLD.description IS NOT NEW.description
      OR OLD.deleted_at IS NOT NEW.deleted_at
    BEGIN
      DELETE FROM cinema_titles_fts WHERE rowid = OLD.rowid;
      INSERT INTO cinema_titles_fts(rowid, identifier, title, creator, subject, description)
      SELECT NEW.rowid, NEW.identifier, NEW.title, NEW.creator,
             COALESCE((SELECT group_concat(value, ' ') FROM json_each(NEW.subject_json)), ''),
             NEW.description
      WHERE NEW.deleted_at IS NULL;
    END;

    INSERT INTO cinema_titles_fts(rowid, identifier, title, creator, subject, description)
    SELECT rowid, identifier, title, creator,
           COALESCE((SELECT group_concat(value, ' ') FROM json_each(subject_json)), ''),
           description
    FROM cinema_titles
    WHERE deleted_at IS NULL;

    INSERT INTO cinema_titles_fts(cinema_titles_fts) VALUES('optimize');
  `,
};
