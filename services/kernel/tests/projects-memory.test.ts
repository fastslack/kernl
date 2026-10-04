import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { assembleSystemPrompt } from "../src/modules/agents/executor/system-prompt.js";
import { agentsTools } from "../src/modules/agents/tools.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { runWithContext } from "../src/core/request-context.js";

describe("project-scoped memory", () => {
  let db: InstanceType<typeof Database>; let s: AgentService; let agentId: string;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    s = new AgentService(db, new EventBus());
    agentId = s.createAgent({ name: "Writer" }).id;
  });
  afterEach(() => db.close());

  it("legacy run sees legacy memory", () => {
    s.addMemory(agentId, "user", "old chat");
    expect(s.getMemory(agentId).map((m) => m.content)).toEqual(["old chat"]);
  });

  it("separates conversation memory strictly by project", () => {
    s.addMemory(agentId, "user", "heural chat", "", "P-HEURAL");
    s.addMemory(agentId, "user", "kernl chat", "", "P-KERNL");
    s.addMemory(agentId, "user", "no project chat");
    expect(s.getMemory(agentId, 20, "P-HEURAL").map((m) => m.content)).toEqual(["heural chat"]);
    expect(s.getRelevantMemory(agentId, "chat", 20, 100, "P-KERNL").map((m) => m.content)).toEqual(["kernl chat"]);
    expect(s.getMemory(agentId).map((m) => m.content)).toEqual(["no project chat"]);
  });

  it("embedding ranker respects the project too", () => {
    s.addMemory(agentId, "user", "heural chat", "", "P-HEURAL");
    s.addMemory(agentId, "user", "kernl chat", "", "P-KERNL");
    const got = s.getRelevantMemoryByEmbedding(agentId, "chat", [0.1, 0.2], 20, 100, undefined, undefined, "P-HEURAL");
    expect(got.map((m) => m.content)).toEqual(["heural chat"]);
  });

  it("learnings: general for everyone, project ones only for their project", () => {
    s.addLearning({ agent_id: agentId, type: "pattern", content: "hooks first line" });
    s.addLearning({ agent_id: agentId, type: "avoid", content: "heural: no 'paciente' in B2B", project_id: "P-HEURAL" });
    s.addLearning({ agent_id: agentId, type: "avoid", content: "kernl: no jargon", project_id: "P-KERNL" });
    expect(s.getLearnings(agentId, "P-HEURAL").map((l) => l.content).sort()).toEqual(["heural: no 'paciente' in B2B", "hooks first line"]);
    expect(s.getLearnings(agentId).map((l) => l.content)).toEqual(["hooks first line"]);
    expect(s.getRelevantLearnings(agentId, "x", 15, "P-KERNL").map((l) => l.content).sort()).toEqual(["hooks first line", "kernl: no jargon"]);
    expect(s.getRelevantLearningsByEmbedding(agentId, "x", [0.1], 1, undefined, undefined, "P-HEURAL").length).toBe(1);
  });

  it("similar past runs only come from the same project", () => {
    const a = s.createRun({ agent_id: agentId, goal: "write the weekly post" });
    s.updateRun(a.id, { status: "completed", result: "ok" });
    db.prepare("UPDATE agent_runs SET project_id = 'P-KERNL' WHERE id = ?").run(a.id);
    expect(s.findSimilarPastRuns(agentId, "write the weekly post", 3, 30, "P-HEURAL")).toEqual([]);
    expect(s.findSimilarPastRuns(agentId, "write the weekly post", 3, 30, "P-KERNL").length).toBe(1);
  });

  it("the native prompt only carries the run's project memory and learnings", async () => {
    s.addMemory(agentId, "assistant", "HEURAL-MEM draft", "", "P-HEURAL");
    s.addMemory(agentId, "assistant", "KERNL-MEM draft", "", "P-KERNL");
    s.addLearning({ agent_id: agentId, type: "avoid", content: "KERNL-LEARN", project_id: "P-KERNL" });
    s.addLearning({ agent_id: agentId, type: "avoid", content: "HEURAL-LEARN", project_id: "P-HEURAL" });
    const agent = s.getAgent(agentId)!;
    const recorder = { emit: () => {}, logEvent: () => {} } as never;
    const out = await assembleSystemPrompt({
      agent, service: s, recorder, config: null, skillResolver: null, lang: "en",
      depth: 0, maxChainDepth: 3, effectiveSystemPrompt: "", effectiveGoal: "draft",
      todayStr: "2026-10-04", goalVector: null, memoryGoalSuffix: "", projectId: "P-HEURAL",
    });
    const all = out.systemText + out.memoryGoalSuffix;
    expect(all).toContain("HEURAL-MEM");
    expect(all).toContain("HEURAL-LEARN");
    expect(all).not.toContain("KERNL-MEM");
    expect(all).not.toContain("KERNL-LEARN");
  });

  it("kernel_agents_add_learning scopes to the caller's project unless told general", async () => {
    const run = s.createRun({ agent_id: agentId, goal: "x" });
    db.prepare("UPDATE agent_runs SET project_id = 'P-HEURAL' WHERE id = ?").run(run.id);
    const tool = agentsTools(s, new AgentExecutor(), new EventBus()).find((t) => t.name === "kernel_agents_add_learning")!;
    const ctx = { callerAgentId: agentId, callerRunId: run.id, callerDepth: 0 };
    await runWithContext(ctx, () => tool.handler({ agent_id: agentId, type: "avoid", content: "proj-scoped" }));
    await runWithContext(ctx, () => tool.handler({ agent_id: agentId, type: "pattern", content: "craft", scope: "general" }));
    expect(s.getLearnings(agentId).map((l) => l.content)).toEqual(["craft"]);
    expect(s.getLearnings(agentId, "P-HEURAL").map((l) => l.content).sort()).toEqual(["craft", "proj-scoped"]);
  });
});
