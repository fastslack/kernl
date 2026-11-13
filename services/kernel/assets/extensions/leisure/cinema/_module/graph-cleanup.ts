/**
 * Taking the catalogue out of a graph that still holds it.
 *
 * Until 0.5.0 cinema projected its catalogue into the graph — works, Wikidata
 * identities, directors, genres, subjects, collections — for the alias lookup
 * that now runs on SQLite FTS5 (alias-resolve.ts). Nothing reads those nodes
 * any more, and on an embedded graph they sit in memory: on a real install
 * they were ~90% of it. The 0.5.0 copy from Neo4j already leaves them behind;
 * a built-in (Relate) store that received them before is cleared here, once,
 * after the vectors have moved to SQLite.
 *
 * Only on Relate. A Neo4j a user keeps (for GDS) is left alone: those nodes
 * cost it disk, not the kernel's memory, and the 0.5.0 upgrade reads that
 * Neo4j while it copies — deleting under it would break the copy's count.
 *
 * Directors and creators are `Person` nodes keyed by `name_norm`. The CRM's
 * people always carry an `id`, so only a `Person` without one is removed.
 */

import { log, type GraphDriver, type SqliteDb } from "@kernl/extension-sdk";

export const CATALOGUE_LABELS = ["CanonicalWork", "CinemaTitle", "CinemaWork", "Subject", "Genre", "Country", "Collection"];
/** What graph-projection.ts created, dropped with the nodes. */
const CATALOGUE_SCHEMA = {
  constraints: [
    "cinema_title_identifier", "cinema_work_key", "cinema_canonical_qid", "cinema_person_name",
    "cinema_genre_name", "cinema_country_name", "cinema_subject_name", "cinema_collection_name",
  ],
  indexes: ["cinemaCanonicalAliases"],
};
const DONE_KEY = "catalogue_out_of_graph";
const BATCH = 5_000;

export interface CatalogueCleanup { nodes: number; people: number }

export async function dropCatalogueFromGraph(graph: GraphDriver | null, db: SqliteDb): Promise<CatalogueCleanup | null> {
  if (!graph?.capabilities.cypher || graph.slug !== "relate") return null;
  const done = db.prepare("SELECT value FROM cinema_graph_state WHERE key = ?").get(DONE_KEY) as { value: string } | undefined;
  if (done?.value === "1") return null;

  const drain = async (cypher: string, params?: Record<string, unknown>): Promise<number> => {
    let total = 0;
    for (;;) {
      const r = await graph.run(cypher, params);
      const n = Number(r.records[0]?.get("n") ?? 0);
      total += n;
      if (n === 0) return total;
    }
  };
  const nodes = await drain(
    `MATCH (n) WHERE any(l IN labels(n) WHERE l IN $labels)
     WITH n LIMIT ${BATCH} DETACH DELETE n RETURN count(*) AS n`,
    { labels: CATALOGUE_LABELS },
  );
  const people = await drain(
    `MATCH (p:Person) WHERE p.id IS NULL WITH p LIMIT ${BATCH} DETACH DELETE p RETURN count(*) AS n`,
  );
  for (const name of CATALOGUE_SCHEMA.constraints) {
    await graph.run(`DROP CONSTRAINT ${name} IF EXISTS`).catch(() => {});
  }
  for (const name of CATALOGUE_SCHEMA.indexes) {
    await graph.run(`DROP INDEX ${name} IF EXISTS`).catch(() => {});
  }
  db.prepare(
    "INSERT INTO cinema_graph_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
  ).run(DONE_KEY);
  if (nodes || people) log.info(`cinema: took the catalogue out of the graph — ${nodes} nodes and ${people} people`);
  return { nodes, people };
}
