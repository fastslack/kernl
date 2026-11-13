import type { Migration } from "@kernl/extension-sdk";

/**
 * The alias full-text index and the resolve candidates, in SQLite.
 *
 * Recovering yearless uploads (alias-resolve.ts) used a Lucene index over
 * `(:CanonicalWork)` nodes and wrote CANDIDATE edges, which is the only reason
 * the catalogue was projected into the graph. Both move here:
 *
 *   - `cinema_alias_fts`: FTS5 over `cinema_canonical_aliases.alias_norm`,
 *     external content (it stores no copy of the ~641k aliases), kept in step
 *     by triggers. The corpus pull writes aliases with INSERT OR IGNORE; the
 *     triggers cover deletes and updates too.
 *   - `cinema_resolve_candidates`: one row per (upload, work) the index
 *     proposed and the matcher's similarity kept, with its score.
 *
 * `rebuild` fills the index from the aliases already pulled, once.
 */
export const cinemaAliasFtsMigration: Migration = {
  version: 22,
  sql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS cinema_alias_fts USING fts5(
      alias_norm,
      content = 'cinema_canonical_aliases',
      content_rowid = 'rowid'
    );
    CREATE TRIGGER IF NOT EXISTS cinema_alias_fts_ai AFTER INSERT ON cinema_canonical_aliases BEGIN
      INSERT INTO cinema_alias_fts (rowid, alias_norm) VALUES (new.rowid, new.alias_norm);
    END;
    CREATE TRIGGER IF NOT EXISTS cinema_alias_fts_ad AFTER DELETE ON cinema_canonical_aliases BEGIN
      INSERT INTO cinema_alias_fts (cinema_alias_fts, rowid, alias_norm) VALUES ('delete', old.rowid, old.alias_norm);
    END;
    CREATE TRIGGER IF NOT EXISTS cinema_alias_fts_au AFTER UPDATE OF alias_norm ON cinema_canonical_aliases BEGIN
      INSERT INTO cinema_alias_fts (cinema_alias_fts, rowid, alias_norm) VALUES ('delete', old.rowid, old.alias_norm);
      INSERT INTO cinema_alias_fts (rowid, alias_norm) VALUES (new.rowid, new.alias_norm);
    END;
    INSERT INTO cinema_alias_fts (cinema_alias_fts) VALUES ('rebuild');

    CREATE TABLE IF NOT EXISTS cinema_resolve_candidates (
      identifier TEXT NOT NULL,
      qid        TEXT NOT NULL,
      score      REAL NOT NULL,
      PRIMARY KEY (identifier, qid)
    );
  `,
};
