import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { agentsTools } from "../src/modules/agents/tools.js";
import { EventBus } from "../src/core/event-bus.js";
import type { ToolDefinition } from "../src/core/types.js";

// Escalation to the human goes through ONE neutrally-named tool. There is no
// themed alias to keep alive — the free tree ships a first-install surface.

describe("kernel_agents_ask_supervisor", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let tools: ToolDefinition[];

  function text(r: Awaited<ReturnType<ToolDefinition["handler"]>>): string {
    return (r as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);

    const executor = new AgentExecutor();
    tools = agentsTools(service, executor, events);
  });

  afterEach(() => db.close());

  it("registers the escalation tool under its neutral name only", () => {
    expect(tools.find((t) => t.name === "kernel_agents_ask_supervisor")).toBeDefined();
    const themed = tools.filter((t) => /brigadier|comodoro|commander/i.test(t.name));
    expect(themed).toEqual([]);
  });

  it("errors when the caller agent context is missing", async () => {
    const supervisor = tools.find((t) => t.name === "kernel_agents_ask_supervisor")!;
    const res = await supervisor.handler({
      question: "Deploy today or tomorrow?",
      options: [{ label: "Today" }, { label: "Tomorrow" }],
    });
    expect(text(res)).toMatch(/Caller agent context missing/);
  });

  it("persists a pending question when invoked with a caller", async () => {
    const agent = service.createAgent({ name: "Worker" });
    const supervisor = tools.find((t) => t.name === "kernel_agents_ask_supervisor")!;

    const res = await supervisor.handler({
      question: "Ship v2 now?",
      context: "Tests are green.",
      options: [{ label: "Yes" }, { label: "No" }],
      __caller_agent_id: agent.id,
    });

    expect(text(res)).toMatch(/escalated to your supervisor/);
    expect(service.listQuestions({ status: "pending" }).length).toBe(1);
  });
});
