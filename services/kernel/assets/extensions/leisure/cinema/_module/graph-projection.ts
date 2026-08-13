/**
 * SQLite → Neo4j projection for the catalogue.
 *
 * `embeddings.ts` already writes one `(:CinemaTitle)` per embedded item, which
 * is enough to answer "what resembles this vector" and nothing else. It carries
 * no edges, so every question about how the catalogue hangs together — other
 * films by this director, what this release is a copy of, which items share a
 * subject — still has to be answered by joining in SQL, one query shape at a
 * time.
 *
 * This module projects the rest: the release groups, the Wikidata identities
 * behind them, and the people, genres, countries, subjects and collections they
 * point at. It is deliberately additive — it MERGEs onto the same
 * `(:CinemaTitle {identifier})` nodes the embedder writes, so vectors and edges
 * end up on one node and neither pass has to wait for the other.
 *
 * ## Why aliases are a property, not nodes
 *
 * `cinema_canonical_aliases` holds ~641k multilingual aliases for ~258k works.
 * Modelled as nodes they would nearly double the graph to buy nothing: nobody
 * traverses *from* an alias. They live as a string array on the work, covered
 * by a full-text index, which is the shape the actual question wants — "given
 * this messy release title, which canonical work is it?"
 *
 * ## Why order matters
 *
 * Entities project in dependency order (canonical → works → members → facets)
 * so an edge's endpoints exist by the time it is written. MERGE would create
 * them regardless, but a MERGE that invents an endpoint writes a node with no
 * properties and hides the fact that a row was missing.
 */

import { log } from "../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import { DEDUPE_EXCLUDED_COLLECTIONS } from "./works.js";

/** Rows pulled from SQLite per batch. Sized so one batch is a few MB of
 *  parameters — large enough that per-round-trip cost disappears, small
 *  enough that a stop() is felt promptly. */
export const DEFAULT_BATCH_SIZE = 2000;

// ── Schema ─────────────────────────────────────────────────────────────

/**
 * Uniqueness constraints for every key the projection MERGEs on, plus the
 * alias full-text index.
 *
 * These are not optional bookkeeping. `MERGE (n:L {k: $v})` without an index on
 * `L.k` scans every node carrying that label, so the cost of each write grows
 * with the graph and a 1M-row projection degrades into a quadratic crawl. With
 * the constraints in place the same projection stays flat.
 */
const CONSTRAINTS: Array<{ name: string; label: string; property: string }> = [
  { name: "cinema_title_identifier", label: "CinemaTitle", property: "identifier" },
  { name: "cinema_work_key", label: "CinemaWork", property: "work_key" },
  { name: "cinema_canonical_qid", label: "CanonicalWork", property: "qid" },
  { name: "cinema_person_name", label: "Person", property: "name_norm" },
  { name: "cinema_genre_name", label: "Genre", property: "name" },
  { name: "cinema_country_name", label: "Country", property: "name" },
  { name: "cinema_subject_name", label: "Subject", property: "name_norm" },
  { name: "cinema_collection_name", label: "Collection", property: "name" },
];

export const ALIAS_INDEX = "cinemaCanonicalAliases";

/**
 * True for errors Neo4j itself labels transient — deadlocks and lock-acquisition
 * timeouts. Schema changes take a lock on the whole label, so they collide with
 * the embedding worker writing `:CinemaTitle` at the same time. Nothing is
 * wrong when this happens; the loser just has to ask again.
 */
function isTransient(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  return code.startsWith("Neo.TransientError.");
}

/** Run a statement, retrying transient lock conflicts with a widening pause. */
async function runWithRetry(
  graph: GraphDriver,
  cypher: string,
  attempts = 6,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await graph.run(cypher);
      return;
    } catch (err) {
      if (!isTransient(err) || attempt >= attempts) throw err;
      const pause = 500 * attempt;
      log.debug(`cinema graph: transient lock conflict, retrying in ${pause}ms (${attempt}/${attempts})`);
      await new Promise((r) => setTimeout(r, pause));
    }
  }
}

/** True when Neo4j refused a constraint because the data already violates it. */
function isConstraintViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code ?? "";
  return (
    code === "Neo.DatabaseError.Schema.ConstraintCreationFailed" ||
    msg.includes("Unable to create Constraint")
  );
}

