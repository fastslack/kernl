import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";

const OPTS = [{ label: "Aprobar" }, { label: "Lo reviso yo", task: true }, { label: "Pedir cambios" }, { label: "Esperar" }];

describe("questions — owed, for_operator, dismiss, reminders", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let seen: Array<[string, unknown]>;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
    seen = [];
    for (const e of ["agent:question_asked", "agent:question_owed", "agent:question_resolved"]) {
      events.on(e as never, ((p: unknown) => seen.push([e, p])) as never);
    }
    const rank = service.createRank({ name: "Chief", level: 99 });
    const chief = service.createAgent({ name: "Chief" });
    service.assignRankToAgent(chief.id, rank.id);
  });
  afterEach(() => db.close());

  it("for_operator skips the chief and keeps the task flag", () => {
    const w = service.createAgent({ name: "W" });
    const q = service.createQuestion({ from_agent_id: w.id, question: "web!1?", options: OPTS, for_operator: true });
    expect(q.status).toBe("pending");
    const got = service.getQuestion(q.id)!;
    expect(got.for_operator).toBe(true);
    expect(got.options[1].task).toBe(true);
  });

  it("pending → owed → answered, each once", () => {
    const w = service.createAgent({ name: "W" });
    const { id } = service.createQuestion({ from_agent_id: w.id, question: "?", options: OPTS, for_operator: true });
    expect(service.markOwed(id, { selected_index: 1, selected_option: "Lo reviso yo" })?.status).toBe("owed");
    expect(service.markOwed(id, { selected_index: 1, selected_option: "Lo reviso yo" })).toBeNull();
    expect(service.getQuestion(id)!.owed_at).toBeTruthy();
    expect(service.answerQuestion(id, { selected_index: -1, selected_option: "Listo", note: "hecho", answered_by: "human" })).not.toBeNull();
    expect(service.answerQuestion(id, { selected_index: 0, selected_option: "Aprobar", answered_by: "human" })).toBeNull();
    expect(service.getQuestion(id)!.status).toBe("answered");
    expect(seen.map((s) => s[0])).toEqual(["agent:question_asked", "agent:question_owed", "agent:question_resolved"]);
  });

  it("dismisses from owed and returns the previous question", () => {
    const w = service.createAgent({ name: "W" });
    const { id } = service.createQuestion({ from_agent_id: w.id, question: "?", options: OPTS, for_operator: true });
    service.markOwed(id, { selected_index: 1, selected_option: "Lo reviso yo" });
    expect(service.dismissQuestion(id)?.status).toBe("owed");
    expect(service.getQuestion(id)!.status).toBe("dismissed");
    expect(service.dismissQuestion(id)).toBeNull();
  });

  it("lists remindable questions older than the cutoff and marks them", () => {
    const w = service.createAgent({ name: "W" });
    const { id } = service.createQuestion({ from_agent_id: w.id, question: "?", options: OPTS, for_operator: true });
    db.run("UPDATE agent_questions SET created_at='2026-10-12T00:00:00Z' WHERE id=?", [id]);
    expect(service.listRemindable("2026-10-13T00:00:00Z").map((q) => q.id)).toEqual([id]);
    service.markReminded(id);
    expect(service.listRemindable("2026-10-13T00:00:00Z")).toEqual([]);
  });

  it("remindable counts from the latest of reminded_at, owed_at and created_at", () => {
    const w = service.createAgent({ name: "W" });
    const { id } = service.createQuestion({ from_agent_id: w.id, question: "?", options: OPTS, for_operator: true });
    // Reminded long ago, but went owed after the cutoff: not due.
    db.run("UPDATE agent_questions SET status='owed', created_at='2026-10-01T00:00:00Z', reminded_at='2026-10-02T00:00:00Z', owed_at='2026-10-13T12:00:00Z' WHERE id=?", [id]);
    expect(service.listRemindable("2026-10-13T00:00:00Z")).toEqual([]);
    // Every timestamp before the cutoff: due.
    db.run("UPDATE agent_questions SET owed_at='2026-10-12T00:00:00Z' WHERE id=?", [id]);
    expect(service.listRemindable("2026-10-13T00:00:00Z").map((q) => q.id)).toEqual([id]);
  });
});
