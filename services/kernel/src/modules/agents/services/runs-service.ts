import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import { newId, isoNow } from "../../../core/helpers.js";
import { log } from "../../../core/logger.js";
import { buildPatch, type PatchColumn } from "../../../sdk/query-helpers.js";
import type { Agent, AgentRun, AgentStep, RunCondition } from "../types.js";
import type { ProjectGateLike } from "../advanced-types.js";

/** Terminal statuses: a run in one of these no longer needs its checkpoint. */
const FINISHED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export interface StoredCheckpoint {
  data: string;
  resumes: number;
  saved_at: string;
}

/** Schedules the background embed of a row's text. Supplied by AgentMemoryService. */
type ScheduleEmbed = (
  table: "agent_memory" | "agent_learnings" | "agent_runs",
  column: "embedding" | "goal_embedding",
  modelColumn: "embedding_model" | "goal_embedding_model",
  rowId: string,
  text: string,
) => void;

/** The agent_runs columns updateRun may write (all stored as given). */
const RUN_PATCH: Record<string, PatchColumn> = {
  status: "text",
  result: "text",
  error: "text",
  steps_count: "text",
  tokens_used: "text",
  started_at: "text",
  completed_at: "text",
};

/**
 * Agent runs and the steps inside them, including the guards that stop a
 * runaway loop before it starts. Owns `agent_runs` and `agent_run_steps`.
 *
 * Two deliberate reaches outside those tables:
 *   - `getRunEvents` reads `agent_event_log` (owned by AgentEventLogService).
 *   - `cleanupStaleRuns` closes `agent_conversations` left open by meetings
 *     that died with the process — see the comment there.
 *
 * `AgentService` delegates to it.
 */
