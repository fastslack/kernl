import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { outputCap, OutputBudgets } from "../assets/extensions/agents/agent-advanced/_module/output-budget.js";

describe("outputCap", () => {
  it("is the agent's usual long output (p90), rounded up to the thousand", () => {
    const sizes = Array.from({ length: 100 }, (_, i) => (i + 1) * 100);   // 100..10000
    expect(outputCap(sizes)).toBe(9000);
  });
  it("never cuts below a floor, never above the CLI's own default", () => {
    expect(outputCap(Array.from({ length: 100 }, () => 500))).toBe(8000);
    expect(outputCap(Array.from({ length: 100 }, () => 50000))).toBeNull();
  });
  it("needs enough outputs before it cuts anything", () => {
    expect(outputCap(Array.from({ length: 10 }, () => 500))).toBeNull();
  });
});

describe("OutputBudgets", () => {
  it("learns from the agent's own Bash outputs only", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE agent_runs (id TEXT, agent_id TEXT);
      CREATE TABLE agent_run_steps (id TEXT, run_id TEXT, step_number INT, type TEXT, content TEXT, tool_name TEXT, tool_input TEXT, tool_output TEXT, tokens INT, created_at TEXT)`);
    db.run("INSERT INTO agent_runs VALUES ('r1','a'),('r2','b')");
    const now = new Date().toISOString();
    for (let i = 0; i < 80; i++) db.run("INSERT INTO agent_run_steps (run_id, type, tool_name, tool_output, created_at) VALUES ('r1','tool_result','Bash',?,?)", ["x".repeat(1000 + i * 100), now]);
    for (let i = 0; i < 80; i++) db.run("INSERT INTO agent_run_steps (run_id, type, tool_name, tool_output, created_at) VALUES ('r1','tool_result','Read',?,?)", ["x".repeat(40000), now]);
    const ob = new OutputBudgets(db as any);
    expect(ob.capFor("a")).toBe(9000);
    expect(ob.capFor("b")).toBeNull();
  });
});
