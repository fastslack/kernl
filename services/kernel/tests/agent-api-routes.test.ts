/**
 * Tests for Agent API route logic:
 *   - GET /api/agents/:id
 *   - DELETE /api/agents/:id
 *   - POST /api/agents/run (response shape)
 *
 * We test the underlying service operations that the route handlers call,
 * since KernelHttpServer is not designed for unit-test isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";

describe("Agent API route service layer", () => {
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

  // GET /api/agents/:id
  describe("getAgent (backing GET /api/agents/:id)", () => {
    it("returns the agent when found", () => {
      const created = service.createAgent({ name: "My Agent", provider: "anthropic", model: "claude-3-5-haiku-20241022" });
      const found = service.getAgent(created.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("My Agent");
      expect(found!.provider).toBe("anthropic");
    });

    it("returns undefined for unknown id", () => {
      const found = service.getAgent("nonexistent-id");
      expect(found).toBeFalsy();
    });
  });

  // DELETE /api/agents/:id
  describe("deleteAgent (backing DELETE /api/agents/:id)", () => {
    it("soft-deletes an agent (sets active=0)", () => {
      const agent = service.createAgent({ name: "To Delete" });
      const ok = service.deleteAgent(agent.id);
      expect(ok).toBe(true);

      // After delete the agent still exists but is inactive
      const after = service.getAgent(agent.id);
      expect(after).toBeDefined();
      expect(after!.active).toBe(0);
    });

    it("returns false for unknown agent id", () => {
      const ok = service.deleteAgent("does-not-exist");
      expect(ok).toBe(false);
    });

    it("deleted agent does not appear in listAgents({ active: true })", () => {
      const a = service.createAgent({ name: "Live" });
      const b = service.createAgent({ name: "Dead" });
      service.deleteAgent(b.id);

      const active = service.listAgents({ active: true });
      expect(active.map(x => x.id)).toContain(a.id);
      expect(active.map(x => x.id)).not.toContain(b.id);
    });
  });

  // listRuns (backing GET /api/agents/:id runs array)
  describe("listRuns (backing run history in GET /api/agents/:id)", () => {
    it("returns empty array for agent with no runs", () => {
      const agent = service.createAgent({ name: "No Runs" });
      const runs = service.listRuns({ agent_id: agent.id, limit: 5 });
      expect(runs).toHaveLength(0);
    });

    it("returns runs for the agent after creating them", () => {
      const agent = service.createAgent({ name: "Has Runs" });
      service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "do stuff" });
      service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "do more" });

      const runs = service.listRuns({ agent_id: agent.id, limit: 5 });
      expect(runs).toHaveLength(2);
    });

    it("respects limit", () => {
      const agent = service.createAgent({ name: "Many Runs" });
      for (let i = 0; i < 10; i++) {
        service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: `run ${i}` });
      }
      const runs = service.listRuns({ agent_id: agent.id, limit: 3 });
      expect(runs).toHaveLength(3);
    });
  });

  // POST /api/agents/run — createRun + updateRun
  describe("createRun + updateRun (backing POST /api/agents/run)", () => {
    it("creates a run with status pending and returns run_id", () => {
      const agent = service.createAgent({ name: "Runner" });
      const run = service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "test goal" });
      expect(run.id).toBeTruthy();
      expect(run.status).toBe("pending");
      expect(run.trigger_type).toBe("manual");
      expect(run.goal).toBe("test goal");
    });

    it("updates run to running state", () => {
      const agent = service.createAgent({ name: "Updater" });
      const run = service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "go" });
      service.updateRun(run.id, { status: "running", started_at: new Date().toISOString() });

      const updated = service.getRun(run.id);
      expect(updated?.status).toBe("running");
      expect(updated?.started_at).toBeTruthy();
    });

    it("marks run as completed with result", () => {
      const agent = service.createAgent({ name: "Completer" });
      const run = service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "complete" });
      service.updateRun(run.id, {
        status: "completed",
        result: "Done successfully",
        steps_count: 3,
        tokens_used: 500,
        completed_at: new Date().toISOString(),
      });

      const updated = service.getRun(run.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.result).toBe("Done successfully");
      expect(updated?.steps_count).toBe(3);
      expect(updated?.tokens_used).toBe(500);
    });

    it("marks run as failed with error", () => {
      const agent = service.createAgent({ name: "Failer" });
      const run = service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "fail" });
      service.updateRun(run.id, {
        status: "failed",
        error: "Something went wrong",
        completed_at: new Date().toISOString(),
      });

      const updated = service.getRun(run.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("Something went wrong");
    });
  });
});
