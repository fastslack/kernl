import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { brainMigrations } from "../src/modules/brain/migrations.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { FactStore, normPredicate, normTime } from "../src/modules/brain/facts.js";
import { askMemory } from "../src/modules/brain/ask.js";

function store() {
  const db = new Database(":memory:");
  runMigrations(db as never, "brain", brainMigrations);
  return { db, facts: new FactStore(db as never) };
}

describe("facts", () => {
  it("normalises predicates and dates", () => {
    expect(normPredicate(" Works at ")).toBe("works_at");
    expect(normPredicate("vive en")).toBe("vive_en");
    expect(normTime("2026-10-01")).toBe("2026-10-01T00:00:00.000Z");
    expect(() => normTime("someday")).toThrow();
  });

  it("a change ends the old value where the new one begins, and keeps both", () => {
    const { facts } = store();
    const a = facts.assert({ subject: "Person:c1", subjectName: "Ada", predicate: "works at", object: "Acme", validFrom: "2024-01-01" });
    const b = facts.assert({ subject: "Person:c1", predicate: "works_at", object: "Globex", validFrom: "2026-10-01" });
    expect(b.ended.map((f) => [f.id, f.valid_to])).toEqual([[a.fact.id, "2026-10-01T00:00:00.000Z"]]);

    expect(facts.query({ subject: "Person:c1" }).map((f) => f.object)).toEqual(["Globex"]);
    expect(facts.query({ subject: "Person:c1", asOf: "2025-06-01" }).map((f) => f.object)).toEqual(["Acme"]);
    expect(facts.query({ subject: "Person:c1", asOf: "2023-06-01" })).toEqual([]);
    expect(facts.query({ subject: "Person:c1", history: true }).map((f) => f.object)).toEqual(["Acme", "Globex"]);
  });

  it("a correction replaces the wrong value over the same span; knownAt still sees the old belief", async () => {
    const { facts } = store();
    const wrong = facts.assert({ subject: "me", predicate: "birthday", object: "1980-03-04", validFrom: "1980-03-04" });
    const before = new Date().toISOString();
    await Bun.sleep(5);
    const right = facts.assert({ subject: "me", predicate: "birthday", object: "1980-04-03", mode: "correction" });
    expect(right.superseded.map((f) => f.id)).toEqual([wrong.fact.id]);
    expect(right.fact.valid_from).toBe("1980-03-04T00:00:00.000Z");

    expect(facts.query({ subject: "me" }).map((f) => f.object)).toEqual(["1980-04-03"]);
    // On any date, the corrected value is what was true…
    expect(facts.query({ subject: "me", asOf: "2000-01-01" }).map((f) => f.object)).toEqual(["1980-04-03"]);
    // …but before the correction Kernl believed the other one.
    expect(facts.query({ subject: "me", asOf: "2000-01-01", knownAt: before }).map((f) => f.object)).toEqual(["1980-03-04"]);
  });

  it("repeats are no-ops, multi-valued predicates accumulate, retract ends or withdraws", () => {
    const { facts } = store();
    const a = facts.assert({ subject: "me", predicate: "speaks", object: "Spanish", multi: true, confidence: 0.6, validFrom: "2020-01-01" });
    const again = facts.assert({ subject: "me", predicate: "speaks", object: "spanish", multi: true, confidence: 0.9 });
    expect(again.status).toBe("unchanged");
    expect(again.fact.confidence).toBe(0.9);
    const b = facts.assert({ subject: "me", predicate: "speaks", object: "English", multi: true });
    expect(b.ended).toEqual([]);
    expect(facts.query({ subject: "me", predicate: "speaks" }).map((f) => f.object).sort()).toEqual(["English", "Spanish"]);

    expect(facts.retract(b.fact.id, "wrong")!.superseded_at).toBeTruthy();
    expect(facts.retract(a.fact.id, "ended", "2026-01-01")!.valid_to).toBe("2026-01-01T00:00:00.000Z");
    expect(facts.query({ subject: "me" })).toEqual([]);
    expect(facts.query({ subject: "me", asOf: "2025-12-31" }).map((f) => f.object)).toEqual(["Spanish"]);
    expect(facts.retract("nope")).toBeNull();
  });
});

describe.skipIf(!relateClientInstalled())("facts in the graph", () => {
  it("projects facts about nodes, links replacements, and answers kernel_brain_ask", async () => {
    const db = new Database(":memory:");
    runMigrations(db as never, "brain", brainMigrations);
    runMigrations(db as never, "chat", chatMigrations);
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    await g.run("CREATE (:Person {id: 'c1', name: 'Ada Lovelace'})");

    // Written while the graph was off, then backfilled.
    const offline = new FactStore(db as never);
    offline.assert({ subject: "Person:c1", subjectName: "Ada Lovelace", predicate: "works_at", object: "Acme", validFrom: "2024-01-01" });
    offline.assert({ subject: "Person:c1", subjectName: "Ada Lovelace", predicate: "works_at", object: "Globex", validFrom: "2026-10-01" });
    const facts = new FactStore(db as never, () => g);
    await facts.backfill(g);

    const rows = (await g.run(
      `MATCH (f:Fact)-[:ABOUT]->(:Person {id: 'c1'}) RETURN f.object AS o, f.current AS cur ORDER BY o`,
    )).records.map((r) => r.toObject());
    expect(rows).toEqual([{ o: "Acme", cur: false }, { o: "Globex", cur: true }]);
    expect(Number((await g.run(
      "MATCH (:Fact {object: 'Globex'})-[:REPLACES {how: 'change'}]->(:Fact {object: 'Acme'}) RETURN count(*) AS n",
    )).records[0].get("n"))).toBe(1);

    const deps = { db: db as never, brain: () => null, embeddings: () => null, chatEmbeddings: () => null, graph: () => g };
    const { results } = await askMemory(deps, { query: "where does Ada work, Globex?" });
    const fact = results.find((r) => r.kind === "fact")!;
    expect(fact.title).toBe("Ada Lovelace · works at · Globex");
    expect(fact.via).toEqual(expect.arrayContaining(["facts", "entities"]));
    // Only the current value answers.
    expect(results.some((r) => r.title.endsWith("Acme"))).toBe(false);
    expect(fact.related).toEqual(expect.arrayContaining([{ rel: "ABOUT", out: true, label: "Person", name: "Ada Lovelace" }]));
  });
});
