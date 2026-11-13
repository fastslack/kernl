import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { GraphDriverRegistry } from "../src/core/db-drivers/graph-driver-registry.js";
import type { GraphDriver } from "../src/core/db-drivers/graph-driver.js";
import { upgradeGraphOnBoot, readUpgrade, neo4jCandidates, chooseGraphLimit, parseSize } from "../src/core/graph-upgrade.js";
import type { Neo4jSource } from "../src/core/db-drivers/builtins/neo4j-to-relate.js";

/**
 * The 0.5.0 upgrade, case by case: whatever 0.4.x left behind, the install
 * ends up on Relate with its data, or stays where it was when it cannot move
 * safely. Neo4j itself is stood in for; the real copy is covered by
 * neo4j-to-relate.test.ts.
 */

function stub(name: string): GraphDriver {
  return {
    name, kind: "graph", deployment: "external-server",
    capabilities: { cypher: false, gds: false, vectorSimilarity: false, mlPipelines: false, embedded: false, parameterised: false, transactions: false },
    getConfigSchema: () => [], validateConfig: () => ({ valid: true }), configure: () => {},
    start: async () => {}, stop: async () => {}, isReady: () => false,
    getStatus: () => ({ slug: name, name, kind: "graph", ready: false }),
    canSelfConfigure: () => false,
  } as unknown as GraphDriver;
}

const NEO4J: Neo4jSource = { uri: "bolt://neo4j:7687", user: "neo4j", password: "kernlgraph" };

