import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";

const OPTS = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }];

describe("agent questions — chief triage", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let asked: string[];
  let triaged: string[];

  function makeChief() {
    const rank = service.createRank({ name: "Chief", level: 99 });
    const chief = service.createAgent({ name: "Chief" });
    service.assignRankToAgent(chief.id, rank.id);
    return chief;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
    asked = []; triaged = [];
    events.on("agent:question_asked", (p) => { asked.push((p as { question_id: string }).question_id); });
    events.on("agent:question_triage", (p) => { triaged.push((p as { question_id: string }).question_id); });
  });
  afterEach(() => db.close());

  it("sends a worker's question to triage and does not ring the human", () => {
    makeChief();
    const worker = service.createAgent({ name: "Worker" });
    const q = service.createQuestion({ from_agent_id: worker.id, question: "?", options: OPTS });
    expect(q.status).toBe("triage");
    expect(triaged).toEqual([q.id]);
    expect(asked).toEqual([]);
  });

  it("sends the chief's own question straight to the human", () => {
    const chief = makeChief();
    const q = service.createQuestion({ from_agent_id: chief.id, question: "?", options: OPTS });
    expect(q.status).toBe("pending");
    expect(asked).toEqual([q.id]);
  });

  it("goes to the human when there is no chief", () => {
    const worker = service.createAgent({ name: "Worker" });
    expect(service.createQuestion({ from_agent_id: worker.id, question: "?", options: OPTS }).status).toBe("pending");
  });

  it("direct_to_human skips the chief even when there is one", () => {
    makeChief();
    const worker = service.createAgent({ name: "Worker" });
    const q = service.createQuestion({ from_agent_id: worker.id, question: "?", options: OPTS, direct_to_human: true });
    expect(q.status).toBe("pending");
    expect(asked).toEqual([q.id]);
    expect(triaged).toEqual([]);
  });

  it("emits the flow walk only when a question reaches the human", () => {
    const flow: Array<Record<string, unknown>> = [];
    events.on("agent:flow:question_asked", (p) => { flow.push(p as Record<string, unknown>); });
    makeChief();
    const worker = service.createAgent({ name: "Worker" });
    const q = service.createQuestion({ from_agent_id: worker.id, question: "Ship?", options: OPTS });
    expect(flow).toEqual([]);
    service.escalateQuestion(q.id, "money decision");
    expect(flow).toHaveLength(1);
    expect(flow[0]).toMatchObject({
      question_id: q.id, from_agent_id: worker.id, from_agent_name: "Worker",
      question: "Ship?", options: ["A", "B", "C", "D"],
    });
  });

  it("escalates triage → pending with the chief's reason", () => {
    makeChief();
    const worker = service.createAgent({ name: "Worker" });
    const q = service.createQuestion({ from_agent_id: worker.id, question: "?", options: OPTS });
    expect(service.escalateQuestion(q.id, "money decision")).toBe(true);
    expect(service.getQuestion(q.id)).toMatchObject({ status: "pending", chief_note: "money decision" });
    expect(asked).toEqual([q.id]);
    expect(service.escalateQuestion(q.id, "again")).toBe(false);
  });

  it("chief answers only triage, human only pending", () => {
    makeChief();
    const worker = service.createAgent({ name: "Worker" });
    const q = service.createQuestion({ from_agent_id: worker.id, question: "?", options: OPTS });
    expect(service.answerQuestion(q.id, { selected_index: 0, selected_option: "A", answered_by: "human" })).toBeNull();
    expect(service.answerQuestion(q.id, { selected_index: 1, selected_option: "B", answered_by: "chief" })).not.toBeNull();
    expect(service.getQuestion(q.id)).toMatchObject({ status: "answered", answered_by: "chief", selected_option: "B" });
    expect(service.getUnreadInbox(worker.id).length).toBe(0); // delivery is not the service's job anymore
  });

  it("postAnswerToInbox writes one letter with the stored answer", () => {
    const worker = service.createAgent({ name: "Worker" });
    const q = service.createQuestion({ from_agent_id: worker.id, question: "Ship?", options: OPTS });
    service.answerQuestion(q.id, { selected_index: -1, selected_option: "only on Friday", note: "only on Friday", answered_by: "human" });
    expect(service.postAnswerToInbox(q.id)).toBe(true);
    const inbox = service.getUnreadInbox(worker.id);
    expect(inbox.length).toBe(1);
    expect(inbox[0].body).toContain("only on Friday");
  });

  it("expireTriage hands stale triage questions to the human", () => {
    makeChief();
    const worker = service.createAgent({ name: "Worker" });
    const q = service.createQuestion({ from_agent_id: worker.id, question: "?", options: OPTS });
    expect(service.expireTriage("2000-01-01T00:00:00Z")).toBe(0);
    expect(service.expireTriage("2999-01-01T00:00:00Z")).toBe(1);
    expect(service.getQuestion(q.id)?.status).toBe("pending");
    expect(service.getQuestion(q.id)?.chief_note).toMatch(/auto-escalated/);
  });

  it("filters the list by answered_by", () => {
    makeChief();
    const worker = service.createAgent({ name: "Worker" });
    const q = service.createQuestion({ from_agent_id: worker.id, question: "?", options: OPTS });
    service.answerQuestion(q.id, { selected_index: 0, selected_option: "A", answered_by: "chief" });
    expect(service.listQuestions({ status: "answered", answered_by: "chief" }).map((x) => x.id)).toEqual([q.id]);
    expect(service.listQuestions({ status: "answered", answered_by: "human" })).toEqual([]);
  });

  it("hasRunningRun sees a running run", () => {
    const worker = service.createAgent({ name: "Worker" });
    expect(service.hasRunningRun(worker.id)).toBe(false);
    const run = service.createRun({ agent_id: worker.id, goal: "g" });
    service.updateRun(run.id, { status: "running" });
    expect(service.hasRunningRun(worker.id)).toBe(true);
  });

  it("tells every agent how to ask the chief", () => {
    const worker = service.createAgent({ name: "Worker" });
    const other = service.createAgent({ name: "Other" });
    const block = service.buildDirectoryBlock(worker.id);
    expect(block).toContain("kernel_agents_ask_supervisor");
    expect(block).toContain("Exactly 4");
  });
});
