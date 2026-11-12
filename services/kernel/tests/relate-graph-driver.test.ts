import { describe, it, expect, afterEach } from "bun:test";
import {
  RelateGraphDriver,
  RelateInteger,
  adaptValue,
  defaultRelatePath,
  type RelateModule,
  type RelateResult,
} from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { KnowledgeService } from "../src/modules/chat/knowledge-service.js";

/**
 * The Relate client is not a kernel dependency, so these tests drive the
 * driver through a fake client. Setting RELATE_CLIENT_MODULE to an installed
 * `@relate/relate` also runs the integration block against the real engine.
 */

interface FakeCall {
  cypher: string;
  params?: Record<string, unknown>;
}

function fakeModule(
  handler: (cypher: string, params?: Record<string, unknown>) => RelateResult,
  calls: FakeCall[] = [],
  opened: string[] = [],
): RelateModule {
  return {
    Database: {
      open(uri: string) {
        opened.push(uri);
        return {
          connect: () => ({
            async queryAsync(cypher: string, params?: Record<string, unknown>) {
              calls.push({ cypher, params });
              return handler(cypher, params);
            },
          }),
          checkpoint: () => {},
        };
      },
    },
  };
}

const CAPS: RelateResult = {
  columns: ["name", "value"],
  rows: [
    { name: "cypher.version", value: "25" },
    { name: "vector.index", value: true },
    { name: "fulltext.index", value: true },
  ],
};

function okHandler(extra?: (cypher: string) => RelateResult | undefined) {
  return (cypher: string): RelateResult => {
    if (cypher.includes("dbms.listCapabilities")) return CAPS;
    return extra?.(cypher) ?? { columns: ["ok"], rows: [{ ok: 1 }] };
  };
}

describe("RelateGraphDriver value adaptation", () => {
  it("turns whole numbers into neo4j-style integers that still behave as numbers", () => {
    const v = adaptValue(42) as RelateInteger;
    expect(v).toBeInstanceOf(RelateInteger);
    expect(v.toNumber()).toBe(42);
    expect(Number(v)).toBe(42);
    expect((v as unknown as number) + 1).toBe(43);
    expect(JSON.stringify({ v })).toBe('{"v":42}');
  });

  it("leaves fractional numbers, strings and nulls alone", () => {
    expect(adaptValue(0.5)).toBe(0.5);
    expect(adaptValue("x")).toBe("x");
    expect(adaptValue(null)).toBeNull();
  });

  it("wraps bigints beyond the safe range", () => {
    const v = adaptValue(9007199254740993n) as RelateInteger;
    expect(v.toNumber()).toBe(Number(9007199254740993n));
  });

  it("gives nodes and relationships the neo4j-driver fields consumers read", () => {
    const node = adaptValue({
      kind: "node",
      elementId: "4:relate-neo4j:n0",
      id: 0,
      labels: ["Person"],
      properties: { name: "Ada", age: 36 },
    }) as { identity: RelateInteger; labels: string[]; properties: { name: string; age: RelateInteger } };
    expect(node.identity.toNumber()).toBe(0);
    expect(node.labels).toEqual(["Person"]);
    expect(node.properties.name).toBe("Ada");
    expect(node.properties.age.toNumber()).toBe(36);

    const rel = adaptValue({
      kind: "relationship",
      elementId: "5:relate-neo4j:r0",
      id: 0,
      type: "KNOWS",
      startElementId: "4:relate-neo4j:n0",
      endElementId: "4:relate-neo4j:n1",
      startId: 0,
      endId: 1,
      properties: {},
    }) as { start: RelateInteger; end: RelateInteger; startNodeElementId: string };
    expect(rel.start.toNumber()).toBe(0);
    expect(rel.end.toNumber()).toBe(1);
    expect(rel.startNodeElementId).toBe("4:relate-neo4j:n0");
  });

  it("adapts values nested in lists and maps", () => {
    const out = adaptValue({ xs: [1, 2.5], m: { n: 3 } }) as {
      xs: [RelateInteger, number];
      m: { n: RelateInteger };
    };
    expect(out.xs[0].toNumber()).toBe(1);
    expect(out.xs[1]).toBe(2.5);
    expect(out.m.n.toNumber()).toBe(3);
  });
});

