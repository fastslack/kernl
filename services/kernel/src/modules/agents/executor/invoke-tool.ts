/**
 * kernel_agents_invoke — the per-run half of the social baseline tool.
 *
 * Its schema is in the baseline, but the handler needs per-run context
 * (caller id, depth) to recurse safely, so it is built for every run.
 */

import { log } from "../../../core/logger.js";
import { isoNow } from "../../../core/helpers.js";
import type { KernelConfig } from "../../../core/config.js";
import type { EventBus } from "../../../core/event-bus.js";
import type { ToolResult } from "../../../core/types.js";
import type { LlmLoopTool } from "../../../core/llm/tool-loop.js";
import type { Agent, AgentRun } from "../types.js";
import type { AgentService } from "../service.js";
import { DEFAULT_INVOKE_TIMEOUT_MS, DEFAULT_MAX_CHAIN_DEPTH, type ExecutionResult } from "./shared.js";
import { extractRoleFromReply, stripRoleWrapper } from "./role-wrapper.js";

/** Fresh schema object per run (providers may annotate tool defs in place). */
export const invokeToolDef = (): LlmLoopTool => ({
  name: "kernel_agents_invoke",
  description:
    "Invoke another AI agent by its UUID and wait for its result. " +
    "Use when you need a pointed, blocking answer from another agent. " +
    "For async back-and-forth prefer kernel_agents_post_to_colleague; " +
    "for group deliberation use kernel_agents_call_meeting.",
  input_schema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "UUID of the target AI agent (not a tool name)" },
      goal: { type: "string", description: "Goal/instruction for the target agent" },
    },
    required: ["agent_id", "goal"],
  },
});

export interface InvokeHandlerDeps {
  agent: Agent;
  run: AgentRun;
  service: AgentService;
  events?: EventBus;
  depth: number;
  /** Read on every call so live config changes apply. */
  getConfig: () => KernelConfig | null;
  /** Recursion into the executor for the target agent. */
  execute: (params: {
    agent: Agent;
    goal: string;
    run: AgentRun;
    service: AgentService;
    events?: EventBus;
    depth: number;
  }) => Promise<ExecutionResult>;
  cancelRun: (runId: string) => boolean;
}

