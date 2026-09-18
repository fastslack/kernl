/**
 * Lead cadence editing for the office panel: update/delete a schedule through
 * the service, HTTP (real KernelHttpServer on an ephemeral port) and RPC.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { EventBus } from "../src/core/event-bus.js";
import { registerAgentRoutes } from "../src/modules/agents/api-routes.js";
import { agentsRpcActions } from "../src/modules/agents/rpc-actions.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import { parseSchedulePatch } from "../src/modules/agents/services/schedules-service.js";
import type { KernelConfig } from "../src/core/config.js";

const HOUR = 3_600_000;
let savedFloor: string | undefined;

beforeAll(() => {
  savedFloor = process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS;
  process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = "300";
});
afterAll(() => {
  if (savedFloor === undefined) delete process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS;
  else process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = savedFloor;
});

function freshService() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "agents", agentsMigrations);
  return { db, service: new AgentService(db, new EventBus()) };
}

describe("AgentService.updateSchedule", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  beforeEach(() => ({ db, service } = freshService()));
  afterEach(() => db.close());

  it("changes the interval, clears cron and recomputes next_run_at", () => {
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    const before = Date.now();
    const updated = service.updateSchedule(s.id, { interval_ms: 2 * HOUR })!;
    expect(updated.interval_ms).toBe(2 * HOUR);
    expect(updated.cron_expression).toBe("");
    const next = Date.parse(updated.next_run_at);
    expect(next).toBeGreaterThanOrEqual(before + 2 * HOUR - 1000);
    expect(next).toBeLessThanOrEqual(Date.now() + 2 * HOUR + 1000);
  });

  it("switching to cron sets interval_ms to 0", () => {
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    const updated = service.updateSchedule(s.id, { cron_expression: "0 7 * * *" })!;
    expect(updated.interval_ms).toBe(0);
    expect(updated.cron_expression).toBe("0 7 * * *");
    expect(Date.parse(updated.next_run_at)).toBeGreaterThan(Date.now());
  });

  it("pausing keeps the cadence and next_run_at", () => {
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    const updated = service.updateSchedule(s.id, { active: false })!;
    expect(updated.active).toBe(0);
    expect(updated.interval_ms).toBe(HOUR);
    expect(updated.next_run_at).toBe(s.next_run_at);
  });

  it("rejects an interval below the floor and leaves the row untouched", () => {
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    expect(() => service.updateSchedule(s.id, { interval_ms: 60_000 })).toThrow(/below minimum/);
    expect(service.getSchedule(s.id)!.interval_ms).toBe(HOUR);
  });

  it("rejects a patch that leaves no cadence", () => {
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    expect(() => service.updateSchedule(s.id, { interval_ms: 0 })).toThrow(/needs interval_ms or cron_expression/);
  });

  it("returns undefined for an unknown id; removeSchedule deletes", () => {
    expect(service.updateSchedule("nope", { active: false })).toBeUndefined();
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    expect(service.removeSchedule(s.id)).toBe(true);
    expect(service.getSchedule(s.id)).toBeUndefined();
  });
});

describe("PUT/DELETE /api/agents/schedules/:id", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let server: KernelHttpServer;
  let base: string;

  beforeEach(async () => {
    ({ db, service } = freshService());
    const cfg = {
      dashboard: { port: 0, bind: "127.0.0.1" },
      auth: { token: "" },
      cors: { allowedOrigins: [] },
    } as unknown as KernelConfig;
    server = new KernelHttpServer({ config: cfg });
    registerAgentRoutes(server, service, new AgentExecutor());
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  const put = (id: string, body: unknown) =>
    fetch(`${base}/api/agents/schedules/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("PUT updates the cadence", async () => {
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    const res = await put(s.id, { interval_ms: 2 * HOUR });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; schedule: { interval_ms: number } };
    expect(body.success).toBe(true);
    expect(body.schedule.interval_ms).toBe(2 * HOUR);
  });

  it("PUT answers 400 below the floor and for a non-number interval", async () => {
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    const low = await put(s.id, { interval_ms: 60_000 });
    expect(low.status).toBe(400);
    expect(((await low.json()) as { error: string }).error).toMatch(/below minimum/);
    const wrong = await put(s.id, { interval_ms: "1h" });
    expect(wrong.status).toBe(400);
  });

  it("PUT answers 404 for an unknown schedule", async () => {
    const res = await put("nope", { active: false });
    expect(res.status).toBe(404);
  });

  it("DELETE removes the schedule, then 404", async () => {
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    const first = await fetch(`${base}/api/agents/schedules/${s.id}`, { method: "DELETE" });
    expect(first.status).toBe(200);
    expect(service.listSchedules(agent.id)).toHaveLength(0);
    const second = await fetch(`${base}/api/agents/schedules/${s.id}`, { method: "DELETE" });
    expect(second.status).toBe(404);
  });
});

describe("agents.schedule.update / agents.schedule.delete RPC", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  beforeEach(() => ({ db, service } = freshService()));
  afterEach(() => db.close());

  const action = (name: string) => {
    const found = agentsRpcActions({ service }).find((a) => a.name === name);
    if (!found) throw new Error(`no rpc action named ${name}`);
    return found;
  };

  it("updates and deletes", async () => {
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    const res = (await action("agents.schedule.update").handler({ id: s.id, interval_ms: 3 * HOUR })) as {
      schedule: { interval_ms: number };
    };
    expect(res.schedule.interval_ms).toBe(3 * HOUR);
    expect(await action("agents.schedule.delete").handler({ id: s.id })).toEqual({ success: true });
    expect(service.getSchedule(s.id)).toBeUndefined();
  });

  it("throws for unknown ids", async () => {
    await expect(action("agents.schedule.update").handler({ id: "nope", active: false })).rejects.toThrow("Schedule not found");
    await expect(action("agents.schedule.delete").handler({ id: "nope" })).rejects.toThrow("Schedule not found");
  });

  it("rejects wrong-typed fields like the HTTP route and leaves the row untouched", async () => {
    const agent = service.createAgent({ name: "Lead" });
    const s = service.addSchedule({ agent_id: agent.id, interval_ms: HOUR });
    await expect(action("agents.schedule.update").handler({ id: s.id, interval_ms: "1h" })).rejects.toThrow("interval_ms must be a number");
    await expect(action("agents.schedule.update").handler({ id: s.id, active: "no" })).rejects.toThrow("active must be a boolean");
    expect(service.getSchedule(s.id)!.interval_ms).toBe(HOUR);
    expect(service.getSchedule(s.id)!.active).toBe(1);
  });
});

describe("parseSchedulePatch", () => {
  it("accepts a well-typed patch", () => {
    const result = parseSchedulePatch({ interval_ms: HOUR, cron_expression: "0 7 * * *", active: true });
    expect(result).toEqual({ ok: true, patch: { interval_ms: HOUR, cron_expression: "0 7 * * *", active: true } });
  });

  it("accepts an empty patch", () => {
    expect(parseSchedulePatch({})).toEqual({ ok: true, patch: {} });
  });

  it("rejects a non-number interval_ms", () => {
    expect(parseSchedulePatch({ interval_ms: "1h" })).toEqual({ ok: false, error: "interval_ms must be a number" });
  });

  it("rejects a non-string cron_expression", () => {
    expect(parseSchedulePatch({ cron_expression: 42 })).toEqual({ ok: false, error: "cron_expression must be a string" });
  });

  it("rejects a non-boolean active", () => {
    expect(parseSchedulePatch({ active: "no" })).toEqual({ ok: false, error: "active must be a boolean" });
  });
});