describe("RelateGraphDriver lifecycle", () => {
  const savedEnv = { RELATE_DATABASE: process.env.RELATE_DATABASE, SQLITE_PATH: process.env.SQLITE_PATH };
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("stays not-ready with a clear error when the client is not installed", async () => {
    const driver = new RelateGraphDriver(async () => {
      throw new Error("Cannot find package '@relate/relate'");
    });
    driver.configure({ path: ":memory:" });
    await driver.start();
    expect(driver.isReady()).toBe(false);
    expect(driver.capabilities.cypher).toBe(false);
    expect(driver.getStatus().error).toContain("Relate client not installed");
    await expect(driver.run("RETURN 1")).rejects.toThrow("not ready");
  });

  it("reports capabilities from dbms.listCapabilities and never GDS", async () => {
    const driver = new RelateGraphDriver(async () => fakeModule(okHandler()));
    driver.configure({ path: ":memory:" });
    await driver.start();
    expect(driver.isReady()).toBe(true);
    expect(driver.capabilities).toMatchObject({
      cypher: true,
      vectorSimilarity: true,
      embedded: true,
      gds: false,
      mlPipelines: false,
    });
    expect(driver.getStatus().info).toMatchObject({ cypherVersion: "25", fulltextIndex: true });
  });

  it("maps rows and counters into GraphResult", async () => {
    const driver = new RelateGraphDriver(async () =>
      fakeModule(
        okHandler((c) =>
          c.startsWith("MATCH")
            ? {
                columns: ["n", "name"],
                rows: [{ n: 2, name: "Ada" }],
                stats: { nodes_created: 1, properties_set: 3 },
              }
            : undefined,
        ),
      ),
    );
    driver.configure({ path: ":memory:" });
    await driver.start();
    const r = await driver.run("MATCH (p) RETURN count(p) AS n, 'Ada' AS name");
    expect(r.records[0].keys).toEqual(["n", "name"]);
    expect((r.records[0].get("n") as RelateInteger).toNumber()).toBe(2);
    expect(r.records[0].toObject().name).toBe("Ada");
    expect(r.summary?.counters).toMatchObject({ nodesCreated: 1, propertiesSet: 3 });
  });

  it("reuses one store handle per path across stop/start (the client cannot close stores)", async () => {
    const opened: string[] = [];
    const mod = fakeModule(okHandler(), [], opened);
    const path = `/tmp/kernl-relate-test-${Date.now()}.rl`;
    const a = new RelateGraphDriver(async () => mod);
    a.configure({ path });
    await a.start();
    await a.stop();
    expect(a.isReady()).toBe(false);
    await a.start();
    const b = new RelateGraphDriver(async () => mod);
    b.configure({ path });
    await b.start();
    expect(opened).toEqual([path]);
  });

  it("rejects a server URI as the store path", () => {
    const driver = new RelateGraphDriver(async () => fakeModule(okHandler()));
    expect(driver.validateConfig({ path: "bolt://localhost:7687" }).valid).toBe(false);
    expect(driver.validateConfig({ path: "./graph.rl" }).valid).toBe(true);
    expect(driver.validateConfig({}).valid).toBe(true);
  });

  it("is the default graph when its client is installed, or when RELATE_DATABASE asks for it", () => {
    const driver = new RelateGraphDriver(async () => fakeModule(okHandler()));
    const savedClient = process.env.RELATE_CLIENT_MODULE;
    const savedNeo4j = process.env.NEO4J_URI;
    try {
      delete process.env.NEO4J_URI;
      delete process.env.RELATE_DATABASE;
      process.env.RELATE_CLIENT_MODULE = "/nonexistent/relate/index.js";
      expect(driver.canSelfConfigure()).toBe(false);
      process.env.RELATE_CLIENT_MODULE = import.meta.path; // any file that exists
      expect(driver.canSelfConfigure()).toBe(true);
      // An install pointed at a Neo4j server keeps it…
      process.env.NEO4J_URI = "bolt://neo4j:7687";
      expect(driver.canSelfConfigure()).toBe(false);
      // …unless Relate is asked for by name.
      process.env.RELATE_CLIENT_MODULE = "/nonexistent/relate/index.js";
      process.env.RELATE_DATABASE = "/tmp/x.rl";
      expect(driver.canSelfConfigure()).toBe(true);
    } finally {
      if (savedClient === undefined) delete process.env.RELATE_CLIENT_MODULE;
      else process.env.RELATE_CLIENT_MODULE = savedClient;
      if (savedNeo4j === undefined) delete process.env.NEO4J_URI;
      else process.env.NEO4J_URI = savedNeo4j;
    }
  });

  it("defaults the store next to the SQLite database", () => {
    delete process.env.RELATE_DATABASE;
    process.env.SQLITE_PATH = "/srv/kernl/data/kernel.db";
    expect(defaultRelatePath()).toBe("/srv/kernl/data/graph.rl");
    process.env.RELATE_DATABASE = "/elsewhere/g.rl";
    expect(defaultRelatePath()).toBe("/elsewhere/g.rl");
  });
});

