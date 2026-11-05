/**
 * Turn budgets learned per kind of letter.
 *
 * An agent's `max_iterations` is one number for everything it does, and it is wrong both ways: an office letter
 * that is always done in 12 turns still lets a confused run burn 200, and a big task dies at 30 halfway through
 * («Reached maximum number of turns (30)», and the office has to send it again). Office work comes as letters
 * whose subject starts with their kind (TRABAJAR, REVISAR-MR, JOB-OK, CERRAR…), so each run's real turn count is
 * recorded by agent and kind, and the next run of that kind gets:
 *   - with 20+ runs that went well: 1.5× the long ones (p95), at least FLOOR;
 *   - when runs of that kind ran out of turns lately: at least twice what they reached;
 *   - otherwise the agent's own limit.
 * Never more than CEILING. Goals that are not letters keep the agent's limit. Opt out per agent with the
 * variable `__adaptive_turns__: false`.
 */

const MIN_SAMPLES = 20;
const FLOOR = 20;
const CEILING = 400;
const HISTORY_DAYS = 30;
const HISTORY_ROWS = 200;

export interface TurnSample { turns: number; ok: boolean; maxed: boolean }

interface Db { exec(sql: string): unknown; prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } }

/** The kind of the first letter a wake goal names ("REVISAR-MR", "CERRAR"…), or null when it names none. */
export function letterKind(goal: string): string | null {
  const m = String(goal ?? "").match(/"([A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)*)(?=[\s"])/);
  return m ? m[1] : null;
}

/** The budget for a run, from the agent's own limit and its history with that kind of letter. */
export function turnBudget(base: number, history: TurnSample[]): number {
  let budget = base;
  const good = history.filter((h) => h.ok && h.turns > 0).map((h) => h.turns).sort((a, b) => a - b);
  if (good.length >= MIN_SAMPLES) {
    const p95 = good[Math.min(good.length - 1, Math.ceil(good.length * 0.95) - 1)];
    budget = Math.max(FLOOR, Math.ceil(p95 * 1.5));
  }
  const maxed = history.filter((h) => h.maxed).map((h) => h.turns);
  if (maxed.length) budget = Math.max(budget, Math.max(...maxed) * 2);
  return Math.min(CEILING, Math.max(FLOOR, budget));
}

export class TurnBudgets {
  constructor(private db: Db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_turn_samples (
      run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, turns INTEGER NOT NULL,
      ok INTEGER NOT NULL DEFAULT 0, maxed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_agent_turn_samples_kind ON agent_turn_samples (agent_id, kind, created_at)");
    // The model each run started on (model-trial.ts), added 05/11.
    try { db.exec("ALTER TABLE agent_turn_samples ADD COLUMN model TEXT NOT NULL DEFAULT ''"); } catch { /* already there */ }
  }

  /** A finished run: how many turns it took and how it ended. Runs whose goal is not a letter are not kept. */
  record(r: { runId: string; agentId: string; goal: string; turns: number; ok: boolean; maxed: boolean; model?: string }): void {
    const kind = letterKind(r.goal);
    if (!kind || !(r.turns > 0)) return;
    this.db.prepare(`INSERT OR REPLACE INTO agent_turn_samples (run_id, agent_id, kind, turns, ok, maxed, created_at, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.runId, r.agentId, kind, Math.round(r.turns), r.ok ? 1 : 0, r.maxed ? 1 : 0, new Date().toISOString(), r.model ?? "");
  }

  /** This agent's runs of one kind of letter, newest first, with the model each started on (model-trial.ts). */
  historyFor(agentId: string, kind: string): Array<{ model: string; ok: boolean; maxed: boolean }> {
    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
    return (this.db.prepare(`SELECT model, ok, maxed FROM agent_turn_samples WHERE agent_id = ? AND kind = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`)
      .all(agentId, kind, since, HISTORY_ROWS) as Array<{ model: string; ok: number; maxed: number }>)
      .map((x) => ({ model: x.model, ok: !!x.ok, maxed: !!x.maxed }));
  }

  /** The turn budget for `agentId` running `goal`, from `base` (its max_iterations). */
  budgetFor(agentId: string, goal: string, base: number): number {
    const kind = letterKind(goal);
    if (!kind) return base;
    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
    const rows = this.db.prepare(`SELECT turns, ok, maxed FROM agent_turn_samples WHERE agent_id = ? AND kind = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`)
      .all(agentId, kind, since, HISTORY_ROWS) as Array<{ turns: number; ok: number; maxed: number }>;
    if (!rows.length) return base;
    return turnBudget(base, rows.map((x) => ({ turns: x.turns, ok: !!x.ok, maxed: !!x.maxed })));
  }
}
