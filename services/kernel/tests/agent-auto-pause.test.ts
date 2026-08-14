import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { normalizeDriverResult, driverThrewOutcome } from "../src/modules/agents/driver-result.js";
import { EventBus } from "../src/core/event-bus.js";

// Circuit breaker: a handler that keeps failing must stop running and the top
// agent must hear about it. Regression guard for pollers that reported a dead
// upstream as a *successful* run and kept their cron slot forever.

describe("driver result normalization", () => {
  it("treats a plain string as success", () => {
    expect(normalizeDriverResult("42 items")).toEqual({ ok: true, text: "42 items", error: "" });
  });

  it("treats { ok: false } as failure and keeps detail as the body", () => {
    const out = normalizeDriverResult({ ok: false, error: "upstream down", detail: "long\nhint" });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("upstream down");
    expect(out.text).toBe("long\nhint");
  });

  it("falls back to the error line when no detail is given", () => {
    expect(normalizeDriverResult({ ok: false, error: "boom" }).text).toBe("boom");
  });

  it("never fails a run over a sloppy return value", () => {
    expect(normalizeDriverResult(undefined).ok).toBe(true);
    expect(normalizeDriverResult(null).ok).toBe(true);
    expect(normalizeDriverResult({ ok: true } as unknown as string).ok).toBe(true);
  });

  it("maps a thrown error to a failure", () => {
    expect(driverThrewOutcome(new Error("ETIMEDOUT"))).toEqual({ ok: false, text: "", error: "ETIMEDOUT" });
  });
});

