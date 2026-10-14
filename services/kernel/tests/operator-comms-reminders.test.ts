import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { remindDue } from "../src/core/operator-comms/reminders.js";

const OPTS = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }];
const H = 3_600_000;

describe("remindDue", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let reminded: string[];
  const comms = { remind: async (id: string) => { reminded.push(id); } };

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
    reminded = [];
  });
  afterEach(() => db.close());

  const waiting = (ageH: number) => {
    const w = service.createAgent({ name: "W" });
    const { id } = service.createQuestion({ from_agent_id: w.id, question: "?", options: OPTS, for_operator: true });
    db.run("UPDATE agent_questions SET created_at = ? WHERE id = ?", [new Date(Date.now() - ageH * H).toISOString(), id]);
    return id;
  };

  it("reminds what waits on the operator for more than 24 h, once", async () => {
    const old = waiting(25);
    waiting(2);
    expect(await remindDue(service, comms)).toBe(1);
    expect(reminded).toEqual([old]);
    expect(await remindDue(service, comms)).toBe(0);
    expect(reminded).toEqual([old]);
    expect(service.getQuestion(old)!.reminded_at).not.toBeNull();
  });

  it("reminds again 24 h after the last reminder", async () => {
    const old = waiting(50);
    await remindDue(service, comms);
    expect(await remindDue(service, comms, Date.now() + 25 * H)).toBe(1);
    expect(reminded).toEqual([old, old]);
  });

  it("a reminder due at boot reaches the driver (nothing is marked without being sent)", async () => {
    // The sweep used to run during agents init, before anyone listened: the
    // question was marked reminded and the reminder went nowhere.
    const old = waiting(30);
    await remindDue(service, comms);
    expect(reminded).toEqual([old]);
  });

  it("a sweep that starts while a slow channel is still sending repeats nothing", async () => {
    const a = waiting(30); const b = waiting(26);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = { remind: async (id: string) => { reminded.push(id); await gate; } };
    const first = remindDue(service, slow);
    const second = remindDue(service, slow); // the next tick, the first still stuck on its first send
    release();
    expect(await first).toBe(2);
    expect(await second).toBe(0);
    expect(reminded.sort()).toEqual([a, b].sort());
  });

  it("a recent owed_at holds the reminder even if an old reminder exists", async () => {
    const id = waiting(72);
    service.markOwed(id, { selected_index: 1, selected_option: "B" });
    db.run("UPDATE agent_questions SET reminded_at = ?, owed_at = ? WHERE id = ?",
      [new Date(Date.now() - 48 * H).toISOString(), new Date(Date.now() - 2 * H).toISOString(), id]);
    expect(await remindDue(service, comms)).toBe(0);
  });
});
