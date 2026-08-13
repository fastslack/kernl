import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Canon rails — which curated lists a work belongs to.
 *
 * Keyed by `qid` rather than by `identifier`, because membership is a fact
 * about the WORK, not about the upload. The Library of Congress selected a
 * film; it did not select somebody's 480p transfer of it. Keying on the work
 * means every copy in the catalogue inherits the rail through the canonical
 * match, and a title identified next week joins its rails with no extra
 * fetch.
 *
 * Derived and replaceable: `syncCanonLists` refreshes a list by deleting and
 * re-inserting its rows. Nothing user-owned lives here.
 */
export const cinemaCanonMigration: Migration = {
  version: 13,
  sql: `
    CREATE TABLE IF NOT EXISTS cinema_canon (
      qid      TEXT NOT NULL,
      list_key TEXT NOT NULL,
      PRIMARY KEY (qid, list_key)
    );
    -- The rail query: everything in one list.
    CREATE INDEX IF NOT EXISTS idx_cinema_canon_list ON cinema_canon(list_key);
  `,
};
