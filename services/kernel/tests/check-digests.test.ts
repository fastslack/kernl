import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  CHECK_PROBES,
  composeDigest,
  CHECK_DIGEST_DEFS,
} from "../src/modules/agents/builtin-checks.js";
import { createBuiltinHandlers, KERNEL_AGENT_DEFS } from "../src/modules/agents/builtin-handlers.js";
import { RETIRED_CHECK_HANDLERS } from "../src/modules/agents/builtin-checks.js";
import { seedDriverAgents } from "../src/modules/agents/seed-driver-agents.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";

// The service enforces a minimum schedule interval as a rate-limit guard.
process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = "1";

/** Records every notification instead of sending it. */
function recordingNotifier() {
  const sent: Array<{ title: string; body: string }> = [];
  return {
    sent,
    notifier: {
      async send(n: { title: string; body: string }) { sent.push(n); return true; },
    },
  };
}

function ctxFor(db: unknown, notifier: unknown) {
  return { db, notifier, config: {} } as unknown as Parameters<typeof createBuiltinHandlers>[0];
}

describe("composeDigest", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("merges the findings of every probe into a single block", () => {
    db.run(`CREATE TABLE tasks (title TEXT, status TEXT, due_date TEXT, priority TEXT)`);
    db.run(`INSERT INTO tasks VALUES ('Pagar ABL', 'todo', '2020-01-01', 'high')`);
    db.run(`CREATE TABLE subscriptions (name TEXT, status TEXT, next_billing TEXT, amount_cents INTEGER, currency TEXT)`);
    db.run(`INSERT INTO subscriptions VALUES ('Netflix', 'active', date('now','+1 day'), 1500, 'USD')`);

    const result = composeDigest(db as never, [CHECK_PROBES["overdue-tasks"], CHECK_PROBES["billing"]]);

    expect(result.hits).toBe(2);
    expect(result.text).toContain("Pagar ABL");
    expect(result.text).toContain("Netflix");
  });

  it("reports every probe's all-clear message when nothing is found", () => {
    const result = composeDigest(db as never, [CHECK_PROBES["overdue-tasks"], CHECK_PROBES["billing"]]);

    expect(result.hits).toBe(0);
    expect(result.text).toContain(CHECK_PROBES["overdue-tasks"].clear);
    expect(result.text).toContain(CHECK_PROBES["billing"].clear);
  });

  it("skips probes whose table does not exist", () => {
    // No tables created at all — every probe must degrade to all-clear.
    const result = composeDigest(db as never, Object.values(CHECK_PROBES));
    expect(result.hits).toBe(0);
  });
});

describe("digest agent handlers", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("sends exactly one notification even when several member checks fire", async () => {
    db.run(`CREATE TABLE subscriptions (name TEXT, status TEXT, next_billing TEXT, amount_cents INTEGER, currency TEXT)`);
    db.run(`INSERT INTO subscriptions VALUES ('Netflix', 'active', date('now','+1 day'), 1500, 'USD')`);
    db.run(`CREATE TABLE home_maintenance_items (name TEXT, next_due TEXT, priority TEXT)`);
    db.run(`INSERT INTO home_maintenance_items VALUES ('Limpiar caldera', '2020-01-01', 'high')`);

    const { sent, notifier } = recordingNotifier();
    const handlers = createBuiltinHandlers(ctxFor(db, notifier));
    const result = await handlers.get("digest:daily-expiry")!();

    expect(sent.length).toBe(1);
    expect(sent[0].body).toContain("Netflix");
    expect(sent[0].body).toContain("Limpiar caldera");
    expect(result).toContain("Netflix");
  });

  it("sends no notification when every member check is clear", async () => {
    const { sent, notifier } = recordingNotifier();
    const handlers = createBuiltinHandlers(ctxFor(db, notifier));
    await handlers.get("digest:daily-expiry")!();

    expect(sent.length).toBe(0);
  });

  it("registers a handler for every digest def", () => {
    const { notifier } = recordingNotifier();
    const handlers = createBuiltinHandlers(ctxFor(db, notifier));
    for (const def of CHECK_DIGEST_DEFS) {
      expect(handlers.has(def.handler)).toBe(true);
    }
  });
});

