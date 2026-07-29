import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { TaskService } from "../assets/extensions/productivity/tasks/_module/service.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "tasks", tasksMigrations);
  return db;
}

function makeService(db: Database): TaskService {
  return new TaskService(db, () => null);
}

describe("tasks migration v3 schema", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it("adds new columns to tasks", () => {
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const c of [
      "project_id", "parent_task_id", "sort_order", "recurrence",
      "recurrence_parent_id", "reminder_id", "deleted_at",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("creates the new tables", () => {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of [
      "task_projects", "task_dependencies", "task_checklist_items", "tags", "task_tags",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("enforces UNIQUE(task_id, depends_on_id) on task_dependencies", () => {
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_id, created_at) VALUES ('a','b',?)")
      .run(new Date().toISOString());
    expect(() =>
      db.prepare("INSERT INTO task_dependencies (task_id, depends_on_id, created_at) VALUES ('a','b',?)")
        .run(new Date().toISOString()),
    ).toThrow();
  });
});

describe("tasks v3 service basics", () => {
  let db: Database;
  let service: TaskService;
  beforeEach(() => { db = makeDb(); service = makeService(db); });
  afterEach(() => { db.close(); });

  it("persists v3 columns on create", () => {
    const t = service.create({
      title: "Set up CI",
      project_id: "proj-1",
      recurrence: "FREQ=WEEKLY",
    });
    const row = service.getById(t.id)!;
    expect(row.project_id).toBe("proj-1");
    expect(row.recurrence).toBe("FREQ=WEEKLY");
    expect(row.sort_order).toBe(0);
    expect(row.reminder_id).toBe("");
    expect(row.deleted_at).toBeNull();
  });

  it("soft-deletes and excludes from list", () => {
    const a = service.create({ title: "Keep" });
    const b = service.create({ title: "Remove" });
    expect(service.softDelete(b.id)).toBe(true);
    const titles = service.list().map((t) => t.title);
    expect(titles).toContain("Keep");
    expect(titles).not.toContain("Remove");
    // getById still resolves the soft-deleted row (internal access)
    expect(service.getById(b.id)?.deleted_at).toBeTruthy();
  });

  it("filters list by project_id", () => {
    service.create({ title: "P1", project_id: "p1" });
    service.create({ title: "P2", project_id: "p2" });
    const p1 = service.list({ project_id: "p1" });
    expect(p1).toHaveLength(1);
    expect(p1[0].title).toBe("P1");
  });

  it("updates v3 columns", () => {
    const t = service.create({ title: "T" });
    service.update(t.id, { project_id: "px", sort_order: 5 });
    const row = service.getById(t.id)!;
    expect(row.project_id).toBe("px");
    expect(row.sort_order).toBe(5);
  });
});

describe("tags as entity + cache sync", () => {
  let db: Database;
  let service: TaskService;
  beforeEach(() => { db = makeDb(); service = makeService(db); });
  afterEach(() => { db.close(); });

  it("normalizes tags into entity tables and comma cache", () => {
    const t = service.create({ title: "X", tags: "#backend, api  #backend" });
    // cache is comma-joined, de-duped, '#'-stripped
    const cache = service.getById(t.id)!.tags;
    expect(cache.split(",").sort()).toEqual(["api", "backend"]);
    // entity rows: one shared 'backend', one 'api'
    expect(service.getTaskTags(t.id).sort()).toEqual(["api", "backend"]);
    const allNames = service.listTags().map((x) => x.name).sort();
    expect(allNames).toEqual(["api", "backend"]);
  });

  it("reuses an existing tag row across tasks (UNIQUE name)", () => {
    const a = service.create({ title: "A", tags: "shared" });
    const b = service.create({ title: "B", tags: "shared" });
    expect(service.listTags().filter((x) => x.name === "shared")).toHaveLength(1);
    expect(service.getTaskTags(a.id)).toEqual(["shared"]);
    expect(service.getTaskTags(b.id)).toEqual(["shared"]);
  });

  it("update replaces a task's tags", () => {
    const t = service.create({ title: "T", tags: "one,two" });
    service.update(t.id, { tags: "two,three" });
    expect(service.getTaskTags(t.id).sort()).toEqual(["three", "two"]);
    expect(service.getById(t.id)!.tags.split(",").sort()).toEqual(["three", "two"]);
  });

  it("still matches list({tag}) via the comma cache", () => {
    service.create({ title: "Hit", tags: "alpha,beta" });
    service.create({ title: "Miss", tags: "gamma" });
    expect(service.list({ tag: "beta" }).map((t) => t.title)).toEqual(["Hit"]);
  });
});

describe("projects + reorder", () => {
  let db: Database;
  let service: TaskService;
  beforeEach(() => { db = makeDb(); service = makeService(db); });
  afterEach(() => { db.close(); });

  it("creates, lists, updates, and archives a project", () => {
    const p = service.createProject({ name: "Website", color: "#09f", area: "Work" });
    expect(p.name).toBe("Website");
    expect(p.status).toBe("active");
    expect(service.listProjects()).toHaveLength(1);

    service.updateProject(p.id, { name: "Website v2" });
    expect(service.listProjects()[0].name).toBe("Website v2");

    expect(service.archiveProject(p.id)).toBe(true);
    expect(service.listProjects()).toHaveLength(0);
    expect(service.listProjects({ include_archived: true })).toHaveLength(1);
  });

  it("assigns and clears a task's project", () => {
    const p = service.createProject({ name: "P" });
    const t = service.create({ title: "T" });
    service.setProject(t.id, p.id);
    expect(service.getById(t.id)!.project_id).toBe(p.id);
    service.setProject(t.id, null);
    expect(service.getById(t.id)!.project_id).toBeNull();
  });

  it("reorders tasks by sort_order", () => {
    const a = service.create({ title: "A" });
    const b = service.create({ title: "B" });
    const c = service.create({ title: "C" });
    service.reorder([c.id, a.id, b.id]);
    expect(service.getById(c.id)!.sort_order).toBe(0);
    expect(service.getById(a.id)!.sort_order).toBe(1);
    expect(service.getById(b.id)!.sort_order).toBe(2);
  });
});

describe("subtasks + progress rollup", () => {
  let db: Database;
  let service: TaskService;
  beforeEach(() => { db = makeDb(); service = makeService(db); });
  afterEach(() => { db.close(); });

  it("creates subtasks linked to a parent", () => {
    const parent = service.create({ title: "Ship feature" });
    const s1 = service.addSubtask(parent.id, { title: "Design" });
    service.addSubtask(parent.id, { title: "Build" });
    expect(s1.parent_task_id).toBe(parent.id);
    expect(service.listSubtasks(parent.id)).toHaveLength(2);
  });

  it("rolls up parent progress as subtasks complete", () => {
    const parent = service.create({ title: "P" });
    const s1 = service.addSubtask(parent.id, { title: "S1" });
    const s2 = service.addSubtask(parent.id, { title: "S2" });
    expect(service.getById(parent.id)!.progress).toBe(0);
    service.update(s1.id, { status: "done" });
    expect(service.getById(parent.id)!.progress).toBe(50);
    service.update(s2.id, { status: "done" });
    expect(service.getById(parent.id)!.progress).toBe(100);
  });

  it("reopening a subtask lowers parent progress again", () => {
    const parent = service.create({ title: "P" });
    const s1 = service.addSubtask(parent.id, { title: "S1" });
    service.addSubtask(parent.id, { title: "S2" });
    service.update(s1.id, { status: "done" });
    expect(service.getById(parent.id)!.progress).toBe(50);
    service.update(s1.id, { status: "todo" });
    expect(service.getById(parent.id)!.progress).toBe(0);
  });
});

describe("dependencies in SQLite + cycles", () => {
  let db: Database;
  let service: TaskService;
  beforeEach(() => { db = makeDb(); service = makeService(db); });
  afterEach(() => { db.close(); });

  it("adds and reads dependencies from SQLite (no Neo4j)", () => {
    const a = service.create({ title: "A" });
    const b = service.create({ title: "B" });
    expect(service.addDependency(a.id, b.id)).toBe(true);
    expect(service.getDependencyIds(a.id)).toEqual([b.id]);
    expect(service.getDependencies(a.id)[0]).toContain("B");
  });

  it("is idempotent on duplicate dependency", () => {
    const a = service.create({ title: "A" });
    const b = service.create({ title: "B" });
    service.addDependency(a.id, b.id);
    service.addDependency(a.id, b.id);
    expect(service.getDependencyIds(a.id)).toEqual([b.id]);
  });

  it("rejects self-dependency", () => {
    const a = service.create({ title: "A" });
    expect(() => service.addDependency(a.id, a.id)).toThrow();
  });

  it("rejects a dependency that would create a cycle", () => {
    const a = service.create({ title: "A" });
    const b = service.create({ title: "B" });
    const c = service.create({ title: "C" });
    service.addDependency(a.id, b.id); // a depends on b
    service.addDependency(b.id, c.id); // b depends on c
    // c depends on a would close the loop a→b→c→a
    expect(() => service.addDependency(c.id, a.id)).toThrow(/cycle/i);
  });

  it("removes a dependency", () => {
    const a = service.create({ title: "A" });
    const b = service.create({ title: "B" });
    service.addDependency(a.id, b.id);
    expect(service.removeDependency(a.id, b.id)).toBe(true);
    expect(service.getDependencyIds(a.id)).toEqual([]);
  });
});

describe("auto-block / unblock", () => {
  let db: Database;
  let service: TaskService;
  beforeEach(() => { db = makeDb(); service = makeService(db); });
  afterEach(() => { db.close(); });

  it("blocks a todo task when it gains an unfinished dependency", () => {
    const work = service.create({ title: "Write code" });
    const dep = service.create({ title: "Get spec" });
    service.addDependency(work.id, dep.id);
    expect(service.getById(work.id)!.status).toBe("blocked");
  });

  it("does not block when the dependency is already done", () => {
    const work = service.create({ title: "Write code" });
    const dep = service.create({ title: "Get spec" });
    service.update(dep.id, { status: "done" });
    service.addDependency(work.id, dep.id);
    expect(service.getById(work.id)!.status).toBe("todo");
  });

  it("unblocks when the last dependency completes", () => {
    const work = service.create({ title: "Write code" });
    const d1 = service.create({ title: "Spec" });
    const d2 = service.create({ title: "Design" });
    service.addDependency(work.id, d1.id);
    service.addDependency(work.id, d2.id);
    expect(service.getById(work.id)!.status).toBe("blocked");
    service.update(d1.id, { status: "done" });
    expect(service.getById(work.id)!.status).toBe("blocked"); // d2 still open
    service.update(d2.id, { status: "done" });
    expect(service.getById(work.id)!.status).toBe("todo");
  });

  it("reports blocked tasks with their unfinished deps", () => {
    const work = service.create({ title: "Work" });
    const dep = service.create({ title: "Dep" });
    service.addDependency(work.id, dep.id);
    const blocked = service.listBlocked();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].task.id).toBe(work.id);
    expect(blocked[0].blockedBy).toEqual([dep.id]);
  });
});

describe("recurrence (RRULE)", () => {
  let db: Database;
  let service: TaskService;
  beforeEach(() => { db = makeDb(); service = makeService(db); });
  afterEach(() => { db.close(); });

  it("computes next due for DAILY/WEEKLY/MONTHLY", () => {
    expect(service.previewNextDue("2026-06-24", "FREQ=DAILY")).toBe("2026-06-25");
    expect(service.previewNextDue("2026-06-24", "FREQ=DAILY;INTERVAL=3")).toBe("2026-06-27");
    expect(service.previewNextDue("2026-06-24", "FREQ=WEEKLY")).toBe("2026-07-01");
    expect(service.previewNextDue("2026-06-24", "FREQ=MONTHLY")).toBe("2026-07-24");
  });

  it("handles WEEKLY BYDAY (next matching weekday)", () => {
    // 2026-06-24 is a Wednesday; next Monday is 2026-06-29
    expect(service.previewNextDue("2026-06-24", "FREQ=WEEKLY;BYDAY=MO")).toBe("2026-06-29");
  });

  it("returns null for an unparseable rule", () => {
    expect(service.previewNextDue("2026-06-24", "garbage")).toBeNull();
    expect(service.previewNextDue("2026-06-24", "")).toBeNull();
  });

  it("generates the next instance when a recurring task completes", () => {
    const t = service.create({
      title: "Water plants",
      due_date: "2026-06-24",
      recurrence: "FREQ=WEEKLY",
    });
    service.update(t.id, { status: "done" });

    const open = service.list({ status: "todo" }).filter((x) => x.title === "Water plants");
    expect(open).toHaveLength(1);
    expect(open[0].id).not.toBe(t.id);
    expect(open[0].due_date).toBe("2026-07-01");
    expect(open[0].recurrence).toBe("FREQ=WEEKLY");
    expect(open[0].recurrence_parent_id).toBe(t.id);
    expect(open[0].progress).toBe(0);
  });

  it("does not regenerate for a non-recurring task", () => {
    const t = service.create({ title: "One-off", due_date: "2026-06-24" });
    service.update(t.id, { status: "done" });
    expect(service.list({ status: "todo" }).filter((x) => x.title === "One-off")).toHaveLength(0);
  });
});
