import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { agentOperations } from "../src/modules/agents/operations.js";

// The dashboard knows an agent is running from run_started with no matching
// run_completed. agents.stop cancelled the run in the database and said
// nothing, so the Stop button sat on "stopping…" and the agent kept walking
// as busy until a reload.
describe("agents.stop", () => {
  let service: AgentService;
  let events: EventBus;
  let completed: Array<{ run_id: string; status: string; agent_name: string }>;

  beforeEach(() => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
    completed = [];
    events.on("agent:flow:run_completed", (p: any) => { completed.push(p); });
  });

  const executor = (cancellable: Set<string>) => ({ cancelRun: (id: string) => cancellable.has(id) }) as any;

  it("announces each run it cancels as run_completed / cancelled", async () => {
    const agent = service.createAgent({ name: "Scout" });
    const run = service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "g" });
    service.updateRun(run.id, { status: "running" });
    const ops = agentOperations({ service, executor: executor(new Set([run.id])), events });

    const res: any = await ops["agents.stop"]({ agent_id: agent.id });

    expect(res.cancelled).toBe(1);
    expect(service.getRun(run.id)?.status).toBe("cancelled");
    expect(completed).toEqual([expect.objectContaining({ run_id: run.id, status: "cancelled", agent_name: "Scout" })]);
  });

  it("says nothing for a run it could not cancel", async () => {
    const agent = service.createAgent({ name: "Scout" });
    const run = service.createRun({ agent_id: agent.id, trigger_type: "manual", goal: "g" });
    const ops = agentOperations({ service, executor: executor(new Set()), events });
    const res: any = await ops["agents.stop"]({ run_id: run.id });
    expect(res.cancelled).toBe(0);
    expect(completed).toEqual([]);
  });
});
