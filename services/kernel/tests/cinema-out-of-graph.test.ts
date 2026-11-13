/**
 * The cinema catalogue out of the graph (0.5.0):
 *   - recovering yearless uploads runs on SQLite FTS5 over the aliases, not on
 *     a Lucene index over graph nodes, and still only proposes for review;
 *   - a built-in graph that received the catalogue gives it back once, keeping
 *     the CRM's people and their own relationships.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import {
  ftsQuery, proposeBatch, resolveComponents, revertGraphProposals,
} from "../assets/extensions/leisure/cinema/_module/alias-resolve.js";
import { dropCatalogueFromGraph } from "../assets/extensions/leisure/cinema/_module/graph-cleanup.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";

const NOW = "2026-11-13T12:00:00Z";

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db as never, "cinema", cinemaMigrations);
  return db;
}

function work(db: Database, qid: string, label: string, year: number, aliases: string[]) {
  db.prepare("INSERT INTO cinema_canonical_works (qid, label, label_norm, year, fetched_at) VALUES (?, ?, ?, ?, ?)")
    .run(qid, label, label.toLowerCase(), year, NOW);
  for (const a of aliases) {
    db.prepare("INSERT OR IGNORE INTO cinema_canonical_aliases (qid, alias_norm, alias_raw) VALUES (?, ?, ?)").run(qid, a, a);
  }
}

function upload(db: Database, identifier: string, title: string, year = 0) {
  db.prepare(
    `INSERT INTO cinema_titles (identifier, title, year, ingested_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(identifier, title, year, NOW, NOW);
}

describe("an FTS5 query from a release title", () => {
  it("quotes every word, so FTS5 syntax in a title is text", () => {
    expect(ftsQuery("nueve reinas")).toBe('"nueve" OR "reinas"');
    expect(ftsQuery('who and or "near" a')).toBe('"who" OR "and" OR "or" OR """near"""');
    expect(ftsQuery("a")).toBe("");
  });
});

describe("recovering yearless uploads through the alias index", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    work(db, "Q1", "Nueve reinas", 2000, ["nueve reinas", "nine queens"]);
    work(db, "Q2", "Nueve semanas y media", 1986, ["nueve semanas y media", "9 1 2 weeks"]);
    work(db, "Q3", "Angel Puss", 1988, ["angel puss"]);
  });

  it("proposes the work whose alias reads like the title, for review only", () => {
    upload(db, "up-1", "Nine Queens");
    upload(db, "up-2", "Nueve Reinas DVDRip");
    const r = proposeBatch(db, "");
    expect(r.titles).toBe(2);
    const cands = db.prepare("SELECT identifier, qid FROM cinema_resolve_candidates ORDER BY identifier").all() as Array<{ identifier: string; qid: string }>;
    expect(cands.filter((c) => c.qid === "Q1").map((c) => c.identifier)).toContain("up-1");

    const c = resolveComponents(db);
    expect(c.unrivalled).toBeGreaterThan(0);
    const row = db.prepare("SELECT qid, state, candidates_json FROM cinema_title_matches WHERE identifier = 'up-1'").get() as
      { qid: string; state: string; candidates_json: string };
    expect(row.qid).toBe("Q1");
    expect(row.state).toBe("review");
    expect(row.candidates_json).toContain("graph-fulltext");

    expect(revertGraphProposals(db)).toBeGreaterThan(0);
    const after = db.prepare("SELECT state FROM cinema_title_matches WHERE identifier = 'up-1'").get() as { state: string };
    expect(after.state).toBe("none");
  });

  it("keeps the year check: a title with a year far from the work's gets nothing", () => {
    upload(db, "up-3", "Angel Puss (1944)");
    proposeBatch(db, "");
    const n = db.prepare("SELECT count(*) AS n FROM cinema_resolve_candidates WHERE identifier = 'up-3'").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("never overwrites a verdict", () => {
    upload(db, "up-1", "Nine Queens");
    db.prepare("INSERT INTO cinema_title_matches (identifier, qid, state, matched_at) VALUES ('up-1', 'Q9', 'rejected', ?)").run(NOW);
    // Not pending: the proposal pass skips it, and a candidate written by hand is not applied.
    expect(proposeBatch(db, "").titles).toBe(0);
    db.prepare("INSERT INTO cinema_resolve_candidates (identifier, qid, score) VALUES ('up-1', 'Q1', 0.95)").run();
    resolveComponents(db);
    const row = db.prepare("SELECT qid, state FROM cinema_title_matches WHERE identifier = 'up-1'").get() as { qid: string; state: string };
    expect(row).toEqual({ qid: "Q9", state: "rejected" });
  });

  it("indexes aliases pulled after the migration", () => {
    work(db, "Q4", "El secreto de sus ojos", 2009, ["el secreto de sus ojos", "the secret in their eyes"]);
    upload(db, "up-4", "The Secret in Their Eyes");
    proposeBatch(db, "");
    const c = db.prepare("SELECT qid FROM cinema_resolve_candidates WHERE identifier = 'up-4'").all() as Array<{ qid: string }>;
    expect(c.map((x) => x.qid)).toContain("Q4");
  });
});

describe.skipIf(!relateClientInstalled())("taking the catalogue out of a built-in graph", () => {
  it("removes the catalogue and cinema's people once, and keeps the CRM's", async () => {
    const db = freshDb();
    const graph = new RelateGraphDriver();
    graph.configure({ path: ":memory:" });
    await graph.start();
    await graph.run(`
      CREATE (l:Person {id: 'p1', name: 'Lucía Ferreyra'}), (b:Person {id: 'p2', name: 'Bruno'})
      CREATE (l)-[:KNOWS]->(b)
      CREATE (t:CinemaTitle {identifier: 'ct1'}), (w:CanonicalWork {qid: 'Q1'}), (g:Genre {name: 'drama'})
      CREATE (d:Person {name_norm: 'fabian bielinsky'})
      CREATE (t)-[:IDENTIFIED_AS]->(w), (w)-[:HAS_GENRE]->(g), (w)-[:DIRECTED_BY]->(d), (w)-[:DIRECTED_BY]->(l)`);

    const r = await dropCatalogueFromGraph(graph, db as never);
    expect(r).toEqual({ nodes: 3, people: 1 });
    const left = await graph.run("MATCH (n) RETURN count(n) AS n");
    expect(Number(left.records[0].get("n"))).toBe(2);
    const knows = await graph.run("MATCH (:Person {id: 'p1'})-[k:KNOWS]->(:Person {id: 'p2'}) RETURN count(k) AS n");
    expect(Number(knows.records[0].get("n"))).toBe(1);

    expect(await dropCatalogueFromGraph(graph, db as never)).toBeNull();
    await graph.stop();
  });

  it("leaves a graph that is not the built-in one alone", async () => {
    const db = freshDb();
    const neo4jLike = { slug: "neo4j", capabilities: { cypher: true }, run: async () => { throw new Error("must not run"); } };
    expect(await dropCatalogueFromGraph(neo4jLike as never, db as never)).toBeNull();
  });
});
