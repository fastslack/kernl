/**
 * Recovering identities the year-blocked matcher structurally cannot reach.
 *
 * `canonical/matcher.ts` finds candidates by taking every canonical work within
 * ±3 years of the upload and scoring their aliases. That blocking is what makes
 * it fast over a 258k corpus, and it is why an upload with no year gets no
 * candidates at all — not a low score, *no candidates* — and why one whose year
 * is wrong by more than three looks at the wrong shelf entirely.
 *
 * The alias full-text index does not care about years. Given a messy release
 * title it returns the works whose aliases read like it, out of all 258k at
 * once. That is the whole contribution here: **recall**. Scoring is deliberately
 * the matcher's own `titleSimilarity`, and the bar is its own `REVIEW_FLOOR`, so
 * a proposal from this path is worth exactly what a proposal from that path is
 * worth — only found differently.
 *
 * ## Nothing here decides anything
 *
 * Every proposal lands in `state='review'`, never `auto`. The matcher refuses to
 * auto-accept a yearless upload on purpose: with no year there is no
 * disambiguator, and a confident-looking wrong answer is the failure this whole
 * subsystem is built to avoid. Finding candidates does not change that, so these
 * go to the existing review lane and a human decides.
 *
 * Writes touch only rows the matcher left at `state='none'`. Human verdicts
 * (`confirmed`, `rejected`) and machine ones (`auto`, `review`) are never
 * overwritten, and everything written carries `matcher_version = GRAPH_PROPOSAL_VERSION`
 * so the whole contribution is one `DELETE ... WHERE matcher_version = …` away
 * from being undone.
 */

import { log } from "../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import { extractYear, normalizeTitle, titleSimilarity } from "./title-norm.js";
import { MATCHER_VERSION, REVIEW_FLOOR, yearFactor } from "./canonical/matcher.js";
import { ALIAS_INDEX } from "./graph-projection.js";

/**
 * Stamped on every row this path writes, well clear of `MATCHER_VERSION` so the
 * two never collide. Provenance is the point: a graph-derived proposal must be
 * distinguishable from a matcher verdict forever, not just until someone forgets.
 */
export const GRAPH_PROPOSAL_VERSION = 1000;

/** Full-text hits to consider per title before scoring. */
const CANDIDATES_PER_TITLE = 8;
/** Titles per pass. */
export const DEFAULT_RESOLVE_BATCH = 500;
/** In-memory GDS graph name for the component pass. */
const GDS_GRAPH = "cinemaResolve";

/**
 * Lucene's syntax characters, neutralised.
 *
 * Release titles are full of them — `[1968]`, `A/V`, `Who?`, `C++` — and an
 * unescaped one is not a bad result but a thrown query, which would take the
 * whole batch down with it.
 */