describe("AgentService circuit breaker", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
  });

  afterEach(() => db.close());

  it("counts consecutive failures without pausing below the threshold", () => {
    const agent = service.createAgent({ name: "YTS RSS" });

    const first = service.recordRunOutcome(agent.id, { ok: false, error: "upstream down" });
    expect(first.paused).toBe(false);
    expect(first.consecutive_failures).toBe(1);

    const second = service.recordRunOutcome(agent.id, { ok: false, error: "upstream down" });
    expect(second.paused).toBe(false);
    expect(service.getAgent(agent.id)?.active).toBe(1);
  });

  it("auto-pauses at the third consecutive failure and records the reason", () => {
    const agent = service.createAgent({ name: "YTS RSS" });

    service.recordRunOutcome(agent.id, { ok: false, error: "upstream down" });
    service.recordRunOutcome(agent.id, { ok: false, error: "upstream down" });
    const third = service.recordRunOutcome(agent.id, { ok: false, error: "Unable to connect" });

    expect(third.paused).toBe(true);
    const paused = service.getAgent(agent.id);
    expect(paused?.active).toBe(0);
    expect(paused?.consecutive_failures).toBe(3);
    expect(paused?.auto_pause_reason).toBe("Unable to connect");
    expect(paused?.auto_paused_at).not.toBe("");
  });

  it("emits agent:auto_paused once, on the transition only", () => {
    const agent = service.createAgent({ name: "YTS RSS" });
    const seen: unknown[] = [];
    events.on("agent:auto_paused", (payload) => { seen.push(payload); });

    for (let i = 0; i < 5; i++) service.recordRunOutcome(agent.id, { ok: false, error: "dead" });

    // Runs 4 and 5 hit an already-paused agent: no second alert.
    expect(seen.length).toBe(1);
  });

  /*
   * The dashboard bell subscriber in bootstrap/services-late.ts reads exactly
   * these three fields off the payload. Emitting the event with a different
   * shape would leave the notification saying "An agent … 0 consecutive
   * failures … unknown" instead of failing loudly, so pin the contract.
   */
  it("emits a payload carrying the name, the count and the reason", () => {
    const agent = service.createAgent({ name: "YTS RSS" });
    const seen: Array<Record<string, unknown>> = [];
    events.on("agent:auto_paused", (p) => { seen.push(p as unknown as Record<string, unknown>); });

    for (let i = 0; i < 3; i++) {
      service.recordRunOutcome(agent.id, { ok: false, error: "yts upstream failed: Unable to connect" });
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].agent_name).toBe("YTS RSS");
    expect(seen[0].consecutive_failures).toBe(3);
    expect(seen[0].reason).toBe("yts upstream failed: Unable to connect");
  });

  /*
   * The 3D panel distinguishes an auto-pause from an operator pause by reading
   * auto_paused_at / auto_pause_reason / consecutive_failures off the graph
   * payload. getAgentGraph deliberately includes inactive agents; it must also
   * keep carrying the breaker columns, which a switch from SELECT * to an
   * explicit column list would quietly drop.
   */
  it("keeps the breaker fields on a paused agent in the graph payload", () => {
    const agent = service.createAgent({ name: "YTS RSS" });
    for (let i = 0; i < 3; i++) {
      service.recordRunOutcome(agent.id, { ok: false, error: "yts upstream failed: Unable to connect" });
    }

    const inGraph = service.getAgentGraph().agents.find((a) => a.id === agent.id);
    expect(inGraph).toBeDefined(); // paused agents must not vanish from the world
    expect(inGraph?.active).toBe(0);
    expect(inGraph?.consecutive_failures).toBe(3);
    expect(inGraph?.auto_pause_reason).toBe("yts upstream failed: Unable to connect");
    expect(inGraph?.auto_paused_at).not.toBe("");
  });

  /*
   * An operator pause leaves the stamp empty, which is the only thing telling
   * the two apart on screen.
   */
  it("leaves the auto-pause stamp empty when the operator pauses by hand", () => {
    const agent = service.createAgent({ name: "YTS RSS" });
    service.recordRunOutcome(agent.id, { ok: false, error: "one blip" });
    service.updateAgent(agent.id, { active: false });

    const paused = service.getAgent(agent.id);
    expect(paused?.active).toBe(0);
    expect(paused?.auto_paused_at ?? "").toBe("");
    expect(paused?.auto_pause_reason ?? "").toBe("");
  });

  /*
   * The breaker is only honest if EVERY path reports. These two were missing:
   * an event-triggered agent could fail identically forever, and a manual
   * "Run now" neither advanced the counter nor cleared it on success.
   */
  it("counts a failure reported from the event-triggered path", () => {
    const agent = service.createAgent({ name: "YTS RSS" });

    // What ReactiveEngine.executeAsync now reports for a failed run.
    service.recordRunOutcome(agent.id, { ok: false, error: "trigger blew up", run_id: "r1" });
    service.recordRunOutcome(agent.id, { ok: false, error: "trigger blew up", run_id: "r2" });
    const third = service.recordRunOutcome(agent.id, { ok: false, error: "trigger blew up", run_id: "r3" });

    expect(third.paused).toBe(true);
    expect(service.getAgent(agent.id)?.active).toBe(0);
  });

  it("lets a successful manual run clear a counter the schedule built up", () => {
    const agent = service.createAgent({ name: "YTS RSS" });
    service.recordRunOutcome(agent.id, { ok: false, error: "upstream down" });
    service.recordRunOutcome(agent.id, { ok: false, error: "upstream down" });
    expect(service.getAgent(agent.id)?.consecutive_failures).toBe(2);

    // The manual path now reports too, so fixing the cause and pressing
    // "Run now" resets the agent instead of leaving it one failure from a pause.
    service.recordRunOutcome(agent.id, { ok: true, run_id: "manual" });

    expect(service.getAgent(agent.id)?.consecutive_failures).toBe(0);
    expect(service.getAgent(agent.id)?.active).toBe(1);
  });

  it("resets the counter on any successful run", () => {
    const agent = service.createAgent({ name: "YTS RSS" });

    service.recordRunOutcome(agent.id, { ok: false, error: "flaky" });
    service.recordRunOutcome(agent.id, { ok: false, error: "flaky" });
    service.recordRunOutcome(agent.id, { ok: true });
    expect(service.getAgent(agent.id)?.consecutive_failures).toBe(0);

    // A single later failure must not tip it over — the budget is full again.
    const next = service.recordRunOutcome(agent.id, { ok: false, error: "flaky" });
    expect(next.paused).toBe(false);
    expect(next.consecutive_failures).toBe(1);
  });

  it("clears the breaker when the agent is reactivated", () => {
    const agent = service.createAgent({ name: "YTS RSS" });
    for (let i = 0; i < 3; i++) service.recordRunOutcome(agent.id, { ok: false, error: "dead" });
    expect(service.getAgent(agent.id)?.active).toBe(0);

    service.updateAgent(agent.id, { active: true });

    const revived = service.getAgent(agent.id);
    expect(revived?.active).toBe(1);
    expect(revived?.consecutive_failures).toBe(0);
    expect(revived?.auto_paused_at).toBe("");
    expect(revived?.auto_pause_reason).toBe("");
  });

  it("alerts the top agent with a message naming the failure", () => {
    const chiefRank = service.createRank({ name: "Chief", level: 11 });
    const chief = service.createAgent({ name: "Chief", rank_id: chiefRank.id });
    const agent = service.createAgent({ name: "YTS RSS", builtin_handler: "torrents:rss:yts" });

    for (let i = 0; i < 3; i++) {
      service.recordRunOutcome(agent.id, { ok: false, error: "yts upstream failed: Unable to connect" });
    }

    const convos = service.listConversations({ agent_id: chief.id });
    expect(convos.length).toBe(1);
    const messages = service.listMessages(convos[0]!.id);
    expect(messages.length).toBe(1);
    expect(messages[0]!.to_agent_id).toBe(chief.id);
    expect(messages[0]!.from_agent_id).toBe(agent.id);
    expect(messages[0]!.body).toContain("Auto-paused");
    expect(messages[0]!.body).toContain("Unable to connect");
    expect(messages[0]!.body).toContain("torrents:rss:yts");
  });

  it("still pauses when there is no top agent to alert", () => {
    const agent = service.createAgent({ name: "YTS RSS" });

    for (let i = 0; i < 3; i++) service.recordRunOutcome(agent.id, { ok: false, error: "dead" });

    expect(service.getAgent(agent.id)?.active).toBe(0);
  });
});

