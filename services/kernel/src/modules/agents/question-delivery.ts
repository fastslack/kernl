/**
 * Getting an answered question back to the agent that asked it — the same
 * path whether the chief or the human answered.
 *
 * The asker is relaunched with the answer in its goal when it is idle. When it
 * is already running (or inactive, or the relaunch fails) the answer goes to
 * its inbox instead, which the running/next run reads. Never both: the asker
 * would see the same answer twice.
 */

import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import type { EventBus } from "../../core/event-bus.js";
import { log } from "../../core/logger.js";

export interface AnswerInput {
  selected_index: number;
  selected_option: string;
  note?: string;
  answered_by: "chief" | "human";
}

export function answerAndDeliver(
  service: AgentService,
  executor: Pick<AgentExecutor, "execute">,
  events: EventBus | undefined,
  id: string,
  input: AnswerInput,
): { from_agent_id: string; question: string; resume_run_id: string | null } | null {
  const result = service.answerQuestion(id, input);
  if (!result) return null;
  events?.emit("agent:flow:question_answered", {
    question_id: id,
    from_agent_id: result.from_agent_id,
    question: result.question,
    selected_option: input.selected_option,
    selected_index: input.selected_index,
    answered_by: input.answered_by,
    ts: new Date().toISOString(),
  });

  const asker = service.getAgent(result.from_agent_id);
  if (!asker || !asker.active || service.hasRunningRun(asker.id)) {
    service.postAnswerToInbox(id);
    return { ...result, resume_run_id: null };
  }

  try {
    const who = input.answered_by === "chief" ? "The chief" : "Your supervisor";
    const noteSuffix = input.note && input.note !== input.selected_option ? `\n\nAdditional note: ${input.note}` : "";
    const goal =
      `${who} answered your earlier question.\n\n` +
      `**Question:** ${result.question}\n\n` +
      `**Answer:** ${input.selected_option}${noteSuffix}\n\n` +
      `Resume from where you stopped: act on the answer using your tools. ` +
      `Do not re-ask the same question.`;
    const run = service.createRun({
      agent_id: asker.id,
      trigger_type: "manual",
      goal,
      trigger_payload: { resume_question_id: id },
    });
    service.updateRun(run.id, { status: "running", started_at: new Date().toISOString() });
    executor
      .execute({ agent: asker, goal, run, service, events })
      .then((r) => {
        service.updateRun(run.id, {
          status: r.status, result: r.result, error: r.error,
          steps_count: r.steps_count, tokens_used: r.tokens_used,
          completed_at: new Date().toISOString(),
        });
      })
      .catch((err) => {
        service.updateRun(run.id, { status: "failed", error: String(err), completed_at: new Date().toISOString() });
      });
    return { ...result, resume_run_id: run.id };
  } catch (err) {
    // Relaunch is best-effort; the inbox letter still reaches the asker.
    log.warn(`resume after answer failed: ${err instanceof Error ? err.message : String(err)}`);
    service.postAnswerToInbox(id);
    return { ...result, resume_run_id: null };
  }
}
