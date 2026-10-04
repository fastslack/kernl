import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { buildProjectContext } from "../src/modules/projects/project-context.js";
import { AgentService } from "../src/modules/agents/service.js";
import { assembleSystemPrompt } from "../src/modules/agents/executor/system-prompt.js";
import { EventBus } from "../src/core/event-bus.js";

describe("project context", () => {
  let db: InstanceType<typeof Database>; let svc: ProjectsService; let root: string;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    root = mkdtempSync(join(tmpdir(), "ctx-"));
    svc = new ProjectsService(db, new EventBus(), { encryptionKey: "a".repeat(64), projectsRoot: root });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("renders brief, office settings, files and linked resources", () => {
    const p = svc.create({ slug: "heural", name: "Heural", brief: { value_prop: "Una historia clínica, todo conectado", audience: "clínicas", voice: "cercano" } });
    svc.assignOffice("F1", p.id, { settings: { countries: ["AR", "ES"] } });
    svc.link(p.id, "social_account", "twitter:42");
    const { block, homeDir } = buildProjectContext(svc, "F1", p.id);
    expect(block.startsWith("## Proyecto: Heural")).toBe(true);
    expect(block).toContain("Una historia clínica, todo conectado");
    expect(block).toContain('"countries":["AR","ES"]');
    expect(block).toContain("twitter:42");
    expect(block).toContain(join(homeDir, "BRIEF.md"));
    expect(block).toContain("kernel_outbox_propose");
  });

  it("the native prompt carries the block for a project run and nothing without one", async () => {
    const agents = new AgentService(db, new EventBus());
    agents.setProjectGate(svc.gate());
    const flowId = agents.createFlow({ name: "Marketing" }).id;
    const agent = agents.createAgent({ name: "Writer", flow_id: flowId });
    const p = svc.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } });
    svc.assignOffice(flowId, p.id);
    const recorder = { emit: () => {}, logEvent: () => {} } as never;
    const build = (projectId: string | null) => assembleSystemPrompt({
      agent: agents.getAgent(agent.id)!, service: agents, recorder, config: null, skillResolver: null, lang: "en",
      depth: 0, maxChainDepth: 3, effectiveSystemPrompt: "", effectiveGoal: "x",
      todayStr: "2026-10-04", goalVector: null, memoryGoalSuffix: "", projectId,
    });
    expect((await build(p.id)).systemText).toContain("## Proyecto: Heural");
    expect((await build(null)).systemText).not.toContain("## Proyecto");
  });
});
