import type { Migration } from "@kernl/extension-sdk";

/**
 * Which titles the graph limits keep out of Neo4j (see graph-budget.ts).
 *
 * `cinema_graph_out` lists them; an empty table means no limits, so every
 * existing query keeps its behaviour until the user sets one. The embedder
 * and the per-title projectors skip what is listed here.
 *
 * `cinema_graph_state` holds `frozen` = '1' while the graph is over the size
 * ceiling set on System › Storage: nothing new is written to it then.
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
