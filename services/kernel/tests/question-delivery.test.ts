import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { AnswerQueue, MAX_REDELIVERIES, answersGoal, answerAndDeliver, deliverPendingAnswers, pendingAnswers, resolveHumanChoice } from "../src/modules/agents/question-delivery.js";

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

  it("an asker whose answers are read elsewhere (__answer_resume__: false) is not relaunched nor written to", () => {
    const w = service.createAgent({ name: "W" });
    db.prepare("UPDATE agents SET variables = ? WHERE id = ?").run('{"__answer_resume__": false}', w.id);
    const q = service.createQuestion({ from_agent_id: w.id, question: "Ship?", options: OPTS });
    const r = answerAndDeliver(service, executor, events, q.id, { selected_index: 1, selected_option: "B", answered_by: "human" });
    expect(r?.resume_run_id).toBeNull();
    expect(goals).toEqual([]);
    expect(service.getUnreadInbox(w.id).length).toBe(0);
    expect(service.getQuestion(q.id)?.status).toBe("answered");
  });

  it("free text is delivered verbatim", () => {
    const w = service.createAgent({ name: "W" });
    const q = service.createQuestion({ from_agent_id: w.id, question: "Ship?", options: OPTS });
    answerAndDeliver(service, executor, events, q.id, { selected_index: -1, selected_option: "wait for QA", note: "wait for QA", answered_by: "human" });
    expect(goals[0]).toContain("wait for QA");
    expect(service.getQuestion(q.id)?.selected_index).toBe(-1);
  });

  it("resumes inside the project the question was asked in", () => {
    service.setProjectGate({ check: () => ({ ok: true }) } as never);
    const w = service.createAgent({ name: "W" });
    const asked = service.createRun({ agent_id: w.id, goal: "prospect", project_id: "P1" });
    service.updateRun(asked.id, { status: "completed" });
    const q = service.createQuestion({ from_agent_id: w.id, question: "Ship?", options: OPTS, run_id: asked.id });
    const r = answerAndDeliver(service, executor, events, q.id, { selected_index: 0, selected_option: "A", answered_by: "human" });
    expect(service.getRun(r!.resume_run_id!)?.project_id).toBe("P1");
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

  describe("a relaunch that dies gives its answers back", () => {
    const ending = (status: string) => ({
      execute: async (p: { goal: string }) => {
        goals.push(p.goal);
        if (status === "throw") throw new Error("model chain exhausted");
        return { status, result: "", steps_count: 0, tokens_used: 0 };
      },
    }) as never;
    const settle = () => new Promise((r) => setTimeout(r, 5));

    it("failed → the letters are unread again and the queue is asked to retry", async () => {
      const w = service.createAgent({ name: "W" });
      service.updateRun(answerWhileBusy(w.id, ["Ship?", "Price?"]), { status: "completed" });
      const requeued: string[] = [];
      deliverPendingAnswers(service, ending("failed"), events, w.id, (id) => requeued.push(id));
      await settle();
      expect(requeued).toEqual([w.id]);
      expect(pendingAnswers(service, w.id)).toHaveLength(2);
      // The next delivery warns that some of them may already be done.
      deliverPendingAnswers(service, executor, events, w.id);
      await settle();
      expect(goals[1]).toContain("stopped before finishing");
      expect(goals[1]).toContain("Ship?");
      expect(pendingAnswers(service, w.id)).toHaveLength(0);
    });

    it("an executor that throws gives them back too", async () => {
      const w = service.createAgent({ name: "W" });
      service.updateRun(answerWhileBusy(w.id, ["Ship?"]), { status: "completed" });
      deliverPendingAnswers(service, ending("throw"), events, w.id);
      await settle();
      expect(pendingAnswers(service, w.id)).toHaveLength(1);
    });

    it("cancelled keeps them read: stopping the agent is the operator's call", async () => {
      const w = service.createAgent({ name: "W" });
      service.updateRun(answerWhileBusy(w.id, ["Ship?"]), { status: "completed" });
      const requeued: string[] = [];
      deliverPendingAnswers(service, ending("cancelled"), events, w.id, (id) => requeued.push(id));
      await settle();
      expect(requeued).toEqual([]);
      expect(pendingAnswers(service, w.id)).toHaveLength(0);
    });

    it(`gives up after ${MAX_REDELIVERIES} redeliveries instead of looping`, async () => {
      const w = service.createAgent({ name: "W" });
      service.updateRun(answerWhileBusy(w.id, ["Ship?"]), { status: "completed" });
      for (let i = 0; i <= MAX_REDELIVERIES; i++) {
        expect(deliverPendingAnswers(service, ending("failed"), events, w.id)).toBeTruthy();
        await settle();
      }
      expect(goals).toHaveLength(MAX_REDELIVERIES + 1);
      expect(pendingAnswers(service, w.id)).toHaveLength(0);
    });

    it("the queue redelivers after a failed run on its own", async () => {
      const w = service.createAgent({ name: "W" });
      service.updateRun(answerWhileBusy(w.id, ["Ship?"]), { status: "completed" });
      let calls = 0;
      const flaky = {
        execute: async (p: { goal: string }) => {
          goals.push(p.goal);
          return { status: calls++ === 0 ? "failed" : "completed", result: "", steps_count: 0, tokens_used: 0 };
        },
      } as never;
      const queue = new AnswerQueue(service, flaky, events, { retryMs: 5 });
      expect(queue.sweep()).toBe(1);
      await new Promise((r) => setTimeout(r, 40));
      expect(goals).toHaveLength(2);
      expect(pendingAnswers(service, w.id)).toHaveLength(0);
      queue.stop();
    });
  });
});

