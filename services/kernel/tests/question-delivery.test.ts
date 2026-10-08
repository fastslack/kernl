import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { AnswerQueue, answerAndDeliver, deliverPendingAnswers } from "../src/modules/agents/question-delivery.js";

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

/**
 * Answering several questions in a row. Measured 2026-10-08: three answers to
 * the Career Lead ten seconds apart — the first relaunched it, the other two
 * were filed in its inbox, and nothing ever delivered them.
 */
describe("answers that arrive while the asker is busy", () => {
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

  function answerWhileBusy(agentId: string, questions: string[]): string {
    const busy = service.createRun({ agent_id: agentId, goal: "busy" });
    service.updateRun(busy.id, { status: "running" });
    questions.forEach((text, i) => {
      const q = service.createQuestion({ from_agent_id: agentId, question: text, options: OPTS });
      answerAndDeliver(service, executor, events, q.id, { selected_index: i % 4, selected_option: OPTS[i % 4].label, answered_by: "human" });
    });
    return busy.id;
  }

  it("relaunches the asker once with every waiting answer when it is free", () => {
    const w = service.createAgent({ name: "Career Lead" });
    const busy = answerWhileBusy(w.id, ["IC or management?", "Salary floor?"]);
    expect(goals).toEqual([]);
    expect(deliverPendingAnswers(service, executor, events, w.id)).toBeNull(); // still busy
    service.updateRun(busy, { status: "completed" });
    expect(deliverPendingAnswers(service, executor, events, w.id)).toBeTruthy();
    expect(goals).toHaveLength(1);
    expect(goals[0]).toContain("Answers to 2 of your earlier questions");
    expect(goals[0]).toContain("IC or management?");
    expect(goals[0]).toContain("Salary floor?");
    // Delivered once: the letters are read and a second call does nothing.
    expect(service.getUnreadInbox(w.id)).toHaveLength(0);
    service.updateRun(service.listRuns({ agent_id: w.id, status: "running", limit: 1 })[0].id, { status: "completed" });
    expect(deliverPendingAnswers(service, executor, events, w.id)).toBeNull();
  });

  it("leaves colleagues' letters alone", () => {
    const w = service.createAgent({ name: "W" });
    const other = service.createAgent({ name: "Other" });
    service.postToColleague({ from_agent_id: other.id, to_agent_id: w.id, subject: "hi", body: "hello" } as never);
    expect(service.getUnreadInbox(w.id)).toHaveLength(1);
    expect(deliverPendingAnswers(service, executor, events, w.id)).toBeNull();
    expect(service.getUnreadInbox(w.id)).toHaveLength(1);
  });

  it("does not relaunch a paused agent", () => {
    const w = service.createAgent({ name: "W" });
    const busy = answerWhileBusy(w.id, ["Ship?"]);
    service.updateRun(busy, { status: "completed" });
    service.updateAgent(w.id, { active: false } as never);
    expect(deliverPendingAnswers(service, executor, events, w.id)).toBeNull();
    expect(service.getUnreadInbox(w.id)).toHaveLength(1);
  });

  it("the queue waits for the run to end, then delivers", async () => {
    const w = service.createAgent({ name: "W" });
    const busy = answerWhileBusy(w.id, ["Ship?"]);
    const queue = new AnswerQueue(service, executor, events, { retryMs: 5, tries: 50 });
    queue.start();
    // run_completed fires before the row leaves 'running' — the queue must wait.
    events.emit("agent:flow:run_completed", { agent_id: w.id });
    await new Promise((r) => setTimeout(r, 20));
    expect(goals).toEqual([]);
    service.updateRun(busy, { status: "completed" });
    await new Promise((r) => setTimeout(r, 30));
    expect(goals).toHaveLength(1);
    queue.stop();
  });

  it("the boot sweep finds answers already waiting", async () => {
    const w = service.createAgent({ name: "W" });
    const busy = answerWhileBusy(w.id, ["Ship?", "Price?"]);
    service.updateRun(busy, { status: "completed" });
    const queue = new AnswerQueue(service, executor, events, { retryMs: 5 });
    expect(queue.sweep()).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(goals).toHaveLength(1);
    queue.stop();
  });
});
