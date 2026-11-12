import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { brainMigrations } from "../src/modules/brain/migrations.js";
import { FactStore } from "../src/modules/brain/facts.js";
import { RelateGraphDriver, relateClientInstalled, temporalToString } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { GraphQueryService } from "../src/modules/graph-query/service.js";
import { filterSchema } from "../src/modules/graph-query/privacy.js";

describe("temporal values read back as ISO text", () => {
  const as = (name: string, fields: object) => Object.assign(Object.create({ constructor: { name } }), fields);

  it("writes what neo4j-driver's toString would, and a UTC datetime exactly as toISOString", () => {
    const dt = { year: 2026, month: 10, day: 1, hour: 9, minute: 5, second: 7, nanosecond: 120_000_000 };
    expect(temporalToString(as("CypherDateTime", { ...dt, offsetSeconds: 0, zone: null }))).toBe("2026-10-01T09:05:07.120Z");
    expect(temporalToString(as("CypherDateTime", { ...dt, offsetSeconds: -10800, zone: null }))).toBe("2026-10-01T09:05:07.120-03:00");
    expect(temporalToString(as("CypherDateTime", { ...dt, offsetSeconds: 3600, zone: "Europe/Madrid" }))).toBe("2026-10-01T09:05:07.120+01:00[Europe/Madrid]");
    expect(temporalToString(as("CypherDate", { year: 2026, month: 1, day: 2 }))).toBe("2026-01-02");
    expect(temporalToString(as("CypherLocalDateTime", dt))).toBe("2026-10-01T09:05:07.120");
    expect(temporalToString(as("CypherDuration", { months: 0, days: 1, seconds: 7200, nanos: 0 }))).toBe("P1DT7200S");
    expect(temporalToString("2026-10-01")).toBeNull();
    expect(temporalToString({ year: 2026 })).toBeNull();
  });
});