describe("builtin execution records the outcome", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let executor: AgentExecutor;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
    executor = new AgentExecutor();
  });

  afterEach(() => db.close());

  const runBuiltin = async (agentId: string) => {
    const agent = service.getAgent(agentId)!;
    const run = service.createRun({ agent_id: agentId, goal: "poll" });
    return executor.execute({ agent, goal: "poll", run, service, events });
  };

  it("fails the run when the handler returns { ok: false }", async () => {
    executor.setBuiltinHandlers(
      new Map([["test:poller", async () => ({ ok: false as const, error: "upstream down" })]]),
    );
    const agent = service.createAgent({ name: "Poller", builtin_handler: "test:poller" });

    const result = await runBuiltin(agent.id);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("upstream down");
    expect(service.getAgent(agent.id)?.consecutive_failures).toBe(1);
  });

  it("fails the run when the handler throws", async () => {
    executor.setBuiltinHandlers(
      new Map([["test:poller", async () => { throw new Error("ETIMEDOUT"); }]]),
    );
    const agent = service.createAgent({ name: "Poller", builtin_handler: "test:poller" });

    const result = await runBuiltin(agent.id);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("ETIMEDOUT");
    expect(service.getAgent(agent.id)?.consecutive_failures).toBe(1);
  });

  it("keeps a string-returning handler a success", async () => {
    executor.setBuiltinHandlers(new Map([["test:poller", async () => "12 items · 3 new"]]));
    const agent = service.createAgent({ name: "Poller", builtin_handler: "test:poller" });

    const result = await runBuiltin(agent.id);

    expect(result.status).toBe("completed");
    expect(result.result).toBe("12 items · 3 new");
    expect(service.getAgent(agent.id)?.consecutive_failures).toBe(0);
  });

  it("auto-pauses a manually-run handler that keeps failing", async () => {
    executor.setBuiltinHandlers(
      new Map([["test:poller", async () => ({ ok: false as const, error: "upstream down" })]]),
    );
    const agent = service.createAgent({ name: "Poller", builtin_handler: "test:poller" });

    await runBuiltin(agent.id);
    await runBuiltin(agent.id);
    await runBuiltin(agent.id);

    expect(service.getAgent(agent.id)?.active).toBe(0);
  });
});

/*
 * Questions are the one kind of agent message addressed to a person by
 * construction, which is what makes them safe to route to the dashboard bell
 * while agent-to-agent chatter stays out of it. The subscriber in
 * bootstrap/services-late.ts reads name/question/options off this payload.
 */
describe("agents asking the operator", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
  });

  afterEach(() => db.close());

  it("emits agent:question_asked naming the agent and carrying the options", () => {
    const chief = service.createAgent({ name: "CHIEF" });
    const seen: Array<Record<string, unknown>> = [];
    events.on("agent:question_asked", (p) => { seen.push(p as unknown as Record<string, unknown>); });

    const { id } = service.createQuestion({
      from_agent_id: chief.id,
      question: "The YTS mirror is unreachable. Switch provider?",
      options: [{ label: "Switch to EZTV" }, { label: "Keep retrying" }],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].question_id).toBe(id);
    expect(seen[0].agent_name).toBe("CHIEF");
    expect(seen[0].question).toBe("The YTS mirror is unreachable. Switch provider?");
    expect(seen[0].options).toEqual(["Switch to EZTV", "Keep retrying"]);
  });

  it("falls back to a generic name when the asking agent is gone", () => {
    const seen: Array<Record<string, unknown>> = [];
    events.on("agent:question_asked", (p) => { seen.push(p as unknown as Record<string, unknown>); });

    service.createQuestion({ from_agent_id: "vanished", question: "still there?", options: [] });

    expect(seen[0].agent_name).toBe("An agent");
    expect(seen[0].options).toEqual([]);
  });

  it("leaves the question pending — the notification does not answer it", () => {
    const chief = service.createAgent({ name: "CHIEF" });
    service.createQuestion({ from_agent_id: chief.id, question: "proceed?", options: [] });

    expect(service.listQuestions({ status: "pending" })).toHaveLength(1);
  });
});
