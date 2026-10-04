import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { QuestionTriager, buildTriageGoal } from "../src/modules/agents/question-triager.js";

const OPTS = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }];

describe("QuestionTriager", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let runs: Array<{ agentId: string; goal: string }>;
  let triager: QuestionTriager;
  let chiefId: string;
  let workerId: string;
  const executor = {
    execute: async (p: { agent: { id: string }; goal: string }) => {
      runs.push({ agentId: p.agent.id, goal: p.goal });
      return { status: "completed", result: "", steps_count: 0, tokens_used: 0 };
    },
  } as never;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
    runs = [];
    const rank = service.createRank({ name: "Chief", level: 99 });
    chiefId = service.createAgent({ name: "Chief" }).id;
    service.assignRankToAgent(chiefId, rank.id);
    workerId = service.createAgent({ name: "Worker" }).id;
    triager = new QuestionTriager(service, executor, events, { debounceMs: 20, timeoutMs: 60_000, sweepMs: 60_000 });
  });
  afterEach(() => { triager.stop(); db.close(); });

  it("batches several questions into one chief run", async () => {
    triager.start();
    const a = service.createQuestion({ from_agent_id: workerId, question: "Q1", options: OPTS });
    const b = service.createQuestion({ from_agent_id: workerId, question: "Q2", options: OPTS });
    await Bun.sleep(80);
    expect(runs.length).toBe(1);
    expect(runs[0].agentId).toBe(chiefId);
    expect(runs[0].goal).toContain(a.id);
    expect(runs[0].goal).toContain(b.id);
    expect(service.getQuestion(a.id)?.triage_started_at).not.toBeNull();
  });

  it("re-arms instead of overlapping a running chief", async () => {
    const busy = service.createRun({ agent_id: chiefId, goal: "busy" });
    service.updateRun(busy.id, { status: "running" });
    service.createQuestion({ from_agent_id: workerId, question: "Q1", options: OPTS });
    expect(await triager.fire()).toBeNull();
    expect(runs.length).toBe(0);
    service.updateRun(busy.id, { status: "completed" });
    expect(await triager.fire()).not.toBeNull();
  });

  it("only picks questions no chief run has seen yet", async () => {
    service.createQuestion({ from_agent_id: workerId, question: "Q1", options: OPTS });
    await triager.fire();
    await Bun.sleep(5); // let the fake run settle to 'completed'
    expect(await triager.fire()).toBeNull();
    expect(runs.length).toBe(1);
  });

  it("sweep hands stale questions to the human", () => {
    const t = new QuestionTriager(service, executor, events, { debounceMs: 20, timeoutMs: -1, sweepMs: 60_000 });
    const q = service.createQuestion({ from_agent_id: workerId, question: "Q1", options: OPTS });
    expect(t.sweep()).toBe(1);
    expect(service.getQuestion(q.id)?.status).toBe("pending");
  });

  it("start() arms for triage rows left from before a restart", async () => {
    service.createQuestion({ from_agent_id: workerId, question: "Q1", options: OPTS }); // not started yet → no listener
    triager.start();
    await Bun.sleep(80);
    expect(runs.length).toBe(1);
  });

  it("fire() with no active chief hands the unseen questions to the human", async () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "Q1", options: OPTS });
    expect(q.status).toBe("triage");
    service.updateAgent(chiefId, { active: false });
    expect(await triager.fire()).toBeNull();
    expect(runs.length).toBe(0);
    const after = service.getQuestion(q.id)!;
    expect(after.status).toBe("pending");
    expect(after.chief_note).toContain("no active chief");
  });

  it("after stop(), a new triage question starts no run", async () => {
    triager.start();
    triager.stop();
    service.createQuestion({ from_agent_id: workerId, question: "Q1", options: OPTS });
    await Bun.sleep(80);
    expect(runs.length).toBe(0);
  });

  it("chief run emits agent.run.started/completed and completes the run", async () => {
    const seen: string[] = [];
    events.on("agent.run.started", () => { seen.push("started"); });
    events.on("agent.run.completed", () => { seen.push("completed"); });
    service.createQuestion({ from_agent_id: workerId, question: "Q1", options: OPTS });
    const runId = await triager.fire();
    await Bun.sleep(5); // let the fake run settle
    expect(seen).toEqual(["started", "completed"]);
    expect(service.getRun(runId!)?.status).toBe("completed");
  });

  it("goal carries the triage rules", () => {
    const q = service.createQuestion({ from_agent_id: workerId, question: "Q1", options: OPTS });
    const goal = buildTriageGoal([service.getQuestion(q.id)!], service);
    expect(goal).toContain("kernel_agents_questions_answer");
    expect(goal).toContain("kernel_agents_questions_escalate");
    expect(goal).toContain("[3] D");
  });
});
