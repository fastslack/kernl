import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { ClaudeCodeExecutor, projectRunContext, toolPolicy } from "../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js";

describe("Claude Code executor and projects", () => {
  let db: InstanceType<typeof Database>; let s: AgentService; let agentId: string;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    s = new AgentService(db, new EventBus());
    agentId = s.createAgent({ name: "Writer" }).id;
    s.addLearning({ agent_id: agentId, type: "avoid", content: "HEURAL-LEARN", project_id: "P-HEURAL" });
    s.addLearning({ agent_id: agentId, type: "avoid", content: "KERNL-LEARN", project_id: "P-KERNL" });
  });
  afterEach(() => db.close());

  it("the system prompt carries only the run's project learnings", () => {
    const ex = new ClaudeCodeExecutor() as unknown as {
      buildSystemPrompt(agent: unknown, goal: string, service: AgentService, projectId?: string | null): string;
    };
    const prompt = ex.buildSystemPrompt(s.getAgent(agentId)!, "draft", s, "P-HEURAL");
    expect(prompt).toContain("HEURAL-LEARN");
    expect(prompt).not.toContain("KERNL-LEARN");
  });

  it("projectRunContext returns the block and the home dir to mount, or nothing", () => {
    const gate = {
      resolve: () => null, check: () => ({ ok: true as const }),
      context: (flowId: string, projectId: string) => ({ block: `BLOCK ${flowId} ${projectId}`, homeDir: "/data/projects/heural" }),
    };
    s.setProjectGate(gate);
    const agent = s.getAgent(agentId)!;
    expect(projectRunContext(s, agent, { project_id: "P-HEURAL" })).toEqual({ block: "BLOCK  P-HEURAL", homeDir: "/data/projects/heural" });
    expect(projectRunContext(s, agent, { project_id: null })).toBeNull();
    s.setProjectGate(null);
    expect(projectRunContext(s, agent, { project_id: "P-HEURAL" })).toBeNull();
  });

  it("a project run gets no extra MCP servers, no inherited settings and Bash only when asked for", () => {
    const base = { usingSandbox: true, allowUnsandboxedBash: false, allowed: new Set<string>() };
    expect(toolPolicy({ ...base, projectRun: false })).toEqual({ includeBash: true, includeWebFetch: true, userMcpServers: true, inheritSettings: true });
    expect(toolPolicy({ ...base, projectRun: true })).toEqual({ includeBash: false, includeWebFetch: true, userMcpServers: false, inheritSettings: false });
    expect(toolPolicy({ ...base, projectRun: true, allowed: new Set(["Bash"]) }).includeBash).toBe(true);
    expect(toolPolicy({ usingSandbox: false, allowUnsandboxedBash: false, allowed: new Set(), projectRun: false }))
      .toEqual({ includeBash: false, includeWebFetch: false, userMcpServers: true, inheritSettings: true });
  });
});

describe("shared office working for a project", () => {
  it("works in the project's own office home, and in its own otherwise", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { projectsMigrations } = await import("../src/modules/projects/migrations.js");
    const { ProjectsService } = await import("../src/modules/projects/projects-service.js");
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    const root = mkdtempSync(join(tmpdir(), "home-"));
    const s = new AgentService(db, events);
    const projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: join(root, "projects") });
    s.setProjectGate(projects.gate());
    const ventas = s.createFlow({ name: "Ventas" }).id;
    const heuralOffice = s.createFlow({ name: "Heural" }).id;
    for (const [id, dir] of [[ventas, "ventas"], [heuralOffice, "heural"]]) {
      db.prepare("UPDATE agent_flows SET home_repo_path = ? WHERE id = ?").run(join(root, dir), id);
      (await import("node:fs")).mkdirSync(join(root, dir));
    }
    const closer = s.createAgent({ name: "Closer", flow_id: ventas });
    const heural = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    const ex = new ClaudeCodeExecutor() as unknown as {
      resolveCwd(agent: unknown, run: unknown, service: AgentService): { cwd: string; officeHomeFlow: { id: string } | null };
    };
    const cwdFor = (projectId: string | null) => ex.resolveCwd(closer, { project_id: projectId, trigger_payload: "{}" }, s).cwd;

    // Not shared, or no home office set → its own home.
    projects.update(heural, { home_flow_id: heuralOffice });
    expect(cwdFor(heural)).toBe(join(root, "ventas"));
    projects.setOfficeServesAny(ventas, true);
    expect(cwdFor(null)).toBe(join(root, "ventas"));
    // Shared office working for Heural → the Heural office's home.
    expect(cwdFor(heural)).toBe(join(root, "heural"));
    projects.update(heural, { home_flow_id: "" });
    expect(cwdFor(heural)).toBe(join(root, "ventas"));
    expect(() => projects.update(heural, { home_flow_id: "nope" })).toThrow(/Office not found/);

    db.close(); rmSync(root, { recursive: true, force: true });
  });
});
