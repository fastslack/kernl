import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor, resolveGoal } from "../src/modules/agents/executor.js";
import { EventBus } from "../src/core/event-bus.js";

// The service enforces a minimum schedule interval (default 300s) as a
// rate-limit guard. Tests use short intervals, so lower the floor.
process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = "1";

// ── Tests ──────────────────────────────────────────

describe("AgentService", () => {
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

  // ── Agent CRUD ──────────────────────────────────

  describe("Agent CRUD", () => {
    it("creates an agent with defaults", () => {
      const agent = service.createAgent({ name: "Test Agent" });
      expect(agent.name).toBe("Test Agent");
      expect(agent.active).toBe(1);
      expect(agent.max_iterations).toBe(15);
      expect(agent.timeout_ms).toBe(300_000);
      expect(agent.allowed_tools).toBe("[]");
      expect(agent.denied_tools).toBe("[]");
      expect(agent.provider).toBe("");
      expect(agent.model).toBe("");
    });

    it("creates an agent with custom config", () => {
      const agent = service.createAgent({
        name: "Custom Agent",
        description: "Does things",
        system_prompt: "You are helpful",
        goal_template: "Do {{action}} for {{target}}",
        allowed_tools: ["kernel_tasks_create", "kernel_tasks_list"],
        denied_tools: ["kernel_agents_delete"],
        provider: "claude",
        model: "claude-sonnet-4-20250514",
        max_iterations: 10,
        timeout_ms: 60_000,
      });

      expect(agent.description).toBe("Does things");
      expect(agent.system_prompt).toBe("You are helpful");
      expect(agent.goal_template).toBe("Do {{action}} for {{target}}");
      expect(JSON.parse(agent.allowed_tools)).toEqual(["kernel_tasks_create", "kernel_tasks_list"]);
      expect(JSON.parse(agent.denied_tools)).toEqual(["kernel_agents_delete"]);
      expect(agent.provider).toBe("claude");
      expect(agent.max_iterations).toBe(10);
    });

    it("gets an agent by id", () => {
      const created = service.createAgent({ name: "Fetch Me" });
      const found = service.getAgent(created.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("Fetch Me");
    });

    it("returns undefined for non-existent agent", () => {
      expect(service.getAgent("nonexistent")).toBeFalsy();
    });

    it("lists all agents", () => {
      service.createAgent({ name: "Agent 1" });
      service.createAgent({ name: "Agent 2" });
      const agents = service.listAgents();
      expect(agents).toHaveLength(2);
    });

    it("lists only active agents", () => {
      const a1 = service.createAgent({ name: "Active" });
      const a2 = service.createAgent({ name: "Inactive" });
      service.deleteAgent(a2.id);

      const active = service.listAgents({ active: true });
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe("Active");

      const inactive = service.listAgents({ active: false });
      expect(inactive).toHaveLength(1);
      expect(inactive[0].name).toBe("Inactive");
    });

    it("updates an agent", () => {
      const agent = service.createAgent({ name: "Old Name" });
      const updated = service.updateAgent(agent.id, {
        name: "New Name",
        max_iterations: 25,
        active: false,
      });

      expect(updated).toBeDefined();
      expect(updated!.name).toBe("New Name");
      expect(updated!.max_iterations).toBe(25);
      expect(updated!.active).toBe(0);
    });

    it("soft-deletes an agent", () => {
      const agent = service.createAgent({ name: "To Delete" });
      expect(service.deleteAgent(agent.id)).toBe(true);

      const found = service.getAgent(agent.id);
      expect(found!.active).toBe(0);
    });

    it("returns false when deleting non-existent agent", () => {
      expect(service.deleteAgent("nonexistent")).toBe(false);
    });
  });

  // ── Run management ──────────────────────────────

  describe("Run management", () => {
    it("creates a run", () => {
      const agent = service.createAgent({ name: "Runner" });
      const run = service.createRun({
        agent_id: agent.id,
        goal: "Do something",
      });

      expect(run.agent_id).toBe(agent.id);
      expect(run.status).toBe("pending");
      expect(run.trigger_type).toBe("manual");
      expect(run.goal).toBe("Do something");
      expect(run.steps_count).toBe(0);
      expect(run.tokens_used).toBe(0);
    });

    it("creates a run with event trigger type", () => {
      const agent = service.createAgent({ name: "Event Agent" });
      const run = service.createRun({
        agent_id: agent.id,
        trigger_type: "event",
        trigger_payload: { event: "test", data: 42 },
        goal: "React to event",
      });

      expect(run.trigger_type).toBe("event");
      expect(JSON.parse(run.trigger_payload)).toEqual({ event: "test", data: 42 });
    });

    it("gets a run by id", () => {
      const agent = service.createAgent({ name: "Test" });
      const created = service.createRun({ agent_id: agent.id, goal: "test" });
      const found = service.getRun(created.id);
      expect(found).toBeDefined();
      expect(found!.goal).toBe("test");
    });

    it("lists runs with filters", () => {
      const agent = service.createAgent({ name: "Test" });
      service.createRun({ agent_id: agent.id, goal: "run1" });
      service.createRun({ agent_id: agent.id, goal: "run2" });

      const runs = service.listRuns({ agent_id: agent.id });
      expect(runs).toHaveLength(2);

      const limited = service.listRuns({ agent_id: agent.id, limit: 1 });
      expect(limited).toHaveLength(1);
    });

    it("updates a run", () => {
      const agent = service.createAgent({ name: "Test" });
      const run = service.createRun({ agent_id: agent.id, goal: "test" });

      service.updateRun(run.id, {
        status: "running",
        started_at: new Date().toISOString(),
      });

      const updated = service.getRun(run.id);
      expect(updated!.status).toBe("running");
      expect(updated!.started_at).not.toBeNull();
    });

    it("cancels a pending run", () => {
      const agent = service.createAgent({ name: "Test" });
      const run = service.createRun({ agent_id: agent.id, goal: "test" });

      expect(service.cancelRun(run.id)).toBe(true);

      const cancelled = service.getRun(run.id);
      expect(cancelled!.status).toBe("cancelled");
      expect(cancelled!.completed_at).not.toBeNull();
    });

    it("cannot cancel a completed run", () => {
      const agent = service.createAgent({ name: "Test" });
      const run = service.createRun({ agent_id: agent.id, goal: "test" });

      service.updateRun(run.id, { status: "completed" });
      expect(service.cancelRun(run.id)).toBe(false);
    });
  });

  // ── Steps ───────────────────────────────────────

  describe("Steps", () => {
    it("adds and retrieves steps in order", () => {
      const agent = service.createAgent({ name: "Test" });
      const run = service.createRun({ agent_id: agent.id, goal: "test" });

      service.addStep({
        run_id: run.id,
        step_number: 1,
        type: "thought",
        content: "I should create a task",
      });

      service.addStep({
        run_id: run.id,
        step_number: 2,
        type: "tool_call",
        tool_name: "kernel_tasks_create",
        tool_input: { title: "New Task" },
      });

      service.addStep({
        run_id: run.id,
        step_number: 3,
        type: "tool_result",
        tool_name: "kernel_tasks_create",
        tool_output: "Task created: abc123",
      });

      service.addStep({
        run_id: run.id,
        step_number: 4,
        type: "final",
        content: "Done. I created a new task.",
      });

      const steps = service.getSteps(run.id);
      expect(steps).toHaveLength(4);
      expect(steps[0].type).toBe("thought");
      expect(steps[1].type).toBe("tool_call");
      expect(steps[1].tool_name).toBe("kernel_tasks_create");
      expect(steps[2].type).toBe("tool_result");
      expect(steps[3].type).toBe("final");
    });

    it("stores tool_input as JSON", () => {
      const agent = service.createAgent({ name: "Test" });
      const run = service.createRun({ agent_id: agent.id, goal: "test" });

      service.addStep({
        run_id: run.id,
        step_number: 1,
        type: "tool_call",
        tool_name: "kernel_tasks_create",
        tool_input: { title: "Hello", priority: "high" },
      });

      const steps = service.getSteps(run.id);
      expect(JSON.parse(steps[0].tool_input)).toEqual({ title: "Hello", priority: "high" });
    });
  });

  // ── Event Triggers ──────────────────────────────

  describe("Event Triggers", () => {
    it("adds an event trigger", () => {
      const agent = service.createAgent({ name: "Test" });
      const trigger = service.addEventTrigger({
        agent_id: agent.id,
        event_name: "reminder.fired",
        cooldown_ms: 30_000,
      });

      expect(trigger.event_name).toBe("reminder.fired");
      expect(trigger.cooldown_ms).toBe(30_000);
      expect(trigger.active).toBe(1);
      expect(trigger.last_fired).toBeNull();
    });

    it("adds a trigger with filter", () => {
      const agent = service.createAgent({ name: "Test" });
      const trigger = service.addEventTrigger({
        agent_id: agent.id,
        event_name: "data.changed",
        filter: { module: "crm" },
      });

      expect(JSON.parse(trigger.filter)).toEqual({ module: "crm" });
    });

    it("lists triggers for an agent", () => {
      const agent = service.createAgent({ name: "Test" });
      service.addEventTrigger({ agent_id: agent.id, event_name: "event1" });
      service.addEventTrigger({ agent_id: agent.id, event_name: "event2" });

      const triggers = service.listEventTriggers(agent.id);
      expect(triggers).toHaveLength(2);
    });

    it("gets active triggers only", () => {
      const a1 = service.createAgent({ name: "Active" });
      const a2 = service.createAgent({ name: "Inactive" });
      service.deleteAgent(a2.id); // soft delete

      service.addEventTrigger({ agent_id: a1.id, event_name: "event1" });
      service.addEventTrigger({ agent_id: a2.id, event_name: "event2" });

      const active = service.getActiveEventTriggers();
      expect(active).toHaveLength(1);
      expect(active[0].event_name).toBe("event1");
    });

    it("removes an event trigger", () => {
      const agent = service.createAgent({ name: "Test" });
      const trigger = service.addEventTrigger({ agent_id: agent.id, event_name: "event1" });

      expect(service.removeEventTrigger(trigger.id)).toBe(true);
      expect(service.listEventTriggers(agent.id)).toHaveLength(0);
    });

    it("updates last_fired timestamp", () => {
      const agent = service.createAgent({ name: "Test" });
      const trigger = service.addEventTrigger({ agent_id: agent.id, event_name: "event1" });

      service.updateTriggerLastFired(trigger.id);

      const triggers = service.listEventTriggers(agent.id);
      expect(triggers[0].last_fired).not.toBeNull();
    });
  });

  // ── Schedules ───────────────────────────────────

  describe("Schedules", () => {
    it("rejects intervals below the configured floor", () => {
      const agent = service.createAgent({ name: "Test" });
      const prev = process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS;
      process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = "300";
      try {
        expect(() =>
          service.addSchedule({ agent_id: agent.id, interval_ms: 60_000 }),
        ).toThrow(/below minimum/);
      } finally {
        process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = prev;
      }
    });

    it("adds a schedule", () => {
      const agent = service.createAgent({ name: "Test" });
      const schedule = service.addSchedule({
        agent_id: agent.id,
        interval_ms: 3_600_000,
      });

      expect(schedule.interval_ms).toBe(3_600_000);
      expect(schedule.active).toBe(1);
      expect(schedule.goal_override).toBe("");
      expect(schedule.last_run_at).toBeNull();
      expect(schedule.next_run_at).toBeTruthy();
    });

    it("adds a schedule with goal override", () => {
      const agent = service.createAgent({ name: "Test" });
      const schedule = service.addSchedule({
        agent_id: agent.id,
        interval_ms: 60_000,
        goal_override: "Custom scheduled goal",
      });

      expect(schedule.goal_override).toBe("Custom scheduled goal");
    });

    it("lists schedules for an agent", () => {
      const agent = service.createAgent({ name: "Test" });
      service.addSchedule({ agent_id: agent.id, interval_ms: 60_000 });
      service.addSchedule({ agent_id: agent.id, interval_ms: 120_000 });

      const schedules = service.listSchedules(agent.id);
      expect(schedules).toHaveLength(2);
    });

    it("gets due schedules", () => {
      const agent = service.createAgent({ name: "Test" });

      // Add schedule with past next_run_at
      const schedule = service.addSchedule({
        agent_id: agent.id,
        interval_ms: 60_000,
      });
      // Force next_run_at to past
      db.prepare("UPDATE agent_schedules SET next_run_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", schedule.id);

      const due = service.getDueSchedules();
      expect(due).toHaveLength(1);
      expect(due[0].agent_name).toBe("Test");
    });

    it("removes a schedule", () => {
      const agent = service.createAgent({ name: "Test" });
      const schedule = service.addSchedule({ agent_id: agent.id, interval_ms: 60_000 });

      expect(service.removeSchedule(schedule.id)).toBe(true);
      expect(service.listSchedules(agent.id)).toHaveLength(0);
    });

    it("updates schedule next_run_at", () => {
      const agent = service.createAgent({ name: "Test" });
      const schedule = service.addSchedule({ agent_id: agent.id, interval_ms: 60_000 });

      const newNext = "2099-12-31T23:59:59.000Z";
      const now = new Date().toISOString();
      service.updateScheduleNextRun(schedule.id, newNext, now);

      const schedules = service.listSchedules(agent.id);
      expect(schedules[0].next_run_at).toBe(newNext);
      expect(schedules[0].last_run_at).toBe(now);
    });
  });

  // ── Feedback ───────────────────────────────────

  describe("Feedback", () => {
    it("adds feedback to a run", () => {
      const agent = service.createAgent({ name: "Test" });
      const run = service.createRun({ agent_id: agent.id, goal: "test" });

      const feedback = service.addFeedback({
        agent_id: agent.id,
        run_id: run.id,
        rating: 4,
        outcome: "success",
        lesson: "Use kernel_tasks_list before creating duplicates",
      });

      expect(feedback.id).toBeTruthy();
      expect(feedback.rating).toBe(4);
      expect(feedback.outcome).toBe("success");
      expect(feedback.lesson).toContain("duplicates");
    });

    it("retrieves feedback for an agent", () => {
      const agent = service.createAgent({ name: "Test" });
      const run1 = service.createRun({ agent_id: agent.id, goal: "g1" });
      const run2 = service.createRun({ agent_id: agent.id, goal: "g2" });

      service.addFeedback({ agent_id: agent.id, run_id: run1.id, rating: 5, outcome: "success" });
      service.addFeedback({ agent_id: agent.id, run_id: run2.id, rating: 2, outcome: "failure" });

      const feedback = service.getFeedback(agent.id);
      expect(feedback).toHaveLength(2);
    });

    it("computes agent stats", () => {
      const agent = service.createAgent({ name: "Stats Agent" });
      const run1 = service.createRun({ agent_id: agent.id, goal: "g1" });
      const run2 = service.createRun({ agent_id: agent.id, goal: "g2" });
      service.updateRun(run1.id, { status: "completed", tokens_used: 100, steps_count: 5 });
      service.updateRun(run2.id, { status: "failed", tokens_used: 50, steps_count: 3, error: "timeout" });
      service.addFeedback({ agent_id: agent.id, run_id: run1.id, rating: 4 });

      const stats = service.getAgentStats(agent.id);
      expect(stats.total_runs).toBe(2);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.success_rate).toBe(50);
      expect(stats.avg_tokens).toBe(75);
      expect(stats.common_errors).toHaveLength(1);
      expect(stats.common_errors[0]).toBe("timeout");
    });
  });

  // ── Learnings ─────────────────────────────────

  describe("Learnings", () => {
    it("adds a learning", () => {
      const agent = service.createAgent({ name: "Test" });
      const learning = service.addLearning({
        agent_id: agent.id,
        type: "avoid",
        content: "Do not call kernel_tasks_create without checking for duplicates",
        confidence: 0.8,
        source_runs: ["run-1", "run-2"],
      });

      expect(learning.id).toBeTruthy();
      expect(learning.type).toBe("avoid");
      expect(learning.confidence).toBe(0.8);
      expect(JSON.parse(learning.source_runs)).toEqual(["run-1", "run-2"]);
    });

    it("retrieves active learnings sorted by confidence", () => {
      const agent = service.createAgent({ name: "Test" });
      service.addLearning({ agent_id: agent.id, type: "pattern", content: "Low conf", confidence: 0.3 });
      service.addLearning({ agent_id: agent.id, type: "prefer", content: "High conf", confidence: 0.9 });
      service.addLearning({ agent_id: agent.id, type: "insight", content: "Mid conf", confidence: 0.6 });

      const learnings = service.getLearnings(agent.id);
      expect(learnings).toHaveLength(3);
      expect(learnings[0].content).toBe("High conf");
      expect(learnings[2].content).toBe("Low conf");
    });

    it("updates confidence", () => {
      const agent = service.createAgent({ name: "Test" });
      const learning = service.addLearning({ agent_id: agent.id, type: "pattern", content: "test", confidence: 0.5 });

      service.updateLearningConfidence(learning.id, 0.2);
      const updated = service.getLearnings(agent.id);
      expect(updated[0].confidence).toBeCloseTo(0.7, 2);
    });

    it("clamps confidence to 0-1", () => {
      const agent = service.createAgent({ name: "Test" });
      const learning = service.addLearning({ agent_id: agent.id, type: "pattern", content: "test", confidence: 0.9 });

      service.updateLearningConfidence(learning.id, 0.5);
      const updated = service.getLearnings(agent.id);
      expect(updated[0].confidence).toBe(1.0);
    });

    it("deactivates a learning", () => {
      const agent = service.createAgent({ name: "Test" });
      const learning = service.addLearning({ agent_id: agent.id, type: "avoid", content: "test" });

      service.deactivateLearning(learning.id);
      const learnings = service.getLearnings(agent.id);
      expect(learnings).toHaveLength(0);
    });

    it("cascades on agent delete", () => {
      const agent = service.createAgent({ name: "Test" });
      const run = service.createRun({ agent_id: agent.id, goal: "test" });
      service.addFeedback({ agent_id: agent.id, run_id: run.id, rating: 3 });
      service.addLearning({ agent_id: agent.id, type: "insight", content: "test" });

      db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);

      expect(service.getFeedback(agent.id)).toHaveLength(0);
      expect(service.getLearnings(agent.id)).toHaveLength(0);
    });
  });

  // ── Chains ─────────────────────────────────────

  describe("Chains", () => {
    it("creates a chain between two agents", () => {
      const a1 = service.createAgent({ name: "Source" });
      const a2 = service.createAgent({ name: "Target" });

      const chain = service.addChain({
        source_agent_id: a1.id,
        target_agent_id: a2.id,
        label: "handoff",
      });

      expect(chain.id).toBeTruthy();
      expect(chain.source_agent_id).toBe(a1.id);
      expect(chain.target_agent_id).toBe(a2.id);
      expect(chain.label).toBe("handoff");
      expect(chain.pass_result).toBe(1);
      expect(chain.delay_ms).toBe(0);
      expect(chain.active).toBe(1);
    });

    it("prevents self-chain", () => {
      const a = service.createAgent({ name: "Self" });
      expect(() => service.addChain({
        source_agent_id: a.id,
        target_agent_id: a.id,
      })).toThrow("Cannot chain an agent to itself");
    });

    it("enforces unique source-target pair", () => {
      const a1 = service.createAgent({ name: "S" });
      const a2 = service.createAgent({ name: "T" });
      service.addChain({ source_agent_id: a1.id, target_agent_id: a2.id });
      expect(() => service.addChain({
        source_agent_id: a1.id,
        target_agent_id: a2.id,
      })).toThrow();
    });

    it("lists chains for an agent (both directions)", () => {
      const a1 = service.createAgent({ name: "A" });
      const a2 = service.createAgent({ name: "B" });
      const a3 = service.createAgent({ name: "C" });
      service.addChain({ source_agent_id: a1.id, target_agent_id: a2.id });
      service.addChain({ source_agent_id: a2.id, target_agent_id: a3.id });

      const chainsA2 = service.listChains(a2.id);
      expect(chainsA2).toHaveLength(2); // one in, one out
    });

    it("gets chains by source", () => {
      const a1 = service.createAgent({ name: "S" });
      const a2 = service.createAgent({ name: "T1" });
      const a3 = service.createAgent({ name: "T2" });
      service.addChain({ source_agent_id: a1.id, target_agent_id: a2.id });
      service.addChain({ source_agent_id: a1.id, target_agent_id: a3.id });

      const chains = service.getChainsBySource(a1.id);
      expect(chains).toHaveLength(2);
    });

    it("removes a chain", () => {
      const a1 = service.createAgent({ name: "S" });
      const a2 = service.createAgent({ name: "T" });
      const chain = service.addChain({ source_agent_id: a1.id, target_agent_id: a2.id });

      expect(service.removeChain(chain.id)).toBe(true);
      expect(service.listChains()).toHaveLength(0);
    });

    it("returns false for removing non-existent chain", () => {
      expect(service.removeChain("nope")).toBe(false);
    });

    it("creates chain-triggered run with event trigger_type in SQL", () => {
      const agent = service.createAgent({ name: "Test" });
      const run = service.createRun({
        agent_id: agent.id,
        trigger_type: "chain",
        trigger_payload: { source_agent_id: "src-123" },
        goal: "chained goal",
      });

      // TypeScript type preserves 'chain'
      expect(run.trigger_type).toBe("chain");
      // Payload includes chain marker
      const payload = JSON.parse(run.trigger_payload);
      expect(payload.chain).toBe(true);
      expect(payload.source_agent_id).toBe("src-123");

      // Verify it's stored in DB (should be retrievable)
      const fetched = service.getRun(run.id);
      expect(fetched).toBeTruthy();
    });

    it("cascades chain deletion when agent is deleted", () => {
      const a1 = service.createAgent({ name: "S" });
      const a2 = service.createAgent({ name: "T" });
      service.addChain({ source_agent_id: a1.id, target_agent_id: a2.id });

      db.prepare("DELETE FROM agents WHERE id = ?").run(a1.id);
      expect(service.listChains()).toHaveLength(0);
    });
  });

  // ── Graph ─────────────────────────────────────

  describe("Agent Graph", () => {
    it("returns full graph data", () => {
      const a1 = service.createAgent({ name: "A" });
      const a2 = service.createAgent({ name: "B" });
      service.addChain({ source_agent_id: a1.id, target_agent_id: a2.id, label: "test" });
      service.addEventTrigger({ agent_id: a1.id, event_name: "data.changed" });
      service.addSchedule({ agent_id: a2.id, interval_ms: 60000 });
      service.createRun({ agent_id: a1.id, goal: "test run" });

      const graph = service.getAgentGraph();
      expect(graph.agents).toHaveLength(2);
      expect(graph.chains).toHaveLength(1);
      expect(graph.triggers).toHaveLength(1);
      expect(graph.schedules).toHaveLength(1);
      expect(graph.recentRuns).toHaveLength(1);
      expect(graph.stats[a1.id].total_runs).toBe(1);
      expect(graph.stats[a2.id].total_runs).toBe(0);
    });
  });

  // ── CASCADE deletes ─────────────────────────────

  describe("CASCADE behavior", () => {
    it("deleting an agent cascades to runs, steps, triggers, and schedules", () => {
      const agent = service.createAgent({ name: "To Delete" });
      const run = service.createRun({ agent_id: agent.id, goal: "test" });
      service.addStep({ run_id: run.id, step_number: 1, type: "thought", content: "hi" });
      service.addEventTrigger({ agent_id: agent.id, event_name: "event1" });
      service.addSchedule({ agent_id: agent.id, interval_ms: 60_000 });

      // Hard delete (not soft delete) to test CASCADE
      db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);

      expect(service.listRuns({ agent_id: agent.id })).toHaveLength(0);
      expect(service.listEventTriggers(agent.id)).toHaveLength(0);
      expect(service.listSchedules(agent.id)).toHaveLength(0);
    });

    it("deleting a run cascades to its steps", () => {
      const agent = service.createAgent({ name: "Test" });
      const run = service.createRun({ agent_id: agent.id, goal: "test" });
      service.addStep({ run_id: run.id, step_number: 1, type: "thought", content: "step" });

      db.prepare("DELETE FROM agent_runs WHERE id = ?").run(run.id);

      expect(service.getSteps(run.id)).toHaveLength(0);
    });
  });
});