describe("proactive notification copy", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("sends the morning briefing in English", async () => {
    const { sent, notifier } = recordingNotifier();
    const handlers = createBuiltinHandlers(ctxFor(db, notifier));
    await handlers.get("proactive:morning-briefing")!();

    expect(sent.length).toBe(1);
    expect(sent[0].title).toBe("Morning Briefing");
    expect(sent[0].body).toContain("No pending tasks or reminders. Have a good day!");
  });

  it("sends the evening summary in English", async () => {
    const { sent, notifier } = recordingNotifier();
    const handlers = createBuiltinHandlers(ctxFor(db, notifier));
    await handlers.get("proactive:evening-summary")!();

    expect(sent.length).toBe(1);
    expect(sent[0].title).toBe("Evening Summary");
  });
});

describe("driver seeder retirement", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;

  function legacyAgent(handler: string, cron: string) {
    const flow = service.listFlows().find((f) => f.name === "Automations")
      ?? service.createFlow({ name: "Automations" });
    const agent = service.createAgent({ name: `Legacy ${handler}`, flow_id: flow.id, builtin_handler: handler });
    db.prepare("UPDATE agents SET builtin_handler = ? WHERE id = ?").run(handler, agent.id);
    service.addSchedule({ agent_id: agent.id, cron_expression: cron });
    return agent.id;
  }

  const activeOf = (id: string) =>
    (db.prepare("SELECT active FROM agents WHERE id = ?").get(id) as { active: number }).active;
  const scheduleActiveOf = (id: string) =>
    (db.prepare("SELECT active FROM agent_schedules WHERE agent_id = ?").get(id) as { active: number }).active;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db as never, "agents", agentsMigrations);
    service = new AgentService(db as never, new EventBus());
  });

  it("deactivates an agent whose check was folded into a digest", () => {
    const id = legacyAgent("check:billing", "0 9 * * *");

    seedDriverAgents(db as never, service as never, [], 1, RETIRED_CHECK_HANDLERS);

    expect(activeOf(id)).toBe(0);
    expect(scheduleActiveOf(id)).toBe(0);
  });

  it("clears the retired agent's office so it stops occupying a desk", () => {
    const id = legacyAgent("check:billing", "0 9 * * *");

    seedDriverAgents(db as never, service as never, [], 1, RETIRED_CHECK_HANDLERS);

    // floor-plan.ts skips agents whose flow_id doesn't resolve — no desk,
    // while the row and its run history stay queryable.
    const row = db.prepare("SELECT flow_id FROM agents WHERE id = ?").get(id) as { flow_id: string };
    expect(row.flow_id).toBe("");
  });

  it("leaves an agent whose check is still standalone untouched", () => {
    const id = legacyAgent("check:low-stock", "0 10 * * *");

    seedDriverAgents(db as never, service as never, [], 1, RETIRED_CHECK_HANDLERS);

    expect(activeOf(id)).toBe(1);
    expect(scheduleActiveOf(id)).toBe(1);
  });

  it("retires every check that a digest took over", () => {
    const digestMembers = CHECK_DIGEST_DEFS.flatMap((d) => d.members).map((k) => `check:${k}`);
    expect([...RETIRED_CHECK_HANDLERS].sort()).toEqual(digestMembers.sort());
  });
});

describe("check coverage", () => {
  it("keeps every check probe reachable — as a digest member or a standalone agent", () => {
    const inDigest = new Set(CHECK_DIGEST_DEFS.flatMap((d) => d.members));
    const standalone = new Set(
      KERNEL_AGENT_DEFS.filter((d) => d.handler.startsWith("check:")).map((d) => d.handler.slice("check:".length)),
    );

    const orphans = Object.keys(CHECK_PROBES).filter((k) => !inDigest.has(k) && !standalone.has(k));
    expect(orphans).toEqual([]);
  });

  it("never runs the same check from two agents", () => {
    const inDigest = CHECK_DIGEST_DEFS.flatMap((d) => d.members);
    const standalone = KERNEL_AGENT_DEFS
      .filter((d) => d.handler.startsWith("check:"))
      .map((d) => d.handler.slice("check:".length));

    const all = [...inDigest, ...standalone];
    expect(all.length).toBe(new Set(all).size);
  });
});