describe("graph upgrade to 0.5.0", () => {
  let db: Database;
  let reg: GraphDriverRegistry;
  let store: string;

  /** A 0.4.x database: the drivers it knew, one of them active. */
  function from04x(active: "noop" | "neo4j" | null) {
    reg = new GraphDriverRegistry();
    reg.setDb(db as never);
    reg.registerFactory("noop", () => stub("noop"));
    reg.registerFactory("neo4j", () => stub("neo4j"));
    reg.seedBuiltinRows();
    db.prepare("UPDATE installed_extensions SET status = 'installed' WHERE type = 'db-driver'").run();
    if (active) db.prepare("UPDATE installed_extensions SET status = 'active' WHERE slug = ?").run(active);
    // 0.5.0 adds Relate; seeding never touches the active row.
    reg.registerFactory("relate", () => stub("relate"));
    reg.seedBuiltinRows();
  }

  // The Relate driver writes its default cap into process.env when it starts;
  // another test in the same process may have started one. The upgrade runs
  // before any driver starts, so here the variable is only ever the operator's.
  let envCap: string | undefined;
  beforeEach(() => {
    envCap = process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT;
    delete process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT;
  });
  afterEach(() => {
    if (envCap === undefined) delete process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT;
    else process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT = envCap;
  });

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db as never, "extensions", extensionsMigrations);
    store = join(mkdtempSync(join(tmpdir(), "kernl-upg-")), "graph");
  });

  const GIB = 1024 ** 3;
  const opts = (o: {
    reachable?: boolean; copy?: (to: string) => void; fail?: string | ((limit: string) => string | null); relate?: boolean; data?: boolean;
    size?: number; ceiling?: number; caps?: string[];
  } = {}) => ({
    relateAvailable: () => o.relate ?? true,
    storePath: () => store,
    locate: async () => (o.reachable ? NEO4J : null),
    hasData: async () => o.data ?? true,
    sizeOf: async () => o.size ?? 100 * 1024 * 1024,
    memoryCeiling: () => o.ceiling ?? 16 * GIB,
    importGraph: async (_s: Neo4jSource, to: string, limit: string) => {
      o.caps?.push(limit);
      const fail = typeof o.fail === "function" ? o.fail(limit) : o.fail;
      if (fail) throw new Error(fail);
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, "copied"), "x");
      o.copy?.(to);
      return "7 nodes, 4 relationships";
    },
  });

  it("a desktop install with no graph moves to Relate, rebuilt from SQLite", async () => {
    from04x("noop");
    const r = await upgradeGraphOnBoot(reg, db as never, opts());
    expect(reg.getActiveRowSlug()).toBe("relate");
    expect(r?.state).toBe("done");
    expect(r?.from).toBe("noop");
  });

  it("noop as the driver, but a Neo4j with data the legacy client wrote: that Neo4j is copied", async () => {
    from04x("noop");
    const r = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true, data: true }));
    expect(r?.state).toBe("done");
    expect(r?.from).toBe("noop+neo4j");
    expect(readdirSync(store)).toEqual(["copied"]);
    expect(reg.getActiveRowSlug()).toBe("relate");
  });

  it("noop with an empty Neo4j around: rebuilt from SQLite, nothing copied", async () => {
    from04x("noop");
    const r = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true, data: false }));
    expect(r?.from).toBe("noop");
    expect(existsSync(store)).toBe(false);
  });

  it("noop with NEO4J_URI set and Neo4j down: Relate now, Neo4j's own data merged in later", async () => {
    from04x("noop");
    process.env.NEO4J_URI = "bolt://neo4j:7687";
    try {
      const r = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: false }));
      expect(r?.state).toBe("pending-import");
      expect(reg.getActiveRowSlug()).toBe("relate");
    } finally {
      delete process.env.NEO4J_URI;
    }
  });

  it("a Docker install on a reachable Neo4j has its graph copied, then moves", async () => {
    from04x("neo4j");
    const r = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true }));
    expect(r?.state).toBe("done");
    expect(r?.detail).toContain("7 nodes, 4 relationships");
    expect(reg.getActiveRowSlug()).toBe("relate");
    expect(readdirSync(store)).toEqual(["copied"]);
    expect(existsSync(`${store}.importing`)).toBe(false);
  });

  it("an existing Relate store is kept aside, not overwritten", async () => {
    from04x("neo4j");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "old"), "x");
    await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true }));
    const parent = join(store, "..");
    expect(readdirSync(store)).toEqual(["copied"]);
    expect(readdirSync(parent).some((n) => n.startsWith("graph.before-0.5.0-"))).toBe(true);
  });

  it("a copy that fails keeps Neo4j, and is tried again on the next boot", async () => {
    from04x("neo4j");
    const r1 = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true, fail: "disk full" }));
    expect(r1?.state).toBe("failed");
    expect(reg.getActiveRowSlug()).toBe("neo4j");
    expect(existsSync(`${store}.importing`)).toBe(false);
    const r2 = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true }));
    expect(r2?.state).toBe("done");
    expect(r2?.attempts).toBe(2);
    expect(reg.getActiveRowSlug()).toBe("relate");
  });

  it("a Neo4j that does not answer: Relate now, the graph-only data merged in later", async () => {
    from04x("neo4j");
    const r = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: false }));
    expect(r?.state).toBe("pending-import");
    expect(reg.getActiveRowSlug()).toBe("relate");
  });

  it("does nothing more once done, even if the user goes back to Neo4j by hand", async () => {
    from04x("noop");
    await upgradeGraphOnBoot(reg, db as never, opts());
    reg.markActive("neo4j");
    const r = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true }));
    expect(r?.state).toBe("done");
    expect(reg.getActiveRowSlug()).toBe("neo4j");
  });

  it("without the Relate client, or with KERNL_KEEP_NEO4J=1, nothing moves", async () => {
    from04x("neo4j");
    await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true, relate: false }));
    expect(reg.getActiveRowSlug()).toBe("neo4j");
    process.env.KERNL_KEEP_NEO4J = "1";
    try {
      const r = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true }));
      expect(r?.state).toBe("skipped");
      expect(reg.getActiveRowSlug()).toBe("neo4j");
    } finally {
      delete process.env.KERNL_KEEP_NEO4J;
    }
  });

  it("KERNL_GRAPH_UPGRADE=off skips the step entirely", async () => {
    from04x("noop");
    process.env.KERNL_GRAPH_UPGRADE = "off";
    try {
      expect(await upgradeGraphOnBoot(reg, db as never, opts())).toBeNull();
      expect(reg.getActiveRowSlug()).toBe("noop");
      expect(readUpgrade(db as never)).toBeNull();
    } finally {
      delete process.env.KERNL_GRAPH_UPGRADE;
    }
  });

  it("sizes the cap from the graph: 1.5× its estimated size, kept as the driver's memoryLimit", async () => {
    from04x("neo4j");
    const caps: string[] = [];
    // Production's graph: about 3.7 GB once in Relate.
    const r = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true, size: 3.7e9, caps }));
    expect(r?.state).toBe("done");
    expect(caps).toEqual(["6gib"]);
    expect(reg.loadConfig("relate").memoryLimit).toBe("6gib");
    expect(r?.detail).toContain("6gib");
  });

  it("a small graph keeps the 2 GiB default and saves nothing", async () => {
    from04x("neo4j");
    const caps: string[] = [];
    await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true, size: 50e6, caps }));
    expect(caps).toEqual(["2gib"]);
    expect(reg.loadConfig("relate").memoryLimit).toBeUndefined();
  });

  it("a copy that runs out of room is retried once at twice the cap", async () => {
    from04x("neo4j");
    const caps: string[] = [];
    const r = await upgradeGraphOnBoot(reg, db as never, opts({
      reachable: true, size: 1.5 * GIB, caps,
      fail: (limit) => (limit === "3gib" ? "RelateError: capacity exceeded: used=3221225000 limit=3221225472" : null),
    }));
    expect(caps).toEqual(["3gib", "6gib"]);
    expect(r?.state).toBe("done");
    expect(reg.getActiveRowSlug()).toBe("relate");
  });

  it("a graph this machine cannot hold stays on Neo4j, and is not copied again on every boot", async () => {
    from04x("neo4j");
    const caps: string[] = [];
    const r1 = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true, size: 20 * GIB, ceiling: 8 * GIB, caps }));
    expect(r1?.state).toBe("failed");
    expect(r1?.detail).toMatch(/needs about 19gib|needs about 20gib/);
    expect(reg.getActiveRowSlug()).toBe("neo4j");
    expect(caps).toEqual([]);
    // Same machine: nothing is tried.
    const r2 = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true, size: 20 * GIB, ceiling: 8 * GIB, caps }));
    expect(r2?.attempts).toBe(1);
    expect(caps).toEqual([]);
    // More memory: it goes.
    const r3 = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true, size: 20 * GIB, ceiling: 64 * GIB, caps }));
    expect(r3?.state).toBe("done");
    expect(caps).toEqual(["30gib"]);
  });

  it("an explicit RELATE_LOGICAL_GRAPH_SIZE_LIMIT is the ceiling, and is not overwritten", async () => {
    from04x("neo4j");
    process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT = "2gib";
    try {
      const r = await upgradeGraphOnBoot(reg, db as never, opts({ reachable: true, size: 3.7e9 }));
      expect(r?.state).toBe("failed");
      expect(r?.detail).toContain("raise RELATE_LOGICAL_GRAPH_SIZE_LIMIT");
      expect(reg.getActiveRowSlug()).toBe("neo4j");
    } finally {
      delete process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT;
    }
  });

  it("parses and chooses caps", () => {
    expect(parseSize("2gib")).toBe(2 * GIB);
    expect(parseSize("512MiB")).toBe(512 * 1024 * 1024);
    expect(parseSize("none")).toBeNull();
    expect(chooseGraphLimit(3.7e9, 2 * GIB, 16 * GIB)).toBe(6 * GIB);
    expect(chooseGraphLimit(1e8, 2 * GIB, 16 * GIB)).toBe(2 * GIB);
    // 1.5× would pass the ceiling: the whole GiBs under it.
    expect(chooseGraphLimit(7 * GIB, 2 * GIB, 8.5 * GIB)).toBe(8 * GIB);
    expect(chooseGraphLimit(9 * GIB, 2 * GIB, 8 * GIB)).toBeNull();
  });

  it("looks for the old Neo4j where 0.4.x put it: saved config, environment, the shipped defaults", () => {
    from04x("neo4j");
    const saved = { NEO4J_URI: process.env.NEO4J_URI, NEO4J_USER: process.env.NEO4J_USER, NEO4J_PASSWORD: process.env.NEO4J_PASSWORD };
    process.env.NEO4J_URI = "bolt://graph.lan:7687";
    process.env.NEO4J_USER = "kernl";
    process.env.NEO4J_PASSWORD = "secret";
    try {
      const c = neo4jCandidates(reg);
      expect(c[0]).toEqual({ uri: "bolt://graph.lan:7687", user: "kernl", password: "secret" });
      expect(c.some((x) => x.uri === "bolt://localhost:17687")).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
});
