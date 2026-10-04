import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { agentsTools } from "../src/modules/agents/tools.js";
import { EventBus } from "../src/core/event-bus.js";
import type { ToolDefinition } from "../src/core/types.js";

const OPTS = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }];

describe("chief triage tools", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let tools: ToolDefinition[];
  let chiefId: string;
  let workerId: string;
  const tool = (n: string) => tools.find((t) => t.name === n)!;
  const text = (r: unknown) => (r as { content: Array<{ text?: string }> }).content[0]?.text ?? "";

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    const events = new EventBus();
    service = new AgentService(db, events);
    const executor = new AgentExecutor();
    // Never actually run an LLM from a tool test.
    (executor as unknown as { execute: () => Promise<unknown> }).execute = async () =>
      ({ status: "completed", result: "", steps_count: 0, tokens_used: 0 });
    tools = agentsTools(service, executor, events);
    const rank = service.createRank({ name: "Chief", level: 99 });
    chiefId = service.createAgent({ name: "Chief" }).id;
    service.assignRankToAgent(chiefId, rank.id);
    workerId = service.createAgent({ name: "Worker" }).id;
  });
  afterEach(() => db.close());

  it("lists triage questions for the chief only", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "Which DB?", options: OPTS });
    expect(text(await tool("kernel_agents_questions_triage_list").handler({ __caller_agent_id: chiefId }))).toContain(q.id);
    expect(text(await tool("kernel_agents_questions_triage_list").handler({ __caller_agent_id: workerId }))).toMatch(/Only the chief/);
  });

  it("answers by option index", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "Which DB?", options: OPTS });
    await tool("kernel_agents_questions_answer").handler({ question_id: q.id, selected_index: 3, __caller_agent_id: chiefId });
    expect(service.getQuestion(q.id)).toMatchObject({ status: "answered", answered_by: "chief", selected_option: "D", selected_index: 3 });
  });

  it("answers with free text", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "Which DB?", options: OPTS });
    await tool("kernel_agents_questions_answer").handler({ question_id: q.id, text: "use sqlite", __caller_agent_id: chiefId });
    expect(service.getQuestion(q.id)).toMatchObject({ selected_option: "use sqlite", selected_index: -1 });
  });

  it("rejects an out-of-range index", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "Which DB?", options: OPTS });
    const r = await tool("kernel_agents_questions_answer").handler({ question_id: q.id, selected_index: 7, __caller_agent_id: chiefId });
    expect(text(r)).toMatch(/selected_index/);
    expect(service.getQuestion(q.id)?.status).toBe("triage");
  });

  it("escalates with a reason", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "Spend $500?", options: OPTS });
    await tool("kernel_agents_questions_escalate").handler({ question_id: q.id, reason: "money", __caller_agent_id: chiefId });
    expect(service.getQuestion(q.id)).toMatchObject({ status: "pending", chief_note: "money" });
  });
});
