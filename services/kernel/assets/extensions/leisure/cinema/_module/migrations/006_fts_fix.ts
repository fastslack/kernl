import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Fix the FTS5 sync triggers from migration 003.
 *
 * The original schema declared `cinema_titles_fts` with `content=''`
 * (contentless mode), which forbids plain `DELETE FROM` on the table.
 * Our UPDATE trigger on cinema_titles was running:
 *
 *     DELETE FROM cinema_titles_fts WHERE rowid = OLD.rowid;
 *
 * which raised `cannot DELETE from contentless fts5 table` on every
 * subsequent update of cinema_titles — that includes embedded_at,
 * watchlist, watched_at, etc., and broke the embed runner.
 *
 * Fix: drop the FTS table + triggers and recreate without content=''.
 * The FTS index now stores its own copy of the indexed columns (a few
 * tens of MB on 200k rows — acceptable). Triggers stay trivial.
 */
export const cinemaFtsFixMigration: Migration = {
  version: 6,
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

    CREATE TRIGGER cinema_titles_fts_au AFTER UPDATE ON cinema_titles
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
  `,
};
