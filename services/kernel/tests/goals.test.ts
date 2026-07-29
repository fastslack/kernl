import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { goalsMigrations } from "../assets/extensions/productivity/goals/_module/migrations/001_goals.js";
import { GoalsService } from "../assets/extensions/productivity/goals/_module/service.js";
// graph driver mocked as null in tests

describe("GoalsService", () => {
  let db: Database;
  let service: GoalsService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "goals", goalsMigrations);
    service = new GoalsService(db, () => null);
  });
  afterEach(() => db.close());

  it("creates a goal", () => {
    const goal = service.createGoal({ title: "Learn Rust" });
    expect(goal.id).toBeTruthy();
    expect(goal.status).toBe("active");
    expect(goal.type).toBe("goal");
  });

  it("creates sub-goals", () => {
    const parent = service.createGoal({ title: "Fitness" });
    const child = service.createGoal({ title: "Run 5k", parent_id: parent.id });
    expect(child.parent_id).toBe(parent.id);
  });

  it("adds key results", () => {
    const goal = service.createGoal({ title: "Revenue" });
    const kr = service.addKeyResult({ goal_id: goal.id, title: "Reach 100k MRR", target_value: 100000, unit: "EUR" });
    expect(kr.goal_id).toBe(goal.id);
    expect(kr.current_value).toBe(0);
  });

  it("calculates progress", () => {
    const goal = service.createGoal({ title: "Q1 Goals" });
    service.addKeyResult({ goal_id: goal.id, title: "KR1", target_value: 100, current_value: 50 });
    service.addKeyResult({ goal_id: goal.id, title: "KR2", target_value: 100, current_value: 100 });
    const progress = service.progress(goal.id);
    expect(progress?.overall_percentage).toBe(75);
  });

  it("updates key result progress", () => {
    const goal = service.createGoal({ title: "Test" });
    const kr = service.addKeyResult({ goal_id: goal.id, title: "KR1", target_value: 10 });
    service.updateKeyResult(kr.id, { current_value: 7 });
    const updated = service.progress(goal.id);
    expect(updated?.overall_percentage).toBe(70);
  });

  it("completes a goal", () => {
    const goal = service.createGoal({ title: "Done" });
    service.updateGoal(goal.id, { status: "completed" });
    expect(service.getGoal(goal.id)?.status).toBe("completed");
    expect(service.listGoals({ status: "active" })).toHaveLength(0);
  });

  it("throws on invalid goal_id for key result", () => {
    expect(() => service.addKeyResult({ goal_id: "invalid", title: "KR" }))
      .toThrow("Goal not found");
  });
});
