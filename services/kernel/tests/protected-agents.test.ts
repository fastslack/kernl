import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { ProtectedAgentError } from "../src/modules/agents/protected-agents.js";

// The Chief and the core system agents can never be switched off: not from
// the panel, not through the API, not by the failure breaker, not by
// removing their office.

let db: InstanceType<typeof Database>;
let service: AgentService;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);
  service = new AgentService(db as any, new EventBus());
});
afterEach(() => db.close());

function setup() {
  const office = service.createFlow({ name: "Management" } as any);
  const chiefRank = service.createRank({ name: "Chief", level: 11 });
  const workerRank = service.createRank({ name: "Specialist", level: 5 });
  const chief = service.createAgent({ name: "Chief", flow_id: office.id, active: true } as any);
  service.assignRankToAgent(chief.id, chiefRank.id);
  const factory = service.createAgent({ name: "Agent Factory", flow_id: office.id, active: true } as any);
  const monitor = service.createAgent({ name: "Agent Offline Monitor", flow_id: office.id, active: true, builtin_handler: "proactive:agent-monitor" } as any);
  const retention = service.createAgent({ name: "Data Retention", flow_id: office.id, active: true, builtin_handler: "storage:retention" } as any);
  const worker = service.createAgent({ name: "Writer", flow_id: office.id, active: true } as any);
  service.assignRankToAgent(worker.id, workerRank.id);
  return { office, chief, factory, monitor, retention, worker };
}

describe("protected agents", () => {
  it("names the four protected agents and only them", () => {
    const { chief, factory, monitor, retention, worker } = setup();
    for (const a of [chief, factory, monitor, retention]) expect(service.protectedReason(service.getAgent(a.id)!)).not.toBeNull();
    expect(service.protectedReason(service.getAgent(worker.id)!)).toBeNull();
  });

  it("refuses to deactivate them, with a 409", () => {
    const { chief, monitor } = setup();
    for (const a of [chief, monitor]) {
      let err: unknown;
      try { service.updateAgent(a.id, { active: false }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ProtectedAgentError);
      expect((err as ProtectedAgentError).status).toBe(409);
      expect(service.getAgent(a.id)!.active).toBe(1);
    }
  });

  it("still lets them be edited in every other way", () => {
    const { chief } = setup();
    expect(service.updateAgent(chief.id, { description: "runs the fleet", active: true })?.description).toBe("runs the fleet");
  });

  it("refuses to delete them", () => {
    const { factory } = setup();
    expect(() => service.deleteAgent(factory.id)).toThrow(/cannot be deactivated or deleted/);
    expect(service.getAgent(factory.id)!.active).toBe(1);
  });

  it("keeps counting their failures but never auto-pauses them", () => {
    const { chief, worker } = setup();
    for (let i = 0; i < 10; i++) {
      service.recordRunOutcome(chief.id, { ok: false, error: "boom" });
      service.recordRunOutcome(worker.id, { ok: false, error: "boom" });
    }
    expect(service.getAgent(chief.id)!.active).toBe(1);
    expect(service.getAgent(chief.id)!.consecutive_failures).toBe(10);
    expect(service.getAgent(worker.id)!.active).toBe(0);
  });

  it("keeps them active when their office is removed", () => {
    const { office, chief, factory, monitor, retention, worker } = setup();
    service.deleteFlow(office.id);
    for (const a of [chief, factory, monitor, retention]) expect(service.getAgent(a.id)!.active).toBe(1);
    expect(service.getAgent(worker.id)!.active).toBe(0);
  });

  it("leaves ordinary agents free to pause and delete", () => {
    const { worker } = setup();
    expect(service.updateAgent(worker.id, { active: false })?.active).toBe(0);
    expect(service.deleteAgent(worker.id)).toBe(true);
  });
});
