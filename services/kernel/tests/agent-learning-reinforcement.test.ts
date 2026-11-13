import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentMemoryService } from "../src/modules/agents/services/memory-service.js";
import { AgentEvalService } from "../assets/extensions/agents/agent-advanced/_module/eval-service.js";

/**
 * Grading credits or blames the learnings a run's prompt actually carried —
 * not every learning the agent happened to have — and a failure never weakens
 * an `avoid` learning, since a failure is what it warned about.
 */
describe("learning reinforcement", () => {
  let db: Database;
  let mem: AgentMemoryService;
  const now = "2026-11-11T10:00:00.000Z";

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    for (const id of ["a", "b"]) {
      db.prepare("INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, id, now, now);
    }
    mem = new AgentMemoryService(db as never);
  });

  const conf = (id: string) =>
    (db.prepare("SELECT confidence, active FROM agent_learnings WHERE id = ?").get(id) as { confidence: number; active: number });

  function learn(agent: string, type: "avoid" | "prefer" | "insight", c = 0.5) {
    return mem.addLearning({ agent_id: agent, type, content: `${type} of ${agent}`, confidence: c }).id;
  }

  it("touches only what the prompt carried, including another agent's learning", () => {
    const shown = learn("a", "prefer");
    const hidden = learn("a", "prefer");
    const shared = learn("b", "insight");
    mem.recordInjectedLearnings("run-1", [shown], false);
    mem.recordInjectedLearnings("run-1", [shared], true);

    mem.reinforceLearningsForRun("a", "2099-01-01T00:00:00Z", "success", "run-1");
    expect(conf(shown).confidence).toBeCloseTo(0.58);
    expect(conf(shared).confidence).toBeCloseTo(0.58);
    expect(conf(hidden).confidence).toBeCloseTo(0.5);
  });

  it("never weakens an avoid learning on failure", () => {
    const avoid = learn("a", "avoid", 0.3);
    const prefer = learn("a", "prefer", 0.3);
    mem.recordInjectedLearnings("run-2", [avoid, prefer], false);

    mem.reinforceLearningsForRun("a", "2099-01-01T00:00:00Z", "failure", "run-2");
    expect(conf(avoid)).toEqual({ confidence: 0.3, active: 1 });
    expect(conf(prefer).confidence).toBeCloseTo(0.15);
  });

  it("blames nothing when the prompt was recorded and carried no learning", () => {
    const l = learn("a", "prefer");
    mem.recordInjectedLearnings("run-3", [], false);
    mem.reinforceLearningsForRun("a", "2099-01-01T00:00:00Z", "failure", "run-3");
    expect(conf(l).confidence).toBeCloseTo(0.5);
  });

  it("keeps the old behaviour for runs recorded before injection was tracked", () => {
    const l = learn("a", "prefer");
    mem.reinforceLearningsForRun("a", "2099-01-01T00:00:00Z", "failure", "never-recorded");
    expect(conf(l).confidence).toBeCloseTo(0.35);
  });
});

describe("AgentEvalService failure streak", () => {
  it("counts failed gradings in a row and resets on success", async () => {
    let fail = true;
    const provider = {
      name: "fake",
      available: () => true,
      supportsTools: () => true,
      async chatCompletion() {
        if (fail) throw new Error("OAuth session expired");
        return { content: '{"score":4,"outcome":"success","lesson":"x","issues":"","confidence":0.8}', tokens_used: 10 };
      },
    };
    const svc = new AgentEvalService();
    svc.setProviders(new Map([["fake", provider as never]]), "fake", "m");
    const input = { goal: "g", result: "r", steps_count: 1, tools_used: [], status: "failed" as const };

    expect(await svc.evaluate(input)).toBeNull();
    expect(await svc.evaluate(input)).toBeNull();
    expect(svc.getFailureState()).toEqual({ streak: 2, lastError: expect.stringContaining("OAuth session expired") });

    fail = false;
    expect(await svc.evaluate(input)).not.toBeNull();
    expect(svc.getFailureState()).toEqual({ streak: 0, lastError: "" });
  });
});
