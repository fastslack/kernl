import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { answerAndDeliver } from "../src/modules/agents/question-delivery.js";

const OPTS = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }];

describe("answerAndDeliver", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let goals: string[];
  const executor = {
    execute: async (p: { goal: string }) => {
      goals.push(p.goal);
      return { status: "completed", result: "", steps_count: 0, tokens_used: 0 };
    },
  } as never;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
    goals = [];
  });
  afterEach(() => db.close());

  it("asker idle → relaunched with the answer, no inbox letter", () => {
    const w = service.createAgent({ name: "W" });
    const q = service.createQuestion({ from_agent_id: w.id, question: "Ship?", options: OPTS });
    const r = answerAndDeliver(service, executor, events, q.id, { selected_index: 2, selected_option: "C", answered_by: "human" });
    expect(r?.resume_run_id).toBeTruthy();
    expect(goals[0]).toContain("**Answer:** C");
    expect(service.getUnreadInbox(w.id).length).toBe(0);
  });

  it("asker running → inbox letter, no new run", () => {
    const w = service.createAgent({ name: "W" });
    const busy = service.createRun({ agent_id: w.id, goal: "busy" });
    service.updateRun(busy.id, { status: "running" });
    const q = service.createQuestion({ from_agent_id: w.id, question: "Ship?", options: OPTS });
    const r = answerAndDeliver(service, executor, events, q.id, { selected_index: 0, selected_option: "A", answered_by: "human" });
    expect(r?.resume_run_id).toBeNull();
    expect(goals).toEqual([]);
    expect(service.getUnreadInbox(w.id).length).toBe(1);
  });

  it("free text is delivered verbatim", () => {
    const w = service.createAgent({ name: "W" });
    const q = service.createQuestion({ from_agent_id: w.id, question: "Ship?", options: OPTS });
    answerAndDeliver(service, executor, events, q.id, { selected_index: -1, selected_option: "wait for QA", note: "wait for QA", answered_by: "human" });
    expect(goals[0]).toContain("wait for QA");
    expect(service.getQuestion(q.id)?.selected_index).toBe(-1);
  });

  it("returns null when the question is not answerable by that party", () => {
    const w = service.createAgent({ name: "W" });
    const q = service.createQuestion({ from_agent_id: w.id, question: "Ship?", options: OPTS });
    expect(answerAndDeliver(service, executor, events, q.id, { selected_index: 0, selected_option: "A", answered_by: "chief" })).toBeNull();
  });
});