// ── Real engine (opt-in) ──────────────────────────────────────────────

const clientModule = process.env.RELATE_CLIENT_MODULE;

describe.skipIf(!clientModule)("RelateGraphDriver against the real engine", () => {
  async function startMemory(): Promise<RelateGraphDriver> {
    const driver = new RelateGraphDriver();
    driver.configure({ path: ":memory:" });
    await driver.start();
    expect(driver.getStatus().error).toBeUndefined();
    return driver;
  }

  it("answers Neo4j-style integers for counts", async () => {
    const driver = await startMemory();
    await driver.run("CREATE (:Person {name: 'Ada'}), (:Person {name: 'Grace'})");
    const r = await driver.run("MATCH (p:Person) RETURN count(p) AS c");
    expect((r.records[0].get("c") as RelateInteger).toNumber()).toBe(2);
  });

  it("creates the chat schema on first use when the graph came up after init", async () => {
    // Bootstrap order: the chat module initializes against the no-op driver,
    // and the real driver starts afterwards.
    let active: RelateGraphDriver | null = null;
    const ks = new KnowledgeService(() => active);
    await ks.createConstraintsAndIndexes();
    active = await startMemory();
    const before = await active.run("SHOW INDEXES YIELD type WHERE type = 'VECTOR' RETURN count(*) AS n");
    expect(Number(before.records[0].get("n"))).toBe(0);

    await ks.createEpisodeNode({ id: "ep", title: "t", started_at: "2026-11-11T10:00:00Z" });
    const r = await active.run(
      "SHOW INDEXES YIELD name, type WHERE type = 'VECTOR' RETURN name ORDER BY name",
    );
    expect(r.records.map((x) => x.get("name"))).toEqual([
      "concept-embeddings",
      "episode-embeddings",
      "memory-embeddings",
    ]);
  });

  it("runs the chat memory graph end to end", async () => {
    const driver = await startMemory();
    const ks = new KnowledgeService(() => driver);
    const dim = 384;
    const vec = (seed: number) => {
      let s = seed;
      const v = Array.from({ length: dim }, () => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647 - 0.5;
      });
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    };
    await ks.createConstraintsAndIndexes();
    await ks.createEpisodeNode({ id: "ep1", title: "t", started_at: "2026-11-11T10:00:00Z" });
    await ks.createMemoryNode({
      id: "m1",
      episode_id: "ep1",
      role: "user",
      content: "replace neo4j with relate",
      embedding: vec(7),
      created_at: "2026-11-11T10:01:00Z",
    });
    await ks.createMemoryNode({
      id: "m2",
      episode_id: "ep1",
      role: "assistant",
      content: "relate is embedded",
      embedding: vec(99),
      created_at: "2026-11-11T10:02:00Z",
    });
    const hits = await ks.findSimilarMemories(vec(7), 2);
    expect(hits[0]?.id).toBe("m1");

    const a = await ks.upsertConcept({ label: "Graph DB", memoryId: "m1", embedding: vec(11) });
    const again = await ks.upsertConcept({ label: "graph db", memoryId: "m2" });
    expect(again).toBe(a);
    const concepts = await ks.getConcepts();
    expect(Number(concepts.find((c) => c.id === a)?.mention_count)).toBe(2);

    // Concepts come back from a traversal with their own label.
    const traversal = await ks.traverseFromMemories(["m1"]);
    expect(traversal.concepts.map((c) => c.label)).toEqual(["Graph DB"]);

    // excludeEpisodeId keeps that episode's memories out of the results.
    await ks.createEpisodeNode({ id: "ep2", title: "other", started_at: "2026-11-10T10:00:00Z" });
    await ks.createMemoryNode({
      id: "m3",
      episode_id: "ep2",
      role: "user",
      content: "buy milk",
      embedding: vec(1234),
      created_at: "2026-11-10T10:01:00Z",
    });
    const others = await ks.findSimilarMemories(vec(7), 3, "ep1");
    expect(others.map((m) => m.id)).toEqual(["m3"]);
  });
});
