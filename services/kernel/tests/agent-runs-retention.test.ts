import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { createBuiltinHandlers, KERNEL_AGENT_DEFS } from "../src/modules/agents/builtin-handlers.js";
import { seedDriverAgents } from "../src/modules/agents/seed-driver-agents.js";

// The service enforces a minimum schedule interval as a rate-limit guard.
process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = "1";

// Every scheduled poll leaves an agent_runs row carrying a goal embedding.
// script:cleanup prunes the old ones, but while it was declared only in
// SCRIPT_AGENT_DEFS, a list nothing seeds, no install ever had an agent to run
// it, and the table grew by about 2k rows a day.

const DAY_MS = 86_400_000;

describe("agent_runs retention", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;

  const ctx = () => ({ db, notifier: null, config: {} }) as unknown as Parameters<typeof createBuiltinHandlers>[0];

  const insertRun = (agentId: string, ageDays: number): string => {
    const id = crypto.randomUUID();
    const createdAt = new Date(Date.now() - ageDays * DAY_MS).toISOString();
    db.prepare(
      `INSERT INTO agent_runs (id, agent_id, trigger_type, trigger_payload, goal, status, result, error,
         steps_count, tokens_used, started_at, completed_at, created_at, parent_run_id, parent_agent_id, depth)
       VALUES (?, ?, 'schedule', '{}', 'poll', 'completed', '', '', 1, 0, ?, ?, ?, '', '', 0)`,
    ).run(id, agentId, createdAt, createdAt, createdAt);
    return id;
  };

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
  });

  afterEach(() => db.close());

  it("seeds a scheduled agent that runs the cleanup", () => {
    seedDriverAgents(db as never, service as never, KERNEL_AGENT_DEFS, 1);

    const row = db.prepare(
      `SELECT a.active, s.active AS scheduled FROM agents a
         JOIN agent_schedules s ON s.agent_id = a.id
        WHERE a.builtin_handler = ?`,
    ).get("script:cleanup");
    expect(row).toEqual({ active: 1, scheduled: 1 });
    expect(createBuiltinHandlers(ctx()).has("script:cleanup")).toBe(true);
  });

  it("prunes month-old poll runs and keeps recent ones and LLM runs", async () => {
    const poller = service.createAgent({ name: "Poller", builtin_handler: "cinema:embed-pending" });
    const writer = service.createAgent({ name: "Writer" });
    insertRun(poller.id, 45);
    const recentPoll = insertRun(poller.id, 2);
    const oldLlmRun = insertRun(writer.id, 45);

    const cleanup = createBuiltinHandlers(ctx()).get("script:cleanup") as unknown as () => Promise<string>;
    await cleanup();

    const left = (db.prepare("SELECT id FROM agent_runs").all() as Array<{ id: string }>).map((r) => r.id);
    expect(left.sort()).toEqual([recentPoll, oldLlmRun].sort());
  });
});