describe("resolveHumanChoice", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let goals: string[];
  const executor = { execute: async (p: { goal: string }) => { goals.push(p.goal); return { status: "completed", result: "", steps_count: 0, tokens_used: 0 }; } } as never;
  const TASKY = [{ label: "Aprobar" }, { label: "Lo reviso yo", task: true }, { label: "Pedir cambios" }, { label: "Esperar" }];

  beforeEach(() => { db = new Database(":memory:"); runMigrations(db, "agents", agentsMigrations); events = new EventBus(); service = new AgentService(db, events); goals = []; });
  afterEach(() => db.close());

  const ask = () => {
    const w = service.createAgent({ name: "W" });
    return { w, id: service.createQuestion({ from_agent_id: w.id, question: "web!7?", options: TASKY, for_operator: true }).id };
  };

  it("task option → owed and a letter that says it is on the operator", () => {
    const { w, id } = ask();
    expect(resolveHumanChoice(service, executor, events, id, { kind: "option", index: 1 })).toEqual({ ok: true, status: "owed" });
    const letters = service.getUnreadInbox(w.id);
    expect(letters[0].subject.startsWith("ANSWER:")).toBe(true);
    expect(letters[0].body).toContain("a cargo del operador");
    expect(goals).toEqual([]);
  });

  it("answersGoal tells the agent an owed letter is not final", () => {
    const { w, id } = ask();
    resolveHumanChoice(service, executor, events, id, { kind: "task" });
    const goal = answersGoal(service.getUnreadInbox(w.id));
    expect(goal).toContain("a cargo del operador");
    expect(goal).toContain("keep waiting and take no action");
  });

  it("Listo from owed → answered and the asker resumes", () => {
    const { id } = ask();
    resolveHumanChoice(service, executor, events, id, { kind: "task" });
    expect(resolveHumanChoice(service, executor, events, id, { kind: "done", note: "aprobado en GitLab" })).toEqual({ ok: true, status: "answered" });
    expect(goals[0]).toContain("Listo: Lo veo yo");
    expect(goals[0]).toContain("aprobado en GitLab");
  });

  it("a task option is not a final answer from owed", () => {
    const { id } = ask();
    resolveHumanChoice(service, executor, events, id, { kind: "task" });
    expect(resolveHumanChoice(service, executor, events, id, { kind: "option", index: 1 })).toEqual({ ok: false, reason: "bad_choice" });
  });

  it("dismiss from owed → DESCARTADA letter", () => {
    const { w, id } = ask();
    resolveHumanChoice(service, executor, events, id, { kind: "task" });
    expect(resolveHumanChoice(service, executor, events, id, { kind: "dismiss" })).toEqual({ ok: true, status: "dismissed" });
    expect(service.getUnreadInbox(w.id).some((l) => l.body.includes("DESCARTADA"))).toBe(true);
  });

  describe("closing an owed question retires its 'keep waiting' letter", () => {
    const owedLetters = (agentId: string) => pendingAnswers(service, agentId).filter((l) => l.body.includes("a cargo del operador"));

    it("Listo", () => {
      const { w, id } = ask();
      resolveHumanChoice(service, executor, events, id, { kind: "task" });
      expect(owedLetters(w.id).length).toBe(1);
      resolveHumanChoice(service, executor, events, id, { kind: "done" });
      expect(pendingAnswers(service, w.id).length).toBe(0);
    });

    it("a final option", () => {
      const { w, id } = ask();
      resolveHumanChoice(service, executor, events, id, { kind: "task" });
      resolveHumanChoice(service, executor, events, id, { kind: "option", index: 0 });
      expect(owedLetters(w.id).length).toBe(0);
    });

    it("free text", () => {
      const { w, id } = ask();
      resolveHumanChoice(service, executor, events, id, { kind: "task" });
      resolveHumanChoice(service, executor, events, id, { kind: "free", text: "lo hice a mano" });
      expect(owedLetters(w.id).length).toBe(0);
    });

    it("dismiss keeps only the DESCARTADA letter", () => {
      const { w, id } = ask();
      resolveHumanChoice(service, executor, events, id, { kind: "task" });
      resolveHumanChoice(service, executor, events, id, { kind: "dismiss" });
      const left = pendingAnswers(service, w.id);
      expect(left.length).toBe(1);
      expect(left[0].body).toContain("DESCARTADA");
    });

    it("a busy asker gets the final answer alone, not with the stale letter", () => {
      const { w, id } = ask();
      resolveHumanChoice(service, executor, events, id, { kind: "task" });
      const busy = service.createRun({ agent_id: w.id, goal: "busy" });
      service.updateRun(busy.id, { status: "running" });
      resolveHumanChoice(service, executor, events, id, { kind: "done" });
      const left = pendingAnswers(service, w.id);
      expect(left.length).toBe(1);
      expect(left[0].body).not.toContain("a cargo del operador");
    });

    it("leaves other questions' owed letters alone", () => {
      const { w, id } = ask();
      const other = service.createQuestion({ from_agent_id: w.id, question: "otra?", options: TASKY, for_operator: true }).id;
      resolveHumanChoice(service, executor, events, id, { kind: "task" });
      resolveHumanChoice(service, executor, events, other, { kind: "task" });
      resolveHumanChoice(service, executor, events, id, { kind: "done" });
      expect(owedLetters(w.id).map((l) => l.subject)).toEqual(["ANSWER: otra?"]);
    });
  });

  it("a second answer gets not_open and changes nothing", () => {
    const { id } = ask();
    resolveHumanChoice(service, executor, events, id, { kind: "option", index: 0 });
    expect(resolveHumanChoice(service, executor, events, id, { kind: "option", index: 2 })).toEqual({ ok: false, reason: "not_open" });
    expect(service.getQuestion(id)!.selected_option).toBe("Aprobar");
  });
});
