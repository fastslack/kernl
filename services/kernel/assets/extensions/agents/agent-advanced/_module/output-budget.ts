/**
 * A Bash output ceiling learned per agent.
 *
 * Every tool output stays in a Claude Code run's context for every later turn, so the long tail of huge outputs
 * (a whole diff, a full log) is paid again and again. The CLI cuts Bash output at 30 000 characters; most of an
 * office agent's outputs are far smaller (in the Acme office: half under 1 400, nine in ten under 7 500). From
 * the agent's own recent Bash outputs (kept in agent_run_steps), its ceiling becomes its usual long output (p90),
 * rounded up to the thousand, never under FLOOR; the CLI cuts anything longer in the middle and the agent can
 * always narrow the command. Applied through the CLI's BASH_MAX_OUTPUT_LENGTH unless the agent sets it itself.
 * Opt out per agent with the variable `__output_cap__: false`.
 */

const MIN_SAMPLES = 50;
const FLOOR = 8000;
const CLI_DEFAULT = 30000;
const HISTORY_DAYS = 7;
const HISTORY_ROWS = 2000;
const CACHE_MS = 3_600_000;

interface Db { prepare(sql: string): { all(...a: unknown[]): unknown[] } }

/** The ceiling for these output sizes, or null to leave the CLI's default. */
export function outputCap(sizes: number[]): number | null {
  if (sizes.length < MIN_SAMPLES) return null;
  const s = [...sizes].sort((a, b) => a - b);
  const p90 = s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
  const cap = Math.max(FLOOR, Math.ceil(p90 / 1000) * 1000);
  return cap >= CLI_DEFAULT ? null : cap;
}

export class OutputBudgets {
  private cache = new Map<string, { at: number; cap: number | null }>();
  constructor(private db: Db) {}

  /** The Bash output ceiling for an agent's next run, or null. */
  capFor(agentId: string): number | null {
    const hit = this.cache.get(agentId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.cap;
    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
    const rows = this.db.prepare(`SELECT length(COALESCE(s.tool_output, '')) AS n FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
      WHERE r.agent_id = ? AND s.type = 'tool_result' AND s.tool_name = 'Bash' AND s.created_at >= ? ORDER BY s.created_at DESC LIMIT ?`)
      .all(agentId, since, HISTORY_ROWS) as Array<{ n: number }>;
    const cap = outputCap(rows.map((r) => r.n));
    this.cache.set(agentId, { at: Date.now(), cap });
    return cap;
  }
}
