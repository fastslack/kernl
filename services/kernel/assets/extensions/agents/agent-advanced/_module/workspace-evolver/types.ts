/**
 * Workspace evolver — types shared between policy/objectives/evaluator/service.
 *
 * Two on-disk artifacts define the contract per workspace:
 *
 *   data/workspaces/{id}/EVOLUTION.md    → free-form mission + invariants for the meta-LLM
 *   data/workspaces/{id}/.evolve/policy.json → structured policy for the optimizer
 *
 * The policy.json is read by the kernel; EVOLUTION.md is included verbatim
 * in any meta-LLM prompt that judges or proposes changes.
 */

/** Minimum-viable policy schema. version is locked at 1 until we break compat. */
export interface WorkspacePolicy {
  version: 1;
  /**
   * Glob list of paths inside the workspace that the agent IS allowed to
   * modify. Empty array → "everything except protected" (which is the
   * intersection of protected_globs below + the global protected-files.ts list).
   */
  mutable_globs: string[];
  /**
   * Workspace-local additions to the global protected-files.ts list. Useful
   * when a project wants to lock down an extra path (e.g. a vendored lib it
   * pulls from upstream).
   */
  protected_globs: string[];
  /** What "the project still works" means — runs as a child process. */
  evaluation: {
    /** Shell command. Exit code 0 = pass. */
    command: string;
    timeout_s: number;
    /** Relative to workspace root. Default: workspace root. */
    cwd?: string;
  };
  /** Forward-looking knobs for SEPL cycles. Optional. */
  budget?: {
    commit_margin?: number;
    max_iterations_per_cycle?: number;
  };
  /** Optional structural constraints — checked by the optimizer, not the agent. */
  constraints?: {
    max_files_changed_per_run?: number;
    forbidden_packages?: string[];
  };
}

/** Output of a single evaluation invocation. */
export interface EvaluationResult {
  passed: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  /** Wall time in ms. */
  duration_ms: number;
  /** Filled when the eval timed out before exit. */
  timed_out: boolean;
}

/** Snapshot taken before/after an evolution run. */
export interface WorkspaceSnapshot {
  /** Git sha. */
  ref: string;
  /** ISO timestamp. */
  taken_at: string;
  /** Optional human label (e.g. "baseline-pre-run-<runId>"). */
  label: string;
}

/** Public summary returned by WorkspaceEvolverService.runCycle(). */
export interface WorkspaceEvolutionSummary {
  evolution_run_id: string;
  workspace_id: string;
  baseline_ref: string;
  candidate_ref: string;
  status: "accepted" | "rejected" | "failed";
  evaluation: EvaluationResult | null;
  error: string;
}
