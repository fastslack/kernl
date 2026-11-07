/**
 * The cinema catalogue's share of the graph, bounded from System › Storage.
 *
 * The catalogue mirrors archive.org: 250k titles, each projected to Neo4j with
 * a vector and its facets — the bulk of a multi-GB graph, much of it trailers,
 * karaoke and dictionaries. The storage page lets the user leave whole
 * collections out and cap the number of titles; this file decides which
 * titles that keeps and makes the graph match.
 *
 * Who stays, in order:
 *   1. Everything the user touched (watchlist, watched, rated, subtitled, in a
 *      directory...) and every other copy of those works — the same rule the
 *      catalogue retention uses (`PROTECTED_CTE`). Never dropped, whatever the
 *      limits say, and not counted against a source the user excluded.
 *   2. The rest, most downloaded first, until the title ceiling.
 *
 * Titles left out stay in SQLite: text search, browsing and playback work as
 * before; only semantic search, "similar" and "for you" stop seeing them.
 * `cinema_graph_out` lists them, and the embedder and projectors skip it.
 */

import type { GraphBudget, GraphBudgetApplyResult, GraphDriver, GraphLimits, SqliteDb } from "@kernl/extension-sdk";
import { log } from "@kernl/extension-sdk";
import { PROTECTED_CTE } from "./retention.js";
import { resetCursors } from "./graph-projection.js";

export { isGraphFrozen } from "./graph-state.js";

export const CINEMA_GRAPH_BUDGET = "cinema.graph";
export const GRAPH_CAP_OPTIONS = [25_000, 50_000, 100_000, 250_000, 500_000];

/** SQL condition: the title is not kept out of the graph. Use on a column called `identifier`. */
export const IN_GRAPH = "identifier NOT IN (SELECT identifier FROM cinema_graph_out)";

/** Collections smaller than this are not offered as sources: a list of 2,000 one-item collections helps nobody. */
const MIN_SOURCE_TITLES = 200;
const DELETE_BATCH = 500;
const ORPHAN_BATCH = 5_000;

