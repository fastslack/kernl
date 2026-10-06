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

describe("createRun project gate", () => {
  let db: InstanceType<typeof Database>; let agents: AgentService; let projects: ProjectsService; let root: string;
  let flowId: string; let agentId: string; let otherAgentId: string; let heural: string; let kernl: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "gate-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    agents = new AgentService(db, events);
    agents.setProjectGate(projects.gate());
    flowId = agents.createFlow({ name: "Ventas" }).id;
    agentId = agents.createAgent({ name: "Closer", flow_id: flowId }).id;
    otherAgentId = agents.createAgent({ name: "Scout", flow_id: flowId }).id;
    const brief = { value_prop: "v", audience: "a" };
    heural = projects.create({ slug: "heural", name: "Heural", brief }).id;
    kernl = projects.create({ slug: "kernl", name: "Kernl", brief }).id;
    projects.assignOffice(flowId, heural);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("records the project on the run", () => {
    const run = agents.createRun({ agent_id: agentId, goal: "x", project_id: heural });
    expect(agents.getRun(run.id)!.project_id).toBe(heural);
  });

  it("refuses a project not assigned to the agent's office", () => {
    expect(() => agents.createRun({ agent_id: agentId, goal: "x", project_id: kernl }))
      .toThrow(/kernl is not assigned to office Ventas/);
  });

  it("refuses a paused project and a paused assignment", () => {
    projects.update(heural, { status: "paused" });
    expect(() => agents.createRun({ agent_id: agentId, goal: "x", project_id: heural })).toThrow(/paused/);
    projects.update(heural, { status: "active" });
    projects.assignOffice(flowId, heural, { active: false });
    expect(() => agents.createRun({ agent_id: agentId, goal: "x", project_id: heural })).toThrow(/not assigned/);
  });

  it("inherits the parent's project when project_id is omitted", () => {
    const parent = agents.createRun({ agent_id: agentId, goal: "x", project_id: heural });
    const child = agents.createRun({ agent_id: otherAgentId, goal: "y", parent_run_id: parent.id, parent_agent_id: agentId, depth: 1 });
    expect(child.project_id).toBe(heural);
  });

  it("runs without project exactly as before", () => {
    const run = agents.createRun({ agent_id: agentId, goal: "x" });
    expect(run.project_id).toBeNull();
    expect(agents.getRun(run.id)!.project_id).toBeNull();
  });

  it("fails closed when a project is requested but no gate is registered", () => {
    agents.setProjectGate(null);
    expect(() => agents.createRun({ agent_id: agentId, goal: "x", project_id: heural })).toThrow(/projects module/);
  });
});

describe("shared offices (serves_any)", () => {
  let db: InstanceType<typeof Database>; let agents: AgentService; let projects: ProjectsService; let root: string;
  let ventas: string; let closer: string; let heural: string; let miniatura: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "gate-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    agents = new AgentService(db, events);
    agents.setProjectGate(projects.gate());
    ventas = agents.createFlow({ name: "Ventas" }).id;
    closer = agents.createAgent({ name: "Closer", flow_id: ventas }).id;
    const brief = { value_prop: "v", audience: "a" };
    heural = projects.create({ slug: "heural", name: "Heural", brief }).id;
    miniatura = projects.create({ slug: "miniatura", name: "Miniatura", brief }).id;
    projects.assignOffice(ventas, miniatura);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("lets a shared office run for a project it is not assigned to", () => {
    expect(() => agents.createRun({ agent_id: closer, goal: "x", project_id: heural })).toThrow(/not assigned/);
    projects.setOfficeServesAny(ventas, true);
    expect(agents.createRun({ agent_id: closer, goal: "x", project_id: heural }).project_id).toBe(heural);
  });

  it("still refuses a paused assignment and a paused project", () => {
    projects.setOfficeServesAny(ventas, true);
    projects.assignOffice(ventas, miniatura, { active: false });
    expect(() => agents.createRun({ agent_id: closer, goal: "x", project_id: miniatura })).toThrow(/not assigned/);
    projects.update(heural, { status: "paused" });
    expect(() => agents.createRun({ agent_id: closer, goal: "x", project_id: heural })).toThrow(/paused/);
  });

  it("tells an unscoped run to pin the project down only when there is a choice", () => {
    const gate = projects.gate();
    expect(gate.unscoped(ventas)).toBeNull();
    projects.setOfficeServesAny(ventas, true);
    const notice = gate.unscoped(ventas)!;
    expect(notice).toContain("Heural (`heural`)");
    expect(notice).toContain("Miniatura (`miniatura`)");
    expect(notice).toMatch(/ask the sender which project/);
    projects.setOfficeServesAny(ventas, false);
    projects.assignOffice(ventas, heural);
    expect(gate.unscoped(ventas)).toMatch(/several projects/);
  });
});
