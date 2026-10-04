import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { agentsTools } from "../src/modules/agents/tools.js";
import { runWithContext } from "../src/core/request-context.js";
import { assembleSystemPrompt } from "../src/modules/agents/executor/system-prompt.js";
import { EventBus } from "../src/core/event-bus.js";

describe("project-scoped inbox", () => {
  let db: InstanceType<typeof Database>; let s: AgentService; let events: EventBus; let a: string; let b: string;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    s = new AgentService(db, events);
    a = s.createAgent({ name: "A" }).id; b = s.createAgent({ name: "B" }).id;
  });
  afterEach(() => db.close());

  it("stores the project and emits it", async () => {
    let seen: unknown = undefined;
    events.on("agent:inbox:posted", (p) => { seen = (p as { project_id?: string }).project_id; });
    s.postToColleague({ from_agent_id: a, to_agent_id: b, subject: "lead", body: "x", project_id: "P1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toBe("P1");
    expect(s.getUnreadInbox(b)[0].project_id).toBe("P1");
  });

  it("run without project does not consume project letters", () => {
    s.postToColleague({ from_agent_id: a, to_agent_id: b, subject: "heural", body: "x", project_id: "P1" });
    s.postToColleague({ from_agent_id: a, to_agent_id: b, subject: "plain", body: "x" });
    expect(s.getUnreadInbox(b, 20, "", null).map((m) => m.subject)).toEqual(["plain"]);
    expect(s.getUnreadInbox(b, 20, "", "P1").map((m) => m.subject).sort()).toEqual(["heural", "plain"]);
    expect(s.getUnreadInbox(b, 20, "", "P2").map((m) => m.subject)).toEqual(["plain"]);
  });

  it("post_to_colleague stamps the caller run's project", async () => {
    const run = s.createRun({ agent_id: a, goal: "x" });
    db.prepare("UPDATE agent_runs SET project_id = 'P1' WHERE id = ?").run(run.id);
    const tool = agentsTools(s, new AgentExecutor(), events).find((t) => t.name === "kernel_agents_post_to_colleague")!;
    await runWithContext({ callerAgentId: a, callerRunId: run.id, callerDepth: 0 },
      () => tool.handler({ to_agent_id: b, subject: "lead", body: "x" }));
    expect(s.getUnreadInbox(b)[0].project_id).toBe("P1");
  });

  it("a no-project run's prompt leaves project letters unread", async () => {
    s.postToColleague({ from_agent_id: a, to_agent_id: b, subject: "HEURAL-LETTER", body: "x", project_id: "P1" });
    const recorder = { emit: () => {}, logEvent: () => {} } as never;
    const out = await assembleSystemPrompt({
      agent: s.getAgent(b)!, service: s, recorder, config: null, skillResolver: null, lang: "en",
      depth: 0, maxChainDepth: 3, effectiveSystemPrompt: "", effectiveGoal: "x",
      todayStr: "2026-10-04", goalVector: null, memoryGoalSuffix: "", projectId: null,
    });
    expect(out.systemText).not.toContain("HEURAL-LETTER");
    expect(s.getUnreadInbox(b).length).toBe(1);
  });

  it("kernel_agents_inbox read from a run only lists that run's project letters", async () => {
    s.postToColleague({ from_agent_id: a, to_agent_id: b, subject: "HEURAL", body: "x", project_id: "P1" });
    s.postToColleague({ from_agent_id: a, to_agent_id: b, subject: "KERNL", body: "x", project_id: "P2" });
    s.postToColleague({ from_agent_id: a, to_agent_id: b, subject: "PLAIN", body: "x" });
    const run = s.createRun({ agent_id: b, goal: "x" });
    db.prepare("UPDATE agent_runs SET project_id = 'P1' WHERE id = ?").run(run.id);
    const tool = agentsTools(s, new AgentExecutor(), events).find((t) => t.name === "kernel_agents_inbox")!;
    const res = await runWithContext({ callerAgentId: b, callerRunId: run.id, callerDepth: 0 }, () => tool.handler({}));
    const text = JSON.stringify(res);
    expect(text).toContain("HEURAL");
    expect(text).toContain("PLAIN");
    expect(text).not.toContain("KERNL");
    const ui = await tool.handler({ agent_id: b });
    expect(JSON.stringify(ui)).toContain("KERNL");
  });
});
