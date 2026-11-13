import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { officePackMigrations } from "../src/modules/office-packs/migrations.js";
import { OfficePackService } from "../src/modules/office-packs/service.js";
import { parsePack, redact, toMarkdown } from "../src/modules/office-packs/pack.js";

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE agent_flows (id TEXT PRIMARY KEY, name TEXT, description TEXT NOT NULL DEFAULT '');
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, role TEXT NOT NULL DEFAULT 'worker', flow_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE agent_learnings (id TEXT PRIMARY KEY, agent_id TEXT, type TEXT, content TEXT, confidence REAL,
      source_runs TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, project_id TEXT);
  `);
  runMigrations(d as never, "office-packs", officePackMigrations);
  d.exec(`
    INSERT INTO agent_flows VALUES ('o1', 'Dev Office', 'Builds things'), ('o2', 'Other Office', '');
    INSERT INTO agents VALUES ('a1', 'Reviewer', 'reviewer', 'o1'), ('a2', 'Coder', 'worker', 'o1'),
                              ('b1', 'Reviewer', 'reviewer', 'o2'), ('b2', 'Builder', 'worker', 'o2');
    INSERT INTO agent_learnings (id, agent_id, type, content, confidence, active, project_id) VALUES
      ('l1', 'a1', 'avoid', 'Never merge without running the tests', 0.9, 1, NULL),
      ('l2', 'a1', 'prefer', 'Ask ada@example.com before touching billing', 0.8, 1, NULL),
      ('l3', 'a1', 'insight', 'Low confidence guess', 0.2, 1, NULL),
      ('l4', 'a1', 'pattern', 'Retired lesson', 0.9, 0, NULL),
      ('l5', 'a2', 'pattern', 'Project-only lesson', 0.9, 1, 'p1'),
      ('l6', 'a2', 'pattern', 'Run   lint before committing', 0.7, 1, NULL),
      ('b1l', 'b1', 'avoid', 'never merge without running the tests!', 0.5, 1, NULL);
  `);
  const added: Array<Record<string, unknown>> = [];
  const svc = new OfficePackService(d as never, () => (input) => {
    const id = `new-${added.length + 1}`;
    added.push({ id, ...input });
    d.prepare("INSERT INTO agent_learnings (id, agent_id, type, content, confidence) VALUES (?, ?, ?, ?, ?)").run(id, input.agent_id, input.type, input.content, input.confidence);
    return { id };
  });
  return { d, svc, added };
}

describe("knowledge pack format", () => {
  it("redacts personal details and secrets", () => {
    expect(redact("mail ada@x.io, call +54 11 4567-8901, key sk-abcdefghijklmnop12, in /Users/matias/code"))
      .toBe("mail [email], call [phone], key [secret], in ~/code");
    expect(redact("version 1.2.3 on 2026-11-12")).toBe("version 1.2.3 on 2026-11-12");
  });

  it("reads back what it writes, in both spellings, and refuses what is not a pack", () => {
    const pack = parsePack(JSON.stringify({
      format: "kernl-office-pack", version: 1, name: "X", description: "d", exported_at: "t",
      agents: [{ name: "A", role: "worker", learnings: [{ type: "avoid", content: "  two\nlines‮ ", confidence: 3 }, { type: "bogus", content: "x" }] }],
    }));
    expect(pack.agents[0].learnings).toEqual([{ type: "avoid", content: "two lines", confidence: 1 }]);
    expect(parsePack(toMarkdown(pack))).toEqual(pack);
    expect(() => parsePack("{}")).toThrow(/Not a knowledge pack/);
    expect(() => parsePack("# just markdown")).toThrow(/--- block/);
    expect(() => parsePack('{"format":"kernl-office-pack","version":9,"agents":[]}')).toThrow(/version 9/);
  });
});

describe("office packs", () => {
  it("exports active general lessons above the floor, sorted and redacted", () => {
    const { svc } = db();
    const md = svc.export("Dev Office", { format: "markdown", now: "2026-11-12T00:00:00.000Z" });
    expect(md).toMatchObject({ office: "Dev Office", agents: 2, lessons: 3 });
    expect(md.content).toBe([
      "---", "format: kernl-office-pack", "version: 1", "name: Dev Office", "exported_at: 2026-11-12T00:00:00.000Z", "---", "",
      "# Dev Office", "", "Builds things", "",
      "## Coder", "role: worker", "", "- [pattern 0.70] Run lint before committing", "",
      "## Reviewer", "role: reviewer", "", "- [avoid 0.90] Never merge without running the tests", "- [prefer 0.80] Ask [email] before touching billing", "",
    ].join("\n"));
    expect(svc.export("o1", { now: "x" }).content).toBe(svc.export("o1", { now: "x" }).content);
  });

  it("stages a pack for review, then accepts and rejects", () => {
    const { svc, added } = db();
    const pack = svc.export("o1", { format: "json" }).content;
    const r = svc.import("Other Office", pack, { source: "test" });
    // Reviewer ↔ Reviewer by name; Coder has no match (o2's only worker is Builder, matched by role).
    expect(r.counts).toEqual({ duplicate: 1, pending: 2 });
    expect(added).toHaveLength(0);
    const pending = svc.items(r.import_id, "pending");
    expect(pending.map((p) => [p.agent_id, p.content])).toEqual([
      ["b2", "Run lint before committing"],
      ["b1", "Ask [email] before touching billing"],
    ]);

    // Same pack again: nothing new staged.
    expect(svc.import("o2", pack)).toMatchObject({ import_id: r.import_id, already: true });

    const done = svc.review(r.import_id, { accept: [pending[1].id], reject: [pending[0].id, "nope"] });
    expect(done).toMatchObject({ rejected: 1, not_pending: ["nope"], counts: { accepted: 1, rejected: 1, duplicate: 1 } });
    expect(added).toEqual([{ id: "new-1", agent_id: "b1", type: "prefer", content: "Ask [email] before touching billing", confidence: 0.6, source_runs: [`pack:${r.import_id}`], project_id: null }]);
    expect(svc.imports("o2")).toEqual([expect.objectContaining({ pack_name: "Dev Office", pending: 0, accepted: 1 })]);
  });

  it("maps agents explicitly and reports the ones it could not place", () => {
    const { svc } = db();
    const pack = JSON.stringify({ format: "kernl-office-pack", version: 1, name: "P", agents: [
      { name: "Ghost", role: "planner", learnings: [{ type: "insight", content: "Plan first", confidence: 0.7 }] },
      { name: "Writer", role: "x", learnings: [{ type: "insight", content: "Short sentences", confidence: 0.7 }] },
    ] });
    const r = svc.import("o1", pack, { agentMap: { Writer: "Coder" } });
    expect(r.counts).toEqual({ no_agent: 1, pending: 1 });
    expect(r.unmatched_agents).toEqual(["Ghost"]);
    expect(svc.items(r.import_id, "pending")[0].agent_id).toBe("a2");
  });
});
