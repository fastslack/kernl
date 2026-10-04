/**
 * Continue an interrupted native agent run from its checkpoint.
 *
 * Two callers: the scheduler at startup, for runs the last process left in
 * flight (see AgentRunsService.recoverStaleRuns), and `kernel_agents_resume`
 * for an operator picking one up by hand.
 *
 * Only native runs checkpoint. A claude_code run lives in an SDK session and
 * a builtin handler has no loop, so neither has anything to resume from.
 */

import { isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import type { EventBus } from "../../core/event-bus.js";
import type { AgentExecutor } from "./executor.js";
import type { AgentService } from "./service.js";
import { parseCheckpoint } from "./executor/run-checkpoint.js";

/** Defaults for the automatic pass; both overridable through the environment. */
export function autoResumePolicy(env: NodeJS.ProcessEnv = process.env): { resumeWithinMs: number; maxResumes: number } {
  const num = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    // A checkpoint older than this is stale context: whatever the run was
    // reacting to has probably moved on. It stays resumable by hand.
    resumeWithinMs: num(env.KERNEL_AGENT_RESUME_WINDOW_MS, 30 * 60_000),
    maxResumes: num(env.KERNEL_AGENT_MAX_AUTO_RESUMES, 2),
  };
}

export type ResumeOutcome =
  /** `done` settles once the run's outcome is recorded; callers may ignore it. */
  | { ok: true; fromTurn: number; done: Promise<void> }
  | { ok: false; error: string };

/**
 * Start the resume and return once it is under way; the run itself continues
 * in the background and records its own outcome, like a manual run does.
 */
export function resumeRun(
  deps: { service: AgentService; executor: AgentExecutor; events?: EventBus },
  runId: string,
  how: "automatic" | "manual",
): ResumeOutcome {
  const { service, executor, events } = deps;
  const run = service.getRun(runId);
  if (!run) return { ok: false, error: "Run not found" };
  if (run.status === "completed" || run.status === "cancelled") {
    return { ok: false, error: `Run is ${run.status}; there is nothing to resume` };
  }
  if (how === "manual" && run.status === "running") {
    return { ok: false, error: "Run is still running" };
  }

  const agent = service.getAgent(run.agent_id);
  if (!agent) return { ok: false, error: "Agent not found" };
  if (!agent.active) return { ok: false, error: "Agent is inactive" };
  if (agent.executor_type === "claude_code" || agent.builtin_handler) {
    return { ok: false, error: "Only native runs can be resumed — this agent does not checkpoint" };
  }

  const stored = service.getCheckpoint(runId);
  const checkpoint = stored ? parseCheckpoint(stored.data) : null;
  if (!checkpoint) return { ok: false, error: "This run has no usable checkpoint" };
  // The checkpoint is written before the tool_call step of its turn is
  // recorded, so it can trail the steps table. Continue after whatever is
  // actually there, or the resumed run reuses step numbers.
  const lastStep = service.getSteps(runId).reduce((max, s) => Math.max(max, s.step_number), 0);
  checkpoint.stepNumber = Math.max(checkpoint.stepNumber, lastStep);

  service.reopenRun(runId);
  service.markCheckpointResumed(runId);
  service.setRunCondition(runId, {
    type: "Resumed", status: "True",
    reason: how === "automatic" ? "Automatic" : "Manual",
    message: `Continuing from turn ${checkpoint.iterations} (${checkpoint.totalTokens} tokens spent)`,
  });
  service.setRunCondition(runId, {
    type: "Interrupted", status: "False", reason: "Resumed", message: "",
  });
  events?.emit("agent.run.started", {
    run_id: run.id, agent_id: agent.id, agent_name: agent.name,
    trigger_type: run.trigger_type, resumed: true,
  });

  const fresh = service.getRun(runId) ?? run;
  const done = executor
    .execute({ agent, goal: run.goal, run: fresh, service, events, depth: run.depth, resume: checkpoint })
    .then((result) => {
      service.updateRun(run.id, {
        status: result.status,
        result: result.result,
        error: result.error,
        steps_count: result.steps_count,
        tokens_used: result.tokens_used,
        completed_at: isoNow(),
      });
      events?.emit("agent.run.completed", {
        run_id: run.id, agent_id: agent.id, status: result.status,
        steps_count: result.steps_count, tokens_used: result.tokens_used,
      });
      service.recordRunOutcome(agent.id, { ok: result.status === "completed", error: result.error, run_id: run.id });
    })
    .catch((err) => {
      log.error(`Resume of run ${run.id} failed:`, err);
      service.updateRun(run.id, { status: "failed", error: String(err), completed_at: isoNow() });
      service.recordRunOutcome(agent.id, { ok: false, error: String(err), run_id: run.id });
    })
    .catch((err) => log.error(`Recording the outcome of resumed run ${run.id} failed:`, err));

  log.info(`Agent "${agent.name}": resuming run ${run.id} (${how}) from turn ${checkpoint.iterations}`);
  return { ok: true, fromTurn: checkpoint.iterations, done };
}
