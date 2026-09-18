/** "Hacer jefe": one manager per office, set in one transaction. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { EventBus } from "../src/core/event-bus.js";
import { registerAgentRoutes } from "../src/modules/agents/api-routes.js";
import { agentsRpcActions } from "../src/modules/agents/rpc-actions.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { DISTRIBUTE_CHAIN_LABEL, OfficeTeamError } from "../src/modules/agents/office-team.js";

let db: InstanceType<typeof Database>;
let service: AgentService;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "agents", agentsMigrations);
  service = new AgentService(db, new EventBus());
});
afterEach(() => db.close());

const roleOf = (id: string) => service.getAgent(id)!.role;

/** Seed an `agent_ranks` row at the maximum level and an agent holding it —
 *  the "headquarters" Chief that Task 4's deleteFlow exclusion (and this
 *  task's setOfficeLead) both carve out of the office lead set. */
function seedTopAgent(flowId = ""): { rankId: string; agentId: string } {
  const rank = service.createRank({ name: "Chief", level: 100 });
  const agent = service.createAgent({ name: "Chief", flow_id: flowId, rank_id: rank.id });
  return { rankId: rank.id, agentId: agent.id };
}

describe("AgentService.setOfficeLead", () => {
  it("makes the agent manager and demotes every other manager of the office only", () => {
    const office = service.createFlow({ name: "Code Review" });
    const other = service.createFlow({ name: "Research" });
    const oldLead = service.createAgent({ name: "Old lead", flow_id: office.id, role: "manager" });
    const second = service.createAgent({ name: "Second", flow_id: office.id, role: "manager" });
    const reviewer = service.createAgent({ name: "Reviewer", flow_id: office.id });
    const elsewhere = service.createAgent({ name: "Curator", flow_id: other.id, role: "manager" });

    const result = service.setOfficeLead(office.id, reviewer.id);
    expect(result.lead_id).toBe(reviewer.id);
    expect([...result.demoted].sort()).toEqual([oldLead.id, second.id].sort());
    expect(roleOf(reviewer.id)).toBe("manager");
    expect(roleOf(oldLead.id)).toBe("worker");
    expect(roleOf(second.id)).toBe("worker");
    expect(roleOf(elsewhere.id)).toBe("manager");
  });

  it("is idempotent for the current lead", () => {
    const office = service.createFlow({ name: "Code Review" });
    const lead = service.createAgent({ name: "Lead", flow_id: office.id, role: "manager" });
    expect(service.setOfficeLead(office.id, lead.id)).toEqual({ lead_id: lead.id, demoted: [] });
    expect(roleOf(lead.id)).toBe("manager");
  });

  it("rejects an agent from another office (400) and an unknown or deleted office (404)", () => {
    const office = service.createFlow({ name: "Code Review" });
    const other = service.createFlow({ name: "Research" });
    const stranger = service.createAgent({ name: "Stranger", flow_id: other.id });
    try {
      service.setOfficeLead(office.id, stranger.id);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeTeamError);
      expect((err as OfficeTeamError).status).toBe(400);
    }
    service.deleteFlow(other.id);
    try {
      service.setOfficeLead(other.id, stranger.id);
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as OfficeTeamError).status).toBe(404);
    }
    expect(roleOf(stranger.id)).not.toBe("manager");
  });

  it("never demotes the headquarters agent when another agent in the same office is made lead", () => {
    const office = service.createFlow({ name: "Code Review" });
    const { agentId: chiefId } = seedTopAgent(office.id);
    // The Chief is created without an explicit role, so it defaults to "worker" —
    // what matters here is that setOfficeLead never touches its role either way.
    const reviewer = service.createAgent({ name: "Reviewer", flow_id: office.id });

    const before = roleOf(chiefId);
    const result = service.setOfficeLead(office.id, reviewer.id);

    expect(result.lead_id).toBe(reviewer.id);
    expect(result.demoted).not.toContain(chiefId);
    expect(roleOf(chiefId)).toBe(before);
  });

  it("rejects making the headquarters agent the lead of an office (400)", () => {
    const office = service.createFlow({ name: "Code Review" });
    const { agentId: chiefId } = seedTopAgent(office.id);
    try {
      service.setOfficeLead(office.id, chiefId);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeTeamError);
      expect((err as OfficeTeamError).status).toBe(400);
      expect((err as OfficeTeamError).message).toBe("the headquarters agent cannot lead an office");
    }
    expect(roleOf(chiefId)).not.toBe("manager");
  });
});

