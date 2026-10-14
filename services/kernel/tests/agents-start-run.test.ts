// tests/agents-start-run.test.ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { startAgentRun } from "../src/modules/agents/start-run.js";

describe("startAgentRun", () => {
  it("creates a running manual run, then records the outcome", async () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    const events = new EventBus();
    const service = new AgentService(db, events);
    const agent = service.createAgent({ name: "Vigía" });
    let release!: () => void;
    const done = new Promise<void>((r) => { release = r; });
    const executor = { execute: async () => { await done; return { status: "completed", result: "ok", error: "", steps_count: 1, tokens_used: 5 }; } } as never;
    const run = startAgentRun({ service, executor, events }, { agent, goal: "Ronda del vigía." });
    expect(service.getRun(run.id)?.status).toBe("running");
    expect(service.getRun(run.id)?.trigger_type).toBe("manual");
    release();
    await Bun.sleep(5);
    expect(service.getRun(run.id)?.status).toBe("completed");
    expect(service.getRun(run.id)?.result).toBe("ok");
  });

  it("marks the run failed when the executor throws", async () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    const service = new AgentService(db, new EventBus());
    const agent = service.createAgent({ name: "X" });
    const executor = { execute: async () => { throw new Error("boom"); } } as never;
    const run = startAgentRun({ service, executor }, { agent, goal: "g" });
    await Bun.sleep(5);
    expect(service.getRun(run.id)?.status).toBe("failed");
    expect(service.getRun(run.id)?.error).toContain("boom");
  });
});
