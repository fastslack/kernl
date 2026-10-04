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

process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = "1";

describe("two projects, one office", () => {
  let db: InstanceType<typeof Database>; let agents: AgentService; let projects: ProjectsService; let root: string;
  let flowId: string; let writer: string; let editor: string; let h: string; let k: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "int-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    agents = new AgentService(db, events);
    agents.setProjectGate(projects.gate());
    flowId = agents.createFlow({ name: "Marketing" }).id;
    writer = agents.createAgent({ name: "Writer", flow_id: flowId }).id;
    editor = agents.createAgent({ name: "Editor", flow_id: flowId }).id;
    const brief = { value_prop: "v", audience: "a" };
    h = projects.create({ slug: "heural", name: "Heural", brief }).id;
    k = projects.create({ slug: "kernl", name: "Kernl", brief }).id;
    projects.assignOffice(flowId, h);
    projects.assignOffice(flowId, k);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("a Heural run never sees Kernl memory, inbox or learnings; chains keep the project", () => {
    const rh = agents.createRun({ agent_id: writer, goal: "post", project_id: h });
    const rk = agents.createRun({ agent_id: writer, goal: "post", project_id: k });
    agents.addMemory(writer, "assistant", "heural draft", rh.id, h);
    agents.addMemory(writer, "assistant", "kernl draft", rk.id, k);
    agents.addLearning({ agent_id: writer, type: "avoid", content: "kernl only", project_id: k });
    agents.postToColleague({ from_agent_id: editor, to_agent_id: writer, subject: "kernl note", body: "x", project_id: k });

    expect(agents.getMemory(writer, 20, h).map((m) => m.content)).toEqual(["heural draft"]);
    expect(agents.getLearnings(writer, h).map((l) => l.content)).toEqual([]);
    expect(agents.getUnreadInbox(writer, 20, "", h)).toEqual([]);

    const child = agents.createRun({ agent_id: editor, goal: "review", parent_run_id: rh.id, parent_agent_id: writer, depth: 1 });
    expect(child.project_id).toBe(h);
  });

  it("a per_project template runs once per project", () => {
    const tpl = agents.addSchedule({ agent_id: writer, interval_ms: 60_000, goal_override: "weekly plan" });
    db.prepare("UPDATE agent_schedules SET per_project = 1 WHERE id = ?").run(tpl.id);
    projects.syncOfficeSchedules(flowId);
    db.prepare("UPDATE agent_schedules SET next_run_at = '2000-01-01T00:00:00Z'").run();
    expect(agents.getDueSchedules().map((s) => s.project_id).sort()).toEqual([h, k].sort());
  });
});