describe("AgentService.setOfficeLead hands the cadence and distribution to the new lead", () => {
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const distributeTargets = (sourceId: string) =>
    service
      .getChainsBySource(sourceId)
      .filter((c) => c.label === DISTRIBUTE_CHAIN_LABEL)
      .map((c) => c.target_agent_id)
      .sort();

  function team() {
    const office = service.createFlow({ name: "Code Review" });
    const oldLead = service.createAgent({ name: "Old lead", flow_id: office.id, role: "manager" });
    const next = service.createAgent({ name: "Reviewer", flow_id: office.id });
    const tester = service.createAgent({ name: "Tester", flow_id: office.id });
    return { office, oldLead, next, tester };
  }

  it("moves the old lead's schedule to a new lead that has none, keeping cadence and next run", () => {
    const { office, oldLead, next } = team();
    const schedule = service.addSchedule({ agent_id: oldLead.id, interval_ms: HOUR });

    service.setOfficeLead(office.id, next.id);

    expect(service.listSchedules(oldLead.id)).toHaveLength(0);
    const moved = service.listSchedules(next.id);
    expect(moved).toHaveLength(1);
    expect(moved[0].id).toBe(schedule.id);
    expect(moved[0].interval_ms).toBe(HOUR);
    expect(moved[0].next_run_at).toBe(schedule.next_run_at);
  });

  it("deletes the old lead's schedule when the new lead already has an active one", () => {
    const { office, oldLead, next } = team();
    const old = service.addSchedule({ agent_id: oldLead.id, interval_ms: HOUR });
    const own = service.addSchedule({ agent_id: next.id, interval_ms: DAY });

    service.setOfficeLead(office.id, next.id);

    expect(service.listSchedules(oldLead.id)).toHaveLength(0);
    expect(service.listSchedules(next.id).map((s) => s.id)).toEqual([own.id]);
    expect(service.listSchedules().some((s) => s.id === old.id)).toBe(false);
  });

  it("rebuilds the distribute chains from the new lead, the former lead included", () => {
    const { office, oldLead, next, tester } = team();
    service.setLeadDistributes(office.id, true);

    service.setOfficeLead(office.id, next.id);

    expect(distributeTargets(oldLead.id)).toEqual([]);
    expect(distributeTargets(next.id)).toEqual([oldLead.id, tester.id].sort());
  });

  it("creates no chains when the old lead did not distribute", () => {
    const { office, oldLead, next } = team();

    service.setOfficeLead(office.id, next.id);

    expect(service.getChainsBySource(next.id)).toHaveLength(0);
    expect(service.getChainsBySource(oldLead.id)).toHaveLength(0);
  });

  it("keeps chains without the distribute label and never duplicates an existing lead → member chain", () => {
    const { office, oldLead, next, tester } = team();
    service.addChain({ source_agent_id: oldLead.id, target_agent_id: tester.id, label: "old → tester" });
    service.addChain({ source_agent_id: next.id, target_agent_id: tester.id, label: "reviewer → tester" });
    service.setLeadDistributes(office.id, true);

    service.setOfficeLead(office.id, next.id);

    const fromOld = service.getChainsBySource(oldLead.id);
    expect(fromOld.map((c) => c.label)).toEqual(["old → tester"]);
    const fromNext = service.getChainsBySource(next.id);
    expect(fromNext).toHaveLength(2);
    expect(fromNext.find((c) => c.target_agent_id === tester.id)!.label).toBe("reviewer → tester");
    expect(fromNext.find((c) => c.target_agent_id === oldLead.id)!.label).toBe(DISTRIBUTE_CHAIN_LABEL);
  });

  it("leaves the headquarters agent's role, schedule and chains alone, and never chains to it", () => {
    const { office, oldLead, next } = team();
    const { agentId: chiefId } = seedTopAgent(office.id);
    db.prepare("UPDATE agents SET role = 'manager' WHERE id = ?").run(chiefId);
    const chiefSchedule = service.addSchedule({ agent_id: chiefId, interval_ms: DAY });
    service.addSchedule({ agent_id: oldLead.id, interval_ms: HOUR });
    service.addChain({ source_agent_id: chiefId, target_agent_id: next.id, label: DISTRIBUTE_CHAIN_LABEL });
    service.setLeadDistributes(office.id, true);

    const result = service.setOfficeLead(office.id, next.id);

    expect(result.demoted).toEqual([oldLead.id]);
    expect(roleOf(chiefId)).toBe("manager");
    expect(service.listSchedules(chiefId).map((s) => s.id)).toEqual([chiefSchedule.id]);
    expect(distributeTargets(chiefId)).toEqual([next.id]);
    expect(service.listSchedules(next.id)).toHaveLength(1);
    expect(distributeTargets(next.id)).not.toContain(chiefId);
  });
});

