import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentMemoryService } from "../src/modules/agents/services/memory-service.js";

/**
 * Every change in what an agent knows is announced and kept: a lesson created
 * by any path, a run moving the confidence of what it was given (its own and
 * other agents' lessons), a lesson retired by another agent's run or by the
 * sweep. The history is what the 3D office and the time machine draw.
 */
describe("learning events and confidence history", () => {
  let db: Database;
  let mem: AgentMemoryService;
  let events: Array<{ name: string; p: Record<string, any> }>;
  const now = "2026-11-11T10:00:00.000Z";

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    for (const [id, name] of [["a", "Ada"], ["b", "Bruno"]]) {
      db.prepare("INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, now, now);
    }
    events = [];
    mem = new AgentMemoryService(db as never, (name, p) => events.push({ name, p }));
  });

  const history = (id: string) =>
    db.prepare("SELECT before, after, run_id, agent_id, cause FROM agent_learning_confidence WHERE learning_id = ? ORDER BY rowid").all(id) as Array<{ before: number | null; after: number; run_id: string; agent_id: string; cause: string }>;

  it("announces a created lesson with its source and run, and starts its history", () => {
    const l = mem.addLearning({ agent_id: "a", type: "prefer", content: "x", confidence: 0.6, source: "auto", run_id: "run-1" });
    const e = events.find((x) => x.name === "agent:flow:learning_created")!;
    expect(e.p).toMatchObject({ agent_id: "a", agent_name: "Ada", run_id: "run-1", learning_id: l.id, source: "auto", confidence: 0.6 });
    expect(history(l.id)).toEqual([{ before: null, after: 0.6, run_id: "run-1", agent_id: "a", cause: "created:auto" }]);
  });

  it("records but does not announce lessons arriving in bulk", () => {
    mem.addLearning({ agent_id: "a", type: "prefer", content: "x", source: "office-pack" });
    mem.addLearning({ agent_id: "a", type: "prefer", content: "y", source: "marketplace" });
    expect(events).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agent_learning_confidence").get() as { n: number }).n).toBe(2);
  });

  it("a run reinforces what it was given, its own and another agent's, in one event", () => {
    const own = mem.addLearning({ agent_id: "a", type: "prefer", content: "own", confidence: 0.5 }).id;
    const theirs = mem.addLearning({ agent_id: "b", type: "insight", content: "theirs", confidence: 0.5 }).id;
    mem.recordInjectedLearnings("run-2", [own], false);
    mem.recordInjectedLearnings("run-2", [theirs], true);
    events = [];
    mem.reinforceLearningsForRun("a", now, "success", "run-2");
    const e = events.find((x) => x.name === "agent:flow:learning_reinforced")!;
    expect(e.p.outcome).toBe("success");
    const byId = Object.fromEntries((e.p.items as Array<Record<string, any>>).map((i) => [i.learning_id, i]));
    expect(byId[own]).toMatchObject({ shared: false, before: 0.5, deactivated: false });
    expect(byId[own].after).toBeCloseTo(0.58);
    expect(byId[theirs]).toMatchObject({ shared: true, owner_agent_id: "b", owner_agent_name: "Bruno" });
    // Bruno's lesson grew because Ada's run used it: the history says whose run.
    expect(history(theirs).at(-1)).toMatchObject({ run_id: "run-2", agent_id: "a", cause: "run:success" });
  });

  it("another agent's lesson retired by a failed run is announced to its owner", () => {
    const theirs = mem.addLearning({ agent_id: "b", type: "prefer", content: "theirs", confidence: 0.2 }).id;
    mem.recordInjectedLearnings("run-3", [theirs], true);
    events = [];
    mem.reinforceLearningsForRun("a", now, "failure", "run-3");
    const off = events.find((x) => x.name === "agent:flow:learning_deactivated")!;
    expect(off.p).toMatchObject({ agent_id: "b", cause: "shared", by_agent_id: "a", count: 1 });
    expect(off.p.learnings[0].id).toBe(theirs);
  });

  it("timelines: every lesson's confidence over time, and when it was retired", () => {
    const l = mem.addLearning({ agent_id: "a", type: "prefer", content: "x", confidence: 0.2 });
    mem.recordInjectedLearnings("run-9", [l.id], false);
    mem.reinforceLearningsForRun("a", now, "failure", "run-9");
    const t = mem.getConfidenceTimelines([l.id, "missing"])[l.id];
    expect(t.points.map((p) => p[1])).toEqual([0.2, expect.closeTo(0.05)]);
    expect(t.retired_at).toBe(t.points[1][0]);
  });

  it("the sweep announces what it retires, and stays quiet when nothing goes", () => {
    const weak = mem.addLearning({ agent_id: "a", type: "insight", content: "weak", confidence: 0.1 }).id;
    events = [];
    expect(mem.cleanupLowConfidenceLearnings("a")).toBe(1);
    const off = events.find((x) => x.name === "agent:flow:learning_deactivated")!;
    expect(off.p).toMatchObject({ agent_id: "a", cause: "sweep", count: 1 });
    expect(off.p.learnings[0].id).toBe(weak);
    events = [];
    expect(mem.cleanupLowConfidenceLearnings("a")).toBe(0);
    expect(events).toHaveLength(0);
  });
});