function setFrozen(db: SqliteDb, frozen: boolean): void {
  db.prepare(
    "INSERT INTO cinema_graph_state (key, value) VALUES ('frozen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(frozen ? "1" : "0");
}

/** Live titles per archive.org collection, biggest first. */
export function graphSources(db: SqliteDb): Array<{ key: string; count: number }> {
  return db
    .prepare(
      `SELECT j.value AS key, COUNT(*) AS count
         FROM cinema_titles t, json_each(CASE WHEN json_valid(t.collection_json) THEN t.collection_json ELSE '[]' END) j
        WHERE t.deleted_at IS NULL
     GROUP BY j.value
       HAVING COUNT(*) >= ?
     ORDER BY count DESC`,
    )
    .all(MIN_SOURCE_TITLES) as Array<{ key: string; count: number }>;
}

/**
 * Fill `cinema_graph_out_next` with the titles these limits keep out. A temp
 * table so the current list survives until the graph has caught up.
 */
export function computeKeptOut(db: SqliteDb, limits: Pick<GraphLimits, "excludedSources" | "maxItems">): void {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS cinema_graph_out_next (identifier TEXT PRIMARY KEY) WITHOUT ROWID");
  db.exec("DELETE FROM cinema_graph_out_next");
  db.exec("CREATE TEMP TABLE IF NOT EXISTS cinema_graph_protected (identifier TEXT PRIMARY KEY) WITHOUT ROWID");
  db.exec("DELETE FROM cinema_graph_protected");
  db.prepare(
    `${PROTECTED_CTE}
     INSERT OR IGNORE INTO cinema_graph_protected SELECT identifier FROM protected WHERE identifier IS NOT NULL`,
  ).run();

  // 1. Excluded sources: a title in any excluded collection goes, unless protected.
  if (limits.excludedSources.length > 0) {
    db.prepare(
      `INSERT OR IGNORE INTO cinema_graph_out_next
       SELECT t.identifier FROM cinema_titles t
        WHERE t.deleted_at IS NULL
          AND t.identifier NOT IN (SELECT identifier FROM cinema_graph_protected)
          AND EXISTS (
            SELECT 1 FROM json_each(CASE WHEN json_valid(t.collection_json) THEN t.collection_json ELSE '[]' END) c
             WHERE c.value IN (SELECT value FROM json_each(?))
          )`,
    ).run(JSON.stringify(limits.excludedSources));
  }

  // 2. Title ceiling: protected titles count toward it; the rest fill what is
  //    left, most downloaded first.
  if (limits.maxItems !== null) {
    const protectedLive = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM cinema_titles
          WHERE deleted_at IS NULL AND identifier IN (SELECT identifier FROM cinema_graph_protected)`,
      )
      .get() as { n: number }).n;
    const room = Math.max(0, limits.maxItems - protectedLive);
    db.prepare(
      `INSERT OR IGNORE INTO cinema_graph_out_next
       SELECT identifier FROM (
         SELECT t.identifier FROM cinema_titles t
          WHERE t.deleted_at IS NULL
            AND t.identifier NOT IN (SELECT identifier FROM cinema_graph_protected)
            AND t.identifier NOT IN (SELECT identifier FROM cinema_graph_out_next)
       ORDER BY t.downloads DESC, t.identifier
          LIMIT -1 OFFSET ?
       )`,
    ).run(room);
  }
}

async function deleteTitles(graph: GraphDriver, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    await graph.run(
      "UNWIND $ids AS id MATCH (t:CinemaTitle {identifier: id}) DETACH DELETE t",
      { ids: ids.slice(i, i + DELETE_BATCH) },
    );
  }
}

/**
 * Nodes the catalogue projected that nothing points at any more. Persons are
 * shared with CRM and Google sync; the catalogue's carry `name_norm` and no
 * `id`, and only those are touched.
 */
const ORPHAN_QUERIES = [
  "MATCH (k:CinemaWork) WHERE NOT ()-[:MEMBER_OF]->(k) WITH k LIMIT $n DETACH DELETE k RETURN count(*) AS n",
  "MATCH (c:CanonicalWork) WHERE NOT ()-[:IDENTIFIED_AS|COPY_OF|TRAILER_FOR]->(c) WITH c LIMIT $n DETACH DELETE c RETURN count(*) AS n",
  "MATCH (p:Person) WHERE p.name_norm IS NOT NULL AND p.id IS NULL AND NOT ()-->(p) WITH p LIMIT $n DETACH DELETE p RETURN count(*) AS n",
  "MATCH (x:Subject) WHERE NOT ()-->(x) WITH x LIMIT $n DETACH DELETE x RETURN count(*) AS n",
  "MATCH (x:Collection) WHERE NOT ()-->(x) WITH x LIMIT $n DETACH DELETE x RETURN count(*) AS n",
  "MATCH (x:Genre) WHERE NOT ()-->(x) WITH x LIMIT $n DETACH DELETE x RETURN count(*) AS n",
  "MATCH (x:Country) WHERE NOT ()-->(x) WITH x LIMIT $n DETACH DELETE x RETURN count(*) AS n",
];

async function deleteOrphans(graph: GraphDriver): Promise<number> {
  let total = 0;
  for (const q of ORPHAN_QUERIES) {
    for (;;) {
      const res = await graph.run(q, { n: ORPHAN_BATCH });
      const n = Number(res.records[0]?.get("n") ?? 0);
      total += n;
      if (n < ORPHAN_BATCH) break;
    }
  }
  return total;
}

export async function applyCinemaGraphLimits(
  db: SqliteDb,
  graph: GraphDriver,
  limits: GraphLimits,
): Promise<GraphBudgetApplyResult> {
  setFrozen(db, limits.frozen);
  computeKeptOut(db, limits);

  const newlyOut = (db
    .prepare("SELECT identifier FROM cinema_graph_out_next WHERE identifier NOT IN (SELECT identifier FROM cinema_graph_out)")
    .all() as Array<{ identifier: string }>).map((r) => r.identifier);
  const readmitted = (db
    .prepare("SELECT identifier FROM cinema_graph_out WHERE identifier NOT IN (SELECT identifier FROM cinema_graph_out_next)")
    .all() as Array<{ identifier: string }>).map((r) => r.identifier);

  // Graph first, list second: a crash in between leaves the old list, and the
  // next run works out the same difference and finishes the job.
  await deleteTitles(graph, newlyOut);

  db.transaction(() => {
    db.exec("DELETE FROM cinema_graph_out");
    db.exec("INSERT INTO cinema_graph_out SELECT identifier FROM cinema_graph_out_next");
    if (readmitted.length > 0) {
      // Their nodes are gone: re-embed them, which writes the node and its
      // vector back, and re-walk the projection for their edges.
      const mark = db.prepare("UPDATE cinema_titles SET embedded_at = NULL WHERE identifier = ?");
      for (const id of readmitted) mark.run(id);
    }
  })();
  if (readmitted.length > 0) resetCursors(db);

  const orphansRemoved = await deleteOrphans(graph);
  log.info(`cinema: graph limits applied — ${newlyOut.length} titles removed, ${readmitted.length} readmitted, ${orphansRemoved} orphan nodes`);
  return { removed: newlyOut.length, readmitted: readmitted.length, orphansRemoved };
}

const STATUS_LABELS = ["CinemaTitle", "CinemaWork", "CanonicalWork", "Person", "Subject"];

export function cinemaGraphBudget(): GraphBudget {
  return {
    id: CINEMA_GRAPH_BUDGET,
    label: "Cinema & leisure",
    unit: "titles",
    capOptions: GRAPH_CAP_OPTIONS,
    sources: (db) => {
      try {
        return graphSources(db);
      } catch {
        return [];
      }
    },
    async status(db, graph) {
      const keptOut = (() => {
        try {
          return (db.prepare("SELECT COUNT(*) AS n FROM cinema_graph_out").get() as { n: number }).n;
        } catch {
          return 0;
        }
      })();
      const nodes: Record<string, number> = {};
      if (graph?.capabilities.cypher) {
        for (const label of STATUS_LABELS) {
          // Label counts come from Neo4j's count store: constant time.
          const res = await graph.run(`MATCH (n:${label}) RETURN count(n) AS n`);
          nodes[label] = Number(res.records[0]?.get("n") ?? 0);
        }
      }
      return { inGraph: nodes.CinemaTitle ?? 0, keptOut, nodes };
    },
    apply: applyCinemaGraphLimits,
  };
}
