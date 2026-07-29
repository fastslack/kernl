import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { TaskService } from "../assets/extensions/productivity/tasks/_module/service.js";
import { taskTools } from "../assets/extensions/productivity/tasks/_module/tools.js";
import type { ToolDefinition, ToolResult } from "../src/core/types.js";

function makeTools(): { service: TaskService; tools: ToolDefinition[]; db: Database } {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "tasks", tasksMigrations);
  const service = new TaskService(db, () => null);
  return { service, tools: taskTools(service), db };
}

describe("tasks MCP tools", () => {
  let service: TaskService;
  let tools: ToolDefinition[];
  let db: Database;

  beforeEach(() => { ({ service, tools, db } = makeTools()); });
  afterEach(() => { db.close(); });

  function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return Promise.resolve(tool.handler(args));
  }
  const text = (r: ToolResult) => r.content.map((c) => ("text" in c ? c.text : "")).join("");

  it("registers all the new tools", () => {
    const names = tools.map((t) => t.name);
    for (const n of [
      "kernel_tasks_create", "kernel_tasks_list", "kernel_tasks_update",
      "kernel_tasks_get", "kernel_tasks_delete",
      "kernel_tasks_add_dependency", "kernel_tasks_remove_dependency",
      "kernel_tasks_get_dependencies", "kernel_tasks_blocked",
      "kernel_tasks_add_subtask", "kernel_tasks_reorder",
      "kernel_tasks_recurrence_preview", "kernel_tasks_list_tags",
      "kernel_tasks_project_create", "kernel_tasks_project_list",
      "kernel_tasks_project_update", "kernel_tasks_project_archive",
      "kernel_tasks_set_project",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("get returns a task with its subtasks", async () => {
    const t = service.create({ title: "Parent" });
    service.addSubtask(t.id, { title: "Child" });
    const r = await call("kernel_tasks_get", { id: t.id });
    expect(text(r)).toContain("Parent");
    expect(text(r)).toContain("Child");
  });

  it("get on a missing task is an error", async () => {
    const r = await call("kernel_tasks_get", { id: "nope" });
    expect(r.isError).toBe(true);
  });

  it("delete soft-deletes a task", async () => {
    const t = service.create({ title: "Gone" });
    const r = await call("kernel_tasks_delete", { id: t.id });
    expect(r.isError).toBeFalsy();
    expect(service.getById(t.id)!.deleted_at).toBeTruthy();
  });

  it("add_dependency rejects a cycle with an error result (not a throw)", async () => {
    const a = service.create({ title: "A" });
    const b = service.create({ title: "B" });
    await call("kernel_tasks_add_dependency", { task_id: a.id, depends_on: b.id });
    const r = await call("kernel_tasks_add_dependency", { task_id: b.id, depends_on: a.id });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/cycle/i);
  });

  it("remove_dependency unwires a dependency", async () => {
    const a = service.create({ title: "A" });
    const b = service.create({ title: "B" });
    await call("kernel_tasks_add_dependency", { task_id: a.id, depends_on: b.id });
    const r = await call("kernel_tasks_remove_dependency", { task_id: a.id, depends_on: b.id });
    expect(r.isError).toBeFalsy();
    expect(service.getDependencyIds(a.id)).toEqual([]);
  });

  it("blocked lists blocked tasks with their waiting-on deps", async () => {
    const work = service.create({ title: "Work" });
    const dep = service.create({ title: "Dep" });
    await call("kernel_tasks_add_dependency", { task_id: work.id, depends_on: dep.id });
    const r = await call("kernel_tasks_blocked", {});
    expect(text(r)).toContain("Work");
    expect(text(r)).toContain(dep.id);
  });

  it("recurrence_preview computes a date and errors on garbage", async () => {
    const ok = await call("kernel_tasks_recurrence_preview", { from_date: "2026-06-24", recurrence: "FREQ=WEEKLY" });
    expect(text(ok)).toContain("2026-07-01");
    const bad = await call("kernel_tasks_recurrence_preview", { from_date: "2026-06-24", recurrence: "garbage" });
    expect(bad.isError).toBe(true);
  });

  it("project create/list/archive flow", async () => {
    const created = await call("kernel_tasks_project_create", { name: "Website", area: "Work" });
    expect(text(created)).toContain("Website");
    const listed = await call("kernel_tasks_project_list", {});
    expect(text(listed)).toContain("Website");

    const p = service.listProjects()[0];
    const archived = await call("kernel_tasks_project_archive", { id: p.id });
    expect(archived.isError).toBeFalsy();
    expect(service.listProjects()).toHaveLength(0);
  });

  it("set_project assigns and clears a project", async () => {
    const p = service.createProject({ name: "P" });
    const t = service.create({ title: "T" });
    await call("kernel_tasks_set_project", { task_id: t.id, project_id: p.id });
    expect(service.getById(t.id)!.project_id).toBe(p.id);
    await call("kernel_tasks_set_project", { task_id: t.id, project_id: null });
    expect(service.getById(t.id)!.project_id).toBeNull();
  });

  it("create accepts v3 fields and list_tags surfaces them", async () => {
    await call("kernel_tasks_create", { title: "X", tags: "alpha,beta", recurrence: "FREQ=DAILY" });
    const r = await call("kernel_tasks_list_tags", {});
    expect(text(r)).toContain("alpha");
    expect(text(r)).toContain("beta");
  });
});
