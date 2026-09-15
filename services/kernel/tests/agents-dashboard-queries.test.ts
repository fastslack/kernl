import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { queryAgents, queryAgentsList } from "../src/modules/agents/dashboard-queries.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

// The publisher re-runs these queries every 15 seconds. agent_runs grows by a
// row per scheduled poll, and each row carries a goal embedding, so a query
// that walks the table instead of an index blocks the event loop for as long
// as the table is big: 1.5s at 106K rows on a real install.
//
// Without sqlite_stat1 the planner picks the same plan for an empty table as
// for a huge one, so the plan checked here is the plan a real install gets.

type Statement = { sql: string; params: unknown[] };

function recordStatements(db: Database): { db: SqliteDb; seen: Statement[] } {
  const seen: Statement[] = [];
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return {
            get: (...params: unknown[]) => { seen.push({ sql, params }); return stmt.get(...(params as [])); },
            all: (...params: unknown[]) => { seen.push({ sql, params }); return stmt.all(...(params as [])); },
          };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy as unknown as SqliteDb, seen };
}

const SQL_KEYWORDS = new Set(["WHERE", "GROUP", "ORDER", "LIMIT", "JOIN", "LEFT", "INNER", "ON"]);

/** Plan steps that read agent_runs and would read every row to answer. */
function fullReadsOfAgentRuns(db: Database, { sql, params }: Statement): string[] {
  const names = ["agent_runs"];
  const alias = sql.match(/\bagent_runs\s+(?:AS\s+)?([a-z]\w*)/i)?.[1];
  if (alias && !SQL_KEYWORDS.has(alias.toUpperCase())) names.push(alias);
  const touchesRuns = new RegExp(`^(SCAN|SEARCH) (${names.join("|")})\\b`);

  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as Array<{ detail: string }>)
    .map((row) => row.detail);
  // A LIMIT read in index order stops after a few rows, so it may go to the
  // table for them. Anything else has to be answered from the index alone.
  const bounded = /\bLIMIT\s+\d+/i.test(sql) && !plan.some((d) => d.includes("USE TEMP B-TREE FOR ORDER BY"));

  return plan.filter((detail) =>
    touchesRuns.test(detail) &&
    !detail.includes("COVERING INDEX") &&
    !(bounded && detail.includes("USING INDEX")),
  );
}

describe("agents dashboard channel queries", () => {
  let raw: InstanceType<typeof Database>;
  let service: AgentService;

  const insertRun = (agentId: string, createdAt: string, tokens: number, triggerType = "schedule") => {
    raw.prepare(
      `INSERT INTO agent_runs (id, agent_id, trigger_type, trigger_payload, goal, status, result, error,
         steps_count, tokens_used, started_at, completed_at, created_at, parent_run_id, parent_agent_id, depth)
       VALUES (?, ?, ?, '{}', 'poll', 'completed', '', '', 1, ?, ?, ?, ?, '', '', 0)`,
    ).run(crypto.randomUUID(), agentId, triggerType, tokens, createdAt, createdAt, createdAt);
  };

  beforeEach(() => {
    raw = new Database(":memory:");
    raw.run("PRAGMA foreign_keys = ON");
    runMigrations(raw, "agents", agentsMigrations);
    service = new AgentService(raw, new EventBus());
  });

  afterEach(() => raw.close());

  it("reads agent_runs only through indexes", () => {
    const agent = service.createAgent({ name: "Poller" });
    insertRun(agent.id, new Date().toISOString(), 0);

    const { db, seen } = recordStatements(raw);
    queryAgents(db);
    queryAgentsList(db);

    const runsStatements = seen.filter((s) => s.sql.includes("agent_runs"));
    expect(runsStatements.length).toBeGreaterThan(0);

    const offenders = runsStatements.flatMap((s) =>
      fullReadsOfAgentRuns(raw, s).map((detail) => `${detail}  <-  ${s.sql.replace(/\s+/g, " ").trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the counts the panel shows, including agents that never ran", () => {
    const busy = service.createAgent({ name: "Busy" });
    const idle = service.createAgent({ name: "Idle" });
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    insertRun(busy.id, now.toISOString(), 10);
    insertRun(busy.id, yesterday.toISOString(), 5, "manual");

    const d = queryAgents(raw)!;
    expect(d.kpis.totalRuns).toBe(2);
    expect(d.kpis.totalTokens).toBe(15);
    expect(d.kpis.runsToday).toBe(1);
    expect(d.runsByTrigger).toEqual({ schedule: 1, manual: 1 });
    expect(d.recentRuns.map((r) => r.tokens_used)).toEqual([10, 5]);

    const top = Object.fromEntries(d.topAgents.map((a) => [a.name, [a.run_count, a.total_tokens]]));
    expect(top).toEqual({ Busy: [2, 15], Idle: [0, 0] });

    const list = queryAgentsList(raw)!;
    const lastRun = Object.fromEntries(list.agents.map((a) => [a.name, a.last_run_at]));
    expect(lastRun).toEqual({ Busy: now.toISOString(), Idle: null });
  });
});
