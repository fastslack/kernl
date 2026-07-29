import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { remindersMigrations } from "../assets/extensions/productivity/reminders/_module/migrations/001_reminders.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { ReminderService } from "../assets/extensions/productivity/reminders/_module/service.js";
import { remindersRpcActions } from "../assets/extensions/productivity/reminders/_module/rpc-actions.js";
import type { RpcAction } from "../src/core/mtw/rpc-handler.js";

function setup() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "tasks", tasksMigrations); // reminders.task_id FKs to tasks
  runMigrations(db, "reminders", remindersMigrations);
  const service = new ReminderService(db, () => null);
  const actions = remindersRpcActions(service);
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const a = actions.find((x: RpcAction) => x.name === name);
    if (!a) throw new Error(`no action ${name}`);
    return Promise.resolve(a.handler(args));
  };
  return { db, service, call };
}

describe("reminders RPC → service", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => { env = setup(); });
  afterEach(() => { env.db.close(); });

  it("create persists via the service", async () => {
    const { ok, id } = (await env.call("reminders.create", {
      title: "Call mum", trigger_at: "2026-07-01T10:00:00Z", repeat: "weekly",
    })) as { ok: boolean; id: string };
    expect(ok).toBe(true);
    const r = env.service.getById(id)!;
    expect(r.title).toBe("Call mum");
    expect(r.repeat).toBe("weekly");
  });

  it("create requires a title and trigger_at", async () => {
    await expect(env.call("reminders.create", { trigger_at: "2026-07-01T10:00:00Z" })).rejects.toThrow();
    await expect(env.call("reminders.create", { title: "x" })).rejects.toThrow();
  });

  it("reschedule moves trigger_at", async () => {
    const r = env.service.create({ title: "R", trigger_at: "2026-07-01T10:00:00Z" });
    await env.call("reminders.reschedule", { id: r.id, trigger_at: "2026-07-05T10:00:00Z" });
    expect(env.service.getById(r.id)!.trigger_at).toBe("2026-07-05T10:00:00Z");
  });

  it("update renames a reminder", async () => {
    const r = env.service.create({ title: "Old", trigger_at: "2026-07-01T10:00:00Z" });
    await env.call("reminders.update", { id: r.id, title: "New" });
    expect(env.service.getById(r.id)!.title).toBe("New");
  });

  it("dismiss sets status to dismissed", async () => {
    const r = env.service.create({ title: "R", trigger_at: "2026-07-01T10:00:00Z" });
    await env.call("reminders.dismiss", { id: r.id });
    expect(env.service.getById(r.id)!.status).toBe("dismissed");
  });

  it("snooze sets status to snoozed", async () => {
    const r = env.service.create({ title: "R", trigger_at: "2026-07-01T10:00:00Z" });
    await env.call("reminders.snooze", { id: r.id, minutes: 15 });
    expect(env.service.getById(r.id)!.status).toBe("snoozed");
  });
});
