/**
 * Getting an answered question back to the agent that asked it — the same
 * path whether the chief or the human answered.
 *
 * The asker is relaunched with the answer in its goal when it is idle. When it
 * is already running (or inactive, or the relaunch fails) the answer goes to
 * its inbox instead. Never both: the asker would see the same answer twice.
 *
 * Inbox answers are a queue, not a mailbox. Answering three questions ten
 * seconds apart relaunched the asker on the first and filed the other two;
 * nothing woke it again, and a Claude Code agent never reads its inbox on
 * its own — the answers sat unread. `AnswerQueue` relaunches the asker once
 * whenever one of its runs ends, with every answer still waiting.
 */

import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import type { EventBus } from "../../core/event-bus.js";
import { log } from "../../core/logger.js";
import type { AgentOfficeInboxMessage } from "./types.js";

/** Who the answer letters come from (`postAnswerToInbox`). */
const HEADQUARTERS = "__top_agent__";

/** Answers filed in the asker's inbox that no run has read yet, oldest first. */
export function pendingAnswers(service: AgentService, agentId: string): AgentOfficeInboxMessage[] {
  return service
    .getUnreadInbox(agentId, 20)
    .filter((m) => m.from_agent_id === HEADQUARTERS && m.subject.startsWith("ANSWER:"));
}

/** The goal for a relaunch that carries every waiting answer. */
export function answersGoal(letters: Array<{ body: string }>): string {
  const n = letters.length;
  return (
    (n === 1
      ? "An answer to one of your earlier questions arrived while you were busy.\n\n"
      : `Answers to ${n} of your earlier questions arrived while you were busy.\n\n`) +
    letters.map((l) => l.body).join("\n\n---\n\n") +
    "\n\nResume from where you stopped: act on each answer using your tools. " +
    "Do not re-ask questions that are answered here."
  );
}

/**
 * Relaunch `agentId` with its waiting answers, if it is active, idle and has
 * any. Returns the new run id, or null when there was nothing to do.
 */
export function deliverPendingAnswers(
  service: AgentService,
  executor: Pick<AgentExecutor, "execute">,
  events: EventBus | undefined,
  agentId: string,
): string | null {
  const agent = service.getAgent(agentId);
  if (!agent || !agent.active || service.hasRunningRun(agentId)) return null;
  const letters = pendingAnswers(service, agentId);
  if (letters.length === 0) return null;
  service.markInboxRead(letters.map((l) => l.id));
  const goal = answersGoal(letters);
  const run = service.createRun({
    agent_id: agentId,
    trigger_type: "manual",
    goal,
    trigger_payload: { resume_answer_letters: letters.map((l) => l.id) },
  });
  service.updateRun(run.id, { status: "running", started_at: new Date().toISOString() });
  executor
    .execute({ agent, goal, run, service, events })
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
  log.info(`answers: relaunched ${agent.name} with ${letters.length} waiting answer(s)`);
  return run.id;
}

/**
 * Drains each agent's waiting answers when its run ends. `run_completed` is
 * emitted before the run row leaves 'running', so the check waits for the
 * agent to be idle (a few tries) instead of racing it.
 */
export class AnswerQueue {
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(
    private service: AgentService,
    private executor: Pick<AgentExecutor, "execute">,
    private events: EventBus,
    private opts: { retryMs?: number; tries?: number } = {},
  ) {}

  start(): void {
    this.events.on("agent:flow:run_completed", (payload) => {
      const agentId = (payload as { agent_id?: unknown })?.agent_id;
      if (typeof agentId === "string" && agentId) this.schedule(agentId);
    });
  }

  /** Every agent with answers already waiting (boot, after a deploy). */
  sweep(): number {
    let n = 0;
    for (const id of this.service.agentsWithPendingAnswers()) {
      this.schedule(id);
      n++;
    }
    return n;
  }

  schedule(agentId: string, triesLeft = this.opts.tries ?? 20): void {
    if (this.stopped || this.pending.has(agentId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(agentId);
      try {
        if (this.service.hasRunningRun(agentId)) {
          if (triesLeft > 1) this.schedule(agentId, triesLeft - 1);
          return;
        }
        deliverPendingAnswers(this.service, this.executor, this.events, agentId);
      } catch (err) {
        log.warn(`answers: delivery to ${agentId} failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.opts.retryMs ?? 3000);
    this.pending.set(agentId, timer);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}

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
