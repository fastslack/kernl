import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * cinema_tags — normalized tag catalog derived from cinema_titles.subject_json.
 *
 * archive.org's `subject` field is a free-form bag of strings: tag case
 * varies ("Drama" / "drama"), tags are sometimes punctuation ("." / "1"),
 * and the same concept appears under multiple spellings ("Cine argentino"
 * vs "ARG"). Exposing this raw to the UI is unusable.
 *
 * This table holds:
 *   - tag_norm    canonical key (lowercase, trimmed, accent-stripped)
 *   - tag_display the most-frequent original casing (for the UI label)
 *   - count       how many titles carry it
 *   - rank        precomputed rank by count for "top N" queries
 *
 * Population happens via a separate backfill script / agent, NOT this
 * migration — backfilling 148k rows in a single SQL statement requires
 * a complex CTE and is fragile under future schema changes. The
 * migration only creates the schema; the cinema:rebuild-tags handler
 * (added in tools.ts) populates it.
 */
export const cinemaTagsMigration: Migration = {
  version: 4,
  sql: `
    CREATE TABLE IF NOT EXISTS cinema_tags (
      tag_norm     TEXT PRIMARY KEY,
      tag_display  TEXT NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      rank         INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cinema_tags_count ON cinema_tags(count DESC);
    CREATE INDEX IF NOT EXISTS idx_cinema_tags_rank  ON cinema_tags(rank);
  `,
};
