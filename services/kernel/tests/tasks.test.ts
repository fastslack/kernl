import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { TaskService } from "../assets/extensions/productivity/tasks/_module/service.js";

describe("TaskService", () => {
  let db: Database;
  let service: TaskService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "tasks", tasksMigrations);
    // No graph driver in tests — service falls through capability gates.
    service = new TaskService(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a task with defaults", () => {
    const task = service.create({ title: "Buy milk" });
    expect(task.title).toBe("Buy milk");
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("medium");
    expect(task.id).toBeTruthy();
  });

  it("creates a task with all fields", () => {
    const task = service.create({
      title: "Deploy app",
      description: "Push v2 to production",
      priority: "urgent",
      context: "@work",
      due_date: "2026-03-01",
    });
    expect(task.priority).toBe("urgent");
    expect(task.context).toBe("@work");
    expect(task.due_date).toBe("2026-03-01");
  });

  it("lists tasks sorted by priority", () => {
    service.create({ title: "Low task", priority: "low" });
    service.create({ title: "Urgent task", priority: "urgent" });
    service.create({ title: "High task", priority: "high" });

    const tasks = service.list();
    expect(tasks[0].title).toBe("Urgent task");
    expect(tasks[1].title).toBe("High task");
    expect(tasks[2].title).toBe("Low task");
  });

  it("filters by status", () => {
    service.create({ title: "A" });
    const b = service.create({ title: "B" });
    service.update(b.id, { status: "done" });

    const todo = service.list({ status: "todo" });
    expect(todo).toHaveLength(1);
    expect(todo[0].title).toBe("A");
  });

  it("updates a task", () => {
    const task = service.create({ title: "Original" });
    const updated = service.update(task.id, {
      title: "Changed",
      status: "in_progress",
    });
    expect(updated?.title).toBe("Changed");
    expect(updated?.status).toBe("in_progress");
  });

  it("returns undefined for unknown task update", () => {
    expect(service.update("nonexistent", { title: "x" })).toBeFalsy();
  });

  it("getById returns task or undefined", () => {
    const task = service.create({ title: "Test" });
    expect(service.getById(task.id)?.title).toBe("Test");
    expect(service.getById("nope")).toBeFalsy();
  });
});
