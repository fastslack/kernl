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
