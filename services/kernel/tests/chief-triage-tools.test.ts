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
    await tool("kernel_agents_questions_answer").handler({ question_id: q.id, selected_index: 3, leaves_work_to_operator: false, __caller_agent_id: chiefId });
    expect(service.getQuestion(q.id)).toMatchObject({ status: "answered", answered_by: "chief", selected_option: "D", selected_index: 3 });
  });

  it("answers with free text", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "Which DB?", options: OPTS });
    await tool("kernel_agents_questions_answer").handler({ question_id: q.id, text: "use sqlite", leaves_work_to_operator: false, __caller_agent_id: chiefId });
    expect(service.getQuestion(q.id)).toMatchObject({ selected_option: "use sqlite", selected_index: -1 });
  });

  it("rejects an out-of-range index", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "Which DB?", options: OPTS });
    const r = await tool("kernel_agents_questions_answer").handler({ question_id: q.id, selected_index: 7, leaves_work_to_operator: false, __caller_agent_id: chiefId });
    expect(text(r)).toMatch(/selected_index/);
    expect(service.getQuestion(q.id)?.status).toBe("triage");
  });

  it("escalates with a reason", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "Spend $500?", options: OPTS });
    await tool("kernel_agents_questions_escalate").handler({ question_id: q.id, reason: "money", __caller_agent_id: chiefId });
    expect(service.getQuestion(q.id)).toMatchObject({ status: "pending", chief_note: "money" });
  });

  it("questions_answer escalates when the chief says it leaves work to the operator", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "web!9?", options: OPTS });
    const res = await tool("kernel_agents_questions_answer").handler({ question_id: q.id, selected_index: 0, leaves_work_to_operator: true, __caller_agent_id: chiefId });
    expect(text(res)).toContain("Escalated");
    expect(service.getQuestion(q.id)!.status).toBe("pending");
  });

  it("questions_answer escalates on the safety net even when the chief says false", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "web!9?", options: OPTS });
    await tool("kernel_agents_questions_answer").handler({ question_id: q.id, text: "Mantener merge_hold; REANUDAR lo decide el operador", leaves_work_to_operator: false, __caller_agent_id: chiefId });
    const got = service.getQuestion(q.id)!;
    expect(got.status).toBe("pending");
    expect(got.chief_note).toContain("dejaba trabajo al operador");
  });

  it("ask_supervisor with for_operator goes straight to pending and keeps task flags", async () => {
    await tool("kernel_agents_ask_supervisor").handler({
      question: "¿Aprobar web!3?", for_operator: true,
      options: [{ label: "Aprobar" }, { label: "Lo reviso yo", task: true }, { label: "Cambios" }, { label: "Esperar" }],
      __caller_agent_id: workerId,
    });
    const q = service.listQuestions({ status: "pending" })[0];
    expect(q.for_operator).toBe(true);
    expect(q.options[1].task).toBe(true);
  });

  it("ask_supervisor takes 2 to 4 options: 3 are accepted, 1 is rejected", async () => {
    const ask = tool("kernel_agents_ask_supervisor");
    const three = await ask.handler({ question: "¿Qué hago?", options: [{ label: "A" }, { label: "B" }, { label: "C" }], __caller_agent_id: workerId });
    expect(text(three)).toContain("sent to the chief");
    expect(service.listQuestions({ status: "triage" })[0].options.map((o) => o.label)).toEqual(["A", "B", "C"]);
    const one = await ask.handler({ question: "¿Y esto?", options: [{ label: "A" }], __caller_agent_id: workerId });
    expect((one as { isError?: boolean }).isError).toBe(true);
    // Two labels, one blank: the schema passes, the handler's own check refuses it.
    const blank = await ask.handler({ question: "¿Y esto?", options: [{ label: "A" }, { label: "  " }], __caller_agent_id: workerId });
    expect(text(blank)).toContain("Provide 2 to 4 non-empty options");
    expect(service.listQuestions({ status: "triage" }).length).toBe(1);
  });
});