/**
 * Collapse nodes that share a key, keeping the richest one.
 *
 * Only reachable before the uniqueness constraint exists, which is the window
 * in which duplicates can appear at all: `MERGE` is atomic *per transaction*,
 * so two concurrent batches MERGEing the same key with no constraint to
 * arbitrate will each create a node. The constraint this repairs the way for
 * is what stops it happening again.
 *
 * Preference goes to a node carrying an embedding — losing a vector means the
 * embedding worker has to redo that row, while losing a bare duplicate costs
 * nothing.
 */
async function dedupeByKey(graph: GraphDriver, label: string, property: string): Promise<number> {
  const result = await graph.run(
    `MATCH (n:${label})
     WITH n.${property} AS key, collect(n) AS nodes
     WHERE size(nodes) > 1
     WITH nodes, head([x IN nodes WHERE x.embedding IS NOT NULL] + nodes) AS keep
     UNWIND [x IN nodes WHERE elementId(x) <> elementId(keep)] AS dup
     DETACH DELETE dup
     RETURN count(dup) AS removed`,
  );
  const removed = result.records[0]?.get("removed");
  return typeof removed === "number" ? removed : Number(removed ?? 0);
}

export async function ensureProjectionSchema(graph: GraphDriver): Promise<void> {
  for (const c of CONSTRAINTS) {
    const cypher =
      `CREATE CONSTRAINT ${c.name} IF NOT EXISTS
       FOR (n:${c.label}) REQUIRE n.${c.property} IS UNIQUE`;
    try {
      await runWithRetry(graph, cypher);
    } catch (err) {
      if (!isConstraintViolation(err)) throw err;
      const removed = await dedupeByKey(graph, c.label, c.property);
      log.warn(
        `cinema graph: ${c.label}.${c.property} had duplicates from unconstrained ` +
        `MERGEs — collapsed ${removed} node(s), retrying the constraint`,
      );
      await runWithRetry(graph, cypher);
    }
  }
  await runWithRetry(
    graph,
    `CREATE FULLTEXT INDEX ${ALIAS_INDEX} IF NOT EXISTS
     FOR (w:CanonicalWork) ON EACH [w.label, w.aliases]`,
  );
  log.info(`cinema graph: schema ready (${CONSTRAINTS.length} constraints + alias full-text index)`);
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Key for people and subjects, which arrive as free text with inconsistent
 *  case and spacing. Without folding, "John Ford" and "john  ford" become two
 *  people and every director edge splits in half. */
function normName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Parse a JSON array column into clean strings. These columns are
 *  `NOT NULL DEFAULT '[]'`, but archive.org metadata also arrives as a bare
 *  string often enough that treating a parse failure as "no values" would
 *  quietly drop real subjects. */
function parseStringArray(raw: string): string[] {
  if (!raw || raw === "[]") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
    return [];
  } catch {
    const bare = raw.trim();
    return bare ? [bare] : [];
  }
}

/** Split a delimited metadata field ("Ford, John; Wayne, Marion") into names.
 *  Semicolons are the reliable separator here — commas appear inside
 *  "Surname, Given" forms and splitting on them would shred every name. */
