import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { agentsTools } from "../src/modules/agents/tools.js";
import { AgentScheduler } from "../src/modules/agents/scheduler.js";
import { ReactiveEngine } from "../src/modules/agents/reactive-engine.js";
import { EventBus } from "../src/core/event-bus.js";

process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = "1";

describe("project propagation", () => {
  let db: InstanceType<typeof Database>; let agents: AgentService; let projects: ProjectsService; let root: string;
  let agentId: string; let heural: string; let events: EventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "prop-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    agents = new AgentService(db, events);
    agents.setProjectGate(projects.gate());
    const flowId = agents.createFlow({ name: "Ventas" }).id;
    agentId = agents.createAgent({ name: "Closer", flow_id: flowId }).id;
    heural = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    projects.assignOffice(flowId, heural);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  function runTool() {
    const executor = new AgentExecutor();
    (executor as unknown as { execute: unknown }).execute = async () =>
      ({ status: "completed", result: "ok", error: "", steps_count: 0, tokens_used: 0 });
    return agentsTools(agents, executor, events).find((t) => t.name === "kernel_agents_run")!;
  }

  it("kernel_agents_run resolves a slug to the project", async () => {
    await runTool().handler({ agent_id: agentId, goal: "x", project: "heural" });
    expect(agents.listRuns({ agent_id: agentId })[0].project_id).toBe(heural);
  });

  it("kernel_agents_run refuses an unknown project without running", async () => {
    const bad = await runTool().handler({ agent_id: agentId, goal: "x", project: "nope" });
    expect(bad.isError).toBe(true);
    expect(agents.listRuns({ agent_id: agentId }).length).toBe(0);
  });

  it("kernel_agents_run reports the gate refusal as a tool error", async () => {
    projects.update(heural, { status: "paused" });
    const res = await runTool().handler({ agent_id: agentId, goal: "x", project: "heural" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain("paused");
  });

  function triggerTool() {
    return agentsTools(agents, new AgentExecutor(), events).find((t) => t.name === "kernel_agents_add_trigger")!;
  }

  it("kernel_agents_add_trigger ties a schedule to the named project", async () => {
    const res = await triggerTool().handler({ agent_id: agentId, type: "schedule", cron: "0 * * * *", project: "heural" });
    expect(res.isError).toBeFalsy();
    expect(agents.listSchedules(agentId)[0].project_id).toBe(heural);
  });

  it("kernel_agents_add_trigger inherits the project of an office that serves only one", async () => {
    await triggerTool().handler({ agent_id: agentId, type: "schedule", cron: "0 * * * *" });
    expect(agents.listSchedules(agentId)[0].project_id).toBe(heural);
  });

  it("kernel_agents_add_trigger leaves the schedule unscoped when the office serves several projects", async () => {
    const other = projects.create({ slug: "otro", name: "Otro", brief: { value_prop: "v", audience: "a" } }).id;
    projects.assignOffice(agents.getAgent(agentId)!.flow_id!, other);
    await triggerTool().handler({ agent_id: agentId, type: "schedule", cron: "0 * * * *" });
    expect(agents.listSchedules(agentId)[0].project_id).toBeNull();
  });

  it("kernel_agents_add_trigger refuses a project the office does not serve", async () => {
    projects.create({ slug: "ajeno", name: "Ajeno", brief: { value_prop: "v", audience: "a" } });
    const res = await triggerTool().handler({ agent_id: agentId, type: "schedule", cron: "0 * * * *", project: "ajeno" });
    expect(res.isError).toBe(true);
    expect(agents.listSchedules(agentId).length).toBe(0);
  });

  it("due schedules carry their project_id and templates never come due", () => {
    const s = agents.addSchedule({ agent_id: agentId, interval_ms: 60_000 });
    const t = agents.addSchedule({ agent_id: agentId, interval_ms: 60_000, goal_override: "tpl" });
    db.prepare("UPDATE agent_schedules SET project_id = ?, next_run_at = ? WHERE id = ?").run(heural, "2000-01-01T00:00:00Z", s.id);
    db.prepare("UPDATE agent_schedules SET per_project = 1, next_run_at = ? WHERE id = ?").run("2000-01-01T00:00:00Z", t.id);
    const due = agents.getDueSchedules();
    expect(due.map((d) => d.id)).toEqual([s.id]);
    expect(due[0].project_id).toBe(heural);
  });

  it("scheduler runs a project schedule for its project and skips it while the project is paused", async () => {
    const s = agents.addSchedule({ agent_id: agentId, interval_ms: 60_000 });
    db.prepare("UPDATE agent_schedules SET project_id = ?, next_run_at = ? WHERE id = ?").run(heural, "2000-01-01T00:00:00Z", s.id);
    const executor = new AgentExecutor();
    (executor as unknown as { execute: unknown }).execute = async () =>
      ({ status: "completed", result: "ok", error: "", steps_count: 0, tokens_used: 0 });
    const sched = new AgentScheduler(agents, executor, events, 60_000, "UTC");
    const tick = () => (sched as unknown as { tick(): Promise<void> }).tick();

    projects.update(heural, { status: "paused" });
    await tick();
    expect(agents.listRuns({ agent_id: agentId }).length).toBe(0);
    expect(agents.getSchedule(s.id)!.next_run_at > "2000-01-01T00:00:00Z").toBe(true);

    projects.update(heural, { status: "active" });
    db.prepare("UPDATE agent_schedules SET next_run_at = ? WHERE id = ?").run("2000-01-01T00:00:00Z", s.id);
    await tick();
    const runs = agents.listRuns({ agent_id: agentId });
    expect(runs.length).toBe(1);
    expect(runs[0].project_id).toBe(heural);
  });

  it("an event trigger runs for the project named in the payload, and is refused for a foreign one", async () => {
    agents.addEventTrigger({ agent_id: agentId, event_name: "project:waitlist.joined" });
    const executor = new AgentExecutor();
    (executor as unknown as { execute: unknown }).execute = async () =>
      ({ status: "completed", result: "ok", error: "", steps_count: 0, tokens_used: 0 });
    const engine = new ReactiveEngine(agents, executor, events);
    const fire = (p: unknown) => (engine as unknown as { handleEvent(n: string, p: unknown): Promise<void> }).handleEvent("project:waitlist.joined", p);

    await fire({ project_id: "not-assigned", email: "a@b.c" });
    expect(agents.listRuns({ agent_id: agentId }).length).toBe(0);

    await fire({ project_id: heural, email: "a@b.c" });
    const runs = agents.listRuns({ agent_id: agentId });
    expect(runs.length).toBe(1);
    expect(runs[0].project_id).toBe(heural);
  });
});

describe("agents.run operation (dashboard Run now) and projects", () => {
  it("runs for the chosen project, refuses an unknown or unserved one", async () => {
    const { agentOperations } = await import("../src/modules/agents/operations.js");
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    const root = mkdtempSync(join(tmpdir(), "op-"));
    const projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    const agents = new AgentService(db, events);
    agents.setProjectGate(projects.gate());
    const flowId = agents.createFlow({ name: "Ventas" }).id;
    const agentId = agents.createAgent({ name: "Closer", flow_id: flowId }).id;
    const h = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    projects.create({ slug: "kernl", name: "Kernl", brief: { value_prop: "v", audience: "a" } });
    projects.assignOffice(flowId, h);
    const executor = { execute: async () => ({ status: "completed", result: "", error: "", steps_count: 0, tokens_used: 0 }) } as never;
    const ops = agentOperations({ service: agents, executor, events });
    const out = (await ops["agents.run"]({ agent_id: agentId, project: "heural" })) as { run_id: string };
    expect(agents.getRun(out.run_id)!.project_id).toBe(h);
    await expect(async () => ops["agents.run"]({ agent_id: agentId, project: "nope" })).toThrow(/Unknown project/);
    await expect(async () => ops["agents.run"]({ agent_id: agentId, project: "kernl" })).toThrow(/not assigned/);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
});
