import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { resolveHumanChoice } from "../src/modules/agents/question-delivery.js";
import { EventBus } from "../src/core/event-bus.js";

const OPTS = [{ label: "Approve and merge" }, { label: "I will review it", task: true }, { label: "Request changes" }];
const noExecutor = { execute: async () => { throw new Error("not used"); } } as never;

// An operator answered "retry the approval" on a question about an MR that had merged since; the office's
// orchestrator sent the item back to merging. An orchestrator that reports its items' states lets the core dismiss
// such questions as soon as the item moves, and refuse an answer that arrives late.
describe("questions and the state of their work item", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let flowId: string;
  let askerId: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
    flowId = "flow-dev";
    askerId = service.createAgent({ name: "QA" }).id;
  });
  afterEach(() => db.close());

  const ask = (extra: Record<string, unknown> = {}) =>
    service.createQuestion({ from_agent_id: askerId, flow_id: flowId, question: "Approve api!7 (app#42: x)?",
      options: OPTS, for_operator: true, ...extra }).id;

  it("a question takes the state its orchestrator last reported for the item", () => {
    service.setSubjectState({ flow_id: flowId, subject_key: "app#42", state: "ready" });
    expect(service.getQuestion(ask())!.subject_state).toBe("ready");
  });

  it("an explicit subject_state wins over the reported one", () => {
    service.setSubjectState({ flow_id: flowId, subject_key: "app#42", state: "ready" });
    expect(service.getQuestion(ask({ subject_state: "in-review" }))!.subject_state).toBe("in-review");
  });

  it("a move dismisses the open questions asked in another state, with the reason, and only those", () => {
    service.setSubjectState({ flow_id: flowId, subject_key: "app#42", state: "ready" });
    const stale = ask();
    const other = service.createQuestion({ from_agent_id: askerId, flow_id: flowId, question: "Approve api!8 (app#43: y)?",
      options: OPTS, for_operator: true }).id;
    const r = service.setSubjectState({ flow_id: flowId, subject_key: "APP#42", state: "merging", by: "orchestrator" });
    expect(r.superseded).toEqual([stale]);
    const q = service.getQuestion(stale)!;
    expect(q.status).toBe("dismissed");
    expect(q.answered_by).toBe("rule");
    expect(q.superseded_reason).toBe("item app#42 moved from ready to merging");
    expect(service.getQuestion(other)!.status).toBe("pending");
  });

  it("reporting the same state again keeps the question open", () => {
    service.setSubjectState({ flow_id: flowId, subject_key: "app#42", state: "ready" });
    const id = ask();
    expect(service.setSubjectState({ flow_id: flowId, subject_key: "app#42", state: "ready" }).superseded).toEqual([]);
    expect(service.getQuestion(id)!.status).toBe("pending");
  });

  it("another office's report on the same key does not touch this office's questions", () => {
    service.setSubjectState({ flow_id: flowId, subject_key: "app#42", state: "ready" });
    const id = ask();
    service.setSubjectState({ flow_id: "other-flow", subject_key: "app#42", state: "done" });
    expect(service.getQuestion(id)!.status).toBe("pending");
  });

  it("a late operator answer is refused and nothing is delivered", () => {
    service.setSubjectState({ flow_id: flowId, subject_key: "app#42", state: "ready" });
    const id = ask();
    // The state moved behind the core's back (no report went through setSubjectState's sweep).
    db.run("UPDATE agent_subject_states SET state='working' WHERE subject_key='app#42'");
    const r = resolveHumanChoice(service, noExecutor, undefined, id, { kind: "option", index: 0 }, { via: "dashboard" });
    expect(r).toEqual({ ok: false, reason: "superseded", detail: "item app#42 moved from ready to working" });
    expect(service.getQuestion(id)!.status).toBe("dismissed");
    expect(service.getQuestion(id)!.selected_option).toBe("");
  });

  it("the chief and an 'I will do it' answer cannot act on a stale question either", () => {
    service.setSubjectState({ flow_id: flowId, subject_key: "app#42", state: "ready" });
    const a = ask();
    db.run("UPDATE agent_subject_states SET state='done' WHERE subject_key='app#42'");
    expect(service.markOwed(a, { selected_index: 1, selected_option: "I will review it" })).toBeNull();
    expect(service.getQuestion(a)!.status).toBe("dismissed");
    const b = ask({ subject_state: "ready" });
    expect(service.answerQuestion(b, { selected_index: 0, selected_option: "Approve and merge", answered_by: "chief" })).toBeNull();
    expect(service.getQuestion(b)!.status).toBe("dismissed");
  });

  it("an owed question whose item moved on is dismissed too", () => {
    service.setSubjectState({ flow_id: flowId, subject_key: "app#42", state: "ready" });
    const id = ask();
    expect(service.markOwed(id, { selected_index: 1, selected_option: "I will review it" })?.status).toBe("owed");
    expect(service.setSubjectState({ flow_id: flowId, subject_key: "app#42", state: "merging" }).superseded).toEqual([id]);
  });

  it("questions with no state, or offices that report none, behave as before", () => {
    const id = ask();
    expect(service.getQuestion(id)!.subject_state).toBe("");
    const r = resolveHumanChoice(service, noExecutor, undefined, id, { kind: "dismiss" }, { via: "dashboard" });
    expect(r).toEqual({ ok: true, status: "dismissed" });
    expect(service.getQuestion(id)!.superseded_reason).toBe("");
  });

  it("refuses an empty key or state", () => {
    expect(() => service.setSubjectState({ flow_id: flowId, subject_key: " ", state: "ready" })).toThrow();
    expect(() => service.setSubjectState({ flow_id: flowId, subject_key: "app#1", state: "" })).toThrow();
  });
});
