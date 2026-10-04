/**
 * Wakes the chief to triage office agents' questions, in batches.
 *
 * Each question entering 'triage' (re)arms a debounce; when it fires, ONE
 * chief run gets every question no earlier triage run has seen. A chief that
 * is already running is not interrupted — the timer re-arms. Questions the
 * chief never resolves go to the human after TRIAGE_TIMEOUT_MS, so nothing
 * waits forever on a paused or failing chief.
 */

import type { AgentService, AgentQuestion } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import type { EventBus } from "../../core/event-bus.js";
import { formatTriageQuestion } from "./question-format.js";
import { log } from "../../core/logger.js";

export const TRIAGE_DEBOUNCE_MS = 30_000;
export const TRIAGE_TIMEOUT_MS = 600_000;
export const TRIAGE_SWEEP_MS = 60_000;

export function buildTriageGoal(questions: AgentQuestion[], service: AgentService): string {
  return [
    `Office agents sent you ${questions.length} question(s). Resolve every one of them in this run.`,
    "",
    "- Answer it yourself with `kernel_agents_questions_answer` (option index, or `text` when no option fits) when it is operational or technical and you can settle it from what you know or can find with your tools.",
    "- Hand it to the human with `kernel_agents_questions_escalate` and a one-line reason when it is a product or business decision, involves money, is irreversible or destructive, is something the human has to own, or you are not sure.",
    "- Do not message the askers directly; the answer reaches them on its own.",
    "",
    ...questions.map((q) => formatTriageQuestion(q, service)),
  ].join("\n");
}

export class QuestionTriager {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private readonly onTriage = () => this.arm();
  private readonly debounceMs: number;
  private readonly timeoutMs: number;
  private readonly sweepMs: number;

  constructor(
    private readonly service: AgentService,
    private readonly executor: Pick<AgentExecutor, "execute">,
    private readonly events: EventBus,
    opts: { debounceMs?: number; timeoutMs?: number; sweepMs?: number } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? TRIAGE_DEBOUNCE_MS;
    this.timeoutMs = opts.timeoutMs ?? TRIAGE_TIMEOUT_MS;
    this.sweepMs = opts.sweepMs ?? TRIAGE_SWEEP_MS;
  }

  start(): void {
    if (this.sweeper) return;
    this.events.on("agent:question_triage", this.onTriage);
    // A throw inside a timer callback is an uncaught exception, and the
    // process exits on those — every timer path logs instead.
    this.sweeper = setInterval(() => this.safeSweep(), this.sweepMs);
    this.sweeper.unref();
    this.safeSweep();
    try {
      if (this.unseen().length > 0) this.arm();
    } catch (err) {
      log.error("Question triage: startup check failed", err);
    }
  }

  stop(): void {
    this.events.off("agent:question_triage", this.onTriage);
    if (this.timer) clearTimeout(this.timer);
    if (this.sweeper) clearInterval(this.sweeper);
    this.timer = null;
    this.sweeper = null;
  }

  sweep(): number {
    const n = this.service.expireTriage(new Date(Date.now() - this.timeoutMs).toISOString());
    if (n > 0) log.info(`Question triage: ${n} question(s) auto-escalated to the human`);
    return n;
  }

  private safeSweep(): void {
    try {
      this.sweep();
    } catch (err) {
      log.error("Question triage: sweep failed", err);
    }
  }

  /** One chief run over every unseen triage question. Returns its run id, or
   *  null when there was nothing to do or the chief was busy (re-armed). */
  async fire(): Promise<string | null> {
    // Clear any pending debounce — fire() can be called directly (tests, a
    // caller that wants triage right now), not only from the timer itself.
    // Just nulling the field without cancelling it would leak the underlying
    // OS timer: it still fires later and calls fire() again on a triager
    // whose db may by then be closed (tests) or long since re-armed.
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sweep();
    const questions = this.unseen();
    if (questions.length === 0) return null;
    const chief = this.service.getTopAgent();
    if (!chief) {
      for (const q of questions) this.service.escalateQuestion(q.id, "auto-escalated: there is no active chief");
      return null;
    }
    if (this.service.hasRunningRun(chief.id)) {
      this.arm();
      return null;
    }
    const goal = buildTriageGoal(questions, this.service);
    const run = this.service.createRun({
      agent_id: chief.id,
      trigger_type: "manual",
      goal,
      trigger_payload: { question_triage: questions.map((q) => q.id) },
    });
    this.service.markTriageStarted(questions.map((q) => q.id));
    this.service.updateRun(run.id, { status: "running", started_at: new Date().toISOString() });
    this.events.emit("agent.run.started", {
      run_id: run.id,
      agent_id: chief.id,
      agent_name: chief.name,
      trigger_type: "manual",
    });
    this.executor
      .execute({ agent: chief, goal, run, service: this.service, events: this.events })
      .then((r) => {
        this.service.updateRun(run.id, {
          status: r.status, result: r.result, error: r.error,
          steps_count: r.steps_count, tokens_used: r.tokens_used,
          completed_at: new Date().toISOString(),
        });
        this.events.emit("agent.run.completed", {
          run_id: run.id,
          agent_id: chief.id,
          status: r.status,
          steps_count: r.steps_count,
          tokens_used: r.tokens_used,
        });
        // Circuit breaker tracking (persistent — see AgentService.recordRunOutcome)
        this.service.recordRunOutcome(chief.id, { ok: r.status !== "failed", error: r.error, run_id: run.id });
      }, (err) => {
        const error = String(err);
        log.error(`Question triage: chief run ${run.id} threw`, err);
        this.service.updateRun(run.id, { status: "failed", error, completed_at: new Date().toISOString() });
        this.events.emit("agent.run.completed", {
          run_id: run.id,
          agent_id: chief.id,
          status: "failed",
          steps_count: 0,
          tokens_used: 0,
        });
        this.service.recordRunOutcome(chief.id, { ok: false, error, run_id: run.id });
      })
      .catch((err) => log.error(`Question triage: recording the outcome of run ${run.id} failed`, err));
    return run.id;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fire().catch((err) => log.error("Question triage: fire failed", err));
    }, this.debounceMs);
    this.timer.unref();
  }

  private unseen(): AgentQuestion[] {
    return this.service.listQuestions({ status: "triage", limit: 50 }).filter((q) => !q.triage_started_at);
  }
}
