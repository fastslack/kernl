/**
 * WorkspaceEvolverService — orchestrates init / snapshot / evaluate / accept
 * / revert primitives for a workspace.
 *
 * Two flows the dashboard / API will call:
 *
 *   A. Manual gate (iteration 1):
 *        snapshotBaseline → (agent runs and modifies files)
 *                         → evaluate
 *                         → if pass: acceptCandidate; if fail: revertTo(baseline)
 *
 *   B. Cycle (future): runCycle() bundles A into one call with a meta-LLM
 *      proposal step. Stub left at the bottom of this file with a TODO so
 *      callers can already wire the route, but the logic is not engaged yet.
 *
 * Persistence: every accept / reject is written into agent_evolution_runs
 * with target='workspace'. The git sha lives in artifact_ref.
 */

import { resolve } from "node:path";
import { log } from "../../../../../../src/core/logger.js";
import { isoNow } from "../../../../../../src/core/helpers.js";
import type { AgentService } from "../../../../../../src/modules/agents/service.js";
import type { AgentExecutor } from "../../../../../../src/modules/agents/executor.js";
import type { EventBus } from "../../../../../../src/core/event-bus.js";
import type { WorkspaceService } from "../workspace-service.js";
import { WORKSPACE_ROOT } from "../workspace-service.js";
import { loadPolicy, initEvolutionFiles, type InitResult } from "./policy.js";
import { loadObjectives } from "./objectives.js";
import { runEvaluation } from "./evaluator.js";
import {
  ensureRepo,
  snapshot as gitSnapshot,
  revertTo as gitRevertTo,
  getHead,
  listChangedFiles,
} from "./git-snapshot.js";
import type {
  EvaluationResult,
  WorkspacePolicy,
  WorkspaceSnapshot,
  WorkspaceEvolutionSummary,
} from "./types.js";

export interface SnapshotBaselineOpts {
  workspace_id: string;
  agent_id?: string;
  label?: string;
}

export interface EvaluateOpts {
  workspace_id: string;
}

export interface AcceptCandidateOpts {
  workspace_id: string;
  /** Required: agent_evolution_runs has a strict FK to agents(id). The kernel
   *  rejects empty strings. Pass the id of the agent that produced the change
   *  (or a "system" agent created for non-agent-driven mutations). */
  agent_id: string;
  baseline_ref: string;
  evaluation: EvaluationResult;
  trigger_run_ids?: string[];
  hypothesis?: string;
  notes?: string;
}

export interface RejectCandidateOpts {
  workspace_id: string;
  agent_id: string;
  baseline_ref: string;
  evaluation: EvaluationResult;
  trigger_run_ids?: string[];
  hypothesis?: string;
  notes?: string;
  /** Default true. When false the dirty files are kept for human triage. */
  revert?: boolean;
}

/** Knobs that protect the LLM API from runaway agent loops. */
export interface EvolverGuardOpts {
  /** Min seconds between two runCycle calls on the same workspace. Default 30. */
  cooldownSeconds?: number;
  /** Max simultaneously inflight runCycle calls across ALL workspaces. Default 4. */
  maxConcurrent?: number;
}

export class WorkspaceEvolverService {
  /** Workspaces currently inside a runCycle — used to reject overlap. */
  private inflight = new Set<string>();
  /** workspace_id → last runCycle-completion timestamp (ms). */
  private lastCycleAt = new Map<string, number>();
  private cooldownMs: number;
  private maxConcurrent: number;

  constructor(
    private agents: AgentService,
    private workspaces: WorkspaceService,
    guards: EvolverGuardOpts = {},
  ) {
    this.cooldownMs = (guards.cooldownSeconds ?? 30) * 1000;
    this.maxConcurrent = guards.maxConcurrent ?? 4;
  }

