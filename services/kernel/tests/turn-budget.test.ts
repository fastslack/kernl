import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { TurnBudgets, letterKind, turnBudget } from "../assets/extensions/agents/agent-advanced/_module/turn-budget.js";

describe("letterKind", () => {
  it("is the kind of the first letter a wake names", () => {
    expect(letterKind('You have 2 unacknowledged letter(s) in your office inbox: "REVISAR-MR web#2720:a-c" (id 1); "JOB-OK qa_controls web#2720" (id 2).')).toBe("REVISAR-MR");
    expect(letterKind('Inbox wake-up: Host just sent you "CERRAR web#2740" (id 9).')).toBe("CERRAR");
  });
  it("is null for goals that are not letters", () => {
    expect(letterKind("Ronda del vigía: hay issues nuevos")).toBeNull();
    expect(letterKind('Inbox wake-up: X just sent you "hola, ¿cómo va?" (id 1).')).toBeNull();
  });
});

describe("turnBudget", () => {
  const ok = (turns: number) => ({ turns, ok: true, maxed: false });
  it("keeps the agent's own limit until it has seen enough runs of that kind", () => {
    expect(turnBudget(30, Array.from({ length: 10 }, () => ok(8)))).toBe(30);
  });
  it("learns it from the runs that went well: room above the usual long run, not the agent's whole limit", () => {
    const h = Array.from({ length: 40 }, (_, i) => ok(10 + (i % 10)));   // 10..19 turns
    const b = turnBudget(200, h);
    expect(b).toBeGreaterThanOrEqual(28);
    expect(b).toBeLessThan(60);
  });
  it("never goes below a floor", () => {
    expect(turnBudget(200, Array.from({ length: 40 }, () => ok(2)))).toBe(20);
  });
  it("raises it when runs of that kind ran out of turns (the Matware Reviewer at 30)", () => {
    const h = [{ turns: 30, ok: false, maxed: true }, ok(12), ok(14)];
    expect(turnBudget(30, h)).toBe(60);
  });
  it("raises a learned budget the same way, and never above the ceiling", () => {
    const h = [...Array.from({ length: 30 }, () => ok(20)), { turns: 33, ok: false, maxed: true }];
    expect(turnBudget(30, h)).toBeGreaterThanOrEqual(66);
    expect(turnBudget(300, [{ turns: 300, ok: false, maxed: true }])).toBe(400);
  });
});

describe("TurnBudgets", () => {
  let db: Database;
  let tb: TurnBudgets;
  beforeEach(() => { db = new Database(":memory:"); tb = new TurnBudgets(db as any); });

  it("records each run's turns by agent and kind, and budgets from them", () => {
    for (let i = 0; i < 25; i++) tb.record({ runId: `r${i}`, agentId: "a", goal: '"CERRAR web#1" (id x)', turns: 10, ok: true, maxed: false });
    expect(tb.budgetFor("a", '"CERRAR web#9" (id y)', 200)).toBe(20);
    expect(tb.budgetFor("a", '"TRABAJAR web#9" (id y)', 200)).toBe(200);   // another kind: nothing learned
    expect(tb.budgetFor("b", '"CERRAR web#9" (id y)', 200)).toBe(200);     // another agent
  });
  it("leaves goals that are not letters alone", () => {
    tb.record({ runId: "r", agentId: "a", goal: "free text", turns: 99, ok: false, maxed: true });
    expect(tb.budgetFor("a", "free text", 30)).toBe(30);
  });
});