function splitPeople(raw: string): string[] {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

export interface ProjectionBatchResult {
  /** Rows read from SQLite. Zero means this entity has reached its end. */
  rows: number;
  /** Primary key of the last row read — the resume point. */
  cursor: string;
  nodes: number;
  rels: number;
}

interface Projector {
  entity: string;
  label: string;
  run(db: SqliteDb, graph: GraphDriver, cursor: string, limit: number): Promise<ProjectionBatchResult>;
}

// ── Canonical works ────────────────────────────────────────────────────

/**
 * Wikidata identities, with their aliases, director, genres and country.
 *
 * This is the identity layer: the thing a release is a copy *of*. Everything
 * else in the projection either points here or hangs off something that does.
 */
const canonicalProjector: Projector = {
  entity: "canonical",
  label: "CanonicalWork",
  async run(db, graph, cursor, limit) {
    const rows = db
      .prepare(
        `SELECT qid, label, year, imdb_id, director, country, genre_json,
                duration_min, ext_rating, ext_votes
           FROM cinema_canonical_works
          WHERE qid > ?
       ORDER BY qid
          LIMIT ?`,
      )
      .all(cursor, limit) as Array<{
      qid: string; label: string; year: number; imdb_id: string;
      director: string; country: string; genre_json: string;
      duration_min: number; ext_rating: number; ext_votes: number;
    }>;
    if (rows.length === 0) return { rows: 0, cursor, nodes: 0, rels: 0 };

    // Aliases for exactly this page, grouped in memory. Fetching them per work
    // would be one round trip per row; fetching all 641k up front would not fit.
    const qids = rows.map((r) => r.qid);
    const placeholders = qids.map(() => "?").join(",");
    const aliasRows = db
      .prepare(
        `SELECT qid, alias_raw, alias_norm FROM cinema_canonical_aliases
          WHERE qid IN (${placeholders})`,
      )
      .all(...qids) as Array<{ qid: string; alias_raw: string; alias_norm: string }>;
    const aliasesByQid = new Map<string, Set<string>>();
    for (const a of aliasRows) {
      const value = (a.alias_raw || a.alias_norm || "").trim();
      if (!value) continue;
      let set = aliasesByQid.get(a.qid);
      if (!set) { set = new Set(); aliasesByQid.set(a.qid, set); }
      set.add(value);
    }

    const works = rows.map((r) => ({
      qid: r.qid,
      label: r.label,
      year: r.year,
      imdb_id: r.imdb_id,
      duration_min: r.duration_min,
      ext_rating: r.ext_rating,
      ext_votes: r.ext_votes,
      aliases: [...(aliasesByQid.get(r.qid) ?? [])],
    }));
    await graph.run(
      `UNWIND $works AS w
       MERGE (c:CanonicalWork {qid: w.qid})
       SET c.label = w.label, c.year = w.year, c.imdb_id = w.imdb_id,
           c.duration_min = w.duration_min, c.ext_rating = w.ext_rating,
           c.ext_votes = w.ext_votes, c.aliases = w.aliases,
           c.updated_at = timestamp()`,
      { works },
    );

    let rels = 0;

    const directed = rows.flatMap((r) =>
      splitPeople(r.director).map((name) => ({
        qid: r.qid, name, name_norm: normName(name),
      })),
    ).filter((d) => d.name_norm);
    if (directed.length > 0) {
      await graph.run(
        `UNWIND $directed AS d
         MATCH (c:CanonicalWork {qid: d.qid})
         MERGE (p:Person {name_norm: d.name_norm})
           ON CREATE SET p.name = d.name
         MERGE (c)-[:DIRECTED_BY]->(p)`,
        { directed },
      );
      rels += directed.length;
    }

    const genres = rows.flatMap((r) =>
      parseStringArray(r.genre_json).map((name) => ({ qid: r.qid, name })),
    );
    if (genres.length > 0) {
      await graph.run(
        `UNWIND $genres AS g
         MATCH (c:CanonicalWork {qid: g.qid})
         MERGE (x:Genre {name: g.name})
         MERGE (c)-[:HAS_GENRE]->(x)`,
        { genres },
      );
      rels += genres.length;
    }

    const countries = rows
      .filter((r) => r.country.trim() !== "")
      .map((r) => ({ qid: r.qid, name: r.country.trim() }));
    if (countries.length > 0) {
      await graph.run(
        `UNWIND $countries AS c
         MATCH (w:CanonicalWork {qid: c.qid})
         MERGE (x:Country {name: c.name})
         MERGE (w)-[:FROM_COUNTRY]->(x)`,
        { countries },
      );
      rels += countries.length;
    }

    return { rows: rows.length, cursor: rows[rows.length - 1].qid, nodes: rows.length, rels };
  },
};

// ── Release groups ─────────────────────────────────────────────────────

/** The grouping layer: many archive.org copies collapse into one release,
 *  which may or may not be tied to a canonical identity. */
const worksProjector: Projector = {
  entity: "works",
  label: "CinemaWork",
  async run(db, graph, cursor, limit) {
    const rows = db
      .prepare(
        `SELECT work_key, qid, title, year, primary_identifier, copies,
                downloads, week_downloads, num_reviews, avg_rating
           FROM cinema_works
          WHERE work_key > ?
       ORDER BY work_key
          LIMIT ?`,
      )
      .all(cursor, limit) as Array<{
      work_key: string; qid: string; title: string; year: number;
      primary_identifier: string; copies: number; downloads: number;
      week_downloads: number; num_reviews: number; avg_rating: number;
    }>;
    if (rows.length === 0) return { rows: 0, cursor, nodes: 0, rels: 0 };

    await graph.run(
      `UNWIND $works AS w
       MERGE (k:CinemaWork {work_key: w.work_key})
       SET k.title = w.title, k.year = w.year,
           k.primary_identifier = w.primary_identifier,
           k.copies = w.copies, k.downloads = w.downloads,
           k.week_downloads = w.week_downloads,
           k.num_reviews = w.num_reviews, k.avg_rating = w.avg_rating,
           k.updated_at = timestamp()`,
      { works: rows },
    );

    let rels = 0;
    // Only ~a third of releases are identified; the rest are the long tail
    // Wikidata does not catalogue, and they stay unlinked rather than guessed.
    const identified = rows
      .filter((r) => r.qid.trim() !== "")
      .map((r) => ({ work_key: r.work_key, qid: r.qid }));
    if (identified.length > 0) {
      await graph.run(
        `UNWIND $identified AS i
         MATCH (k:CinemaWork {work_key: i.work_key})
         MERGE (c:CanonicalWork {qid: i.qid})
         MERGE (k)-[:IDENTIFIED_AS]->(c)`,
        { identified },
      );
      rels += identified.length;
    }

    return { rows: rows.length, cursor: rows[rows.length - 1].work_key, nodes: rows.length, rels };
  },
};

// ── Membership ─────────────────────────────────────────────────────────

/**
 * Which item belongs to which release group.
 *
 * This MERGEs the `(:CinemaTitle)` too rather than only matching it. The
 * embedding worker creates those nodes as it goes and is still far from the end
 * of the catalogue; waiting for it would leave the graph's edges hostage to an
 * unrelated pass. A node created here is bare, and the embedder fills in the
 * vector when it reaches that row.
 */
const membersProjector: Projector = {
  entity: "members",
  label: "CinemaTitle",
  async run(db, graph, cursor, limit) {
    const rows = db
      .prepare(
        // The soft-delete check belongs in the JOIN, not the WHERE: a deleted
        // title should read as "no metadata" while the membership itself
        // survives. Moving it to WHERE would turn this into an inner join and
        // silently drop the edge along with the title.
        `SELECT m.identifier, m.work_key, t.title, t.year, t.has_torrent
           FROM cinema_work_members m
           LEFT JOIN cinema_titles t
             ON t.identifier = m.identifier AND t.deleted_at IS NULL
          WHERE m.identifier > ?
       ORDER BY m.identifier
          LIMIT ?`,
      )
      .all(cursor, limit) as Array<{
      identifier: string; work_key: string;
      title: string | null; year: number | null; has_torrent: number | null;
    }>;
    if (rows.length === 0) return { rows: 0, cursor, nodes: 0, rels: 0 };

    const members = rows.map((r) => ({
      identifier: r.identifier,
      work_key: r.work_key,
      title: r.title ?? "",
      year: r.year ?? 0,
      has_torrent: (r.has_torrent ?? 0) === 1,
    }));
    await graph.run(
      `UNWIND $members AS m
       MERGE (t:CinemaTitle {identifier: m.identifier})
         ON CREATE SET t.title = m.title, t.year = m.year,
                       t.has_torrent = m.has_torrent, t.updated_at = timestamp()
       MERGE (k:CinemaWork {work_key: m.work_key})
       MERGE (t)-[:MEMBER_OF]->(k)`,
      { members },
    );

    return {
      rows: rows.length,
      cursor: rows[rows.length - 1].identifier,
      nodes: rows.length,
      rels: rows.length,
    };
  },
};

// ── Item facets ────────────────────────────────────────────────────────

/** Creator, subjects and collections straight off the item. These are the
 *  edges that reach the 81 popular cartoons Wikidata never catalogued — the
 *  ones every identity-based signal is blind to. */
const facetsProjector: Projector = {
  entity: "facets",
  label: "CinemaTitle",
  async run(db, graph, cursor, limit) {
    const rows = db
      .prepare(
        `SELECT identifier, creator, subject_json, collection_json
           FROM cinema_titles
          WHERE identifier > ? AND deleted_at IS NULL
       ORDER BY identifier
          LIMIT ?`,
      )
      .all(cursor, limit) as Array<{
      identifier: string; creator: string;
      subject_json: string; collection_json: string;
    }>;
    if (rows.length === 0) return { rows: 0, cursor, nodes: 0, rels: 0 };

    let rels = 0;

    const creators = rows.flatMap((r) =>
      splitPeople(r.creator).map((name) => ({
        identifier: r.identifier, name, name_norm: normName(name),
      })),
    ).filter((c) => c.name_norm);
    if (creators.length > 0) {
      await graph.run(
        `UNWIND $creators AS c
         MERGE (t:CinemaTitle {identifier: c.identifier})
         MERGE (p:Person {name_norm: c.name_norm})
           ON CREATE SET p.name = c.name
         MERGE (t)-[:CREATED_BY]->(p)`,
        { creators },
      );
      rels += creators.length;
    }

    const subjects = rows.flatMap((r) =>
      parseStringArray(r.subject_json).map((name) => ({
        identifier: r.identifier, name, name_norm: normName(name),
      })),
    ).filter((s) => s.name_norm);
    if (subjects.length > 0) {
      await graph.run(
        `UNWIND $subjects AS s
         MERGE (t:CinemaTitle {identifier: s.identifier})
         MERGE (x:Subject {name_norm: s.name_norm})
           ON CREATE SET x.name = s.name
         MERGE (t)-[:ABOUT]->(x)`,
        { subjects },
      );
      rels += subjects.length;
    }

    const collections = rows.flatMap((r) =>
      parseStringArray(r.collection_json).map((name) => ({
        identifier: r.identifier, name,
      })),
    );
    if (collections.length > 0) {
      await graph.run(
        `UNWIND $collections AS c
         MERGE (t:CinemaTitle {identifier: c.identifier})
         MERGE (x:Collection {name: c.name})
         MERGE (t)-[:IN_COLLECTION]->(x)`,
        { collections },
      );
      rels += collections.length;
    }

    return {
      rows: rows.length,
      cursor: rows[rows.length - 1].identifier,
      nodes: rows.length,
      rels,
    };
  },
};

// ── Title-level matches ────────────────────────────────────────────────

/**
 * What each individual upload was matched to, which the work-level rollup
 * cannot represent.
 *
 * `rebuildWorks` drops trailers from grouping on purpose: a trailer that
 * claimed its film's identity would inherit that film's rating and ranking,
 * which is the exact failure the matcher exists to prevent. Correct — under a
 * model whose only relation is "is a copy of". But the match itself is real
 * information (a trailer for Nosferatu *is* about Nosferatu) and today it is
 * discarded entirely: 34k decisions with nowhere to live.
 *
 * A graph has no such constraint. `TRAILER_FOR` and `COPY_OF` are different
 * edges, so both facts can be held at once without either contaminating the
 * other — a copy-of traversal never sees a trailer, and "everything about this
 * film" finally can.
 */
const matchesProjector: Projector = {
  entity: "matches",
  label: "CinemaTitle",
  async run(db, graph, cursor, limit) {
    const rows = db
      .prepare(
        `SELECT m.identifier, m.qid, m.score, t.collection_json
           FROM cinema_title_matches m
           JOIN cinema_titles t ON t.identifier = m.identifier
          WHERE m.identifier > ?
            AND m.state IN ('auto','confirmed')
            AND m.qid <> ''
            AND t.deleted_at IS NULL
       ORDER BY m.identifier
          LIMIT ?`,
      )
      .all(cursor, limit) as Array<{
      identifier: string; qid: string; score: number; collection_json: string;
    }>;
    if (rows.length === 0) return { rows: 0, cursor, nodes: 0, rels: 0 };

    const isTrailer = (json: string) =>
      DEDUPE_EXCLUDED_COLLECTIONS.some((c) => (json || "").includes(`"${c}"`));

    const trailers = rows.filter((r) => isTrailer(r.collection_json))
      .map((r) => ({ identifier: r.identifier, qid: r.qid, score: r.score }));
    const copies = rows.filter((r) => !isTrailer(r.collection_json))
      .map((r) => ({ identifier: r.identifier, qid: r.qid, score: r.score }));

    let rels = 0;
    if (trailers.length > 0) {
      await graph.run(
        `UNWIND $trailers AS m
         MERGE (t:CinemaTitle {identifier: m.identifier})
         MERGE (c:CanonicalWork {qid: m.qid})
         MERGE (t)-[r:TRAILER_FOR]->(c)
         SET r.score = m.score`,
        { trailers },
      );
      rels += trailers.length;
    }
    if (copies.length > 0) {
      await graph.run(
        `UNWIND $copies AS m
         MERGE (t:CinemaTitle {identifier: m.identifier})
         MERGE (c:CanonicalWork {qid: m.qid})
         MERGE (t)-[r:COPY_OF]->(c)
         SET r.score = m.score`,
        { copies },
      );
      rels += copies.length;
    }

    return {
      rows: rows.length,
      cursor: rows[rows.length - 1].identifier,
      nodes: 0,
      rels,
    };
  },
};

/** Dependency order — see the module header. */
export const PROJECTORS: Projector[] = [
  canonicalProjector,
  worksProjector,
  membersProjector,
  facetsProjector,
  matchesProjector,
];

// ── Cursors ────────────────────────────────────────────────────────────

export interface CursorRow {
  entity: string;
  cursor: string;
  projected: number;
  done: number;
}

export function readCursor(db: SqliteDb, entity: string): CursorRow {
  const row = db
    .prepare("SELECT entity, cursor, projected, done FROM cinema_graph_cursors WHERE entity = ?")
    .get(entity) as CursorRow | undefined;
  return row ?? { entity, cursor: "", projected: 0, done: 0 };
}

export function writeCursor(db: SqliteDb, entity: string, cursor: string, projected: number, done: boolean): void {
  db.prepare(
    `INSERT INTO cinema_graph_cursors (entity, cursor, projected, done, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity) DO UPDATE SET
       cursor = excluded.cursor,
       projected = excluded.projected,
       done = excluded.done,
       updated_at = excluded.updated_at`,
  ).run(entity, cursor, projected, done ? 1 : 0, new Date().toISOString());
}

/** Rewind every entity so the next pass re-walks the tables. Used to pick up
 *  rows that changed after a sweep finished. MERGE makes the re-walk
 *  idempotent, so this costs time and nothing else. */
export function resetCursors(db: SqliteDb): void {
  // `projected` counts the rows of the current sweep, so it rewinds with the
  // cursor. Letting it accumulate made it read as "rows in the table" while
  // actually reporting "rows ever written", which is double after one reset.
  db.prepare("UPDATE cinema_graph_cursors SET cursor = '', projected = 0, done = 0, updated_at = ?")
    .run(new Date().toISOString());
}

export function projectionProgress(db: SqliteDb): CursorRow[] {
  return PROJECTORS.map((p) => readCursor(db, p.entity));
}

// ── One pass ───────────────────────────────────────────────────────────

export interface ProjectionTickResult {
  entity: string;
  rows: number;
  nodes: number;
  rels: number;
  done: boolean;
  durationMs: number;
}

/**
 * Advance the projection by one batch of whichever entity still has work,
 * in dependency order. Returns null when every entity has reached its end.
 *
 * One call = one batch, like `embedPending` — the caller owns the cadence.
 */
export async function projectTick(
  db: SqliteDb,
  graph: GraphDriver | null,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<ProjectionTickResult | null> {
  if (!graph?.capabilities.cypher) {
    throw new Error("catalogue projection requires an active graph driver with cypher support");
  }
  for (const projector of PROJECTORS) {
    const state = readCursor(db, projector.entity);
    if (state.done === 1) continue;

    const t0 = Date.now();
    const result = await projector.run(db, graph, state.cursor, batchSize);
    // A short page means the table ended: the projector asked for `batchSize`
    // rows and SQLite had fewer left.
    const done = result.rows < batchSize;
    writeCursor(
      db,
      projector.entity,
      result.cursor,
      state.projected + result.rows,
      done,
    );
    return {
      entity: projector.entity,
      rows: result.rows,
      nodes: result.nodes,
      rels: result.rels,
      done,
      durationMs: Date.now() - t0,
    };
  }
  return null;
}