  /** Read-only inspection of policy + objectives + repo state. */
  async describe(workspaceId: string): Promise<{
    workspace_id: string;
    workspace_dir: string;
    initialised: boolean;
    policy: WorkspacePolicy | null;
    objectives: string | null;
    head_ref: string | null;
  }> {
    const workspaceDir = this.resolveWorkspaceDir(workspaceId);
    let head: WorkspaceSnapshot | null = null;
    try {
      head = await getHead(workspaceDir);
    } catch {
      head = null;
    }
    const [policy, objectives] = await Promise.all([
      loadPolicy(workspaceDir),
      loadObjectives(workspaceDir),
    ]);
    return {
      workspace_id: workspaceId,
      workspace_dir: workspaceDir,
      initialised: head !== null,
      policy,
      objectives,
      head_ref: head?.ref ?? null,
    };
  }

  /**
   * Scaffold .evolve/ files and ensure the git repo exists. Idempotent —
   * never overwrites existing content.
   */
  async init(workspaceId: string): Promise<InitResult & { head_ref: string }> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) throw new Error(`workspace ${workspaceId} not found`);
    const workspaceDir = this.resolveWorkspaceDir(workspaceId);
    const files = await initEvolutionFiles(workspaceDir);
    const head = await ensureRepo(workspaceDir);
    return { ...files, head_ref: head.ref };
  }

  /**
   * Take a baseline snapshot just before an agent run. Returns the git sha.
   * Caller passes the sha to acceptCandidate / rejectCandidate later.
   */
  async snapshotBaseline(opts: SnapshotBaselineOpts): Promise<WorkspaceSnapshot> {
    const workspaceDir = this.resolveWorkspaceDir(opts.workspace_id);
    await ensureRepo(workspaceDir);
    const label = opts.label || `baseline ${isoNow()}`;
    const snap = await gitSnapshot(workspaceDir, label);
    log.info(
      `WorkspaceEvolver: baseline ${snap.ref.slice(0, 8)} for workspace ${opts.workspace_id.slice(0, 8)}`,
    );
    return snap;
  }

  /** Run policy.evaluation.command. Returns null when no policy is configured. */
  async evaluate(opts: EvaluateOpts): Promise<EvaluationResult | null> {
    const workspaceDir = this.resolveWorkspaceDir(opts.workspace_id);
    const policy = await loadPolicy(workspaceDir);
    if (!policy) return null;
    const result = await runEvaluation(workspaceDir, policy);
    log.info(
      `WorkspaceEvolver: eval ${opts.workspace_id.slice(0, 8)} → ${result.passed ? "pass" : "fail"} (exit=${result.exit_code}, ${result.duration_ms}ms)`,
    );
    return result;
  }

  /**
   * Promote the current dirty/working state to a candidate commit and record
   * it in agent_evolution_runs as target='workspace', status='accepted'.
   */
  async acceptCandidate(opts: AcceptCandidateOpts): Promise<WorkspaceEvolutionSummary> {
    const workspaceDir = this.resolveWorkspaceDir(opts.workspace_id);
    await ensureRepo(workspaceDir);

    const candidate = await gitSnapshot(
      workspaceDir,
      `candidate ${isoNow()} (eval exit=${opts.evaluation.exit_code})`,
    );

    const changed = await listChangedFiles(workspaceDir, opts.baseline_ref, candidate.ref);

    if (!opts.agent_id) throw new Error("agent_id is required for acceptCandidate");
    const evolutionRun = this.agents.createEvolutionRun({
      agent_id: opts.agent_id,
      base_version: 0,
      hypothesis: opts.hypothesis ?? "",
      proposal: opts.notes ?? "",
      trigger_run_ids: opts.trigger_run_ids,
      target: "workspace",
      workspace_id: opts.workspace_id,
      artifact_ref: candidate.ref,
    });

    this.agents.updateEvolutionRun(evolutionRun.id, {
      status: "accepted",
      candidate_score: opts.evaluation.passed ? 10 : 0,
      baseline_score: 0,
      evaluation: serialiseEval(opts.evaluation, changed),
      committed_at: new Date().toISOString(),
    });

    return {
      evolution_run_id: evolutionRun.id,
      workspace_id: opts.workspace_id,
      baseline_ref: opts.baseline_ref,
      candidate_ref: candidate.ref,
      status: "accepted",
      evaluation: opts.evaluation,
      error: "",
    };
  }

  /**
   * Mark the current dirty state as rejected. By default also reverts the
   * working tree to baseline_ref. Records target='workspace', status='rejected'.
   */
  async rejectCandidate(opts: RejectCandidateOpts): Promise<WorkspaceEvolutionSummary> {
    const workspaceDir = this.resolveWorkspaceDir(opts.workspace_id);
    await ensureRepo(workspaceDir);

    let changed: string[] = [];
    try {
      const currentHead = await getHead(workspaceDir);
      if (currentHead.ref !== opts.baseline_ref) {
        changed = await listChangedFiles(workspaceDir, opts.baseline_ref, currentHead.ref);
      }
    } catch {
      // No HEAD or unrelated history — leave changed empty.
    }

    if (!opts.agent_id) throw new Error("agent_id is required for rejectCandidate");
    const evolutionRun = this.agents.createEvolutionRun({
      agent_id: opts.agent_id,
      base_version: 0,
      hypothesis: opts.hypothesis ?? "",
      proposal: opts.notes ?? "",
      trigger_run_ids: opts.trigger_run_ids,
      target: "workspace",
      workspace_id: opts.workspace_id,
      artifact_ref: "",
    });

    this.agents.updateEvolutionRun(evolutionRun.id, {
      status: "rejected",
      candidate_score: opts.evaluation.passed ? 10 : 0,
      baseline_score: 0,
      evaluation: serialiseEval(opts.evaluation, changed),
    });

    const shouldRevert = opts.revert !== false;
    if (shouldRevert) {
      await gitRevertTo(workspaceDir, opts.baseline_ref);
      log.info(
        `WorkspaceEvolver: reverted ${opts.workspace_id.slice(0, 8)} to ${opts.baseline_ref.slice(0, 8)}`,
      );
    }

    return {
      evolution_run_id: evolutionRun.id,
      workspace_id: opts.workspace_id,
      baseline_ref: opts.baseline_ref,
      candidate_ref: "",
      status: "rejected",
      evaluation: opts.evaluation,
      error: "",
    };
  }

  /**
   * End-to-end SEPL cycle for a workspace target:
   *   1. Snapshot baseline.
   *   2. Hand the goal to the agent executor — the agent edits files in the
   *      workspace via the same tools it would use in any normal run.
   *   3. Run the policy evaluation command.
   *   4. Accept the candidate when eval passes; reject (with optional revert)
   *      when it fails or the agent run errors out.
   *
   * Returns both the evolution summary and the agent run id so the caller can
   * link to the run trace in the dashboard.
   */
  async runCycle(opts: {
    workspace_id: string;
    agent_id: string;
    goal: string;
    executor: AgentExecutor;
    events?: EventBus;
    /** Default true: when the cycle fails, revert the workspace to baseline. */
    revertOnFail?: boolean;
    /** Optional override notes (otherwise the goal becomes the proposal). */
    notes?: string;
  }): Promise<{
    summary: WorkspaceEvolutionSummary;
    agent_run_id: string;
  }> {
    // ── Guards (anti rate-limit / runaway loop) ──
    // Reserve the inflight slot synchronously, BEFORE the first await — otherwise
    // two concurrent runCycle calls both pass the size/has checks.
    if (this.inflight.has(opts.workspace_id)) {
      throw new Error(`cycle already in progress for workspace ${opts.workspace_id}`);
    }
    if (this.inflight.size >= this.maxConcurrent) {
      throw new Error(`evolver concurrency cap reached (${this.maxConcurrent} cycles inflight) — try again shortly`);
    }
    const last = this.lastCycleAt.get(opts.workspace_id);
    if (last !== undefined) {
      const elapsed = Date.now() - last;
      if (elapsed < this.cooldownMs) {
        const wait = Math.ceil((this.cooldownMs - elapsed) / 1000);
        throw new Error(`cooldown active for workspace ${opts.workspace_id} — retry in ${wait}s`);
      }
    }
    this.inflight.add(opts.workspace_id);

    try {
      const workspaceDir = this.resolveWorkspaceDir(opts.workspace_id);
      const policy = await loadPolicy(workspaceDir);
      if (!policy) throw new Error(`workspace ${opts.workspace_id} has no .evolve/policy.json — call init first`);
      const agent = this.agents.getAgent(opts.agent_id);
      if (!agent) throw new Error(`agent ${opts.agent_id} not found`);
      const baseline = await this.snapshotBaseline({
        workspace_id: opts.workspace_id,
        agent_id: opts.agent_id,
        label: `cycle-baseline ${isoNow()}`,
      });

      const run = this.agents.createRun({
        agent_id: opts.agent_id,
        goal: opts.goal,
        trigger_type: "manual",
        trigger_payload: { evolution: true, workspace_id: opts.workspace_id, baseline_ref: baseline.ref },
      });
      this.agents.updateRun(run.id, { status: "running", started_at: isoNow() });

      let executionFailed = false;
      let executionError = "";
      let runResult = "";
      let runStepsCount = 0;
      let runTokens = 0;
      try {
        const result = await opts.executor.execute({
          agent,
          goal: opts.goal,
          run,
          service: this.agents,
          events: opts.events,
        });
        runResult = result.result;
        runStepsCount = result.steps_count;
        runTokens = result.tokens_used;
        if (result.status === "failed") {
          executionFailed = true;
          executionError = result.error || "agent run failed";
        }
      } catch (err) {
        executionFailed = true;
        executionError = err instanceof Error ? err.message : String(err);
        log.warn(`WorkspaceEvolver: execute threw for run ${run.id}: ${executionError}`);
      }

      // Persist whatever the executor returned (it doesn't update the row itself
      // on the builtin-handler short-circuit path).
      this.agents.updateRun(run.id, {
        status: executionFailed ? "failed" : "completed",
        result: runResult,
        error: executionError,
        steps_count: runStepsCount,
        tokens_used: runTokens,
        completed_at: isoNow(),
      });

      const evaluation = await runEvaluation(workspaceDir, policy);
      log.info(
        `WorkspaceEvolver: cycle ${run.id.slice(0, 8)} → eval ${evaluation.passed ? "pass" : "fail"} (exit=${evaluation.exit_code}, ${evaluation.duration_ms}ms)`,
      );

      const shouldAccept = !executionFailed && evaluation.passed;
      if (shouldAccept) {
        const summary = await this.acceptCandidate({
          workspace_id: opts.workspace_id,
          agent_id: opts.agent_id,
          baseline_ref: baseline.ref,
          evaluation,
          trigger_run_ids: [run.id],
          hypothesis: opts.goal.slice(0, 500),
          notes: opts.notes ?? "",
        });
        return { summary, agent_run_id: run.id };
      }

      const summary = await this.rejectCandidate({
        workspace_id: opts.workspace_id,
        agent_id: opts.agent_id,
        baseline_ref: baseline.ref,
        evaluation,
        trigger_run_ids: [run.id],
        hypothesis: opts.goal.slice(0, 500),
        notes: opts.notes ?? "",
        revert: opts.revertOnFail !== false,
      });

      if (executionFailed) {
        summary.error = executionError;
      }
      return { summary, agent_run_id: run.id };
    } finally {
      this.inflight.delete(opts.workspace_id);
      this.lastCycleAt.set(opts.workspace_id, Date.now());
    }
  }

  /** Hard revert + log. Useful as a recovery escape hatch from the dashboard. */
  async revertTo(workspaceId: string, ref: string): Promise<{ workspace_id: string; head_ref: string }> {
    const workspaceDir = this.resolveWorkspaceDir(workspaceId);
    await gitRevertTo(workspaceDir, ref);
    const head = await getHead(workspaceDir);
    return { workspace_id: workspaceId, head_ref: head.ref };
  }

  // ── internals ────────────────────────────────────────────────────────

  private resolveWorkspaceDir(workspaceId: string): string {
    return resolve(WORKSPACE_ROOT, workspaceId);
  }
}

function serialiseEval(ev: EvaluationResult, changed: string[]): string {
  return JSON.stringify({
    passed: ev.passed,
    exit_code: ev.exit_code,
    duration_ms: ev.duration_ms,
    timed_out: ev.timed_out,
    files_changed: changed.length,
    files_changed_sample: changed.slice(0, 50),
    stdout_tail: ev.stdout.slice(-2000),
    stderr_tail: ev.stderr.slice(-2000),
  });
}
