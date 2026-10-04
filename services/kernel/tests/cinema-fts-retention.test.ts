/**
 * Cinema catalogue storage:
 *   - migration 20 rebuilds cinema_titles_fts as a contentless index; search
 *     results (and their bm25 order) must be the same before and after, and
 *     the triggers must keep the index in step with cinema_titles.
 *   - the "cinema.catalog-untouched" retention policy deletes old titles the
 *     user never touched, with their per-title rows, and nothing else.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import { cinemaRetentionPolicies } from "../assets/extensions/leisure/cinema/_module/retention.js";
import { rebuildWorks } from "../assets/extensions/leisure/cinema/_module/works.js";
import { runMigrations } from "../src/core/db/migrations.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";
import type { RetentionRunContext } from "../src/core/types.js";

const OLD = "2025-01-01T00:00:00.000Z";

interface Seed {
  title?: string;
  creator?: string;
  description?: string;
  subjects?: string[];
  year?: number;
  at?: string;
  deleted?: boolean;
  watchlist?: boolean;
  hidden?: boolean;
}

function insertTitle(db: SqliteDb, identifier: string, o: Seed = {}): void {
  const at = o.at ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO cinema_titles
      (identifier, title, year, creator, description, subject_json, collection_json,
       has_torrent, watchlist, hidden, ingested_at, last_seen_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, '["feature_films"]', 1, ?, ?, ?, ?, ?)
  `).run(
    identifier, o.title ?? identifier, o.year ?? 0, o.creator ?? "", o.description ?? "",
    JSON.stringify(o.subjects ?? []),
    o.watchlist ? 1 : 0, o.hidden ? 1 : 0,
    at, at, o.deleted ? at : null,
  );
}

const FIXTURE: Array<[string, Seed]> = [
  ["matrix-1999", { title: "The Matrix", creator: "Wachowski", subjects: ["Science fiction", "action"], description: "A hacker learns the truth." }],
  ["matrix-doc", { title: "Making of", creator: "Studio", subjects: ["documentary"], description: "Behind the matrix, the matrix and more matrix." }],
  ["metropolis", { title: "Metropolis", creator: "Fritz Lang", subjects: ["silent", "Science fiction"], description: "Película muda alemana." }],
  ["kid-chaplin", { title: "The Kid", creator: "Charlie Chaplin", subjects: ["silent", "comedy"], description: "Chaplin and a child." }],
  ["noir-1", { title: "Detour", creator: "Ulmer", subjects: ["film noir", "drama"], description: "A pianist hitchhikes west." }],
  ["noir-2", { title: "D.O.A.", creator: "Maté", subjects: ["noir"], description: "Peliculas de cine negro: a poisoned man." }],
  ["gone", { title: "Deleted Matrix copy", deleted: true }],
];

const QUERIES = ["matrix", "película", "peliculas", "noir drama", "chaplin", "science fiction", "silent", "zzz-none"];

function snapshot(svc: CinemaService) {
  return QUERIES.map((q) => ({
    q,
    fts: svc.fullTextSearch(q, 50),
    list: svc.list({ query: q, limit: 50 }).map((t) => t.identifier),
    count: svc.countAll({ query: q }),
  }));
}

function search(svc: CinemaService, q: string): string[] {
  return svc.fullTextSearch(q, 50).sort();
}

describe("cinema_titles_fts contentless migration", () => {
  let db: SqliteDb;
  let svc: CinemaService;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as SqliteDb;
    runMigrations(db, "cinema", cinemaMigrations.filter((m) => m.version < 20));
    svc = new CinemaService(db);
    for (const [id, seed] of FIXTURE) insertTitle(db, id, seed);
  });

  it("returns the same identifiers, in the same order, before and after", () => {
    const before = snapshot(svc);
    expect(before.find((s) => s.q === "matrix")!.fts.length).toBe(2);

    runMigrations(db, "cinema", cinemaMigrations);

    expect(snapshot(svc)).toEqual(before);
  });

  it("drops the content copy and runs exactly once", () => {
    const shadow = () =>
      (db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'cinema_titles_fts_%' ORDER BY name`).all() as Array<{ name: string }>)
        .map((r) => r.name);
    expect(shadow()).toContain("cinema_titles_fts_content");

    runMigrations(db, "cinema", cinemaMigrations);
    expect(shadow()).not.toContain("cinema_titles_fts_content");

    runMigrations(db, "cinema", cinemaMigrations);
    const applied = db.prepare(`SELECT COUNT(*) AS n FROM _migrations WHERE module = 'cinema' AND version = 20`).get() as { n: number };
    expect(applied.n).toBe(1);
    expect(search(svc, "matrix")).toEqual(["matrix-1999", "matrix-doc"]);
  });

  it("keeps search in step with inserts, updates and deletes", () => {
    runMigrations(db, "cinema", cinemaMigrations);

    insertTitle(db, "matrix-2003", { title: "The Matrix Reloaded" });
    expect(search(svc, "matrix")).toEqual(["matrix-1999", "matrix-2003", "matrix-doc"]);

    // Text change: the old tokens leave the index, the new ones arrive.
    db.prepare(`UPDATE cinema_titles SET title = 'Neo Returns' WHERE identifier = 'matrix-2003'`).run();
    expect(search(svc, "reloaded")).toEqual([]);
    expect(search(svc, "neo")).toEqual(["matrix-2003"]);

    // Subjects are indexed through subject_json.
    db.prepare(`UPDATE cinema_titles SET subject_json = '["cyberpunk"]' WHERE identifier = 'matrix-2003'`).run();
    expect(search(svc, "cyberpunk")).toEqual(["matrix-2003"]);

    // A non-indexed write leaves the entry alone (and still findable).
    db.prepare(`UPDATE cinema_titles SET embedded_at = '2026-01-01', watchlist = 1 WHERE identifier = 'matrix-2003'`).run();
    expect(search(svc, "neo")).toEqual(["matrix-2003"]);

    // Soft delete removes it from the index; undelete brings it back.
    db.prepare(`UPDATE cinema_titles SET deleted_at = '2026-01-02' WHERE identifier = 'matrix-2003'`).run();
    expect(search(svc, "neo")).toEqual([]);
    db.prepare(`UPDATE cinema_titles SET deleted_at = NULL WHERE identifier = 'matrix-2003'`).run();
    expect(search(svc, "neo")).toEqual(["matrix-2003"]);

    // Hard delete.
    db.prepare(`DELETE FROM cinema_titles WHERE identifier = 'matrix-2003'`).run();
    expect(search(svc, "neo")).toEqual([]);
    const ftsRows = db.prepare(`SELECT COUNT(*) AS n FROM cinema_titles_fts WHERE cinema_titles_fts MATCH '"neo" OR "cyberpunk"'`).get() as { n: number };
    expect(ftsRows.n).toBe(0);

    // Deleting a title that was never indexed (soft-deleted) is harmless.
    db.prepare(`DELETE FROM cinema_titles WHERE identifier = 'gone'`).run();
    expect(search(svc, "matrix")).toEqual(["matrix-1999", "matrix-doc"]);
  });
});

describe("cinema.catalog-untouched retention policy", () => {
  let db: SqliteDb;
  let svc: CinemaService;
  const policy = cinemaRetentionPolicies().find((p) => p.id === "cinema.catalog-untouched")!;

  function rc(batchSize: number): RetentionRunContext {
    const days = 180;
    return { db, days, cutoff: new Date(Date.now() - days * 86_400_000).toISOString(), batchSize };
  }

  const ids = () =>
    (db.prepare(`SELECT identifier FROM cinema_titles ORDER BY identifier`).all() as Array<{ identifier: string }>).map((r) => r.identifier);

  beforeEach(() => {
    db = new Database(":memory:") as unknown as SqliteDb;
    runMigrations(db, "cinema", cinemaMigrations);
    svc = new CinemaService(db);
    const now = new Date().toISOString();

    // Eligible: old, untouched, unlinked.
    insertTitle(db, "old-a", { at: OLD, title: "Forgotten Reel" });
    insertTitle(db, "old-b", { at: OLD, title: "Forgotten Short" });
    insertTitle(db, "old-c", { at: OLD, title: "Forgotten Newsreel" });
    // Recent: untouched but inside the window.
    insertTitle(db, "recent", { title: "Forgotten Today" });
    // Touched in each of the ways the policy knows.
    insertTitle(db, "t-watchlist", { at: OLD, watchlist: true });
    insertTitle(db, "t-hidden", { at: OLD, hidden: true });
    insertTitle(db, "t-watched", { at: OLD });
    db.prepare(`UPDATE cinema_titles SET watched_at = ? WHERE identifier = 't-watched'`).run(now);
    insertTitle(db, "t-subs", { at: OLD, title: "Same Film", year: 1931 });
    db.prepare(`INSERT INTO cinema_subs (id, identifier, tgt_lang, generated_at) VALUES ('s1', 't-subs', 'es', ?)`).run(now);
    insertTitle(db, "t-dir", { at: OLD });
    insertTitle(db, "t-cover", { at: OLD });
    db.prepare(`
      INSERT INTO cinema_directories (id, owner_pubkey, title, items_json, cover_identifier, created_at, updated_at)
      VALUES ('d1', 'pk', 'Mine', '[{"identifier":"t-dir","added_at":"x"}]', 't-cover', ?, ?)
    `).run(now, now);
    insertTitle(db, "t-transcribed", { at: OLD });
    db.prepare(`
      INSERT INTO cinema_transcribe_jobs (key, url, engine, model, created_at, updated_at, heartbeat_at)
      VALUES ('k1', 'https://archive.org/download/t-transcribed/file.mp4', 'whisper', 'base', ?, ?, ?)
    `).run(now, now, now);
    insertTitle(db, "t-rejected", { at: OLD });
    // Linked to a touched work: same qid as t-watchlist, same work group as t-subs.
    insertTitle(db, "copy-qid", { at: OLD });
    insertTitle(db, "copy-work", { at: OLD, title: "Same Film", year: 1931 });
    const match = db.prepare(`INSERT INTO cinema_title_matches (identifier, qid, state, matched_at) VALUES (?, ?, ?, ?)`);
    match.run("t-watchlist", "Q1", "auto", now);
    match.run("copy-qid", "Q1", "auto", now);
    match.run("t-rejected", "Q9", "rejected", now);
    match.run("old-a", "Q2", "auto", now);
    // Work groups come from the real grouping: same normalized title + year
    // puts t-subs and copy-work together, the shared qid does the same for
    // t-watchlist and copy-qid.
    rebuildWorks(db);
    const group = (id: string) =>
      (db.prepare(`SELECT work_key FROM cinema_work_members WHERE identifier = ?`).get(id) as { work_key: string }).work_key;
    expect(group("copy-work")).toBe(group("t-subs"));
    db.prepare(`INSERT INTO cinema_title_media (identifier, probed_at) VALUES ('old-a', ?)`).run(now);
    db.prepare(`
      INSERT INTO cinema_subs_index (id, provider_id, provider_event_id, identifier, tgt_lang, seen_at)
      VALUES ('i1', 'nostr', 'e1', 'old-a', 'es', ?)
    `).run(now);
  });

  it("is opt-in reference data and accounts for the FTS table", () => {
    expect(policy.kind).toBe("reference");
    expect(policy.defaultEnabled).toBe(false);
    expect(policy.tables).toContain("cinema_titles_fts");
  });

  it("estimates exactly what it purges and spares every touched title", () => {
    const estimate = policy.estimate(rc(1));
    expect(estimate).toBe(3);

    // The runner loops until a batch comes back short.
    let total = 0;
    for (;;) {
      const n = policy.purge(rc(1));
      total += n;
      if (n < 1) break;
    }
    expect(total).toBe(estimate);
    policy.afterPurge?.(rc(1), total);

    expect(ids()).toEqual([
      "copy-qid", "copy-work", "recent",
      "t-cover", "t-dir", "t-hidden", "t-rejected", "t-subs",
      "t-transcribed", "t-watched", "t-watchlist",
    ]);
    expect(policy.estimate(rc(1))).toBe(0);
  });

  it("deletes the dependent rows and keeps search consistent", () => {
    expect(svc.fullTextSearch("forgotten", 50).sort()).toEqual(["old-a", "old-b", "old-c", "recent"]);
    while (policy.purge(rc(100)) >= 100) { /* drain */ }
    policy.afterPurge?.(rc(100), 3);

    expect(svc.fullTextSearch("forgotten", 50)).toEqual(["recent"]);
    for (const table of ["cinema_title_matches", "cinema_work_members", "cinema_title_media", "cinema_subs_index"]) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE identifier = 'old-a'`).get() as { n: number };
      expect(n.n).toBe(0);
    }
    // Rebuilt derived tables reference only surviving titles.
    const orphans = db.prepare(`
      SELECT COUNT(*) AS n FROM cinema_works w
      WHERE NOT EXISTS (SELECT 1 FROM cinema_titles t WHERE t.identifier = w.primary_identifier)
    `).get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it("does nothing without an age cut", () => {
    const noCut: RetentionRunContext = { db, days: null, cutoff: null, batchSize: 100 };
    expect(policy.estimate(noCut)).toBe(0);
    expect(policy.purge(noCut)).toBe(0);
  });
});
