import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { notificationMigrations } from "../src/modules/dashboard/notification-migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { createBuiltinHandlers, KERNEL_AGENT_DEFS } from "../src/modules/agents/builtin-handlers.js";
import { seedDriverAgents, splitRetiredDrivers } from "../src/modules/agents/seed-driver-agents.js";
import { createStorageModule } from "../src/modules/storage/index.js";
import { storageMigrations } from "../src/modules/storage/migrations.js";
import { StorageService } from "../src/modules/storage/service.js";
import type { KernelModule } from "../src/core/types.js";

// The service enforces a minimum schedule interval as a rate-limit guard.
process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = "1";

// Every scheduled poll leaves an agent_runs row. Retention used to be the
// hardcoded script:cleanup; it is now the storage module's policies, applied
// nightly by storage:retention, which also retires the old agent row.

const DAY_MS = 86_400_000;

describe("agent_runs retention", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let storage: ReturnType<typeof createStorageModule>;
  let svc: StorageService;

  const insertRun = (agentId: string, ageDays: number, status = "completed"): string => {
    const id = crypto.randomUUID();
    const createdAt = new Date(Date.now() - ageDays * DAY_MS).toISOString();
    db.prepare(
      `INSERT INTO agent_runs (id, agent_id, trigger_type, trigger_payload, goal, status, result, error,
         steps_count, tokens_used, started_at, completed_at, created_at, parent_run_id, parent_agent_id, depth)
       VALUES (?, ?, 'schedule', '{}', 'poll', ?, '', '', 1, 0, ?, ?, ?, '', '', 0)`,
    ).run(id, agentId, status, createdAt, createdAt, createdAt);
    return id;
  };

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "dashboard-notifications", notificationMigrations);
    runMigrations(db, "storage", storageMigrations);
    service = new AgentService(db, new EventBus());
    storage = createStorageModule(() => [storage as KernelModule]);
    svc = new StorageService(db, ":memory:", () => [storage as KernelModule]);
  });

  afterEach(() => db.close());

  it("no longer seeds script:cleanup, and storage retires the old row", () => {
    const old = service.createAgent({ name: "Data Cleanup", builtin_handler: "script:cleanup" });
    expect(KERNEL_AGENT_DEFS.some((d) => d.handler === "script:cleanup")).toBe(false);
    expect(createBuiltinHandlers({ db, notifier: null, config: {} } as never).has("script:cleanup")).toBe(false);

    const { active, retiredHandlers } = splitRetiredDrivers(storage.getAgentDrivers!());
    expect(active.map((d) => d.handler)).toEqual(["storage:retention"]);
    expect(retiredHandlers).toEqual(["script:cleanup"]);

    seedDriverAgents(db as never, service as never, [...KERNEL_AGENT_DEFS, ...active], 1, retiredHandlers);
    const parked = db.prepare("SELECT active FROM agents WHERE id = ?").get(old.id) as { active: number };
    expect(parked.active).toBe(0);
    const seeded = db.prepare(
      `SELECT a.active, s.active AS scheduled FROM agents a JOIN agent_schedules s ON s.agent_id = a.id
        WHERE a.builtin_handler = 'storage:retention'`,
    ).get();
    expect(seeded).toEqual({ active: 1, scheduled: 1 });
  });

  it("prunes old automatic runs, keeps recent ones, LLM runs and recent failures", async () => {
    const poller = service.createAgent({ name: "Poller", builtin_handler: "cinema:embed-pending" });
    const writer = service.createAgent({ name: "Writer" });
    insertRun(poller.id, 20);
    const recentPoll = insertRun(poller.id, 2);
    const oldLlmRun = insertRun(writer.id, 400);
    const recentFail = insertRun(writer.id, 30, "failed");
    insertRun(writer.id, 90, "failed");

    await svc.run("manual");

    const left = (db.prepare("SELECT id FROM agent_runs").all() as Array<{ id: string }>).map((r) => r.id);
    expect(left.sort()).toEqual([recentPoll, oldLlmRun, recentFail].sort());
  });

  it("does not embed the goal of builtin agents' runs", () => {
    const calls: string[] = [];
    (service as unknown as { memory: { scheduleEmbed: (...a: unknown[]) => void } }).memory.scheduleEmbed =
      (_t, _c, _m, rowId) => { calls.push(String(rowId)); };
    const poller = service.createAgent({ name: "Poller", builtin_handler: "check:digest" });
    const writer = service.createAgent({ name: "Writer" });
    service.createRun({ agent_id: poller.id, trigger_type: "schedule", goal: "Run the scheduled check" });
    const llm = service.createRun({ agent_id: writer.id, trigger_type: "manual", goal: "Write the weekly report" });
    expect(calls).toEqual([llm.id]);
  });
});
