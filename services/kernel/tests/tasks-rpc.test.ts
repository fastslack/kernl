import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { TaskService } from "../assets/extensions/productivity/tasks/_module/service.js";
import { tasksRpcActions } from "../assets/extensions/productivity/tasks/_module/rpc-actions.js";
import type { RpcAction } from "../src/core/mtw/rpc-handler.js";

function setup() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "tasks", tasksMigrations);
  const service = new TaskService(db, () => null);
  const actions = tasksRpcActions(service);
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const a = actions.find((x: RpcAction) => x.name === name);
    if (!a) throw new Error(`no action ${name}`);
    return Promise.resolve(a.handler(args));
  };
  return { db, service, call };
}

describe("tasks RPC → service", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => { env = setup(); });
  afterEach(() => { env.db.close(); });

  it("create goes through the service and list returns it", async () => {
    const { ok, id } = (await env.call("tasks.create", { title: "Do thing", tags: "a,b" })) as { ok: boolean; id: string };
    expect(ok).toBe(true);
    // tag-entity sync ran (service path), not raw SQL
    expect(env.service.getTaskTags(id).sort()).toEqual(["a", "b"]);
    const { tasks } = (await env.call("tasks.list")) as { tasks: Array<{ id: string }> };
    expect(tasks.map((t) => t.id)).toContain(id);
  });

  it("delete is a soft delete and drops out of list", async () => {
    const a = env.service.create({ title: "Keep" });
    const b = env.service.create({ title: "Remove" });
    await env.call("tasks.delete", { id: b.id });
    expect(env.service.getById(b.id)!.deleted_at).toBeTruthy();
    const { tasks } = (await env.call("tasks.list")) as { tasks: Array<{ id: string }> };
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("reschedule sets due_date via the service", async () => {
    const t = env.service.create({ title: "T" });
    await env.call("tasks.reschedule", { id: t.id, due_date: "2026-07-10" });
    expect(env.service.getById(t.id)!.due_date).toBe("2026-07-10");
  });

  it("updateStatus done on a recurring task spawns the next instance (service logic flows)", async () => {
    const t = env.service.create({ title: "Water", due_date: "2026-06-24", recurrence: "FREQ=WEEKLY" });
    await env.call("tasks.updateStatus", { id: t.id, status: "done" });
    const open = env.service.list({ status: "todo" }).filter((x) => x.title === "Water");
    expect(open).toHaveLength(1);
    expect(open[0].due_date).toBe("2026-07-01");
  });

  it("updateField rejects non-whitelisted fields", async () => {
    const t = env.service.create({ title: "T" });
    await expect(env.call("tasks.updateField", { id: t.id, field: "status", value: "done" })).rejects.toThrow();
  });
});
