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
