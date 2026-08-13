import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Which corpus definition a slice was pulled under.
 *
 * The Wikidata corpus is fetched year by year and a finished slice is never
 * fetched again — that is what keeps re-running the phase cheap. But "finished"
 * is only meaningful relative to the set of work types the query asked for.
 * Widen that set and every slice on disk is silently out of date, with nothing
 * in the schema to say so.
 *
 * Stamping the version the slice was pulled under turns that into an ordinary
 * comparison: a slice counts as done only when its version matches the current
 * one, so bumping `CORPUS_VERSION` re-opens the whole corpus by itself. Same
 * idea as `matcher_version` on a decision, for the same reason — the code that
 * changes should not depend on someone remembering to clear a table.
 *
 * Existing rows default to 1, the version that pulled the original six types.
 */
export const cinemaCorpusVersionMigration: Migration = {
  version: 17,
  sql: `
    ALTER TABLE cinema_canonical_sync
      ADD COLUMN corpus_version INTEGER NOT NULL DEFAULT 1;
  `,
};
