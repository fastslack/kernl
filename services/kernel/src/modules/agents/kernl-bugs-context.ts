/** A failed run, reduced to what a Kernl bug report may carry — redacted. */
import type { AgentService } from "./service.js";
import { isPrivateTool, redactForReport } from "./kernl-bugs-redact.js";

const cut = (s: unknown, n: number) => redactForReport(String(s ?? "")).slice(0, n);

export function buildBugContext(service: AgentService, runId: string) {
  const run = service.getRun(runId);
  if (!run) return null;
  const agent = service.getAgent(run.agent_id);
  const steps = service.getSteps(runId).slice(-8).map((s) => ({
    type: s.type,
    tool: s.tool_name || undefined,
    // A message tool's input is a message too (a mail body, a chat text).
    input: s.type === "tool_call"
      ? (isPrivateTool(s.tool_name) ? `‹${String(s.tool_input ?? "").length} chars of message content›` : cut(s.tool_input, 300))
      : undefined,
    output: s.type === "tool_result" ? (isPrivateTool(s.tool_name) ? `‹${String(s.tool_output ?? "").length} chars of message content›` : cut(s.tool_output, 300)) : undefined,
    text: s.type === "thought" || s.type === "final" || s.type === "error" ? cut(s.content, 300) : undefined,
  }));
  return {
    error: cut(run.error || run.result, 2000),
    agent_id: run.agent_id,
    agent_name: agent?.name ?? "",
    context: {
      error: cut(run.error, 2000),
      agent: agent?.name ?? "",
      executor: agent?.executor_type || "native",
      model: [agent?.provider, agent?.model].filter(Boolean).join("/") || "default",
      limits: { max_iterations: agent?.max_iterations, max_tokens: agent?.max_tokens, timeout_ms: agent?.timeout_ms, max_errors: agent?.max_errors },
      trigger: run.trigger_type,
      steps_count: run.steps_count,
      last_steps: steps,
    },
  };
}
