/**
 * Graph limits for the cinema catalogue (System › Storage):
 *   - which titles the limits keep out of the graph: excluded collections and
 *     the title ceiling, never what the user touched;
 *   - applying them removes those nodes, readmits titles that came back, and
 *     keeps the embedder off what is out;
 *   - the storage module stores the limits and freezes growth over the size
 *     ceiling.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import {
  applyCinemaGraphLimits,
  cinemaGraphBudget,
  graphSources,
} from "../assets/extensions/leisure/cinema/_module/graph-budget.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { storageMigrations } from "../src/modules/storage/migrations.js";
import { GraphStorageService } from "../src/modules/storage/graph.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";
import type { GraphDriver } from "../src/core/db-drivers/graph-driver.js";
import type { KernelModule } from "../src/core/types.js";

function insertTitle(db: SqliteDb, identifier: string, collections: string[], downloads: number, watchlist = false): void {
  const at = new Date().toISOString();
  db.prepare(`
    INSERT INTO cinema_titles
      (identifier, title, collection_json, has_torrent, downloads, watchlist, ingested_at, last_seen_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)
  `).run(identifier, identifier, JSON.stringify(collections), downloads, watchlist ? 1 : 0, at, at);
}

/** Records every query; answers count queries with 0 so orphan loops end. */
function fakeGraph(): GraphDriver & { calls: Array<{ cypher: string; params?: Record<string, unknown> }> } {
  const calls: Array<{ cypher: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    kind: "graph",
    capabilities: { cypher: true },
    async run(cypher: string, params?: Record<string, unknown>) {
      calls.push({ cypher, params });
      return { records: [{ keys: ["n"], get: () => 0, toObject: () => ({ n: 0 }) }] };
    },
  } as never;
}

const deletedIds = (g: ReturnType<typeof fakeGraph>): string[] =>
  g.calls.filter((c) => c.cypher.includes("CinemaTitle {identifier: id}")).flatMap((c) => c.params?.ids as string[]);

const outIds = (db: SqliteDb): string[] =>
  (db.prepare("SELECT identifier FROM cinema_graph_out ORDER BY identifier").all() as Array<{ identifier: string }>).map((r) => r.identifier);

describe("cinema graph limits", () => {
  let db: SqliteDb;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as SqliteDb;
    runMigrations(db, "cinema", cinemaMigrations);
    insertTitle(db, "film-a", ["feature_films"], 900);
    insertTitle(db, "film-b", ["feature_films"], 500);
    insertTitle(db, "film-c", ["feature_films"], 100);
    insertTitle(db, "trailer-1", ["movie_trailers"], 800);
    insertTitle(db, "trailer-mine", ["movie_trailers"], 1, true);
  });

  it("no limits keep everything in", async () => {
    const g = fakeGraph();
    const r = await applyCinemaGraphLimits(db, g, { excludedSources: [], maxItems: null, frozen: false });
    expect(r).toEqual({ removed: 0, readmitted: 0, orphansRemoved: 0 });
    expect(outIds(db)).toEqual([]);
  });

  it("an excluded collection goes, except what the user touched", async () => {
    const g = fakeGraph();
    const r = await applyCinemaGraphLimits(db, g, { excludedSources: ["movie_trailers"], maxItems: null, frozen: false });
    expect(r.removed).toBe(1);
    expect(outIds(db)).toEqual(["trailer-1"]);
    expect(deletedIds(g)).toEqual(["trailer-1"]);
  });

  it("the title ceiling keeps the touched ones plus the most downloaded", async () => {
    const g = fakeGraph();
    await applyCinemaGraphLimits(db, g, { excludedSources: [], maxItems: 3, frozen: false });
    // trailer-mine (touched) + film-a (900) + trailer-1 (800) stay.
    expect(outIds(db)).toEqual(["film-b", "film-c"]);
  });

  it("raising the ceiling readmits titles and queues them for re-embedding", async () => {
    await applyCinemaGraphLimits(db, fakeGraph(), { excludedSources: [], maxItems: 3, frozen: false });
    db.prepare("UPDATE cinema_titles SET embedded_at = '2026-01-01', embedded_model = 'm', embedded_dim = 4").run();

    const g = fakeGraph();
    const r = await applyCinemaGraphLimits(db, g, { excludedSources: [], maxItems: null, frozen: false });
    expect(r).toMatchObject({ removed: 0, readmitted: 2 });
    expect(outIds(db)).toEqual([]);
    const pending = new CinemaService(db).pendingEmbeddingIds("m", 4, 10).sort();
    expect(pending).toEqual(["film-b", "film-c"]);
  });

  it("the embedder skips titles kept out", async () => {
    await applyCinemaGraphLimits(db, fakeGraph(), { excludedSources: ["movie_trailers"], maxItems: null, frozen: false });
    const pending = new CinemaService(db).pendingEmbeddingIds("m", 4, 10);
    expect(pending).not.toContain("trailer-1");
    expect(pending).toContain("trailer-mine");
  });

  it("orphan cleanup only touches catalogue persons", async () => {
    const g = fakeGraph();
    await applyCinemaGraphLimits(db, g, { excludedSources: [], maxItems: null, frozen: false });
    const personQuery = g.calls.find((c) => c.cypher.includes(":Person"))!.cypher;
    expect(personQuery).toContain("p.name_norm IS NOT NULL AND p.id IS NULL");
  });

  it("freezing is recorded for the runners", async () => {
    await applyCinemaGraphLimits(db, fakeGraph(), { excludedSources: [], maxItems: null, frozen: true });
    expect(new CinemaService(db).graphFrozen()).toBe(true);
    await applyCinemaGraphLimits(db, fakeGraph(), { excludedSources: [], maxItems: null, frozen: false });
    expect(new CinemaService(db).graphFrozen()).toBe(false);
  });

  it("offers collections as sources, biggest first, only from a minimum size", () => {
    expect(graphSources(db)).toEqual([]);
    for (let i = 0; i < 200; i++) insertTitle(db, `k-${i}`, ["karaokevideos"], 0);
    expect(graphSources(db)).toEqual([{ key: "karaokevideos", count: 200 }]);
  });
});

