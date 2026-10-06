/**
 * Music catalogue storage:
 *   - archive-catalog migration 2 rebuilds music_titles_fts as a contentless
 *     index; the same searches must return the same identifiers in the same
 *     bm25 order, and the triggers must keep the index in step.
 *   - the "music.catalog-untouched" retention policy deletes old titles that
 *     are neither in the library nor in the play history.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { archiveCatalogMigrations } from "../assets/extensions/leisure/_lib/archive-catalog/migrations.js";
import { ArchiveCatalog } from "../assets/extensions/leisure/_lib/archive-catalog/service.js";
import { musicMigrations } from "../assets/extensions/leisure/music/_module/migrations/001_music.js";
import { musicRetentionPolicies } from "../assets/extensions/leisure/music/_module/retention.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";
import type { RetentionRunContext } from "../src/core/types.js";

const OLD = "2025-01-01T00:00:00.000Z";

const FIXTURE = [
  { identifier: "blues-1", title: "Delta Blues", creator: "Robert Johnson", subject: ["blues", "78rpm"], description: "Crossroad recordings." },
  { identifier: "blues-2", title: "City Blues", creator: "Bessie Smith", subject: ["blues", "jazz"], description: "Blues, blues and more blues." },
  { identifier: "tango", title: "Por una cabeza", creator: "Carlos Gardel", subject: ["tango"], description: "Canción argentina." },
  { identifier: "ambient", title: "Drift", creator: "Netlabel", subject: ["ambient", "electronic"], description: "Cancion sin palabras." },
  { identifier: "jazz", title: "Take Five", creator: "Quartet", subject: ["jazz"], description: "Cool jazz standard." },
];

const QUERIES = ["blues", "jazz", "cancion", "canción", "gardel tango", "electronic", "nothing-here"];

function search(db: SqliteDb, q: string): string[] {
  const match = q.split(/\s+/).map((t) => `"${t}"`).join(" ");
  return (db.prepare(`
    SELECT t.identifier
    FROM music_titles_fts f
    JOIN music_titles t ON t.rowid = f.rowid
    WHERE t.deleted_at IS NULL AND music_titles_fts MATCH ?
    ORDER BY bm25(music_titles_fts, 5.0, 2.0, 3.0, 1.0)
  `).all(match) as Array<{ identifier: string }>).map((r) => r.identifier);
}

const sorted = (db: SqliteDb, q: string) => search(db, q).sort();

describe("music_titles_fts contentless migration", () => {
  let db: SqliteDb;
  let catalog: ArchiveCatalog;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as SqliteDb;
    runMigrations(db, "music_catalog", archiveCatalogMigrations("music").filter((m) => m.version < 2));
    catalog = new ArchiveCatalog({ db, prefix: "music" });
    for (const row of FIXTURE) catalog.upsertFromScrape(row);
  });

  it("returns the same identifiers, in the same order, before and after", () => {
    const before = QUERIES.map((q) => search(db, q));
    expect(before[0].length).toBe(2);

    runMigrations(db, "music_catalog", archiveCatalogMigrations("music"));

    expect(QUERIES.map((q) => search(db, q))).toEqual(before);
  });

  it("drops the content copy and runs exactly once", () => {
    const hasContent = () =>
      !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'music_titles_fts_content'`).get();
    expect(hasContent()).toBe(true);
    runMigrations(db, "music_catalog", archiveCatalogMigrations("music"));
    expect(hasContent()).toBe(false);
    runMigrations(db, "music_catalog", archiveCatalogMigrations("music"));
    const n = db.prepare(`SELECT COUNT(*) AS n FROM _migrations WHERE module = 'music_catalog' AND version = 2`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("keeps search in step with the ingester's inserts, refreshes and deletes", () => {
    runMigrations(db, "music_catalog", archiveCatalogMigrations("music"));

    catalog.upsertFromScrape({ identifier: "blues-3", title: "Chicago Blues", subject: ["electric"] });
    expect(sorted(db, "blues")).toEqual(["blues-1", "blues-2", "blues-3"]);

    // A refresh that changes the text re-indexes the row.
    catalog.upsertFromScrape({ identifier: "blues-3", title: "Chicago Shuffle", subject: ["electric"] });
    expect(sorted(db, "blues")).toEqual(["blues-1", "blues-2"]);
    expect(sorted(db, "shuffle")).toEqual(["blues-3"]);

    // A refresh with identical text, and embedding bookkeeping, keep it findable.
    catalog.upsertFromScrape({ identifier: "blues-3", title: "Chicago Shuffle", subject: ["electric"] });
    catalog.markEmbedded("blues-3", "m", 384);
    expect(sorted(db, "shuffle")).toEqual(["blues-3"]);

    db.prepare(`UPDATE music_titles SET deleted_at = ? WHERE identifier = 'blues-3'`).run(OLD);
    expect(sorted(db, "shuffle")).toEqual([]);
    // The ingester un-deletes on the next sighting.
    catalog.upsertFromScrape({ identifier: "blues-3", title: "Chicago Shuffle", subject: ["electric"] });
    expect(sorted(db, "shuffle")).toEqual(["blues-3"]);

    db.prepare(`DELETE FROM music_titles WHERE identifier = 'blues-3'`).run();
    expect(sorted(db, "shuffle")).toEqual([]);
    expect(sorted(db, "electric")).toEqual([]);
  });
});

describe("music.catalog-untouched retention policy", () => {
  let db: SqliteDb;
  const policy = musicRetentionPolicies().find((p) => p.id === "music.catalog-untouched")!;

  function rc(batchSize: number): RetentionRunContext {
    const days = 180;
    return { db, days, cutoff: new Date(Date.now() - days * 86_400_000).toISOString(), batchSize };
  }

  beforeEach(() => {
    db = new Database(":memory:") as unknown as SqliteDb;
    runMigrations(db, "music", musicMigrations);
    runMigrations(db, "music_catalog", archiveCatalogMigrations("music"));
    const catalog = new ArchiveCatalog({ db, prefix: "music" });
    for (const id of ["old-a", "old-b", "old-c", "in-library", "played", "recent"]) {
      catalog.upsertFromScrape({ identifier: id, title: `Forgotten ${id}`, subject: ["blues"] });
    }
    db.prepare(`UPDATE music_titles SET ingested_at = ?, last_seen_at = ? WHERE identifier <> 'recent'`).run(OLD, OLD);
    db.prepare(`INSERT INTO music_library (identifier, title, added_at) VALUES ('in-library', 'x', ?)`).run(OLD);
    db.prepare(`INSERT INTO music_play_history (identifier, played_at) VALUES ('played', ?)`).run(OLD);
    catalog.rebuildTags();
  });

  it("is opt-in reference data and accounts for the FTS table", () => {
    expect(policy.kind).toBe("reference");
    expect(policy.defaultEnabled).toBe(false);
    expect(policy.tables).toEqual(["music_titles", "music_titles_fts"]);
  });

  it("estimates exactly what it purges and spares library and played titles", () => {
    const estimate = policy.estimate(rc(2));
    expect(estimate).toBe(3);
    let total = 0;
    for (;;) {
      const n = policy.purge(rc(2));
      total += n;
      if (n < 2) break;
    }
    expect(total).toBe(estimate);
    policy.afterPurge?.(rc(2), total);

    const left = (db.prepare(`SELECT identifier FROM music_titles ORDER BY identifier`).all() as Array<{ identifier: string }>)
      .map((r) => r.identifier);
    expect(left).toEqual(["in-library", "played", "recent"]);
    expect(sorted(db, "forgotten")).toEqual(["in-library", "played", "recent"]);
    const tag = db.prepare(`SELECT count FROM music_tags WHERE tag_norm = 'blues'`).get() as { count: number };
    expect(tag.count).toBe(3);
    expect(policy.estimate(rc(2))).toBe(0);
  });

  it("does nothing without an age cut", () => {
    const noCut: RetentionRunContext = { db, days: null, cutoff: null, batchSize: 100 };
    expect(policy.estimate(noCut)).toBe(0);
    expect(policy.purge(noCut)).toBe(0);
  });
});
