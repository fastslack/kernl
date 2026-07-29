import type { ChatLlmProvider } from "./chat-adapters.js";
import type { ChatCompletionOptions, ChatMessage, ContentBlock } from "./chat-types.js";

/** Tool definition in the shape LLM APIs accept (Anthropic/OpenAI). */
export interface LlmLoopTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmLoopBudgets {
  maxIterations: number;
  maxTokens: number;
  maxErrors: number;
  timeoutMs: number;
  /** Same tool+args this many times → abort as stuck loop. Default: 8. */
  toolLoopThreshold?: number;
}

export interface LlmLoopHooks {
  onThought?(payload: { content: string; tokens: number }): void;
  onFinal?(payload: { content: string; tokens: number }): void;
  onToolCall?(payload: { tool_name: string; tool_input: Record<string, unknown>; preview: string }): void;
  onToolResult?(payload: { tool_name: string; text: string; isError: boolean }): void;
  onRateLimitWait?(payload: { waitMs: number; attempt: number }): void;
}

export interface LlmLoopConfig {
  provider: ChatLlmProvider;
  systemText: string;
  model?: string;
  /** Initial messages; the loop appends assistant/tool-result turns in place. */
  messages: ChatMessage[];
  tools: LlmLoopTool[];
  executeTool: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }>;
  budgets: LlmLoopBudgets;
  isCancelled?: () => boolean;
  hooks?: LlmLoopHooks;
  /** Diagnostic tag forwarded to the LLM call logger (e.g. agent name). */
  caller?: string;
}

export interface LlmLoopResult {
  status: "completed" | "aborted";
  finalContent: string;
  totalTokens: number;
  iterations: number;
  toolsUsed: string[];
  /** Empty when status === "completed". */
  abortReason: string;
  hitMaxIterations: boolean;
}

/** Short, human-readable one-liner of tool args for log lines. */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    let s: string;
    if (typeof v === "string") s = v.length > 40 ? v.slice(0, 39) + "…" : v;
    else if (typeof v === "number" || typeof v === "boolean") s = String(v);
    else s = JSON.stringify(v).slice(0, 40);
    parts.push(`${k}=${s}`);
    if (parts.join(" ").length > 90) break;
  }
  return parts.join(" ");
}

/**
 * Iteration-budget warning injected into the system prompt as the agent
 * approaches its turn limit. Kicks in at 70% (caution) and 90% (warning).
 * Mirrors the helper in chat/service.ts — the same pattern keeps both the
 * conversational chat loop and the autonomous-agent loop on the same rails.
 */
export function formatBudgetWarning(current: number, max: number): string | null {
  const usage = current / max;
  const remaining = Math.max(0, max - current);
  if (usage >= 0.9) {
    return `[BUDGET WARNING: turn ${current}/${max}. Only ${remaining} turn(s) left. Provide your final response NOW. Do not start new tool calls.]`;
  }
  if (usage >= 0.7) {
    return `[BUDGET: turn ${current}/${max}. ${remaining} turn(s) left. Start consolidating your work and prepare a response.]`;
  }
  return null;
}

/** Stable stringification of tool args for loop detection (order-independent). */
function stableArgsKey(input: unknown): string {
  if (!input || typeof input !== "object") return String(input ?? "");
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    parts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join("|");
}

/**
 * Provider-agnostic LLM tool-use loop with safety controls.
 *
 * Runs the standard turn-taking loop: call LLM, execute tool calls, feed results back,
 * repeat until the model produces text with no tool calls. Enforces four independent
 * safety aborts (token budget, consecutive tool errors, same-tool-same-args loop,
 * wall-clock timeout) plus external cancellation.
 *
 * Pure and side-effect-free aside from:
 *   - mutating `messages` in place (appends assistant + tool-result turns)
 *   - calling `executeTool` once per tool call the model emits
 *   - invoking `hooks` for step-level observability (persistence/events live upstream)
 */
