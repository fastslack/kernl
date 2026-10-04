/** "El jefe reparte al equipo": lead → member chains labelled office:distribute. */
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

function office() {
  const flow = service.createFlow({ name: "Code Review" });
  const lead = service.createAgent({ name: "Lead", flow_id: flow.id, role: "manager" });
  const a = service.createAgent({ name: "Reviewer", flow_id: flow.id });
  const b = service.createAgent({ name: "Tester", flow_id: flow.id });
  const paused = service.createAgent({ name: "Paused", flow_id: flow.id });
  service.updateAgent(paused.id, { active: false });
  return { flow, lead, a, b, paused };
}

const fromLead = (leadId: string) => service.getChainsBySource(leadId);

/** The top-rank rank: the highest level in agent_ranks, as deleteFlow and the rail read it. */
function topRank() {
  service.createRank({ name: "Officer", level: 1 });
  return service.createRank({ name: "Chief", level: 9 });
}

function statusOf(fn: () => unknown): number {
  try {
    fn();
    return 0;
  } catch (err) {
    expect(err).toBeInstanceOf(OfficeTeamError);
    return (err as OfficeTeamError).status;
  }
}

describe("AgentService.setLeadDistributes", () => {
  it("enabling chains the lead to every member, paused ones included, skipping existing chains", () => {
    const { flow, lead, a, b, paused } = office();
    service.addChain({ source_agent_id: lead.id, target_agent_id: a.id, label: "lead → reviewer" });

    expect(service.setLeadDistributes(flow.id, true)).toEqual({ lead_id: lead.id, created: 2, removed: 0 });
    const chains = fromLead(lead.id);
    expect(chains.map((c) => c.target_agent_id).sort()).toEqual([a.id, b.id, paused.id].sort());
    expect(chains.find((c) => c.target_agent_id === b.id)!.label).toBe(DISTRIBUTE_CHAIN_LABEL);
    expect(chains.find((c) => c.target_agent_id === paused.id)!.label).toBe(DISTRIBUTE_CHAIN_LABEL);

    expect(service.setLeadDistributes(flow.id, true).created).toBe(0);
  });

  it("disabling removes only office:distribute chains", () => {
    const { flow, lead, a } = office();
    service.addChain({ source_agent_id: lead.id, target_agent_id: a.id, label: "lead → reviewer" });
    service.setLeadDistributes(flow.id, true);

    expect(service.setLeadDistributes(flow.id, false)).toEqual({ lead_id: lead.id, created: 0, removed: 2 });
    const left = fromLead(lead.id);
    expect(left).toHaveLength(1);
    expect(left[0].label).toBe("lead → reviewer");
  });

  it("the graph returns the new chains", () => {
    const { flow, lead } = office();
    service.setLeadDistributes(flow.id, true);
    const labelled = service.getAgentGraph().chains.filter((c) => c.source_agent_id === lead.id && c.label === DISTRIBUTE_CHAIN_LABEL);
    expect(labelled).toHaveLength(3);
  });

  it("no lead → 400, two leads → 409, unknown office → 404", () => {
    const empty = service.createFlow({ name: "Empty" });
    service.createAgent({ name: "Worker", flow_id: empty.id });
    expect(statusOf(() => service.setLeadDistributes(empty.id, true))).toBe(400);
    const { flow } = office();
    service.createAgent({ name: "Second lead", flow_id: flow.id, role: "manager" });
    expect(statusOf(() => service.setLeadDistributes(flow.id, true))).toBe(409);
    expect(statusOf(() => service.setLeadDistributes("nope", true))).toBe(404);
  });

  it("a paused second manager still counts: 409, and no chain is created", () => {
    const { flow, lead } = office();
    const second = service.createAgent({ name: "Second lead", flow_id: flow.id, role: "manager" });
    service.updateAgent(second.id, { active: false });
    expect(statusOf(() => service.setLeadDistributes(flow.id, true))).toBe(409);
    expect(fromLead(lead.id)).toHaveLength(0);
  });

  it("the top-rank agent in the office is neither lead nor member", () => {
    const chief = topRank();
    const { flow, lead, a, b, paused } = office();
    const top = service.createAgent({ name: "Chief", flow_id: flow.id, role: "manager", rank_id: chief.id });

    expect(service.setLeadDistributes(flow.id, true)).toEqual({ lead_id: lead.id, created: 3, removed: 0 });
    expect(fromLead(lead.id).map((c) => c.target_agent_id).sort()).toEqual([a.id, b.id, paused.id].sort());
    expect(fromLead(lead.id).some((c) => c.target_agent_id === top.id)).toBe(false);

    const hq = service.createFlow({ name: "Research" });
    service.createAgent({ name: "Chief of research", flow_id: hq.id, role: "manager", rank_id: chief.id });
    service.createAgent({ name: "Worker", flow_id: hq.id });
    expect(statusOf(() => service.setLeadDistributes(hq.id, true))).toBe(400);
  });
});

describe("PUT /api/agents/flows/:id/distribute", () => {
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

  const put = (id: string, body: unknown) =>
    fetch(`${base}/api/agents/flows/${id}/distribute`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("200 with counts", async () => {
    const { flow, lead } = office();
    const res = await put(flow.id, { enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, lead_id: lead.id, created: 3, removed: 0 });
  });

  it("400 for a non-boolean, 404 for an unknown office", async () => {
    const { flow } = office();
    expect((await put(flow.id, { enabled: "yes" })).status).toBe(400);
    expect((await put("nope", { enabled: true })).status).toBe(404);
  });
});

describe("agents.flows.set_distribute RPC", () => {
  const action = () => {
    const found = agentsRpcActions({ service }).find((a) => a.name === "agents.flows.set_distribute");
    if (!found) throw new Error("no rpc action named agents.flows.set_distribute");
    return found;
  };

  it("enables and disables", async () => {
    const { flow, lead } = office();
    expect(await action().handler({ flow_id: flow.id, enabled: true })).toEqual({ success: true, lead_id: lead.id, created: 3, removed: 0 });
    expect(await action().handler({ flow_id: flow.id, enabled: false })).toEqual({ success: true, lead_id: lead.id, created: 0, removed: 3 });
  });

  it("requires a boolean", async () => {
    const { flow } = office();
    // Same operation, and so the same message, as PUT /api/agents/flows/:id/distribute.
    await expect(action().handler({ flow_id: flow.id })).rejects.toThrow("enabled must be a boolean");
  });
});