export function createInvokeHandler(deps: InvokeHandlerDeps): (args: unknown) => Promise<ToolResult> {
  const { agent, run, service, events, depth } = deps;
  return async (args: unknown) => {
    const input = args as { agent_id: string; goal: string };
    const targetAgent = service.getAgent(input.agent_id);
    if (!targetAgent) {
      return { content: [{ type: "text" as const, text: `Agent not found: ${input.agent_id}` }], isError: true };
    }
    if (!targetAgent.active) {
      return { content: [{ type: "text" as const, text: `Agent is inactive: ${targetAgent.name}` }], isError: true };
    }

    // Pre-recursion depth gate. The post-execute guard at the top of execute()
    // also catches it but firing here avoids creating a doomed child run.
    const cap = deps.getConfig()?.agents?.maxInvokeDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
    if (depth + 1 > cap) {
      return {
        content: [{
          type: "text" as const,
          text: `Cannot invoke "${targetAgent.name}": invocation chain at max depth (${cap}). ` +
                `Resolve the current task or break the recursion before calling another agent.`,
        }],
        isError: true,
      };
    }

    // Propagate root_run_id so nested invokes share a single budget root.
    // If the calling run was itself an invoke target, its trigger_payload
    // already carries root_run_id; otherwise this run IS the root.
    let rootRunId = run.id;
    try {
      const tp = JSON.parse(run.trigger_payload || "{}") as Record<string, unknown>;
      if (typeof tp.root_run_id === "string" && tp.root_run_id) {
        rootRunId = tp.root_run_id;
      }
    } catch { /* ignore */ }

    const targetRun = service.createRun({
      agent_id: targetAgent.id,
      trigger_type: "chain",
      trigger_payload: {
        source_agent_id: agent.id,
        source_run_id: run.id,
        root_run_id: rootRunId,
        invoke_depth: depth + 1,
      },
      goal: input.goal,
      parent_run_id: run.id,
      parent_agent_id: agent.id,
      depth: depth + 1,
    });

    service.updateRun(targetRun.id, { status: "running", started_at: isoNow() });
    log.info(`Agent "${agent.name}" invoking agent "${targetAgent.name}" (depth: ${depth + 1})`);

    // Save inter-agent conversation: source asks target
    service.addMemory(agent.id, "assistant", `[To ${targetAgent.name}] ${input.goal.slice(0, 1000)}`, run.id);
    service.addMemory(targetAgent.id, "user", `[From ${agent.name}] ${input.goal.slice(0, 1000)}`, run.id);

    // Mirror into a generic conversation so the debate orchestrator and
    // dashboard can observe the exchange as a unified thread. One convo per
    // (topic_hash, participants) pair — reused if the same pair talks about
    // the same topic within the same hash window.
    const invokeConvo = service.findOrCreateChatConversation({
      topic: input.goal.slice(0, 300),
      participants: [agent.id, targetAgent.id],
      initiator_agent_id: agent.id,
    });
    const questionMsg = service.postMessage({
      conversation_id: invokeConvo.id,
      from_agent_id: agent.id,
      to_agent_id: targetAgent.id,
      role: "question",
      body: input.goal,
      run_id: run.id,
      meta: { via: "kernel_agents_invoke", depth: depth + 1 },
    });

    events?.emit("agent:flow:chain_triggered", {
      source_agent_id: agent.id, source_agent_name: agent.name,
      target_agent_id: targetAgent.id, target_agent_name: targetAgent.name,
      chain_id: `invoke-${agent.id}-${targetAgent.id}`, chain_label: `${agent.name} → ${targetAgent.name}`,
      run_id: targetRun.id,
    });
    service.logEvent({
      run_id: targetRun.id, agent_id: targetAgent.id, agent_name: targetAgent.name,
      event_type: "chain", event_subtype: "triggered",
      detail: `${agent.name} -> ${targetAgent.name}`,
      raw_data: { source_agent_id: agent.id, source_agent_name: agent.name, chain_id: `invoke-${agent.id}-${targetAgent.id}` },
    });

    // Hard timeout on the recursive await — prevents an unresponsive child
    // (or a long sub-tree of invokes) from hanging the parent. We cancel
    // the target run on timeout so its state doesn't stay 'running' forever.
    const timeoutMs = deps.getConfig()?.agents?.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
    const TIMEOUT_SENTINEL: ExecutionResult = {
      status: "failed",
      result: "",
      error: `Invoke timeout: ${targetAgent.name} did not return within ${timeoutMs}ms`,
      steps_count: 0,
      tokens_used: 0,
    };
    const result = await Promise.race<ExecutionResult>([
      deps.execute({
        agent: targetAgent,
        goal: input.goal,
        run: targetRun,
        service,
        events,
        depth: depth + 1,
      }),
      new Promise<ExecutionResult>((resolve) =>
        setTimeout(() => {
          // Best-effort cancel of the child run so its branch unwinds.
          deps.cancelRun(targetRun.id);
          resolve(TIMEOUT_SENTINEL);
        }, timeoutMs),
      ),
    ]);

    service.updateRun(targetRun.id, {
      status: result.status,
      result: result.result,
      error: result.error,
      steps_count: result.steps_count,
      tokens_used: result.tokens_used,
      completed_at: isoNow(),
    });

    // Save target's response back to source agent's memory
    const responseText = result.status === "failed" ? `[Error] ${result.error}` : result.result;
    service.addMemory(targetAgent.id, "assistant", `[To ${agent.name}] ${responseText.slice(0, 1000)}`, targetRun.id);
    service.addMemory(agent.id, "user", `[From ${targetAgent.name}] ${responseText.slice(0, 1000)}`, targetRun.id);

    // Mirror the reply into the conversation. Role defaults to 'answer';
    // the target's own LLM output may override this via self-marking
    // (parsed in step 7 below), but from invoke we know at least it's an
    // answer to the question — counter/stmt can still be applied by the
    // parser when the target wraps its reply with a role marker.
    const answerRole = extractRoleFromReply(result.result) ?? "answer";
    service.postMessage({
      conversation_id: invokeConvo.id,
      from_agent_id: targetAgent.id,
      to_agent_id: agent.id,
      role: answerRole,
      in_reply_to: questionMsg.id,
      body: result.status === "failed" ? `[Error] ${result.error}` : stripRoleWrapper(result.result),
      tokens: result.tokens_used,
      run_id: targetRun.id,
      meta: { via: "kernel_agents_invoke" },
    });

    return {
      content: [{
        type: "text" as const,
        text: result.status === "failed"
          ? `Agent "${targetAgent.name}" failed: ${result.error}`
          : result.result,
      }],
      isError: result.status === "failed",
    };
  };
}
