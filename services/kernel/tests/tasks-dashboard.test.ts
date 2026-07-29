import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { TaskService } from "../assets/extensions/productivity/tasks/_module/service.js";
import { queryTasks } from "../assets/extensions/productivity/tasks/_module/dashboard-queries.js";

function setup() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "tasks", tasksMigrations);
  return { db, service: new TaskService(db, () => null) };
}

describe("dashboard-queries excludes soft-deleted tasks", () => {
  let db: Database;
  let service: TaskService;
  beforeEach(() => { ({ db, service } = setup()); });
  afterEach(() => { db.close(); });

  it("a soft-deleted task drops out of KPI total and breakdowns", () => {
    service.create({ title: "Alive", priority: "high", tags: "x" });
    const gone = service.create({ title: "Gone", priority: "urgent", tags: "y" });
    let d = queryTasks(db);
    expect(d.kpis.total).toBe(2);

    service.softDelete(gone.id);
    d = queryTasks(db);
    expect(d.kpis.total).toBe(1);
    // breakdown by priority should no longer count the deleted 'urgent'
    expect(d.byPriority.urgent ?? 0).toBe(0);
    // status breakdown total should be 1
    const statusTotal = Object.values(d.byStatus).reduce((a, b) => a + b, 0);
    expect(statusTotal).toBe(1);
    // tag breakdown should not include the deleted task's tag
    expect(d.byTag.y ?? 0).toBe(0);
  });

  it("a soft-deleted in-progress task drops out of inProgressTasks", () => {
    const t = service.create({ title: "Working" });
    service.update(t.id, { status: "in_progress" });
    expect(queryTasks(db).inProgressTasks).toHaveLength(1);
    service.softDelete(t.id);
    expect(queryTasks(db).inProgressTasks).toHaveLength(0);
  });

  it("a soft-deleted blocked task drops out of the blocked list", () => {
    const work = service.create({ title: "Work" });
    const dep = service.create({ title: "Dep" });
    service.addDependency(work.id, dep.id); // auto-blocks work
    expect(queryTasks(db).blocked.map((b) => b.id)).toContain(work.id);
    service.softDelete(work.id);
    expect(queryTasks(db).blocked.map((b) => b.id)).not.toContain(work.id);
  });
});