export async function runToolLoop(config: LlmLoopConfig): Promise<LlmLoopResult> {
  const { provider, systemText, model, messages, tools, executeTool, budgets, isCancelled, hooks, caller } = config;
  const { maxIterations, maxTokens, maxErrors, timeoutMs } = budgets;
  const loopThreshold = budgets.toolLoopThreshold ?? 3;

  let iterations = 0;
  let totalTokens = 0;
  let finalContent = "";
  const toolsUsed = new Set<string>();
  let consecutiveErrors = 0;
  let abortReason = "";

  const toolCallCounts = new Map<string, number>();
  const toolResultCache = new Map<string, string>();

  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);

  try {
    while (iterations < maxIterations) {
      if (isCancelled?.()) { abortReason = "Cancelled by user"; break; }
      if (timedOut) { abortReason = `Timeout after ${Math.round(timeoutMs / 1000)}s`; break; }
      if (totalTokens >= maxTokens) { abortReason = `Token budget exhausted (${totalTokens}/${maxTokens})`; break; }
      if (consecutiveErrors >= maxErrors) { abortReason = `${maxErrors} consecutive tool errors`; break; }

      iterations++;

      const budgetWarning = formatBudgetWarning(iterations, maxIterations);
      const systemForThisTurn = budgetWarning
        ? `${systemText}\n\n${budgetWarning}`
        : systemText;

      const opts: ChatCompletionOptions = {
        model: model || undefined,
        system: systemForThisTurn,
        tools: tools.length > 0 ? tools : undefined,
        onRateLimitWait: hooks?.onRateLimitWait
          ? (waitMs, attempt) => hooks.onRateLimitWait!({ waitMs, attempt })
          : undefined,
        caller,
      };

      const completion = await provider.chatCompletion(messages, opts);
      totalTokens += completion.tokens_used;

      if (isCancelled?.()) { abortReason = "Cancelled by user"; break; }

      // No tool calls → final text response
      if (!completion.tool_calls || completion.tool_calls.length === 0) {
        finalContent += completion.content;
        hooks?.onFinal?.({ content: completion.content, tokens: completion.tokens_used });
        break;
      }

      // Thought alongside tool calls (reasoning text the model produced)
      if (completion.content) {
        hooks?.onThought?.({ content: completion.content, tokens: completion.tokens_used });
      }

      // Build assistant turn with mixed text + tool_use blocks
      const assistantBlocks: ContentBlock[] = [];
      if (completion.content) assistantBlocks.push({ type: "text", text: completion.content });
      for (const tc of completion.tool_calls) assistantBlocks.push(tc);
      messages.push({ role: "assistant", content: assistantBlocks });

      // Execute each tool call
      const toolResultBlocks: ContentBlock[] = [];
      let batchHadError = false;

      for (const tc of completion.tool_calls) {
        if (isCancelled?.()) { abortReason = "Cancelled by user"; break; }

        toolsUsed.add(tc.name);
        const toolInput = tc.input as Record<string, unknown>;
        hooks?.onToolCall?.({
          tool_name: tc.name,
          tool_input: toolInput,
          preview: summarizeToolInput(toolInput),
        });

        // Check if this exact call was already made — return cached result
        // with a hint instead of re-executing (prevents local model loops)
        const callKey = `${tc.name}::${stableArgsKey(toolInput)}`;
        const prevCount = (toolCallCounts.get(callKey) ?? 0);
        let result: { text: string; isError: boolean };
        if (prevCount > 0) {
          // Already called with same args — return hint instead of re-executing
          const cachedResult = toolResultCache.get(callKey) ?? "Same as before";
          result = {
            text: `[ALREADY CALLED — same result as before. DO NOT call this tool again with the same arguments. Use the data you already have and proceed to the next step.]\n\n${cachedResult.slice(0, 500)}`,
            isError: false,
          };
        } else {
          result = await executeTool(tc.name, toolInput);
          toolResultCache.set(callKey, result.text);
        }

        hooks?.onToolResult?.({ tool_name: tc.name, text: result.text, isError: result.isError });

        if (result.isError) batchHadError = true;

        // Loop detection by tool-name + args fingerprint: batch searches with
        // distinct args are legitimate progress; exact repeats are a stuck loop.
        const loopKey = `${tc.name}::${stableArgsKey(toolInput)}`;
        const count = (toolCallCounts.get(loopKey) ?? 0) + 1;
        toolCallCounts.set(loopKey, count);
        if (count >= loopThreshold) {
          abortReason = `Tool "${tc.name}" called ${count} times with the same args — likely stuck in a loop`;
          break;
        }

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.text,
          is_error: result.isError,
        });
      }

      consecutiveErrors = batchHadError ? consecutiveErrors + 1 : 0;

      if (abortReason) break;

      messages.push({ role: "user", content: toolResultBlocks });

      if (completion.content) finalContent += completion.content + "\n";
    }
  } finally {
    clearTimeout(timeoutTimer);
  }

  const hitMaxIterations = iterations >= maxIterations && !abortReason;

  // Forced synthesis pass when the model burned its budget while still in a
  // tool-calling state. One last completion with tools disabled lets it
  // produce a real answer from the data it already collected, instead of
  // leaving the user with a "[Reached maximum iterations]" stub.
  const lastMessage = messages[messages.length - 1];
  const stuckInToolUse =
    hitMaxIterations &&
    lastMessage?.role === "user" &&
    Array.isArray(lastMessage.content) &&
    (lastMessage.content as ContentBlock[]).some(b => b.type === "tool_result");

  if (stuckInToolUse) {
    try {
      const synthesisSystem = `${systemText}\n\n[BUDGET EXHAUSTED] You have used all ${maxIterations} tool-use turns. You MUST now write your final answer using only the tool results already in this conversation. Do NOT request more tools — they are disabled. Be direct and concise.`;
      const synthesis = await provider.chatCompletion(messages, {
        model: model || undefined,
        system: synthesisSystem,
        tools: undefined,
        caller: caller ? `${caller}/synthesis` : "synthesis",
      });
      totalTokens += synthesis.tokens_used;
      if (synthesis.content) {
        finalContent = (finalContent ? finalContent + "\n" : "") + synthesis.content;
        hooks?.onFinal?.({ content: synthesis.content, tokens: synthesis.tokens_used });
      }
    } catch {
      // Synthesis pass is best-effort — fall through to the legacy stub.
      finalContent += "\n[Reached maximum iterations]";
    }
  } else if (hitMaxIterations) {
    finalContent += "\n[Reached maximum iterations]";
  }

  return {
    status: abortReason ? "aborted" : "completed",
    finalContent,
    totalTokens,
    iterations,
    toolsUsed: [...toolsUsed],
    abortReason,
    hitMaxIterations,
  };
}