// ── resolveGoal ─────────────────────────────────────

describe("resolveGoal", () => {
  it("resolves simple variables", () => {
    expect(resolveGoal("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("resolves nested variables", () => {
    expect(
      resolveGoal("Event: {{event.type}} from {{event.module}}", {
        event: { type: "data.changed", module: "crm" },
      }),
    ).toBe("Event: data.changed from crm");
  });

  it("replaces missing variables with empty string", () => {
    expect(resolveGoal("Hello {{missing}}", {})).toBe("Hello ");
  });

  it("handles empty template", () => {
    expect(resolveGoal("", { name: "test" })).toBe("");
  });

  it("handles template with no variables", () => {
    expect(resolveGoal("No variables here", { name: "test" })).toBe("No variables here");
  });

  it("resolves numeric values", () => {
    expect(resolveGoal("Count: {{count}}", { count: 42 })).toBe("Count: 42");
  });
});

// ── Dashboard query ──────────────────────────────────

describe("queryAgents (dashboard)", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
  });

  afterEach(() => db.close());

  it("returns null when agents table does not exist", async () => {
    const emptyDb = new Database(":memory:");
    const { queryAgents } = await import("../src/modules/agents/dashboard-queries.js");
    expect(queryAgents(emptyDb)).toBeNull();
    emptyDb.close();
  });

  it("returns agent stats when table exists", async () => {
    const { queryAgents } = await import("../src/modules/agents/dashboard-queries.js");
    const events = new EventBus();
    const service = new AgentService(db, events);

    service.createAgent({ name: "Agent A" });
    service.createAgent({ name: "Agent B" });

    const result = queryAgents(db);
    expect(result).not.toBeNull();
    expect(result!.kpis.totalAgents).toBe(2);
    expect(result!.kpis.activeAgents).toBe(2);
  });
});