describe("POST /api/agents/flows/:id/lead", () => {
  let server: KernelHttpServer;
  let base: string;

  beforeEach(async () => {
    const cfg = {
      dashboard: { port: 0, bind: "127.0.0.1" },
      auth: { token: "" },
      cors: { allowedOrigins: [] },
    } as unknown as KernelConfig;
    server = new KernelHttpServer({ config: cfg });
    registerAgentRoutes(server, service, new AgentExecutor());
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await server.stop();
  });

  const post = (id: string, body: unknown) =>
    fetch(`${base}/api/agents/flows/${id}/lead`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("200 and the lead changes", async () => {
    const office = service.createFlow({ name: "Code Review" });
    const agent = service.createAgent({ name: "Reviewer", flow_id: office.id });
    const res = await post(office.id, { agent_id: agent.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, lead_id: agent.id, demoted: [] });
    expect(roleOf(agent.id)).toBe("manager");
  });

  it("400 without agent_id or for an outsider, 404 for an unknown office", async () => {
    const office = service.createFlow({ name: "Code Review" });
    const outsider = service.createAgent({ name: "Outsider" });
    expect((await post(office.id, {})).status).toBe(400);
    expect((await post(office.id, { agent_id: outsider.id })).status).toBe(400);
    expect((await post("nope", { agent_id: outsider.id })).status).toBe(404);
  });

  it("400 for the headquarters agent, with the amendment's error message", async () => {
    const office = service.createFlow({ name: "Code Review" });
    const { agentId: chiefId } = seedTopAgent(office.id);
    const res = await post(office.id, { agent_id: chiefId });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "the headquarters agent cannot lead an office" });
  });
});

describe("agents.flows.set_lead RPC", () => {
  const action = () => {
    const found = agentsRpcActions({ service }).find((a) => a.name === "agents.flows.set_lead");
    if (!found) throw new Error("no rpc action named agents.flows.set_lead");
    return found;
  };

  it("sets the lead", async () => {
    const office = service.createFlow({ name: "Code Review" });
    const agent = service.createAgent({ name: "Reviewer", flow_id: office.id });
    expect(await action().handler({ flow_id: office.id, agent_id: agent.id })).toEqual({
      success: true, lead_id: agent.id, demoted: [],
    });
  });

  it("throws for an outsider", async () => {
    const office = service.createFlow({ name: "Code Review" });
    const outsider = service.createAgent({ name: "Outsider" });
    await expect(action().handler({ flow_id: office.id, agent_id: outsider.id })).rejects.toThrow(/is not in this office/);
  });

  it("throws with the amendment's message for the headquarters agent", async () => {
    const office = service.createFlow({ name: "Code Review" });
    const { agentId: chiefId } = seedTopAgent(office.id);
    await expect(action().handler({ flow_id: office.id, agent_id: chiefId })).rejects.toThrow(
      /the headquarters agent cannot lead an office/,
    );
  });
});
