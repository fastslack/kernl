import type { Migration } from "@kernl/extension-sdk";

/**
 * Which titles the graph limits kept out of Neo4j (System › Storage, until
 * 0.5.0 took the catalogue out of the graph).
 *
 * `cinema_graph_out` lists them; an empty table means no limits. The embedder
 * still skips what is listed, so titles a user left out are not embedded now.
 *
 * `cinema_graph_state` is cinema's key/value state (e.g. `vectors_in_sqlite`,
 * `catalogue_out_of_graph`).
 */
export const cinemaGraphLimitsMigration: Migration = {
  version: 21,
  sql: `
    CREATE TABLE IF NOT EXISTS cinema_graph_out (
      identifier TEXT PRIMARY KEY
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cinema_graph_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,
};
