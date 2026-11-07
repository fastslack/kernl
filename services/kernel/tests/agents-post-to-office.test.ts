import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";

// Aprobaciones hands a failed or unwanted draft to an office: the letter goes to that office's lead.
describe("AgentService.postToOffice", () => {
  let db: InstanceType<typeof Database>; let svc: AgentService;
  let flow: string; let lead: string; let worker: string; let author: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    svc = new AgentService(db, new EventBus());
    flow = svc.createFlow({ name: "Desarrollo" }).id;
    const other = svc.createFlow({ name: "Seguridad" }).id;
    worker = svc.createAgent({ name: "Resolver", flow_id: flow, role: "worker" }).id;
    lead = svc.createAgent({ name: "Vigía", flow_id: flow, role: "manager" }).id;
    author = svc.createAgent({ name: "Probador", flow_id: other }).id;
  });
  afterEach(() => db.close());

  const unread = (to: string) =>
    db.prepare("SELECT from_agent_id, subject, body, project_id FROM agent_office_inbox WHERE to_agent_id = ? AND status = 'unread'").all(to) as Array<Record<string, string | null>>;

  it("delivers to the office's lead, from the agent that prepared the item", () => {
    const r = svc.postToOffice(flow, { agent_id: author, subject: "Aprobaciones: x", body: "cuerpo", project_id: null });
    expect(r).toEqual({ ok: true, to_agent_id: lead });
    expect(unread(lead)).toEqual([{ from_agent_id: author, subject: "Aprobaciones: x", body: "cuerpo", project_id: null }]);
    expect(unread(worker)).toEqual([]);
  });

  it("an office without a lead is an error, and nothing is posted", () => {
    const solo = svc.createFlow({ name: "Sin líder" }).id;
    svc.createAgent({ name: "Solo", flow_id: solo, role: "worker" });
    const r = svc.postToOffice(solo, { agent_id: author, subject: "s", body: "b", project_id: null });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Sin líder");
    expect(db.prepare("SELECT COUNT(*) AS c FROM agent_office_inbox").get()).toEqual({ c: 0 });
  });

  it("when the author is gone or is the lead itself, another agent signs the letter", () => {
    const a = svc.postToOffice(flow, { agent_id: "missing", subject: "s", body: "b", project_id: null });
    const b = svc.postToOffice(flow, { agent_id: lead, subject: "s2", body: "b", project_id: null });
    expect(a.ok && b.ok).toBe(true);
    const got = unread(lead);
    expect(got).toHaveLength(2);
    for (const m of got) expect(m.from_agent_id).not.toBe(lead);
  });
});
