import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import { newId, isoNow } from "../../../core/helpers.js";
import type { AgentFeedback, AgentRun } from "../types.js";

/**
 * Human feedback on a run, and the per-agent statistics derived from its
 * history. Owns `agent_feedback`.
 *
 * Stats aggregate over `agent_runs` and `agent_run_steps` (owned by
 * AgentRunsService) — read-only, in SQL, never loading rows into memory.
 * Scoring a run also reinforces the learnings that were active during it,
 * which is why `AgentService` injects that call from AgentMemoryService.
 */
export class AgentFeedbackService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private getRun: (id: string) => AgentRun | undefined,
    private reinforceLearningsForRun: (
      agentId: string,
      runCreatedAt: string,
      outcome: "success" | "partial" | "failure" | "neutral",
      runId?: string,
    ) => { updated: number; deactivated: number },
  ) {}

  addFeedback(input: {
    agent_id: string;
    run_id: string;
    rating: number;
    outcome?: AgentFeedback["outcome"];
    lesson?: string;
  }): AgentFeedback {
    const now = isoNow();
    const feedback: AgentFeedback = {
      id: newId(),
      agent_id: input.agent_id,
      run_id: input.run_id,
      rating: input.rating,
      outcome: input.outcome ?? "neutral",
      lesson: input.lesson ?? "",
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_feedback (id, agent_id, run_id, rating, outcome, lesson, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        feedback.id, feedback.agent_id, feedback.run_id,
        feedback.rating, feedback.outcome, feedback.lesson, feedback.created_at,
      );

    // Reinforce or penalize learnings that were active during the run.
    // This closes the feedback loop: repeated-success learnings gain confidence,
    // learnings that guided failures get downweighted and eventually deactivated.
    const run = this.getRun(input.run_id);
    if (run) {
      this.reinforceLearningsForRun(input.agent_id, run.created_at, feedback.outcome, run.id);
    }

    this.events.emit("data.changed", { module: "agents", action: "feedback_added" });
    return feedback;
  }

  getFeedback(agentId: string, limit = 20): AgentFeedback[] {
    return this.db
      .prepare("SELECT * FROM agent_feedback WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, limit) as AgentFeedback[];
  }

  /**
   * Tools that failed in a good share of recent runs, fleet-wide: a tool
   * result flagged is_error counts once per run. Only tools that failed in at
   * least `minRuns` runs and in `minRate` of the runs that used them.
   */
  getToolFailures(opts: { tools: string[]; days?: number; minRuns?: number; minRate?: number; limit?: number }): Array<{
    tool: string;
    runs: number;
    failedRuns: number;
    lastError: string;
    lastAt: string;
  }> {
    if (opts.tools.length === 0) return [];
    const since = new Date(Date.now() - (opts.days ?? 14) * 86_400_000).toISOString();
    const failed = "json_extract(s.tool_input, '$.is_error') = 1";
    const rows = this.db
      .prepare(
        `SELECT s.tool_name AS tool,
                COUNT(DISTINCT s.run_id) AS runs,
                COUNT(DISTINCT CASE WHEN ${failed} THEN s.run_id END) AS failedRuns,
                MAX(CASE WHEN ${failed} THEN s.created_at END) AS lastAt
           FROM agent_run_steps s
          WHERE s.type = 'tool_result' AND s.created_at >= ?
            AND s.tool_name IN (${opts.tools.map(() => "?").join(",")})
          GROUP BY s.tool_name
         HAVING failedRuns >= ? AND failedRuns * 1.0 / runs >= ?
          ORDER BY failedRuns DESC, lastAt DESC
          LIMIT ?`,
      )
      .all(since, ...opts.tools, opts.minRuns ?? 2, opts.minRate ?? 0.3, opts.limit ?? 6) as Array<{
        tool: string; runs: number; failedRuns: number; lastAt: string;
      }>;
    const lastError = this.db.prepare(
      `SELECT substr(tool_output, 1, 300) AS out FROM agent_run_steps
        WHERE tool_name = ? AND type = 'tool_result' AND json_extract(tool_input, '$.is_error') = 1
        ORDER BY created_at DESC LIMIT 1`,
    );
    return rows.map((r) => ({ ...r, lastError: (lastError.get(r.tool) as { out: string } | undefined)?.out ?? "" }));
  }

  /** Tools an agent called in its recent runs. */
  getRecentToolsUsed(agentId: string, limit = 40): string[] {
    return (this.db
      .prepare(
        `SELECT s.tool_name FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
          WHERE r.agent_id = ? AND s.type = 'tool_call' AND s.tool_name <> ''
          GROUP BY s.tool_name ORDER BY MAX(s.created_at) DESC LIMIT ?`,
      )
      .all(agentId, limit) as Array<{ tool_name: string }>).map((r) => r.tool_name);
  }

  getAgentStats(agentId: string): {
    total_runs: number;
    completed: number;
    failed: number;
    avg_rating: number | null;
    avg_tokens: number;
    avg_steps: number;
    success_rate: number;
    top_tools: Array<{ tool: string; count: number }>;
    common_errors: string[];
  } {
    // Aggregate in SQL — loading every run row into memory grew unbounded with
    // an agent's history (called on every invocation).
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                COALESCE(SUM(tokens_used), 0) AS sum_tokens,
                COALESCE(SUM(steps_count), 0) AS sum_steps
         FROM agent_runs WHERE agent_id = ?`,
      )
      .get(agentId) as { total: number; completed: number; failed: number; sum_tokens: number; sum_steps: number };

    const completed = agg.completed ?? 0;
    const failed = agg.failed ?? 0;
    const total = agg.total ?? 0;

    const avgRatingRow = this.db
      .prepare("SELECT AVG(rating) as avg FROM agent_feedback WHERE agent_id = ?")
      .get(agentId) as { avg: number | null } | undefined;

    const avgTokens = total > 0 ? agg.sum_tokens / total : 0;
    const avgSteps = total > 0 ? agg.sum_steps / total : 0;

    // Top tools used across all runs
    const toolRows = this.db
      .prepare(
        `SELECT s.tool_name, COUNT(*) as cnt
         FROM agent_run_steps s
         JOIN agent_runs r ON s.run_id = r.id
         WHERE r.agent_id = ? AND s.type = 'tool_call' AND s.tool_name <> ''
         GROUP BY s.tool_name ORDER BY cnt DESC LIMIT 10`,
      )
      .all(agentId) as Array<{ tool_name: string; cnt: number }>;

    // Common errors from failed runs
    const errorRows = this.db
      .prepare(
        `SELECT error FROM agent_runs WHERE agent_id = ? AND status = 'failed' AND error <> ''
         ORDER BY created_at DESC LIMIT 5`,
      )
      .all(agentId) as Array<{ error: string }>;

    return {
      total_runs: total,
      completed,
      failed,
      avg_rating: avgRatingRow?.avg ?? null,
      avg_tokens: Math.round(avgTokens),
      avg_steps: Math.round(avgSteps * 10) / 10,
      success_rate: total > 0 ? Math.round((completed / total) * 100) : 0,
      top_tools: toolRows.map(r => ({ tool: r.tool_name, count: r.cnt })),
      common_errors: errorRows.map(r => r.error.slice(0, 200)),
    };
  }
}
