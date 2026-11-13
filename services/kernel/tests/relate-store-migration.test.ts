import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RelateGraphDriver,
  loadRelateClient,
  relateClientInstalled,
} from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { migrateRelateStore } from "../src/core/db-drivers/builtins/relate-store-migration.js";

/**
 * Earlier versions kept the graph in a single `.rl` file, which nothing else
 * can read while the kernel runs and which never shrinks. A default install
 * moves to a directory store once, in a child process, keeping the old file.
 */
describe.skipIf(!relateClientInstalled())("Relate store migration", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "kernl-relate-mig-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function seedLegacy(path: string): Promise<void> {
    // In a child: the client cannot close a store, and this test process must
    // be able to open the same file afterwards.
    const script = `
      const { Database } = require(${JSON.stringify(resolve("node_modules/@relate/relate"))});
      const db = Database.open(${JSON.stringify(path)});
      const c = db.connect();
      c.query("CREATE CONSTRAINT p_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE");
      c.query("CREATE VECTOR INDEX m_emb IF NOT EXISTS FOR (m:Memory) ON (m.embedding) OPTIONS { indexConfig: { \\\`vector.dimensions\\\`: 3, \\\`vector.similarity_function\\\`: 'cosine' }}");
      c.query("CREATE (a:Person:Contact {id: 'p1', name: 'Ada', since: datetime('2026-01-02T03:04:05Z')}), (b:Person {id: 'p2', name: 'Grace'}), (m:Memory {id: 'm1', embedding: [1.0, 0.0, 0.0]}), (a)-[:KNOWS {w: 2}]->(b), (m)-[:MENTIONS]->(a)");
      db.checkpoint();
    `;
    const p = Bun.spawnSync([process.execPath, "-e", script]);
    if (p.exitCode !== 0) throw new Error(String(p.stderr));
  }

  it("copies nodes, labels, properties, relationships and schema", async () => {
    const d = tmp();
    const from = join(d, "graph.rl");
    const to = join(d, "graph");
    await seedLegacy(from);
    const r = await migrateRelateStore(await loadRelateClient(), from, to);
    expect(r).toMatchObject({ nodes: 3, relationships: 2 });

    const c = (await loadRelateClient()).Database.open(to, { readOnly: true }).connect();
    const ada = c.query("MATCH (p:Person {id: 'p1'}) RETURN labels(p) AS l, p.name AS n, p.since AS s, keys(p) AS k").rows[0] as {
      l: string[]; n: string; s: { year: number }; k: string[];
    };
    expect(ada.l.sort()).toEqual(["Contact", "Person"]);
    expect(ada.n).toBe("Ada");
    expect(ada.s.year).toBe(2026);
    expect(ada.k).not.toContain("__kernl_mig");
    expect(c.query("MATCH (:Person {id:'p1'})-[k:KNOWS]->(:Person {id:'p2'}) RETURN k.w AS w").rows).toEqual([{ w: 2 }]);
    expect(c.query("MATCH (n:__KernlMig) RETURN count(n) AS n").rows).toEqual([{ n: 0 }]);
    const idx = c.query("SHOW INDEXES YIELD name, type RETURN name, type").rows as Array<{ name: string; type: string }>;
    expect(idx.map((i) => i.type)).toContain("VECTOR");
    expect(idx.map((i) => i.name)).not.toContain("kernl_store_migration");
    const cons = c.query("SHOW CONSTRAINTS YIELD name RETURN name").rows as Array<{ name: string }>;
    expect(cons.map((x) => x.name)).toContain("p_id");
    const hit = c.query("MATCH (m:Memory) SEARCH m IN (VECTOR INDEX m_emb FOR [1.0, 0.0, 0.0] LIMIT 1) SCORE AS s RETURN m.id AS id").rows;
    expect(hit).toEqual([{ id: "m1" }]);
  });

  it("moves a default install from graph.rl to a directory store on start, in a child process", async () => {
    const d = tmp();
    await seedLegacy(join(d, "graph.rl"));
    const saved = { sqlite: process.env.SQLITE_PATH, db: process.env.RELATE_DATABASE, argv1: process.argv[1] };
    try {
      process.env.SQLITE_PATH = join(d, "kernel.db");
      delete process.env.RELATE_DATABASE;
      process.argv[1] = resolve("bin/mcp-server.ts"); // the entry point the child re-runs
      const driver = new RelateGraphDriver();
      driver.configure({});
      await driver.start();
      expect(driver.getStatus().error).toBeUndefined();
      expect(driver.getStatus().info?.path).toBe(join(d, "graph"));
      expect(existsSync(join(d, "graph.rl.migrated"))).toBe(true);
      expect(existsSync(join(d, "graph.rl"))).toBe(false);
      const r = await driver.run("MATCH (p:Person) RETURN count(p) AS n");
      expect(Number(r.records[0].get("n"))).toBe(2);
    } finally {
      if (saved.sqlite === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = saved.sqlite;
      if (saved.db !== undefined) process.env.RELATE_DATABASE = saved.db;
      process.argv[1] = saved.argv1;
    }
  }, 120_000);

  it("keeps using graph.rl when the move fails", async () => {
    const d = tmp();
    await seedLegacy(join(d, "graph.rl"));
    const saved = { sqlite: process.env.SQLITE_PATH, argv1: process.argv[1] };
    try {
      process.env.SQLITE_PATH = join(d, "kernel.db");
      process.argv[1] = join(d, "no-such-entry.js");
      const driver = new RelateGraphDriver();
      driver.configure({});
      await driver.start();
      expect(driver.getStatus().info?.path).toBe(join(d, "graph.rl"));
      expect(existsSync(join(d, "graph"))).toBe(false);
      const r = await driver.run("MATCH (p:Person) RETURN count(p) AS n");
      expect(Number(r.records[0].get("n"))).toBe(2);
    } finally {
      if (saved.sqlite === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = saved.sqlite;
      process.argv[1] = saved.argv1;
    }
  });
});
