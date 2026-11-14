import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentExperienceGraph } from "../src/modules/agents/services/experience-graph.js";
import { subjectKeyOf, subjectRootOf } from "../src/modules/agents/subject-key.js";
import { promptEarlierAttemptsBlock } from "../src/core/i18n/prompts.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import type { GraphDriver } from "../src/core/db-drivers/graph-driver.js";

describe("subject keys", () => {
  it("takes the first issue or part a text names", () => {
    expect(subjectKeyOf("TRABAJAR web#2653:a-b — fix the form")).toBe("web#2653:a-b");
    expect(subjectKeyOf("Review API#12 then web#3")).toBe("api#12");
    expect(subjectKeyOf("see https://x/y#12 or !1253")).toBe("");
    expect(subjectRootOf("web#2653:a-b")).toBe("web#2653");
    expect(subjectRootOf("web#2653")).toBe("web#2653");
  });
});

describe("earlier attempts block", () => {
  it("says nothing without attempts, and lists them newest first with their outcome", () => {
    expect(promptEarlierAttemptsBlock("en", "web#1", [])).toBe("");
    const out = promptEarlierAttemptsBlock("es", "web#1", [
      { agent: "Dev", ok: false, when: "2026-11-14 03:00", key: "web#1:a", outcome: "blocked: no DB access" },
      { agent: "QA", ok: true, when: "2026-11-13 22:00", key: "web#1", outcome: "" },
    ]);
    expect(out).toContain("web#1");
    expect(out).toContain("✗ 2026-11-14 03:00 · Dev · web#1:a: blocked: no DB access");
    expect(out).toContain("✓ 2026-11-13 22:00 · QA · web#1: (sin resultado)");
  });
});

describe("experience graph without a graph", () => {
  it("returns nothing", async () => {
    const xp = new AgentExperienceGraph(new Database(":memory:") as never, () => null);
    expect(await xp.earlierAttempts("web#1", "r")).toEqual([]);
    expect(await xp.learningAudit("l")).toBeNull();
  });
});

describe.skipIf(!relateClientInstalled())("earlier attempts and learning audit on Relate", () => {
  let db: Database;
  let graph: GraphDriver;
  let xp: AgentExperienceGraph;
  const now = "2026-11-14T08:00:00.000Z";

  function addAgent(id: string, name: string) {
    db.prepare("INSERT INTO agents (id, name, flow_id, created_at, updated_at) VALUES (?, ?, 'office', ?, ?)").run(id, name, now, now);
  }
  function addRun(id: string, agent: string, goal: string, at: string, status = "completed", result = "", error = "") {
    db.prepare(
      "INSERT INTO agent_runs (id, agent_id, goal, status, result, error, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, agent, goal, status, result, error, at, at);
  }
  function addLearning(id: string, agent: string, content: string, runs: string[], at = now) {
    db.prepare(
      `INSERT INTO agent_learnings (id, agent_id, type, content, confidence, source_runs, active, created_at, updated_at, embedding, embedding_model)
       VALUES (?, ?, 'avoid', ?, 0.7, ?, 1, ?, ?, NULL, '')`,
    ).run(id, agent, content, JSON.stringify(runs), at, at);
  }

  beforeEach(async () => {
    db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    const driver = new RelateGraphDriver();
    driver.configure({ path: ":memory:" });
    await driver.start();
    graph = driver;
    xp = new AgentExperienceGraph(db as never, () => graph, () => null);
    addAgent("dev", "Developer");
    addAgent("qa", "Tester");
  });

  it("links runs to the issue they were on, and lists what was tried on it or its parts", async () => {
    addRun("r1", "dev", "TRABAJAR web#2653:form — build it", "2026-11-14T01:00:00.000Z", "failed", "", "no DB access");
    addRun("r2", "qa", "Test web#2653", "2026-11-14T02:00:00.000Z", "completed", "  looks\n good  ");
    addRun("r3", "dev", "TRABAJAR web#2653:form again", "2026-11-14T03:00:00.000Z");
    addRun("r4", "dev", "TRABAJAR web#26530 other issue", "2026-11-14T04:00:00.000Z");
    addRun("r5", "dev", "no issue named", "2026-11-14T05:00:00.000Z");
    await xp.sync();

    const part = await graph.run(
      "MATCH (:AgentRun {id: 'r1'})-[:ON]->(w:WorkItem)-[:PART_OF]->(p:WorkItem) RETURN w.key AS w, p.key AS p",
    );
    expect(part.records.map((r) => [r.get("w"), r.get("p")])).toEqual([["web#2653:form", "web#2653"]]);

    // Asked from a part: the whole issue counts; the current run and other issues stay out.
    const got = await xp.earlierAttempts("web#2653:form", "r3");
    expect(got.map((a) => [a.id, a.agent, a.status, a.key, a.outcome])).toEqual([
      ["r2", "Tester", "completed", "web#2653", "looks good"],
      ["r1", "Developer", "failed", "web#2653:form", "no DB access"],
    ]);
    expect((await xp.earlierAttempts("web#2653", "", 1)).map((a) => a.id)).toEqual(["r3"]);
    expect(await xp.earlierAttempts("web#9", "")).toEqual([]);
  });

  it("audits a lesson: owner, source run, who carried it and what they learned from it", async () => {
    addRun("src", "dev", "TRABAJAR web#1", "2026-11-13T10:00:00.000Z", "failed");
    addRun("use1", "qa", "Test web#1", "2026-11-13T12:00:00.000Z");
    addRun("use2", "dev", "TRABAJAR web#2", "2026-11-13T13:00:00.000Z", "failed");
    addLearning("l-root", "dev", "Run migrations before tests", ["src"], "2026-11-13T11:00:00.000Z");
    addLearning("l-child", "qa", "Seed the DB after migrating", ["use1"], "2026-11-13T12:30:00.000Z");
    const give = db.prepare("INSERT INTO agent_run_learnings (run_id, learning_id, shared) VALUES (?, ?, ?)");
    give.run("use1", "l-root", 1);
    give.run("use2", "l-root", 0);
    await xp.sync();

    const audit = (await xp.learningAudit("l-root"))!;
    expect(audit.owner).toBe("Developer");
    expect(audit.content).toBe("Run migrations before tests");
    expect(audit.active).toBe(true);
    expect(audit.source).toEqual({ run: "src", status: "failed", goal: "TRABAJAR web#1" });
    expect(audit.readers.map((r) => [r.run, r.agent, r.status, r.shared])).toEqual([
      ["use2", "Developer", "failed", false],
      ["use1", "Tester", "completed", true],
    ]);
    expect(audit.children.map((c) => c.id)).toEqual(["l-child"]);

    const lone = (await xp.learningAudit("l-child"))!;
    expect(lone.readers).toEqual([]);
    expect(lone.children).toEqual([]);
    expect(await xp.learningAudit("nope")).toBeNull();
  });
});
