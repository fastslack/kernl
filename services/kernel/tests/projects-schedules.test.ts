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
import { EventBus } from "../src/core/event-bus.js";
import { watchScheduleChanges } from "../src/modules/projects/index.js";
import { materializeOffice, officeDefinitionFromJson } from "../src/modules/agents/office-kit.js";

process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = "1";

describe("per_project schedules", () => {
  let db: InstanceType<typeof Database>; let agents: AgentService; let projects: ProjectsService; let root: string;
  let flowId: string; let agentId: string;
  const brief = { value_prop: "v", audience: "a" };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "sch-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    agents = new AgentService(db, events);
    flowId = agents.createFlow({ name: "Marketing" }).id;
    agentId = agents.createAgent({ name: "Editor", flow_id: flowId }).id;
    const tpl = agents.addSchedule({ agent_id: agentId, interval_ms: 3_600_000, goal_override: "plan the week" });
    db.prepare("UPDATE agent_schedules SET per_project = 1 WHERE id = ?").run(tpl.id);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  const clones = () => (db.prepare("SELECT project_id FROM agent_schedules WHERE per_project = 1 AND project_id IS NOT NULL ORDER BY project_id").all() as Array<{ project_id: string }>).map((c) => c.project_id);

  it("clones the template once per active project and removes on unassign/pause", () => {
    const h = projects.create({ slug: "heural", name: "Heural", brief }).id;
    const k = projects.create({ slug: "kernl", name: "Kernl", brief }).id;
    projects.assignOffice(flowId, h);
    projects.assignOffice(flowId, k);
    projects.assignOffice(flowId, k);
    expect(clones().sort()).toEqual([h, k].sort());
    projects.assignOffice(flowId, k, { active: false });
    expect(clones()).toEqual([h]);
    projects.unassignOffice(flowId, h);
    expect(clones()).toEqual([]);
  });

  it("pausing the project drops its clones and resuming brings them back", () => {
    const h = projects.create({ slug: "heural", name: "Heural", brief }).id;
    projects.assignOffice(flowId, h);
    projects.update(h, { status: "paused" });
    expect(clones()).toEqual([]);
    projects.update(h, { status: "active" });
    expect(clones()).toEqual([h]);
  });

  it("templates never come due", () => {
    db.prepare("UPDATE agent_schedules SET next_run_at = '2000-01-01T00:00:00Z'").run();
    expect(agents.getDueSchedules()).toEqual([]);
  });

  it("office.json cron with per_project materializes a template, cloned per assigned project", () => {
    const def = officeDefinitionFromJson({
      name: "Ventas",
      agents: [{ slug: "closer", name: "Closer", role: "manager", prompt: "x" }],
      cron: { agent: "closer", every: "6h", goal: "work the pipeline", per_project: true },
    });
    materializeOffice(db, agents, def);
    const flow = agents.listFlows().find((f) => f.name === "Ventas")!;
    const tpl = db.prepare("SELECT per_project, project_id FROM agent_schedules WHERE goal_override = 'work the pipeline'").all();
    expect(tpl).toEqual([{ per_project: 1, project_id: null }]);
    const h = projects.create({ slug: "heural", name: "Heural", brief }).id;
    projects.assignOffice(flow.id, h);
    expect(db.prepare("SELECT project_id FROM agent_schedules WHERE goal_override = 'work the pipeline' AND project_id IS NOT NULL").all()).toEqual([{ project_id: h }]);
  });

  it("syncAll picks up a template added after the projects were assigned", () => {
    const h = projects.create({ slug: "heural", name: "Heural", brief }).id;
    db.prepare("UPDATE agent_schedules SET per_project = 0").run();
    projects.assignOffice(flowId, h);
    expect(clones()).toEqual([]);
    db.prepare("UPDATE agent_schedules SET per_project = 1 WHERE project_id IS NULL").run();
    projects.syncAllOfficeSchedules();
    expect(clones()).toEqual([h]);
  });

  it("pausing or deleting a template through the agents service drops its clones", async () => {
    const events = new EventBus();
    const ag = new AgentService(db, events);
    watchScheduleChanges(events, projects);
    const h = projects.create({ slug: "heural", name: "Heural", brief }).id;
    projects.assignOffice(flowId, h);
    expect(clones()).toEqual([h]);
    const tpl = (db.prepare("SELECT id FROM agent_schedules WHERE per_project = 1 AND project_id IS NULL").get() as { id: string }).id;
    ag.updateSchedule(tpl, { active: false } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(clones()).toEqual([]);
    ag.updateSchedule(tpl, { active: true } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(clones()).toEqual([h]);
    ag.removeSchedule(tpl);
    await new Promise((r) => setTimeout(r, 0));
    expect(clones()).toEqual([]);
  });
});
