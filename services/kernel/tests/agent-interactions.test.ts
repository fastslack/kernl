import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { InboxWaker } from "../assets/extensions/agents/agent-advanced/_module/inbox-waker.js";
import { ConversationSubscriptionEngine } from "../assets/extensions/agents/agent-advanced/_module/conversation-subscription-engine.js";
import { EventBus } from "../src/core/event-bus.js";

// ── Mock executor ──────────────────────────────────────────────────────────
// The wake/subscribe engines call executor.execute(). We swap in a fake that
// records calls so we can assert "agent X was woken" without burning LLM
// tokens. The shape only needs to satisfy the small surface those engines use.
function makeMockExecutor() {
  const calls: Array<{ agentId: string; goal: string; depth: number }> = [];
  const fake = {
    async execute(params: { agent: { id: string }; goal: string; depth?: number }) {
      calls.push({ agentId: params.agent.id, goal: params.goal, depth: params.depth ?? 0 });
      return { status: "completed" as const, result: "ok", error: "", steps_count: 1, tokens_used: 0 };
    },
    cancelRun: () => true,
  };
  return { fake: fake as unknown as AgentExecutor, calls };
}

// Tiny config stub matching the bits the executor reads.
function makeConfigStub(overrides: { maxInvokeDepth?: number; invokeTimeoutMs?: number } = {}) {
  return {
    agents: {
      pollIntervalMs: 30_000,
      maxConcurrentRuns: 3,
      defaultProvider: "",
      defaultModel: "",
      defaultModelChain: [],
      evalProvider: "",
      evalModel: "",
      learningCleanupIntervalMs: 3_600_000,
      learningMinConfidence: 0.15,
      maxInvokeDepth: overrides.maxInvokeDepth ?? 5,
      invokeTimeoutMs: overrides.invokeTimeoutMs ?? 300_000,
      inboxWakeQuietMs: 300_000,
      subscriptionCooldownMs: 60_000,
    },
  } as unknown as Parameters<AgentExecutor["setConfig"]>[0];
}