describe("storage graph service", () => {
  let db: SqliteDb;
  let dataDir: string;
  let svc: GraphStorageService;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as SqliteDb;
    runMigrations(db, "storage", storageMigrations);
    runMigrations(db, "cinema", cinemaMigrations);
    dataDir = mkdtempSync(path.join(tmpdir(), "neo4j-data-"));
    const mod = { name: "cinema", getGraphBudgets: () => [cinemaGraphBudget()] } as unknown as KernelModule;
    svc = new GraphStorageService(db, () => [mod], () => null, dataDir);
  });

  it("stores the limits and validates them", () => {
    svc.set({ maxGb: 2, txlog: "min", budget: "cinema.graph", maxItems: 50_000, excluded: ["movie_trailers"] });
    expect(svc.maxGb()).toBe(2);
    expect(svc.txlog()).toBe("min");
    expect(svc.limitsFor("cinema.graph")).toEqual({ excludedSources: ["movie_trailers"], maxItems: 50_000, frozen: false });
    svc.set({ budget: "cinema.graph", maxItems: null });
    expect(svc.limitsFor("cinema.graph").maxItems).toBeNull();
    expect(() => svc.set({ txlog: "forever" })).toThrow();
    expect(() => svc.set({ budget: "nope", maxItems: 5 })).toThrow();
  });

  it("measures the graph on disk and freezes over the size ceiling", () => {
    expect(svc.disk()).toBeNull();
    mkdirSync(path.join(dataDir, "databases", "neo4j"), { recursive: true });
    mkdirSync(path.join(dataDir, "transactions", "neo4j"), { recursive: true });
    writeFileSync(path.join(dataDir, "databases", "neo4j", "store"), Buffer.alloc(3000));
    writeFileSync(path.join(dataDir, "transactions", "neo4j", "log.1"), Buffer.alloc(1000));
    expect(svc.disk()).toEqual({ storeBytes: 3000, txBytes: 1000 });
    expect(svc.frozen()).toBe(false);
    svc.set({ maxGb: 1 });
    expect(svc.frozen()).toBe(false);
    // 4,000 bytes over a ceiling of 0.000003 GB (~3,221 bytes).
    db.prepare("UPDATE graph_settings SET value = '0.000003' WHERE key = 'max_gb'").run();
    expect(svc.frozen()).toBe(true);
  });

  it("an unmounted volume reads as unknown and never freezes", () => {
    const blind = new GraphStorageService(db, () => [], () => null, path.join(dataDir, "missing"));
    blind.set({ maxGb: 1 });
    expect(blind.disk()).toBeNull();
    expect(blind.frozen()).toBe(false);
  });

  it("does nothing without a graph", async () => {
    expect(await svc.apply()).toEqual(["Graph: not connected, limits not applied."]);
  });
});
