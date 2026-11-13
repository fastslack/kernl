import { describe, it, expect, afterEach } from "bun:test";
import {
  RelateGraphDriver,
  isReadStatement,
  readConnectionCount,
  relateClientInstalled,
} from "../src/core/db-drivers/builtins/relate-graph-driver.js";

describe("which statements may run on a reader", () => {
  it("sends reads to the readers", () => {
    for (const q of [
      "MATCH (p:Person {id: $id}) RETURN p",
      "MATCH (n:Fact) WHERE n.current RETURN count(n) AS c",
      "CALL db.labels() YIELD label RETURN label",
      "CALL db.index.vector.queryNodes('memory', 5, $v) YIELD node, score RETURN node, score",
      "SHOW INDEXES",
      "EXPLAIN MATCH (n:Task) RETURN n",
      "CALL () { MATCH (t:Task) RETURN t } RETURN * LIMIT 10",
      // Names that look like clauses are names.
      "MATCH (n:Task) RETURN n.set AS s, n.merge, {delete: 1} AS m",
      "MATCH (n:Set) RETURN n",
      "MATCH (n) WHERE n.title = 'CREATE something' RETURN n // DELETE later",
    ]) expect([q, isReadStatement(q)]).toEqual([q, true]);
  });

  it("sends anything that writes, or might, to the writer", () => {
    for (const q of [
      "CREATE (:Task {id: $id})",
      "MERGE (p:Person {id: $id}) ON CREATE SET p.name = $n",
      "MATCH (t:Task {id: $id}) SET t.done = true",
      "MATCH (t:Task) DETACH DELETE t",
      "MATCH (n:Task) REMOVE n:Archived",
      "CREATE INDEX task_id IF NOT EXISTS FOR (t:Task) ON (t.id)",
      "DROP INDEX x",
      "CALL db.checkpoint()",
      "CALL db.ontology.set($doc)",
      "CALL gds.pageRank.write('g', {})",
      "MATCH (n:Task) CALL (n) { SET n.x = 1 } IN TRANSACTIONS",
      "UNWIND $rows AS r MERGE (f:Fact {id: r.id}) SET f += r.props",
      "MATCH (a:X), (b:Y) FOREACH (x IN [1] | CREATE (a)-[:R]->(b))",
      "RETURN 1",
    ]) expect([q, isReadStatement(q)]).toEqual([q, q === "RETURN 1"]);
  });

  it("reads RELATE_READ_CONNECTIONS, defaulting to three", () => {
    const saved = process.env.RELATE_READ_CONNECTIONS;
    try {
      delete process.env.RELATE_READ_CONNECTIONS;
      expect(readConnectionCount()).toBe(3);
      process.env.RELATE_READ_CONNECTIONS = "0";
      expect(readConnectionCount()).toBe(0);
      process.env.RELATE_READ_CONNECTIONS = "99";
      expect(readConnectionCount()).toBe(16);
      process.env.RELATE_READ_CONNECTIONS = "junk";
      expect(readConnectionCount()).toBe(3);
    } finally {
      if (saved === undefined) delete process.env.RELATE_READ_CONNECTIONS;
      else process.env.RELATE_READ_CONNECTIONS = saved;
    }
  });
});

describe.skipIf(!relateClientInstalled())("one writer, several readers, against the real engine", () => {
  const saved = process.env.RELATE_READ_CONNECTIONS;
  afterEach(() => {
    if (saved === undefined) delete process.env.RELATE_READ_CONNECTIONS;
    else process.env.RELATE_READ_CONNECTIONS = saved;
  });

  async function start(readers?: number): Promise<RelateGraphDriver> {
    if (readers === undefined) delete process.env.RELATE_READ_CONNECTIONS;
    else process.env.RELATE_READ_CONNECTIONS = String(readers);
    const d = new RelateGraphDriver();
    d.configure({ path: ":memory:" });
    await d.start();
    expect(d.getStatus().error).toBeUndefined();
    return d;
  }

  const SLOW = "MATCH (a:P), (b:P) WHERE a.id % 7 = b.id % 11 RETURN count(*) AS n";
  const seed = (d: RelateGraphDriver) => d.run("UNWIND range(1, 1500) AS i CREATE (:P {id: i})");

  it("a slow read holds up neither a quick read nor a write", async () => {
    const d = await start();
    expect(d.getStatus().info?.readConnections).toBe(3);
    await seed(d);
    const t0 = performance.now();
    const slow = d.run(SLOW).then(() => performance.now() - t0);
    await Bun.sleep(5);

    let t = performance.now();
    const read = await d.run("MATCH (p:P {id: 42}) RETURN p.id AS id");
    const readMs = performance.now() - t;
    t = performance.now();
    await d.run("CREATE (:Q {id: 1})");
    const writeMs = performance.now() - t;
    const slowMs = await slow;

    expect(Number(read.records[0].get("id"))).toBe(42);
    expect(slowMs).toBeGreaterThan(200);
    expect(readMs).toBeLessThan(slowMs / 4);
    expect(writeMs).toBeLessThan(slowMs / 4);
  }, 30_000);

  it("with no readers, everything queues on the one connection as before", async () => {
    const d = await start(0);
    await seed(d);
    const t0 = performance.now();
    const slow = d.run(SLOW).then(() => performance.now() - t0);
    await Bun.sleep(5);
    const t = performance.now();
    await d.run("MATCH (p:P {id: 42}) RETURN p.id AS id");
    const readMs = performance.now() - t;
    expect(readMs).toBeGreaterThan((await slow) / 2);
  }, 30_000);

  it("a read sees the writes issued before it, even when they were not awaited", async () => {
    const d = await start();
    const writes = Array.from({ length: 20 }, (_, i) => d.run("CREATE (:W {i: $i})", { i }));
    const r = await d.run("MATCH (w:W) RETURN count(w) AS n");
    expect(Number(r.records[0].get("n"))).toBe(20);
    await Promise.all(writes);
  });

  it("a transaction commits all of its statements, or none of them", async () => {
    const d = await start();
    await d.withTransaction(async (tx) => {
      await tx.run("CREATE (:T {id: 1})");
      await tx.run("MATCH (t:T {id: 1}) CREATE (t)-[:NEXT]->(:T {id: 2})");
    });
    expect(Number((await d.run("MATCH (:T)-[:NEXT]->(:T) RETURN count(*) AS n")).records[0].get("n"))).toBe(1);

    await expect(
      d.withTransaction(async (tx) => {
        await tx.run("CREATE (:T {id: 3})");
        throw new Error("changed my mind");
      }),
    ).rejects.toThrow("changed my mind");
    expect(Number((await d.run("MATCH (t:T) RETURN count(t) AS n")).records[0].get("n"))).toBe(2);
  });

  it("conflicting transactions are retried until each one has counted", async () => {
    const d = await start();
    await d.run("CREATE (:Counter {id: 1, n: 0})");
    await Promise.all(
      Array.from({ length: 6 }, () =>
        d.withTransaction(async (tx) => {
          await tx.run("MATCH (c:Counter {id: 1}) SET c.n = c.n + 1");
        }),
      ),
    );
    expect(Number((await d.run("MATCH (c:Counter {id: 1}) RETURN c.n AS n")).records[0].get("n"))).toBe(6);
  });
});