async function flush() {
  // Engines fire-and-forget — let microtasks drain before assertions.
  await new Promise((r) => setTimeout(r, 10));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Agent interactions — B/A/C wiring", () => {
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

  // ── B — Hard caps on invoke ────────────────────────────────────────────

  describe("B: invoke depth cap", () => {
    it("execute() returns failed when depth exceeds maxInvokeDepth", async () => {
      const agent = service.createAgent({ name: "Solo" });
      const run = service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "x" });

      const executor = new AgentExecutor();
      executor.setConfig(makeConfigStub({ maxInvokeDepth: 5 }));

      const result = await executor.execute({
        agent, goal: "x", run, service, events, depth: 6,
      });

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/Max chain depth exceeded/);
    });

    it("execute() respects custom maxInvokeDepth from config", async () => {
      const agent = service.createAgent({ name: "Solo" });
      const run = service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "x" });

      const executor = new AgentExecutor();
      executor.setConfig(makeConfigStub({ maxInvokeDepth: 2 }));

      const okAt2 = await executor.execute({ agent, goal: "x", run, service, events, depth: 2 });
      const failAt3 = await executor.execute({ agent, goal: "x", run, service, events, depth: 3 });

      // depth=2 reaches the LLM stage and fails for unrelated reasons
      // (no providers configured) — we just want to confirm it didn't fail
      // on the depth guard.
      expect(okAt2.error).not.toMatch(/Max chain depth exceeded/);
      expect(failAt3.error).toMatch(/Max chain depth exceeded \(limit: 2\)/);
    });
  });

  // ── A — Inbox wake ─────────────────────────────────────────────────────

  describe("A: InboxWaker", () => {
    it("wakes an idle recipient when wake_on_inbox=1", async () => {
      const sender = service.createAgent({ name: "Sender" });
      const target = service.createAgent({ name: "Target" });
      expect(target.wake_on_inbox).toBe(1); // default opt-in

      const { fake, calls } = makeMockExecutor();
      const waker = new InboxWaker(service, fake, events, { quietMs: 1_000 });
      waker.start();

      service.postToColleague({
        from_agent_id: sender.id,
        to_agent_id: target.id,
        subject: "ping",
        body: "are you there?",
      });
      await flush();

      expect(calls.length).toBe(1);
      expect(calls[0].agentId).toBe(target.id);
      expect(calls[0].goal).toContain("Inbox wake-up");
      expect(calls[0].goal).toContain("Sender");
    });

    it("does NOT wake when wake_on_inbox=0", async () => {
      const sender = service.createAgent({ name: "Sender" });
      const target = service.createAgent({ name: "Target", wake_on_inbox: false });
      expect(target.wake_on_inbox).toBe(0);

      const { fake, calls } = makeMockExecutor();
      const waker = new InboxWaker(service, fake, events, { quietMs: 1_000 });
      waker.start();

      service.postToColleague({
        from_agent_id: sender.id, to_agent_id: target.id,
        subject: "x", body: "y",
      });
      await flush();

      expect(calls.length).toBe(0);
    });

    it("does NOT wake when target already has a running run", async () => {
      const sender = service.createAgent({ name: "Sender" });
      const target = service.createAgent({ name: "Target" });
      // Pre-existing run keeps the target busy.
      const busyRun = service.createRun({ agent_id: target.id, trigger_type: "manual", goal: "busy" });
      service.updateRun(busyRun.id, { status: "running" });

      const { fake, calls } = makeMockExecutor();
      const waker = new InboxWaker(service, fake, events, { quietMs: 1_000 });
      waker.start();

      service.postToColleague({
        from_agent_id: sender.id, to_agent_id: target.id,
        subject: "x", body: "y",
      });
      await flush();

      expect(calls.length).toBe(0);
    });

    it("collapses a burst of messages into a single wake-up (cooldown)", async () => {
      const sender = service.createAgent({ name: "Sender" });
      const target = service.createAgent({ name: "Target" });

      const { fake, calls } = makeMockExecutor();
      const waker = new InboxWaker(service, fake, events, { quietMs: 60_000 });
      waker.start();

      for (let i = 0; i < 5; i++) {
        service.postToColleague({
          from_agent_id: sender.id, to_agent_id: target.id,
          subject: `msg ${i}`, body: "spam",
        });
      }
      await flush();

      expect(calls.length).toBe(1);
    });
  });

  // ── C — Conversation subscriptions ─────────────────────────────────────

  describe("C: ConversationSubscriptionEngine", () => {
    it("subscribeAgentToConversation is idempotent (re-subscribe updates mode)", () => {
      const agent = service.createAgent({ name: "Watcher" });
      const convo = service.findOrCreateChatConversation({
        topic: "release plan",
        participants: [agent.id],
        initiator_agent_id: agent.id,
      });

      const first = service.subscribeAgentToConversation({
        agent_id: agent.id, conversation_id: convo.id, mode: "responder",
      });
      const second = service.subscribeAgentToConversation({
        agent_id: agent.id, conversation_id: convo.id, mode: "observer",
      });

      expect(first?.id).toBe(second?.id);          // same row reused
      expect(second?.mode).toBe("observer");        // updated
      expect(service.listSubscriptionsForAgent(agent.id).length).toBe(1);
    });

    it("wakes responders on new turns; sender is excluded", async () => {
      const a = service.createAgent({ name: "Speaker" });
      const b = service.createAgent({ name: "Listener" });
      const convo = service.findOrCreateChatConversation({
        topic: "design review",
        participants: [a.id, b.id],
        initiator_agent_id: a.id,
      });
      service.subscribeAgentToConversation({ agent_id: b.id, conversation_id: convo.id });
      // The sender is also subscribed — must NOT self-wake.
      service.subscribeAgentToConversation({ agent_id: a.id, conversation_id: convo.id });

      const { fake, calls } = makeMockExecutor();
      const engine = new ConversationSubscriptionEngine(service, fake, events, { cooldownMs: 0 });
      engine.start();

      service.postMessage({
        conversation_id: convo.id,
        from_agent_id: a.id,
        body: "what do you think?",
        role: "question",
      });
      await flush();

      expect(calls.length).toBe(1);
      expect(calls[0].agentId).toBe(b.id);
      expect(calls[0].goal).toContain("conversation");
    });

    it("filter_role gates which messages trigger the subscription", async () => {
      const a = service.createAgent({ name: "Speaker" });
      const b = service.createAgent({ name: "Listener" });
      const convo = service.findOrCreateChatConversation({
        topic: "topic",
        participants: [a.id, b.id],
        initiator_agent_id: a.id,
      });
      service.subscribeAgentToConversation({
        agent_id: b.id, conversation_id: convo.id, filter_role: "counter",
      });

      const { fake, calls } = makeMockExecutor();
      const engine = new ConversationSubscriptionEngine(service, fake, events, { cooldownMs: 0 });
      engine.start();

      // role=stmt — should be skipped by the filter
      service.postMessage({ conversation_id: convo.id, from_agent_id: a.id, body: "hi", role: "stmt" });
      await flush();
      expect(calls.length).toBe(0);

      // role=counter — passes the filter
      service.postMessage({ conversation_id: convo.id, from_agent_id: a.id, body: "no", role: "counter" });
      await flush();
      expect(calls.length).toBe(1);
    });

    it("unsubscribe stops further wake-ups", async () => {
      const a = service.createAgent({ name: "Speaker" });
      const b = service.createAgent({ name: "Listener" });
      const convo = service.findOrCreateChatConversation({
        topic: "t", participants: [a.id, b.id], initiator_agent_id: a.id,
      });
      service.subscribeAgentToConversation({ agent_id: b.id, conversation_id: convo.id });

      const { fake, calls } = makeMockExecutor();
      const engine = new ConversationSubscriptionEngine(service, fake, events, { cooldownMs: 0 });
      engine.start();

      service.postMessage({ conversation_id: convo.id, from_agent_id: a.id, body: "1", role: "stmt" });
      await flush();
      expect(calls.length).toBe(1);

      service.unsubscribeAgentFromConversation(b.id, convo.id);
      service.postMessage({ conversation_id: convo.id, from_agent_id: a.id, body: "2", role: "stmt" });
      await flush();
      expect(calls.length).toBe(1); // unchanged
    });
  });
});
