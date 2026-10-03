import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { InboxWaker } from "../assets/extensions/agents/agent-advanced/_module/inbox-waker.js";

let db: Database;
let service: AgentService;
let events: EventBus;
const executed: string[] = [];
const executor = {
  execute: async ({ agent }: { agent: { id: string } }) => {
    executed.push(agent.id);
    return { status: "completed", result: "", error: "", steps_count: 0, tokens_used: 0 };
  },
} as any;

/** Older than the quiet window, inside the sweep's 7-day horizon. */
const AN_HOUR_AGO = () => new Date(Date.now() - 3_600_000).toISOString();

function mkAgent(name: string, flowId: string) {
  return service.createAgent({ name, description: name, flow_id: flowId, active: true } as any);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);
  events = new EventBus();
  service = new AgentService(db as any, events);
  executed.length = 0;
});
afterEach(() => db.close());

describe("inbox sweeper", () => {
  it("sweep wakes an idle agent with unacked letters", async () => {
    const flow = service.createFlow({ name: "Ops" } as any);
    const a = mkAgent("Sender", flow.id);
    const b = mkAgent("Receiver", flow.id);
    service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "hola", body: "x" });
    // Pretend the letter is older than the quiet window.
    db.run("UPDATE agent_office_inbox SET created_at = ?", [AN_HOUR_AGO()]);
    const waker = new InboxWaker(service, executor, events, { quietMs: 60_000 });
    const woke = await waker.sweep();
    expect(woke).toBe(1);
    expect(executed).toEqual([b.id]);
    const row = db.query("SELECT wake_attempts FROM agent_office_inbox").get() as { wake_attempts: number };
    expect(row.wake_attempts).toBe(1);
  });

  it("does not wake an agent that already has a running run", async () => {
    const flow = service.createFlow({ name: "Ops" } as any);
    const a = mkAgent("Sender", flow.id);
    const b = mkAgent("Receiver", flow.id);
    service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "hola", body: "x" });
    db.run("UPDATE agent_office_inbox SET created_at = ?", [AN_HOUR_AGO()]);
    const run = service.createRun({ agent_id: b.id, trigger_type: "manual", goal: "busy" } as any);
    service.updateRun(run.id, { status: "running" } as any);
    const waker = new InboxWaker(service, executor, events, { quietMs: 60_000 });
    expect(await waker.sweep()).toBe(0);
  });

  it("archives letters after 3 wake attempts", async () => {
    const flow = service.createFlow({ name: "Ops" } as any);
    const a = mkAgent("Sender", flow.id);
    const b = mkAgent("Receiver", flow.id);
    service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "hola", body: "x" });
    db.run("UPDATE agent_office_inbox SET created_at = '2020-01-01T00:00:00.000Z', wake_attempts = 3");
    const gone = service.archiveExhaustedInbox(3);
    expect(gone.length).toBe(1);
    const row = db.query("SELECT status, read_at FROM agent_office_inbox").get() as { status: string; read_at: string | null };
    expect(row.status).toBe("archived");
    expect(row.read_at).toBeNull();
  });

  it("markInboxRead acks so the sweeper stops", async () => {
    const flow = service.createFlow({ name: "Ops" } as any);
    const a = mkAgent("Sender", flow.id);
    const b = mkAgent("Receiver", flow.id);
    const { message } = service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "hola", body: "x" });
    db.run("UPDATE agent_office_inbox SET created_at = '2020-01-01T00:00:00.000Z'");
    service.markInboxRead([message!.id]);
    expect(service.listAgentsWithUnackedInbox(new Date().toISOString())).toEqual([]);
  });

  it("does not archive a letter whose agent has a running run; archives once the run completes", async () => {
    const flow = service.createFlow({ name: "Ops" } as any);
    const a = mkAgent("Sender", flow.id);
    const b = mkAgent("Receiver", flow.id);
    service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "hola", body: "x" });
    db.run("UPDATE agent_office_inbox SET created_at = '2020-01-01T00:00:00.000Z', wake_attempts = 3");
    const run = service.createRun({ agent_id: b.id, trigger_type: "manual", goal: "processing the 3rd wake" } as any);
    service.updateRun(run.id, { status: "running" } as any);

    let gone = service.archiveExhaustedInbox(3);
    expect(gone.length).toBe(0);
    let row = db.query("SELECT status FROM agent_office_inbox").get() as { status: string };
    expect(row.status).toBe("unread");

    service.updateRun(run.id, { status: "completed" } as any);
    gone = service.archiveExhaustedInbox(3);
    expect(gone.length).toBe(1);
    row = db.query("SELECT status FROM agent_office_inbox").get() as { status: string };
    expect(row.status).toBe("archived");
  });

  it("one sweep bumps exactly the 20 letters surfaced in the wake goal, not all 25 unread", async () => {
    const flow = service.createFlow({ name: "Ops" } as any);
    const a = mkAgent("Sender", flow.id);
    const b = mkAgent("Receiver", flow.id);
    for (let i = 0; i < 25; i++) {
      service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: `letter ${i}`, body: "x" });
    }
    db.run("UPDATE agent_office_inbox SET created_at = ?", [AN_HOUR_AGO()]);
    const waker = new InboxWaker(service, executor, events, { quietMs: 60_000 });
    const woke = await waker.sweep();
    expect(woke).toBe(1);
    const bumped = db.query("SELECT COUNT(*) AS c FROM agent_office_inbox WHERE wake_attempts = 1").get() as { c: number };
    const notBumped = db.query("SELECT COUNT(*) AS c FROM agent_office_inbox WHERE wake_attempts = 0").get() as { c: number };
    expect(bumped.c).toBe(20);
    expect(notBumped.c).toBe(5);
  });

  it("sweep ignores letters older than SWEEP_MAX_AGE_DAYS and leaves them untouched", async () => {
    const flow = service.createFlow({ name: "Ops" } as any);
    const a = mkAgent("Sender", flow.id);
    const b = mkAgent("Receiver", flow.id);
    service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "stale", body: "x" });
    const stale = new Date(Date.now() - (InboxWaker.SWEEP_MAX_AGE_DAYS + 1) * 86_400_000).toISOString();
    db.run("UPDATE agent_office_inbox SET created_at = ?", [stale]);
    const waker = new InboxWaker(service, executor, events, { quietMs: 60_000 });
    expect(await waker.sweep()).toBe(0);
    expect(executed).toEqual([]);
    const row = db.query("SELECT status, wake_attempts FROM agent_office_inbox").get() as { status: string; wake_attempts: number };
    expect(row).toEqual({ status: "unread", wake_attempts: 0 });
  });

  it("a sweep wake surfaces and bumps only the recent letters, not the stale ones", async () => {
    const flow = service.createFlow({ name: "Ops" } as any);
    const a = mkAgent("Sender", flow.id);
    const b = mkAgent("Receiver", flow.id);
    const old = service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "stale", body: "x" }).message!;
    const fresh = service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "fresh", body: "x" }).message!;
    db.run("UPDATE agent_office_inbox SET created_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", old.id]);
    db.run("UPDATE agent_office_inbox SET created_at = ? WHERE id = ?", [AN_HOUR_AGO(), fresh.id]);
    const waker = new InboxWaker(service, executor, events, { quietMs: 60_000 });
    expect(await waker.sweep()).toBe(1);
    const rows = db.query("SELECT subject, wake_attempts FROM agent_office_inbox ORDER BY subject").all();
    expect(rows).toEqual([{ subject: "fresh", wake_attempts: 1 }, { subject: "stale", wake_attempts: 0 }]);
  });

  it("sweep skips agents with a builtin handler (they never run an LLM, so never ack)", async () => {
    const flow = service.createFlow({ name: "Ops" } as any);
    const a = mkAgent("Sender", flow.id);
    const b = mkAgent("Robot", flow.id);
    db.run("UPDATE agents SET builtin_handler = 'email:triage' WHERE id = ?", [b.id]);
    service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "hola", body: "x" });
    db.run("UPDATE agent_office_inbox SET created_at = ?", [AN_HOUR_AGO()]);
    const waker = new InboxWaker(service, executor, events, { quietMs: 60_000 });
    expect(await waker.sweep()).toBe(0);
    expect(executed).toEqual([]);
  });

  it("sweep skips an agent whose schedule fires within the quiet window", async () => {
    const flow = service.createFlow({ name: "Ops" } as any);
    const a = mkAgent("Sender", flow.id);
    const b = mkAgent("Receiver", flow.id);
    service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "hola", body: "x" });
    db.run("UPDATE agent_office_inbox SET created_at = ?", [AN_HOUR_AGO()]);
    const sched = service.addSchedule({ agent_id: b.id, cron_expression: "0 * * * *", goal_override: "tick" } as any);
    db.run("UPDATE agent_schedules SET active = 1, next_run_at = ? WHERE id = ?", [new Date(Date.now() + 10_000).toISOString(), sched.id]);
    const waker = new InboxWaker(service, executor, events, { quietMs: 60_000 });
    expect(await waker.sweep()).toBe(0);
    expect(executed).toEqual([]);
  });

  it("stopSweep leaves no active timer after startSweep", async () => {
    const waker = new InboxWaker(service, executor, events, { quietMs: 60_000 });
    let calls = 0;
    const originalSweep = waker.sweep.bind(waker);
    (waker as any).sweep = async () => {
      calls++;
      return originalSweep();
    };
    waker.startSweep(10);
    waker.stopSweep();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(0);
  });
});
