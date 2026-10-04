import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { parseLotId } from "../assets/extensions/_shared/office-lots.js";
import { registerExtensionFlowKinds } from "../src/modules/agents/types.js";

function setup() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "agents", agentsMigrations);
  const service = new AgentService(db, new EventBus());
  return { db, service };
}

const lotOf = (db: Database, flowId: string) =>
  (db.prepare("SELECT lot_id FROM agent_flows WHERE id = ?").get(flowId) as { lot_id: string }).lot_id;

describe("office lot assignment", () => {
  let db: Database;
  let service: AgentService;
  beforeEach(() => ({ db, service } = setup()));

  it("gives an empty office no lot", () => {
    const flow = service.createFlow({ name: "Empty" });
    service.syncLots();
    expect(lotOf(db, flow.id)).toBe("");
  });

  it("gives an off-grid office no lot: an extension draws it in its own building", () => {
    registerExtensionFlowKinds([{ id: "test-yard", offGrid: true }]);
    const flow = service.createFlow({ name: "Yard", kind: "test-yard" });
    for (let i = 0; i < 6; i++) service.createAgent({ name: `W${i}`, flow_id: flow.id });
    service.syncLots();
    expect(lotOf(db, flow.id)).toBe("");
  });

  it("frees the lot of an office that becomes off-grid", () => {
    registerExtensionFlowKinds([{ id: "test-yard", offGrid: true }]);
    const flow = service.createFlow({ name: "Stock" });
    service.createAgent({ name: "S", flow_id: flow.id });
    service.syncLots();
    expect(parseLotId(lotOf(db, flow.id))).not.toBeNull();
    service.updateFlow(flow.id, { kind: "test-yard" });
    service.syncLots();
    expect(lotOf(db, flow.id)).toBe("");
  });

  it("refuses a kind no core list or extension declares", () => {
    expect(() => service.createFlow({ name: "X", kind: "nope-kind" })).toThrow(/Invalid office kind/);
  });

  it("gives an office a lot that fits once it has agents", () => {
    const flow = service.createFlow({ name: "Team" });
    for (let i = 0; i < 7; i++) service.createAgent({ name: `A${i}`, flow_id: flow.id });
    service.syncLots();
    const lot = parseLotId(lotOf(db, flow.id));
    expect(lot).not.toBeNull();
    expect(lot!.capacity).toBeGreaterThanOrEqual(7);
  });

  it("never gives two offices the same lot", () => {
    const ids = [];
    for (let f = 0; f < 10; f++) {
      const flow = service.createFlow({ name: `F${f}` });
      service.createAgent({ name: `A${f}`, flow_id: flow.id });
      service.syncLots();
      ids.push(lotOf(db, flow.id));
    }
    expect(new Set(ids).size).toBe(10);
  });

  it("keeps an old office on its lot when it outgrows it", () => {
    const flow = service.createFlow({ name: "Grows" });
    service.createAgent({ name: "A0", flow_id: flow.id });
    service.syncLots();
    const before = lotOf(db, flow.id);
    db.prepare("UPDATE agent_flows SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", flow.id);
    for (let i = 1; i < 14; i++) service.createAgent({ name: `A${i}`, flow_id: flow.id });
    service.syncLots();
    expect(lotOf(db, flow.id)).toBe(before);
  });

  it("moves an office still being set up to a lot that fits", () => {
    const flow = service.createFlow({ name: "Fresh" });
    service.createAgent({ name: "A0", flow_id: flow.id });
    service.syncLots();
    for (let i = 1; i < 14; i++) service.createAgent({ name: `A${i}`, flow_id: flow.id });
    service.syncLots();
    expect(parseLotId(lotOf(db, flow.id))!.capacity).toBeGreaterThanOrEqual(14);
  });

  it("never moves an office another office is next to", () => {
    const a = service.createFlow({ name: "A" });
    service.createAgent({ name: "a", flow_id: a.id });
    service.syncLots();
    const lotA = lotOf(db, a.id);
    for (let f = 0; f < 6; f++) {
      const flow = service.createFlow({ name: `F${f}` });
      for (let i = 0; i < 5; i++) service.createAgent({ name: `F${f}-${i}`, flow_id: flow.id });
      service.syncLots();
    }
    expect(lotOf(db, a.id)).toBe(lotA);
  });

  it("frees the lot when the office is deleted", () => {
    const flow = service.createFlow({ name: "Gone" });
    service.createAgent({ name: "A0", flow_id: flow.id });
    service.syncLots();
    const lot = lotOf(db, flow.id);
    service.deleteFlow(flow.id);
    expect(lotOf(db, flow.id)).toBe("");
    const next = service.createFlow({ name: "Next" });
    service.createAgent({ name: "B0", flow_id: next.id });
    service.syncLots();
    expect(lotOf(db, next.id)).toBe(lot);
  });

  it("assigns lots on its own when agents change", () => {
    const flow = service.createFlow({ name: "Auto" });
    service.createAgent({ name: "A0", flow_id: flow.id });
    expect(lotOf(db, flow.id)).not.toBe("");
  });

  it("backfills existing offices biggest first", () => {
    const small = service.createFlow({ name: "Small" });
    const big = service.createFlow({ name: "Big" });
    db.prepare("UPDATE agent_flows SET created_at = ?").run("2020-01-01T00:00:00.000Z");
    // Insert agents without triggering the listener, as rows that predate lots.
    const now = new Date().toISOString();
    const ins = db.prepare(
      "INSERT INTO agents (id, name, flow_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    ins.run("s1", "s1", small.id, now, now);
    for (let i = 0; i < 9; i++) ins.run(`b${i}`, `b${i}`, big.id, now, now);
    service.syncLots();
    const lotBig = parseLotId(lotOf(db, big.id))!;
    const lotSmall = parseLotId(lotOf(db, small.id))!;
    expect(lotBig.col ** 2 + lotBig.row ** 2).toBeLessThanOrEqual(lotSmall.col ** 2 + lotSmall.row ** 2);
  });
});

describe("office lot chosen by the operator", () => {
  let db: Database;
  let service: AgentService;
  beforeEach(() => ({ db, service } = setup()));

  it("builds the office on the lot that was clicked", () => {
    const flow = service.createFlow({ name: "Here", lot_id: "2,2" });
    for (let i = 0; i < 3; i++) service.createAgent({ name: `A${i}`, flow_id: flow.id });
    expect(lotOf(db, flow.id)).toBe("2,2");
  });

  it("ignores a lot another office already stands on", () => {
    const a = service.createFlow({ name: "First", lot_id: "2,2" });
    service.createAgent({ name: "a", flow_id: a.id });
    const b = service.createFlow({ name: "Second", lot_id: "2,2" });
    service.createAgent({ name: "b", flow_id: b.id });
    expect(lotOf(db, b.id)).not.toBe("2,2");
    expect(lotOf(db, b.id)).not.toBe("");
  });

  it("ignores a cell that is not a lot", () => {
    const flow = service.createFlow({ name: "Core", lot_id: "0,0" });
    expect(lotOf(db, flow.id)).toBe("");
  });

  it("moves a team that does not fit the clicked lot", () => {
    const flow = service.createFlow({ name: "Big", lot_id: "-2,0" });
    for (let i = 0; i < 12; i++) service.createAgent({ name: `B${i}`, flow_id: flow.id });
    expect(parseLotId(lotOf(db, flow.id))!.capacity).toBeGreaterThanOrEqual(12);
  });
});