export function luceneEscape(raw: string): string {
  return raw.replace(/[+\-!(){}\[\]^"~*?:\\/&|]/g, "\\$&");
}

export interface ResolveBatchResult {
  /** Titles examined. Zero means there is nothing left unmatched. */
  titles: number;
  /** Titles that got at least one candidate above the floor. */
  withCandidates: number;
  /** CANDIDATE edges written. */
  candidates: number;
  cursor: string;
}

interface PendingTitle {
  identifier: string;
  title: string;
  year: number;
}

/**
 * Titles the matcher could not place: it either found nothing (`none`) or never
 * saw them. Ordered by identifier so the pass is resumable by cursor.
 */
function pendingTitles(db: SqliteDb, cursor: string, limit: number): PendingTitle[] {
  return db
    .prepare(
      `SELECT t.identifier, t.title, t.year
         FROM cinema_titles t
         LEFT JOIN cinema_title_matches m ON m.identifier = t.identifier
        WHERE t.identifier > ?
          AND t.deleted_at IS NULL
          AND t.hidden = 0
          AND (m.state IS NULL OR m.state = 'none')
     ORDER BY t.identifier
        LIMIT ?`,
    )
    .all(cursor, limit) as PendingTitle[];
}

/**
 * Ask the alias index for lookalikes, score them the matcher's way, and record
 * the survivors as CANDIDATE edges.
 *
 * One full-text query per title: batching them into a single Cypher call would
 * mean one OR-ed query whose scores are no longer per-title comparable.
 */
export async function proposeBatch(
  db: SqliteDb,
  graph: GraphDriver | null,
  cursor: string,
  limit: number = DEFAULT_RESOLVE_BATCH,
): Promise<ResolveBatchResult> {
  if (!graph?.capabilities.cypher) {
    throw new Error("candidate proposal requires an active graph driver with cypher support");
  }
  const titles = pendingTitles(db, cursor, limit);
  if (titles.length === 0) return { titles: 0, withCandidates: 0, candidates: 0, cursor };

  const edges: Array<{ identifier: string; qid: string; score: number }> = [];
  let withCandidates = 0;

  for (const t of titles) {
    const norm = normalizeTitle(t.title);
    if (!norm) continue;
    const query = luceneEscape(norm).trim();
    if (!query) continue;

    // The year in the metadata column, or the one the release title carries
    // ("Angel Puss (1944)") — same two places the matcher looks.
    const uploadYear = t.year > 0 ? t.year : extractYear(t.title);

    let hits: Array<{ qid: string; label: string; year: number; aliases: string[] }> = [];
    try {
      const result = await graph.run(
        `CALL db.index.fulltext.queryNodes($index, $query, {limit: $k})
         YIELD node
         RETURN node.qid AS qid, node.label AS label, node.year AS year,
                coalesce(node.aliases, []) AS aliases`,
        { index: ALIAS_INDEX, query, k: CANDIDATES_PER_TITLE },
      );
      hits = result.records.map((r) => ({
        qid: r.get("qid") as string,
        label: (r.get("label") as string) ?? "",
        year: Number(r.get("year") ?? 0),
        aliases: (r.get("aliases") as string[]) ?? [],
      }));
    } catch (err) {
      // A single unparseable title must not sink the batch.
      log.debug(`cinema resolve: full-text query failed for "${t.title}" — ${String(err)}`);
      continue;
    }

    // Lucene ranks by term overlap, which is the wrong yardstick for deciding
    // sameness — rescore with the matcher's own similarity against the best
    // alias each work answers to, then apply its year factor.
    //
    // Dropping the year BLOCKING is the point of this path; dropping the year
    // CHECK was a mistake that let "Angel Puss (1944)" propose a 1988 film of
    // the same name. `yearFactor` already encodes both halves of what is wanted
    // here: beyond three years apart it returns 0 and the candidate dies, while
    // an upload with no year at all gets 0.9 — enough to reach review on a
    // strong title, never enough to be accepted automatically.
    let matched = false;
    for (const h of hits) {
      if (!h.qid) continue;
      const factor = yearFactor(uploadYear, h.year);
      if (factor === 0) continue;
      let best = 0;
      for (const alias of [h.label, ...h.aliases]) {
        const score = titleSimilarity(norm, normalizeTitle(alias));
        if (score > best) best = score;
      }
      const final = best * factor;
      if (final >= REVIEW_FLOOR) {
        edges.push({ identifier: t.identifier, qid: h.qid, score: final });
        matched = true;
      }
    }
    if (matched) withCandidates++;
  }

  if (edges.length > 0) {
    await graph.run(
      `UNWIND $edges AS e
       MERGE (t:CinemaTitle {identifier: e.identifier})
       MERGE (c:CanonicalWork {qid: e.qid})
       MERGE (t)-[r:CANDIDATE]->(c)
       SET r.score = e.score`,
      { edges },
    );
  }

  return {
    titles: titles.length,
    withCandidates,
    candidates: edges.length,
    cursor: titles[titles.length - 1].identifier,
  };
}

// ── Component resolution ───────────────────────────────────────────────

export interface ComponentResult {
  components: number;
  /** Components holding exactly one canonical work — nothing rivals the match. */
  unrivalled: number;
  /** Components holding several — a human has to choose. */
  ambiguous: number;
  /** Rows written to the review lane. */
  proposed: number;
  /** Titles found to be copies of each other via a shared candidate. */
  coCopies: number;
}

/**
 * Group the candidate graph into connected components with GDS, then read each
 * component as a claim about the world.
 *
 * A component is a set of uploads and the canonical works they might be. When it
 * holds exactly ONE canonical work, nothing rivals that identity — the same
 * reasoning behind the matcher's unrivalled floor, applied to a cluster instead
 * of a single row. When it holds several, the uploads are still copies of *each
 * other* even though which film they are is open; that is a real answer to a
 * different question, and it is why this runs as a graph algorithm rather than a
 * per-row loop.
 */
export async function resolveComponents(
  db: SqliteDb,
  graph: GraphDriver | null,
): Promise<ComponentResult> {
  if (!graph?.capabilities.gds) {
    throw new Error("component resolution requires GDS — install the plugin and restart Neo4j");
  }

  // Drop first: a projection is a snapshot, and a stale one would answer about
  // the graph as it was several passes ago.
  await graph.run(`CALL gds.graph.drop($name, false) YIELD graphName`, { name: GDS_GRAPH })
    .catch(() => {});
  await graph.run(
    `CALL gds.graph.project($name,
       ['CinemaTitle', 'CanonicalWork'],
       { CANDIDATE: { orientation: 'UNDIRECTED' } })
     YIELD nodeCount`,
    { name: GDS_GRAPH },
  );

  const result = await graph.run(
    `CALL gds.wcc.stream($name) YIELD nodeId, componentId
     WITH componentId, gds.util.asNode(nodeId) AS n
     WITH componentId,
          collect(CASE WHEN n:CanonicalWork THEN n.qid END) AS rawQids,
          collect(CASE WHEN n:CinemaTitle THEN n END) AS rawTitles
     WITH componentId,
          [x IN rawQids WHERE x IS NOT NULL] AS qids,
          [x IN rawTitles WHERE x IS NOT NULL] AS titleNodes
     WHERE size(titleNodes) > 0 AND size(qids) > 0
     UNWIND titleNodes AS t
     OPTIONAL MATCH (t)-[r:CANDIDATE]->(:CanonicalWork)
     WITH componentId, qids, t, max(r.score) AS score
     RETURN componentId, qids,
            collect({id: t.identifier, score: coalesce(score, 0.0)}) AS titles`,
    { name: GDS_GRAPH },
  );

  await graph.run(`CALL gds.graph.drop($name, false) YIELD graphName`, { name: GDS_GRAPH })
    .catch(() => {});

  // Only rows the matcher gave up on. `state='none'` in the WHERE is the whole
  // safety story: an auto/confirmed/rejected/review row is never touched, so a
  // human verdict cannot be overwritten by a machine proposal.
  const propose = db.prepare(
    `UPDATE cinema_title_matches
        SET qid = ?, score = ?, state = 'review',
            candidates_json = ?, matcher_version = ${GRAPH_PROPOSAL_VERSION},
            matched_at = ?
      WHERE identifier = ? AND state = 'none'`,
  );
  const insert = db.prepare(
    `INSERT INTO cinema_title_matches
       (identifier, qid, score, state, candidates_json, matcher_version, matched_at)
     VALUES (?, ?, ?, 'review', ?, ${GRAPH_PROPOSAL_VERSION}, ?)
     ON CONFLICT(identifier) DO NOTHING`,
  );

  let unrivalled = 0, ambiguous = 0, proposed = 0, coCopies = 0;
  const now = new Date().toISOString();

  for (const record of result.records) {
    const titles = (record.get("titles") as Array<{ id: string; score: number }>) ?? [];
    const qids = (record.get("qids") as string[]) ?? [];
    const distinctQids = [...new Set(qids)];
    if (titles.length > 1) coCopies += titles.length;

    if (distinctQids.length === 1) {
      unrivalled++;
      const qid = distinctQids[0];
      const candidatesJson = JSON.stringify([{ qid, via: "graph-fulltext" }]);
      for (const t of titles) {
        const score = Number(t.score ?? 0);
        insert.run(t.id, qid, score, candidatesJson, now);
        const info = propose.run(qid, score, candidatesJson, now, t.id);
        proposed += info.changes ?? 0;
      }
    } else {
      ambiguous++;
    }
  }

  log.info(
    `cinema resolve: ${result.records.length} components — ${unrivalled} unrivalled, ` +
    `${ambiguous} ambiguous, ${proposed} rows sent to review`,
  );

  return {
    components: result.records.length,
    unrivalled,
    ambiguous,
    proposed,
    coCopies,
  };
}

/**
 * Undo everything this path ever wrote. Provenance made actionable.
 *
 * The version stamp goes back to the matcher's too. A reverted row is once
 * again the matcher's `none` verdict, and leaving it stamped as a graph
 * proposal would claim this path still has an opinion about a row it has
 * explicitly withdrawn from.
 */
export function revertGraphProposals(db: SqliteDb): number {
  const info = db
    .prepare(
      `UPDATE cinema_title_matches
          SET qid = '', score = 0, state = 'none', candidates_json = '[]',
              matcher_version = ${MATCHER_VERSION}
        WHERE matcher_version = ${GRAPH_PROPOSAL_VERSION} AND state = 'review'`,
    )
    .run();
  return info.changes ?? 0;
}

/**
 * Repair rows left stamped as graph proposals while sitting at `none` — the
 * footprint of a revert that restored state but not provenance.
 */
export function clearStaleProposalStamps(db: SqliteDb): number {
  const info = db
    .prepare(
      `UPDATE cinema_title_matches
          SET matcher_version = ${MATCHER_VERSION}
        WHERE matcher_version = ${GRAPH_PROPOSAL_VERSION} AND state = 'none'`,
    )
    .run();
  return info.changes ?? 0;
}
