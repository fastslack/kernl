// src/modules/agents/start-run.ts
/**
 * Start a manual run and let it finish in the background — the one path
 * "Run now", the agent chat and office panels share, so all of them feed the
 * circuit breaker the same way.
 */
import type { EventBus } from "../../core/event-bus.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import type { Agent, AgentRun } from "./types.js";

const now = () => new Date().toISOString();

export function startAgentRun(
  deps: { service: AgentService; executor: Pick<AgentExecutor, "execute">; events?: EventBus },
  input: { agent: Agent; goal: string; triggerPayload?: Record<string, unknown>; projectId?: string | null },
): AgentRun {
  const { service, executor, events } = deps;
  const { agent, goal } = input;
  const run = service.createRun({
    agent_id: agent.id,
    trigger_type: "manual",
    goal,
    trigger_payload: input.triggerPayload && Object.keys(input.triggerPayload).length ? input.triggerPayload : undefined,
    project_id: input.projectId ?? null,
  });
  service.updateRun(run.id, { status: "running", started_at: now() });
  executor.execute({ agent, goal, run, service, events }).then((result) => {
    service.updateRun(run.id, {
      status: result.status, result: result.result, error: result.error,
      steps_count: result.steps_count, tokens_used: result.tokens_used, completed_at: now(),
    });
    service.recordRunOutcome(agent.id, { ok: result.status === "completed", error: result.error, run_id: run.id });
  }).catch((err) => {
    service.updateRun(run.id, { status: "failed", error: String(err), completed_at: now() });
    service.recordRunOutcome(agent.id, { ok: false, error: String(err), run_id: run.id });
  });
  return service.getRun(run.id) ?? run;
}
