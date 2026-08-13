import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Work-level dedupe — collapsing the many uploads of one film into one row.
 *
 * archive.org holds the same film over and over: different rips, different
 * languages, "restored" and "colorized" and someone's 240p VHS capture, each
 * its own item with its own identifier. The catalogue treats every one as a
 * separate title, and that costs twice:
 *
 *   - the grid fills with repeats, so a catalogue of 74k rows shows far fewer
 *     than 74k distinct films
 *   - downloads and reviews FRAGMENT across the copies. The weighted rating
 *     needs votes to say anything, and splitting thirty reviews across six
 *     uploads leaves every one of them looking unmeasured. This is the same
 *     v=0 problem canonical identification attacked from the other side.
 *
 * Aggregating the group is what makes the second one go away: the work has
 * the sum of its copies' votes, which is the number that was always true.
 *
 * Both tables are DERIVED — rebuilt by a single scan, like cinema_tags. They
 * hold no user state and can be dropped and regenerated at any time.
 */
export const cinemaWorksMigration: Migration = {
  version: 11,
  sql: `
    -- One row per distinct film.
    --
    -- work_key is either 'qid:<Q…>' when the copies were identified as a
    -- catalogued work, or 'norm:<normalized title>::<year>' when they were
    -- not. The qid form is the stronger one: it merges copies whose titles
    -- do not resemble each other at all — "Nosferatu" and "Nosferatu, eine
    -- Symphonie des Grauens" are the same film, and only the canonical
    -- identity knows that.
    CREATE TABLE IF NOT EXISTS cinema_works (
      work_key           TEXT PRIMARY KEY,
      qid                TEXT NOT NULL DEFAULT '',
      title              TEXT NOT NULL DEFAULT '',
      year               INTEGER NOT NULL DEFAULT 0,
      -- The copy shown when the group is collapsed.
      primary_identifier TEXT NOT NULL,
      copies             INTEGER NOT NULL DEFAULT 1,
      -- Summed across every copy. These are the numbers the ranking should
      -- always have been using.
      downloads          INTEGER NOT NULL DEFAULT 0,
      week_downloads     INTEGER NOT NULL DEFAULT 0,
      num_reviews        INTEGER NOT NULL DEFAULT 0,
      -- Vote-weighted mean across copies, NOT a mean of means: a 5.0 from one
      -- reviewer must not outweigh a 4.2 from forty just because they sat on
      -- different uploads.
      avg_rating         REAL NOT NULL DEFAULT 0,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cinema_works_primary ON cinema_works(primary_identifier);
    CREATE INDEX IF NOT EXISTS idx_cinema_works_downloads ON cinema_works(downloads DESC);
    CREATE INDEX IF NOT EXISTS idx_cinema_works_qid ON cinema_works(qid) WHERE qid <> '';

    -- Which work each upload belongs to. Every non-deleted title gets a row,
    -- including the ones that are the only copy of themselves — a singleton
    -- is a group of one, and treating it as a special case would mean every
    -- consumer needs a fallback path.
    CREATE TABLE IF NOT EXISTS cinema_work_members (
      identifier TEXT PRIMARY KEY,
      work_key   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cinema_work_members_key ON cinema_work_members(work_key);
  `,
};