export class AgentRunsService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
    private getAgent: (id: string) => Agent | undefined,
    private scheduleEmbed: ScheduleEmbed,
    private getProjectGate: () => ProjectGateLike | null = () => null,
  ) {}

  createRun(input: {
    agent_id: string;
    trigger_type?: "manual" | "event" | "schedule" | "chain";
    trigger_payload?: Record<string, unknown>;
    goal: string;
    /** Run that spawned this one (chain/invoke). Empty string for top-level. */
    parent_run_id?: string;
    /** Agent that spawned this one. Empty string for top-level. */
    parent_agent_id?: string;
    /** 0 for top-level, parent.depth + 1 otherwise. */
    depth?: number;
    /** Project this run works for. undefined → inherit from parent_run_id; null → none. */
    project_id?: string | null;
  }): AgentRun {
    const now = isoNow();

    // ── Defense-in-depth gates ───────────────────────────
    // 1. Refuse to create runs for inactive agents. The handler in tools.ts
    //    already checks `agent.active`, but the agent could be deactivated
    //    between that check and here, OR another path could call createRun
    //    directly without the check (e.g. extension-facade, chain-runner).
    const agentRow = this.db
      .prepare("SELECT active, builtin_handler FROM agents WHERE id = ?")
      .get(input.agent_id) as { active: number; builtin_handler: string | null } | undefined;
    if (!agentRow) {
      throw new Error(`createRun: agent ${input.agent_id} not found`);
    }
    if (agentRow.active === 0) {
      throw new Error(`createRun: agent ${input.agent_id} is inactive (active=0)`);
    }

    // 2. Self-invocation guard. If a parent context is supplied and the parent
    //    agent_id matches the target, refuse — this is the classic runaway-loop
    //    failure mode: an agent invoking `kernel_agents_run(self)` ad infinitum.
    //    Top-level runs (no parent) bypass this check.
    const parentAgentId = (input.parent_agent_id ?? "").trim();
    const parentRunId = (input.parent_run_id ?? "").trim();
    if (parentAgentId && parentAgentId === input.agent_id) {
      throw new Error(
        `createRun: agent ${input.agent_id} cannot invoke itself (self-recursion). ` +
        `Parent run was ${parentRunId || "(unknown)"}.`,
      );
    }

    // 3. Recursion depth cap. Even without direct self-invocation a chain
    //    A→B→A→B→... can spiral. Hard ceiling ends the descent.
    const depth = Math.max(0, Number(input.depth ?? 0));
    const maxDepth = Math.max(1, Number(process.env.KERNEL_AGENT_MAX_DEPTH ?? 5));
    if (depth > maxDepth) {
      throw new Error(
        `createRun: agent ${input.agent_id} depth=${depth} exceeds KERNEL_AGENT_MAX_DEPTH=${maxDepth}. ` +
        `Parent chain rooted at run ${parentRunId || "(unknown)"}.`,
      );
    }

    // 4. Per-agent runaway guard. Count CONCURRENT in-flight runs, not the
    //    rolling-60s total — high-frequency legit agents (Email Triage,
    //    Trading Auto-Execute) can complete dozens of fast runs per minute
    //    without that being a loop. A loop, by contrast, leaves runs piling
    //    up in pending/running because the executor can't keep pace.
    //    Tunable via env so a legit burst can crank it.
    const maxConcurrent = Math.max(1, Number(process.env.KERNEL_AGENT_MAX_CONCURRENT ?? 25));
    const concurrent = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM agent_runs WHERE agent_id = ? AND status IN ('pending', 'running')",
      )
      .get(input.agent_id) as { c: number };
    if (concurrent.c >= maxConcurrent) {
      throw new Error(
        `createRun: agent ${input.agent_id} runaway guard tripped — ${concurrent.c} concurrent in-flight runs (max ${maxConcurrent}). ` +
        `Likely a self-invocation loop or a stuck executor. Raise KERNEL_AGENT_MAX_CONCURRENT to lift.`,
      );
    }

    // 5. Project. Inherit from the parent run when not given, then require
    //    the agent's office to serve that project. No silent fallback.
    let projectId: string | null = input.project_id ?? null;
    if (input.project_id === undefined && parentRunId) {
      const parent = this.db.prepare("SELECT project_id FROM agent_runs WHERE id = ?").get(parentRunId) as
        { project_id: string | null } | undefined;
      projectId = parent?.project_id ?? null;
    }
    if (projectId) {
      const gate = this.getProjectGate();
      if (!gate) throw new Error(`createRun: project ${projectId} requested but the projects module is not available`);
      const agent = this.getAgent(input.agent_id);
      const verdict = gate.check(agent?.flow_id ?? "", projectId);
      if (!verdict.ok) throw new Error(`createRun: ${verdict.error}`);
    }

    // For chain-triggered runs, enrich payload with chain metadata and use
    // 'event' as the SQL trigger_type (CHECK constraint compatibility).
    // The TypeScript type preserves 'chain' for application-level logic.
    const isChain = input.trigger_type === "chain";
    const sqlTriggerType = isChain ? "event" : (input.trigger_type ?? "manual");
    const payload = isChain
      ? { chain: true, ...(input.trigger_payload ?? {}) }
      : (input.trigger_payload ?? {});

    const run: AgentRun = {
      id: newId(),
      agent_id: input.agent_id,
      trigger_type: input.trigger_type ?? "manual",
      trigger_payload: JSON.stringify(payload),
      goal: input.goal,
      status: "pending",
      result: "",
      error: "",
      steps_count: 0,
      tokens_used: 0,
      started_at: null,
      completed_at: null,
      created_at: now,
      parent_run_id: parentRunId,
      parent_agent_id: parentAgentId,
      depth,
      conditions: "[]",
      project_id: projectId,
    };

    this.db
      .prepare(
        `INSERT INTO agent_runs (id, agent_id, trigger_type, trigger_payload, goal,
         status, result, error, steps_count, tokens_used, started_at, completed_at, created_at,
         parent_run_id, parent_agent_id, depth, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id, run.agent_id, sqlTriggerType, run.trigger_payload,
        run.goal, run.status, run.result, run.error, run.steps_count,
        run.tokens_used, run.started_at, run.completed_at, run.created_at,
        run.parent_run_id, run.parent_agent_id, run.depth, run.project_id,
      );

    // Builtin agents never reach the LLM executor, so nothing ever ranks their
    // runs by similarity — and their goal is the same fixed string every poll.
    // Embedding them stored one identical 6 KB vector per run (hundreds of MB).
    const isBuiltin = !!agentRow.builtin_handler;
    if (!isBuiltin && run.goal && run.goal.length >= 5) {
      this.scheduleEmbed("agent_runs", "goal_embedding", "goal_embedding_model", run.id, run.goal);
    }
    return run;
  }

  getRun(id: string): AgentRun | undefined {
    return this.db
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(id) as AgentRun | undefined;
  }

  listRuns(filters?: {
    agent_id?: string;
    status?: string;
    limit?: number;
  }): AgentRun[] {
    let sql = "SELECT * FROM agent_runs WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.agent_id) {
      sql += " AND agent_id = ?";
      params.push(filters.agent_id);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }

    sql += " ORDER BY created_at DESC";

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.db.prepare(sql).all(...params) as AgentRun[];
  }

  updateRun(
    id: string,
    updates: Partial<{
      status: AgentRun["status"];
      result: string;
      error: string;
      steps_count: number;
      tokens_used: number;
      started_at: string;
      completed_at: string;
    }>,
  ): void {
    const { sets, params } = buildPatch(updates, RUN_PATCH);

    if (sets.length === 0) return;
    params.push(id);

    this.db.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    if (updates.status && FINISHED.has(updates.status)) this.deleteCheckpoint(id);
  }

  // ── Checkpoints ─────────────────────────────────────

  /** Overwrite the run's checkpoint. Keeps the resume counter. */
  saveCheckpoint(runId: string, data: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_run_checkpoints (run_id, data, resumes, saved_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(run_id) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at`,
      )
      .run(runId, data, isoNow());
  }

  getCheckpoint(runId: string): StoredCheckpoint | undefined {
    return (this.db
      .prepare("SELECT data, resumes, saved_at FROM agent_run_checkpoints WHERE run_id = ?")
      .get(runId) as StoredCheckpoint | null | undefined) ?? undefined;
  }

  /** Put a failed/interrupted run back in flight for a resume. */
  reopenRun(runId: string): void {
    this.db
      .prepare("UPDATE agent_runs SET status = 'running', error = '', completed_at = NULL WHERE id = ?")
      .run(runId);
  }

  /** Count a resume attempt, so a run that keeps crashing the kernel stops being retried. */
  markCheckpointResumed(runId: string): void {
    this.db.prepare("UPDATE agent_run_checkpoints SET resumes = resumes + 1 WHERE run_id = ?").run(runId);
  }

  deleteCheckpoint(runId: string): void {
    this.db.prepare("DELETE FROM agent_run_checkpoints WHERE run_id = ?").run(runId);
  }

  // ── Conditions ──────────────────────────────────────

  getRunConditions(runId: string): RunCondition[] {
    const row = this.db.prepare("SELECT conditions FROM agent_runs WHERE id = ?").get(runId) as
      | { conditions: string }
      | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.conditions);
      return Array.isArray(parsed) ? (parsed as RunCondition[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Upsert a condition by type. `last_transition_time` moves only when the
   * status flips, so it answers "since when", not "when did we last look".
   */
  setRunCondition(runId: string, input: Omit<RunCondition, "last_transition_time">): void {
    const conditions = this.getRunConditions(runId);
    const existing = conditions.find((c) => c.type === input.type);
    const now = isoNow();
    if (existing) {
      if (existing.status !== input.status) existing.last_transition_time = now;
      existing.status = input.status;
      existing.reason = input.reason;
      existing.message = input.message;
    } else {
      conditions.push({ ...input, last_transition_time: now });
    }
    this.db.prepare("UPDATE agent_runs SET conditions = ? WHERE id = ?").run(JSON.stringify(conditions), runId);
    this.events.emit("agent:run:condition", { run_id: runId, ...input });
  }

  cancelRun(id: string): boolean {
    const run = this.getRun(id);
    if (!run || run.status === "completed" || run.status === "failed") return false;

    this.updateRun(id, { status: "cancelled", completed_at: isoNow() });
    this.events.emit("data.changed", { module: "agents", action: "run_cancelled" });
    return true;
  }

  /** Mark stale "running"/"pending" runs as failed (e.g. after crash/restart) */
  cleanupStaleRuns(): number {
    return this.recoverStaleRuns({ resumeWithinMs: 0, maxResumes: 0 }).failed;
  }

  /**
   * Startup pass over the runs the last process left in flight.
   *
   * A run with a fresh checkpoint stays `running` and comes back in `resume`
   * for the caller to continue once the executor is wired. Everything else is
   * failed, as before — but a run whose checkpoint is merely too old, or that
   * already used its automatic retries, keeps that checkpoint and says so in
   * its error, so `kernel_agents_resume` can still pick it up by hand.
   *
   * The retry cap is what keeps a run that crashes the kernel from crashing
   * it again on every boot.
   */
  recoverStaleRuns(opts: { resumeWithinMs: number; maxResumes: number }): { resume: string[]; failed: number } {
    const now = isoNow();
    const stale = this.db
      .prepare(
        `SELECT r.id, c.saved_at, c.resumes, c.data IS NOT NULL AS has_checkpoint
           FROM agent_runs r LEFT JOIN agent_run_checkpoints c ON c.run_id = r.id
          WHERE r.status IN ('running', 'pending')`,
      )
      .all() as Array<{ id: string; saved_at: string | null; resumes: number | null; has_checkpoint: number }>;

    const resume: string[] = [];
    let failed = 0;
    const fail = this.db.prepare(
      `UPDATE agent_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
    );
    for (const run of stale) {
      const age = run.saved_at ? Date.now() - Date.parse(run.saved_at) : Infinity;
      const resumes = run.resumes ?? 0;
      if (run.has_checkpoint && age < opts.resumeWithinMs && resumes < opts.maxResumes) {
        resume.push(run.id);
        this.setRunCondition(run.id, {
          type: "Interrupted", status: "True", reason: "KernelRestart",
          message: "The kernel restarted mid-run; resuming from the last checkpoint.",
        });
        continue;
      }
      const why = !run.has_checkpoint
        ? "Stale run cleaned up on startup"
        : resumes >= opts.maxResumes && opts.maxResumes > 0
          ? `Interrupted by a kernel restart after ${resumes} automatic resume(s) — not retried again; resume by hand with kernel_agents_resume`
          : "Interrupted by a kernel restart — resumable with kernel_agents_resume";
      fail.run(why, now, run.id);
      this.setRunCondition(run.id, {
        type: "Interrupted", status: "True", reason: "KernelRestart", message: why,
      });
      failed++;
    }
    if (failed > 0) {
      log.info(`AgentService: cleaned up ${failed} stale runs`);
    }
    if (resume.length > 0) {
      log.info(`AgentService: ${resume.length} interrupted run(s) will resume from their checkpoint`);
    }
    // …and the meetings those runs were driving.
    //
    // A meeting or debate only exists inside a live process: MeetingExecutor
    // loops in memory and closes the conversation when it finishes. Kill the
    // process mid-meeting — a crash, or an operator redeploying — and the run
    // was marked failed here while the conversation stayed `open` forever.
    // Nothing ever closed it, and the dashboard hydrates open meetings on
    // load, so the 3D office kept showing a phantom meeting in session, halo,
    // banner, wall display and all, for a discussion that died days ago.
    // A process that has just started cannot have a meeting in flight, so any
    // open one is by definition abandoned.
    const stranded = this.db
      .prepare(
        `UPDATE agent_conversations SET status = 'closed', closed_at = ?
          WHERE status = 'open' AND kind IN ('meeting', 'debate')`,
      )
      .run(now);
    const closed = stranded?.changes ?? 0;
    if (closed > 0) {
      log.info(`AgentService: closed ${closed} meeting(s) stranded by the last shutdown`);
    }
    return { resume, failed };
  }

  // ── Steps ───────────────────────────────────────────

  addStep(input: {
    run_id: string;
    step_number: number;
    type: AgentStep["type"];
    content?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_output?: string;
    tokens?: number;
  }): AgentStep {
    const now = isoNow();
    const step: AgentStep = {
      id: newId(),
      run_id: input.run_id,
      step_number: input.step_number,
      type: input.type,
      content: input.content ?? "",
      tool_name: input.tool_name ?? "",
      tool_input: JSON.stringify(input.tool_input ?? {}),
      tool_output: input.tool_output ?? "",
      tokens: input.tokens ?? 0,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_run_steps (id, run_id, step_number, type, content,
         tool_name, tool_input, tool_output, tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        step.id, step.run_id, step.step_number, step.type,
        step.content, step.tool_name, step.tool_input, step.tool_output,
        step.tokens, step.created_at,
      );

    return step;
  }

  getSteps(runId: string): AgentStep[] {
    return this.db
      .prepare("SELECT * FROM agent_run_steps WHERE run_id = ? ORDER BY step_number ASC")
      .all(runId) as AgentStep[];
  }

  getRunEvents(runId: string): Array<{ id: string; event_type: string; event_subtype: string; detail: string; raw_data: string; tokens_used: number; duration_ms: number; created_at: string }> {
    return this.db
      .prepare("SELECT id, event_type, event_subtype, detail, raw_data, tokens_used, duration_ms, created_at FROM agent_event_log WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Array<{ id: string; event_type: string; event_subtype: string; detail: string; raw_data: string; tokens_used: number; duration_ms: number; created_at: string }>;
  }

  getAdHocConnections(agentId: string): {
    invokedBy: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
    invoked: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
  } {
    // Who invoked ME (runs where I'm the target and trigger_payload has source_agent_id)
    const invokedByRows = this.db.prepare(
      `SELECT json_extract(trigger_payload, '$.source_agent_id') AS src_id,
              COUNT(*) AS cnt,
              MAX(created_at) AS last_at
       FROM agent_runs
       WHERE agent_id = ? AND trigger_type = 'chain'
         AND json_extract(trigger_payload, '$.source_agent_id') IS NOT NULL
         AND json_extract(trigger_payload, '$.source_agent_id') <> ''
       GROUP BY src_id
       ORDER BY last_at DESC
       LIMIT 20`,
    ).all(agentId) as Array<{ src_id: string; cnt: number; last_at: string }>;

    const invokedBy = invokedByRows.map((r) => {
      const a = this.getAgent(r.src_id);
      return { agent_id: r.src_id, agent_name: a?.name ?? "Unknown", count: r.cnt, last_at: r.last_at };
    });

    // Who did I invoke (tool_call steps with tool_name = kernel_agents_invoke from my runs)
    const invokedRows = this.db.prepare(
      `SELECT json_extract(s.tool_input, '$.agent_id') AS tgt_id,
              COUNT(*) AS cnt,
              MAX(r.created_at) AS last_at
       FROM agent_run_steps s
       JOIN agent_runs r ON r.id = s.run_id
       WHERE r.agent_id = ? AND s.tool_name = 'kernel_agents_invoke'
         AND s.type = 'tool_call'
         AND json_extract(s.tool_input, '$.agent_id') IS NOT NULL
       GROUP BY tgt_id
       ORDER BY last_at DESC
       LIMIT 20`,
    ).all(agentId) as Array<{ tgt_id: string; cnt: number; last_at: string }>;

    const invoked = invokedRows.map((r) => {
      const a = this.getAgent(r.tgt_id);
      return { agent_id: r.tgt_id, agent_name: a?.name ?? "Unknown", count: r.cnt, last_at: r.last_at };
    });

    return { invokedBy, invoked };
  }
}
