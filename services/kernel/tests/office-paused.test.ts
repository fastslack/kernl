/** Office on/off switch: agent_flows.paused stops every run of its members. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { agentsRpcActions } from "../src/modules/agents/rpc-actions.js";

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
  const flow = service.createFlow({ name: "Ventas" });
  const member = service.createAgent({ name: "Closer", flow_id: flow.id });
  return { flow, member };
}

const action = () => {
  const found = agentsRpcActions({ service }).find((a) => a.name === "agents.flows.set_paused");
  if (!found) throw new Error("no rpc action named agents.flows.set_paused");
  return found;
};

describe("office pause", () => {
  it("new offices start switched on", () => {
    const { flow } = office();
    expect(service.getFlow(flow.id)?.paused).toBe(0);
    expect(service.isFlowPaused(flow.id)).toBe(false);
  });

  it("createRun refuses members of a paused office and accepts them again on resume", () => {
    const { flow, member } = office();
    service.setFlowPaused(flow.id, true);
    expect(() => service.createRun({ agent_id: member.id, goal: "sell" })).toThrow(/paused office/);

    service.setFlowPaused(flow.id, false);
    expect(service.createRun({ agent_id: member.id, goal: "sell" }).agent_id).toBe(member.id);
  });

  it("never stops the top agent, who sits in an office but is shown as headquarters", () => {
    const { flow, member } = office();
    const chief = service.createAgent({ name: "Chief", flow_id: flow.id });
    const lead = service.createRank({ name: "Lead", level: 1 });
    const top = service.createRank({ name: "Chief", level: 9 });
    service.assignRankToAgent(member.id, lead.id);
    service.assignRankToAgent(chief.id, top.id);
    service.setFlowPaused(flow.id, true);

    expect(service.isAgentOfficePaused(chief.id)).toBe(false);
    expect(service.createRun({ agent_id: chief.id, goal: "fix it" }).agent_id).toBe(chief.id);
    expect(service.isAgentOfficePaused(member.id)).toBe(true);
    expect(() => service.createRun({ agent_id: member.id, goal: "sell" })).toThrow(/paused office/);
  });

  it("lets a run spawned by one still in flight through, and nothing else", () => {
    const { flow, member } = office();
    const helper = service.createAgent({ name: "Helper", flow_id: flow.id });
    const parent = service.createRun({ agent_id: member.id, goal: "sell" });
    service.updateRun(parent.id, { status: "running" });
    service.setFlowPaused(flow.id, true);

    const child = service.createRun({ agent_id: helper.id, goal: "quote", parent_run_id: parent.id, parent_agent_id: member.id, depth: 1 });
    expect(child.agent_id).toBe(helper.id);

    service.updateRun(parent.id, { status: "completed" });
    expect(() =>
      service.createRun({ agent_id: helper.id, goal: "again", parent_run_id: parent.id, parent_agent_id: member.id, depth: 1 }),
    ).toThrow(/paused office/);
  });

  it("leaves the member rows untouched", () => {
    const { flow, member } = office();
    service.setFlowPaused(flow.id, true);
    expect(service.getAgent(member.id)?.active).toBeTruthy();
    expect(service.getAgent(member.id)?.flow_id).toBe(flow.id);
  });

  it("agents without an office are never paused", () => {
    const loner = service.createAgent({ name: "Loner" });
    expect(service.isFlowPaused("")).toBe(false);
    expect(service.createRun({ agent_id: loner.id, goal: "x" }).agent_id).toBe(loner.id);
  });

  it("RPC toggles the switch and validates input", async () => {
    const { flow } = office();
    const out = (await action().handler({ flow_id: flow.id, paused: true })) as { success: boolean; flow: { paused: number } };
    expect(out.success).toBe(true);
    expect(out.flow.paused).toBe(1);
    await expect(Promise.resolve().then(() => action().handler({ flow_id: flow.id, paused: "yes" }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => action().handler({ flow_id: "nope", paused: true }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => action().handler({ flow_id: flow.id, paused: true, cut_now: "yes" }))).rejects.toThrow();
  });

  it("switching off is graceful by default: running runs are left to finish", async () => {
    const { flow, member } = office();
    const run = service.createRun({ agent_id: member.id, goal: "sell" });
    service.updateRun(run.id, { status: "running" });
    const out = (await action().handler({ flow_id: flow.id, paused: true })) as { cancelled: number };
    expect(out.cancelled).toBe(0);
    expect(service.getRun(run.id)?.status).toBe("running");
  });

  it("a deleted office can't be paused", () => {
    const { flow } = office();
    service.deleteFlow(flow.id);
    expect(service.setFlowPaused(flow.id, true)).toBeUndefined();
  });
});