describe.skipIf(!relateClientInstalled())("facts in the built-in graph", () => {
  const drivers: RelateGraphDriver[] = [];
  afterEach(async () => {
    for (const d of drivers.splice(0)) await d.stop();
  });

  async function setup() {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    drivers.push(g);
    const db = new Database(":memory:");
    runMigrations(db as never, "brain", brainMigrations);
    const facts = new FactStore(db as never, () => g);
    return { g, db, facts };
  }
  const one = async (g: RelateGraphDriver, q: string, p?: Record<string, unknown>) => (await g.run(q, p)).records[0];

  it("stores fact times as datetimes, read back exactly as SQLite holds them", async () => {
    const { g, facts } = await setup();
    const a = facts.assert({ subject: "Person:l", subjectName: "Lucía", predicate: "works_at", object: "Andina", validFrom: "2026-09-01" });
    const b = facts.assert({ subject: "Person:l", predicate: "works_at", object: "Delta", validFrom: "2026-11-01" });
    await facts.project([facts.get(a.fact.id)!, b.fact]);

    const r = await one(g, "MATCH (f:Fact {id: $id}) RETURN f.valid_from AS from, f.valid_to AS to, valueType(f.valid_from) AS t, f.superseded_at AS sup", { id: a.fact.id });
    const stored = facts.get(a.fact.id)!;
    expect(String(r.get("t"))).toStartWith("ZONED DATETIME");
    expect(r.get("from")).toBe(stored.valid_from);
    expect(r.get("to")).toBe(stored.valid_to);
    expect(r.get("sup")).toBeNull();

    // Temporal Cypher now works on them: what held on a day, and for how long.
    const held = await g.run(
      `MATCH (f:Fact {subject: 'Person:l', predicate: 'works_at'})
       WHERE f.valid_from <= datetime($at) AND (f.valid_to IS NULL OR f.valid_to > datetime($at))
       RETURN f.object AS o, duration.inDays(f.valid_from, coalesce(f.valid_to, datetime('2026-11-12'))).days AS days`,
      { at: "2026-10-15" },
    );
    expect(held.records.map((x) => [x.get("o"), Number(x.get("days"))])).toEqual([["Andina", 61]]);
  });

  it("refuses a fact the schema does not allow, and finds one by id through the index", async () => {
    const { g, facts } = await setup();
    const f = facts.assert({ subject: "Person:x", predicate: "likes", object: "tea" });
    await facts.project([f.fact]);
    await expect(g.run("CREATE (:Fact {id: 'bad', subject: 'x', predicate: 'p', valid_from: '2026-10-01'})")).rejects.toThrow(/fact_valid_from_type/);
    await expect(g.run("CREATE (:Fact {id: $id, subject: 'x', predicate: 'p'})", { id: f.fact.id })).rejects.toThrow(/fact_id/);
    await expect(g.run("CREATE (:Fact {id: 'nosubject', predicate: 'p'})")).rejects.toThrow(/fact_subject_required/);
    const c = await g.run("SHOW CONSTRAINTS YIELD name RETURN collect(name) AS n");
    expect((c.records[0].get("n") as string[]).sort()).toEqual([
      "fact_ended_at_type", "fact_id", "fact_predicate_required", "fact_recorded_at_type",
      "fact_subject_required", "fact_superseded_at_type", "fact_valid_from_type", "fact_valid_to_type",
    ]);
  });

  it("two projections of one fact at once leave one node", async () => {
    const { g, facts } = await setup();
    const f = facts.assert({ subject: "Person:x", predicate: "likes", object: "tea" });
    await Promise.all([facts.project([f.fact]), facts.project([f.fact]), facts.project([f.fact])]);
    expect(Number((await one(g, "MATCH (f:Fact {id: $id}) RETURN count(f) AS c", { id: f.fact.id })).get("c"))).toBe(1);
  });

  it("brings an older graph to the schema: text times converted, duplicate nodes merged with their links", async () => {
    const { g, db } = await setup();
    await g.run("CREATE (:Person {id: 'p1', name: 'Ada'})");
    // Written while the graph was off; the store that meets the old graph comes next.
    const offline = new FactStore(db as never, () => null);
    const f = offline.assert({ subject: "Person:p1", predicate: "likes", object: "tea", validFrom: "2026-10-01" });
    const row = offline.get(f.fact.id)!;
    const facts = new FactStore(db as never, () => g);
    // What an older Kernl left: text times, and the same fact twice — one copy linked, one not.
    await g.run(
      `CREATE (a:Fact {id: $id, subject: $s, predicate: 'likes', valid_from: $vf, recorded_at: $ra}),
              (:Fact {id: $id, subject: $s, predicate: 'likes', valid_from: $vf, recorded_at: $ra})
       WITH a MATCH (p:Person {id: 'p1'}) CREATE (a)-[:ABOUT]->(p)`,
      { id: row.id, s: row.subject, vf: row.valid_from, ra: row.recorded_at },
    );
    await g.run("UNWIND range(1, 1500) AS i CREATE (:Fact {id: 'old-' + toString(i), subject: 'x', predicate: 'p', valid_from: '2026-01-01T00:00:00.000Z'})");

    await facts.ensureGraphSchema(g);
    expect(Number((await one(g, "MATCH (f:Fact) WHERE toString(f.valid_from) = f.valid_from RETURN count(f) AS c")).get("c"))).toBe(0);
    const r = await one(g, "MATCH (f:Fact {id: $id}) OPTIONAL MATCH (f)-[:ABOUT]->(p:Person) RETURN count(DISTINCT f) AS n, collect(p.name) AS who, f.valid_from AS vf", { id: row.id });
    expect(Number(r.get("n"))).toBe(1);
    expect(r.get("who")).toEqual(["Ada"]);
    expect(r.get("vf")).toBe(row.valid_from);
  });

  it("tells the query writer which properties are datetimes, and keeps that private with the label", async () => {
    const { g, facts } = await setup();
    await facts.project([facts.assert({ subject: "Person:x", predicate: "likes", object: "tea" }).fact]);
    const svc = new GraphQueryService(() => g);
    const text = await svc.schemaText();
    expect(text).toContain("valid_from :: ZONED DATETIME");
    expect(text).toContain("compare them with datetime(");
    const hidden = filterSchema(await svc.schema(), { privateLabels: new Set(["Fact"]) } as never);
    expect(JSON.stringify(hidden)).not.toContain("ZONED DATETIME");
  });
});
