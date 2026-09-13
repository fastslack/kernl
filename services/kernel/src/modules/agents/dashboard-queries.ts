import type { SqliteDb } from "../../core/db/sqlite.js";
import { tableExists, safeAll, safeGet, toRecord } from "../../core/db/query-helpers.js";

export interface DashboardAgents {
  kpis: {
    totalAgents: number;
    activeAgents: number;
    totalRuns: number;
    runsToday: number;
    completedRuns: number;
    failedRuns: number;
    totalTokens: number;
  };
  recentRuns: Array<{
    id: string;
    agent_name: string;
    trigger_type: string;
    status: string;
    steps_count: number;
    tokens_used: number;
    created_at: string;
  }>;
  runsByStatus: Record<string, number>;
  runsByTrigger: Record<string, number>;
  topAgents: Array<{
    id: string;
    name: string;
    run_count: number;
    total_tokens: number;
  }>;
  activeTriggers: number;
  activeSchedules: number;
}

export function queryAgents(db: SqliteDb): DashboardAgents | null {
  if (!tableExists(db, "agents")) return null;

  const totalAgents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as { c: number }).c;
  const activeAgents = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE active = 1").get() as { c: number }).c;
  const totalRuns = (db.prepare("SELECT COUNT(*) as c FROM agent_runs").get() as { c: number }).c;

  const today = new Date().toISOString().slice(0, 10);
  const runsToday = (db.prepare("SELECT COUNT(*) as c FROM agent_runs WHERE created_at >= ?").get(today) as { c: number }).c;
  const completedRuns = (db.prepare("SELECT COUNT(*) as c FROM agent_runs WHERE status = 'completed'").get() as { c: number }).c;
  const failedRuns = (db.prepare("SELECT COUNT(*) as c FROM agent_runs WHERE status = 'failed'").get() as { c: number }).c;
  const totalTokens = (db.prepare("SELECT COALESCE(SUM(tokens_used), 0) as c FROM agent_runs").get() as { c: number }).c;

  const recentRuns = db
    .prepare(
      `SELECT r.id, r.agent_id, a.name as agent_name, r.trigger_type, r.status,
              r.steps_count, r.tokens_used, r.created_at
       FROM agent_runs r
       JOIN agents a ON r.agent_id = a.id
       ORDER BY r.created_at DESC LIMIT 10`,
    )
    .all() as DashboardAgents["recentRuns"];

  const statusRows = db
    .prepare("SELECT status as key, COUNT(*) as count FROM agent_runs GROUP BY status")
    .all() as Array<{ key: string; count: number }>;
  const runsByStatus = toRecord(statusRows);

  const triggerRows = db
    .prepare("SELECT trigger_type as key, COUNT(*) as count FROM agent_runs GROUP BY trigger_type")
    .all() as Array<{ key: string; count: number }>;
  const runsByTrigger = toRecord(triggerRows);

  const topAgents = db
    .prepare(
      `SELECT a.id, a.name, COUNT(r.id) as run_count, COALESCE(SUM(r.tokens_used), 0) as total_tokens
       FROM agents a
       LEFT JOIN agent_runs r ON a.id = r.agent_id
       WHERE a.active = 1
       GROUP BY a.id
       ORDER BY run_count DESC LIMIT 10`,
    )
    .all() as DashboardAgents["topAgents"];

  const activeTriggers = safeGet(db, "SELECT COUNT(*) as c FROM agent_event_triggers WHERE active = 1", [], { c: 0 }).c;
  const activeSchedules = safeGet(db, "SELECT COUNT(*) as c FROM agent_schedules WHERE active = 1", [], { c: 0 }).c;

  return {
    kpis: { totalAgents, activeAgents, totalRuns, runsToday, completedRuns, failedRuns, totalTokens },
    recentRuns,
    runsByStatus,
    runsByTrigger,
    topAgents,
    activeTriggers,
    activeSchedules,
  };
}

/** Agent list for the Agents dashboard page (WS channel). */
export function queryAgentsList(db: SqliteDb): { agents: Record<string, unknown>[]; flows?: unknown[] } | null {
  if (!tableExists(db, "agents")) return null;

  const agents = db
    .prepare(
      `SELECT a.*,
              (SELECT MAX(r.created_at) FROM agent_runs r WHERE r.agent_id = a.id) as last_run_at
       FROM agents a
       ORDER BY a.created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  // Determine trigger type per agent
  const triggerMap: Record<string, string> = {};
  const triggerRows = safeAll<{ agent_id: string }>(db,
    "SELECT DISTINCT agent_id FROM agent_event_triggers WHERE active = 1",
  );
  for (const t of triggerRows) triggerMap[t.agent_id] = "event";
  const scheduleRows = safeAll<{ agent_id: string }>(db,
    "SELECT DISTINCT agent_id FROM agent_schedules WHERE active = 1",
  );
  for (const s of scheduleRows) if (!triggerMap[s.agent_id]) triggerMap[s.agent_id] = "schedule";

  // Flow metadata for categorization
  const flowMap: Record<string, string> = {};
  type FlowRow = { id: string; name: string; color: string; description: string; home_workspace_id: string; home_repo_path: string };
  const flowDetailMap: Record<string, FlowRow> = {};
  const flowRows = safeAll<FlowRow>(db,
    "SELECT id, name, color, description, home_workspace_id, home_repo_path FROM agent_flows WHERE active = 1",
  );
  for (const f of flowRows) {
    flowMap[f.id] = f.name;
    flowDetailMap[f.id] = f;
  }

  // Cron expressions for display
  const cronMap: Record<string, string> = {};
  const cronRows = safeAll<{ agent_id: string; cron_expression: string }>(db,
    "SELECT agent_id, cron_expression FROM agent_schedules WHERE active = 1 AND cron_expression <> ''",
  );
  for (const s of cronRows) cronMap[s.agent_id] = s.cron_expression;

  // Compute per-flow agent counts and last run times
  const flowAgentCount: Record<string, number> = {};
  const flowLastRun: Record<string, string | null> = {};
  for (const a of agents) {
    const fid = a.flow_id as string;
    if (fid && flowDetailMap[fid]) {
      flowAgentCount[fid] = (flowAgentCount[fid] || 0) + 1;
      const lastRun = a.last_run_at as string | null;
      if (lastRun && (!flowLastRun[fid] || lastRun > flowLastRun[fid]!)) {
        flowLastRun[fid] = lastRun;
      }
    }
  }

  return {
    agents: agents.map(a => ({
      ...a,
      enabled: a.active === 1,
      providerType: a.provider || "anthropic",
      trigger: triggerMap[a.id as string] || "manual",
      flow_name: flowMap[a.flow_id as string] || "",
      flow_color: flowDetailMap[a.flow_id as string]?.color || "",
      cron: cronMap[a.id as string] || "",
    })),
    flows: Object.values(flowDetailMap).map(f => ({
      id: f.id,
      name: f.name,
      color: f.color,
      description: f.description,
      // The agent drawer resolves an office agent's cwd from these.
      home_workspace_id: f.home_workspace_id,
      home_repo_path: f.home_repo_path,
      agent_count: flowAgentCount[f.id] || 0,
      last_run_at: flowLastRun[f.id] || null,
    })),
  };
}
