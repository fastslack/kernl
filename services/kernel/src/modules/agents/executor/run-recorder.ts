/**
 * Per-run persistence for a native agent run: the step counter, the running
 * token total, the set of tools used, and the three sinks every record goes
 * to — the steps table (service.addStep), the live flow event bus, and the
 * agent event log (service.logEvent).
 *
 * Everything here used to be inline closures in AgentExecutor.execute(). The
 * payload shapes, key order and the order of the three writes are unchanged:
 * step row first, then the flow event, then the event-log line.
 */

import type { EventBus } from "../../../core/event-bus.js";
import type { LlmLoopHooks } from "../../../core/llm/tool-loop.js";
import { log } from "../../../core/logger.js";
import type { Agent, AgentRun } from "../types.js";
import type { AgentService } from "../service.js";

type LogEventInput = Parameters<AgentService["logEvent"]>[0];

export class RunRecorder {
  stepNumber = 0;
  /**
   * Per-step running token counter so the LIVE UI can show cumulative
   * consumption alongside each event without having to wait for the run
   * to finish. Incremented inside onThought / onFinal hooks. The final
   * `tokens_used` field on the run row remains the authoritative number
   * — this just lets the timeline render `tokens_total: 1234` per step.
   */
  runningTokens = 0;
  readonly toolsUsed = new Set<string>();

  constructor(
    private readonly agent: Agent,
    private readonly run: AgentRun,
    private readonly service: AgentService,
    private readonly events?: EventBus,
  ) {}

  /** Emit a flow event carrying this run's agent_id / agent_name / run_id. */
  emit(event: string, fields: Record<string, unknown>): void {
    this.events?.emit(event, {
      agent_id: this.agent.id, agent_name: this.agent.name, run_id: this.run.id,
      ...fields,
    });
  }

  /** Append to the agent event log for this run. */
  logEvent(fields: Omit<LogEventInput, "run_id" | "agent_id" | "agent_name">): void {
    this.service.logEvent({
      run_id: this.run.id, agent_id: this.agent.id, agent_name: this.agent.name,
      ...fields,
    } as LogEventInput);
  }

  /** Persistence, event emission and pretty logging for runToolLoop. */
  loopHooks(): LlmLoopHooks {
    const { agent, run, service } = this;
    const onText = (type: "final" | "thought") => ({ content, tokens }: { content: string; tokens: number }) => {
      this.stepNumber++;
      const stepTokens = Number(tokens) || 0;
      this.runningTokens += stepTokens;
      service.addStep({
        run_id: run.id, step_number: this.stepNumber, type,
        content, tokens,
      });
      this.emit("agent:flow:step", {
        step_number: this.stepNumber, type,
        content_preview: content.slice(0, 2000),
        tokens: stepTokens,
        tokens_total: this.runningTokens,
      });
      this.logEvent({
        event_type: "step", event_subtype: type,
        detail: content.slice(0, 200),
        raw_data: { step_number: this.stepNumber },
        tokens_used: tokens,
      });
    };
    return {
      onRateLimitWait: ({ waitMs, attempt }) => {
        const detail = `Rate limited — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/3)`;
        log.warn(`Agent "${agent.name}": ${detail}`);
        this.emit("agent:flow:step", {
          step_number: this.stepNumber, type: "rate_limit_wait",
          content_preview: detail, wait_ms: waitMs, attempt,
        });
        this.logEvent({
          event_type: "step", event_subtype: "rate_limit_wait",
          detail, raw_data: { wait_ms: waitMs, attempt },
        });
      },
      onFinal: onText("final"),
      onThought: onText("thought"),
      onToolCall: ({ tool_name, tool_input, preview }) => {
        this.stepNumber++;
        this.toolsUsed.add(tool_name);
        service.addStep({
          run_id: run.id, step_number: this.stepNumber, type: "tool_call",
          tool_name, tool_input,
        });
        this.emit("agent:flow:step", {
          step_number: this.stepNumber, type: "tool_call", tool_name,
          content_preview: JSON.stringify(tool_input).slice(0, 800),
          tokens_total: this.runningTokens,
        });
        this.logEvent({
          event_type: "step", event_subtype: "tool_call",
          detail: preview ? `${tool_name}(${preview})` : tool_name,
          raw_data: { step_number: this.stepNumber, tool_name, tool_input },
        });
      },
      onToolResult: ({ tool_name, text, isError }) => {
        this.stepNumber++;
        service.addStep({
          run_id: run.id, step_number: this.stepNumber, type: "tool_result",
          tool_name, tool_output: text,
        });
        this.emit("agent:flow:step", {
          step_number: this.stepNumber, type: "tool_result", tool_name,
          // Preview was 200 chars which hid almost all tool output in the
          // LIVE tab. 2000 covers most useful tool returns; full text
          // stays in DB (tool_output) for the HISTORY tab.
          content_preview: text.slice(0, 2000),
          tokens_total: this.runningTokens,
        });
        this.logEvent({
          event_type: "step", event_subtype: "tool_result",
          detail: `${tool_name}: ${text.slice(0, 150)}`,
          raw_data: { step_number: this.stepNumber, tool_name, is_error: isError },
        });
      },
    };
  }

  /** Record an error step (row + flow event + log line). */
  recordErrorStep(content: string, preview: string): void {
    this.stepNumber++;
    this.service.addStep({
      run_id: this.run.id,
      step_number: this.stepNumber,
      type: "error",
      content,
    });
    this.emit("agent:flow:step", {
      step_number: this.stepNumber, type: "error",
      content_preview: preview,
    });
    this.logEvent({
      event_type: "step", event_subtype: "error",
      detail: preview,
      raw_data: { step_number: this.stepNumber },
    });
  }

  /** Announce a failed run completion (flow event + log line). */
  recordRunFailed(error: string, finalContent: string, totalTokens: number): void {
    this.emit("agent:flow:run_completed", {
      status: "failed", steps_count: this.stepNumber, tokens_used: totalTokens,
      result_preview: finalContent.slice(0, 200), error,
    });
    this.logEvent({
      event_type: "run", event_subtype: "completed",
      detail: `Failed: ${error.slice(0, 200)}`,
      raw_data: { status: "failed", steps_count: this.stepNumber, tokens_used: totalTokens },
      tokens_used: totalTokens,
    });
  }
}
