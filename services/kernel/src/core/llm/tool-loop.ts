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
  /**
   * Tool results stay verbatim for this many tool turns, then a long one is
   * cut down to its opening (see compactOldToolResults). Default 3; 0 keeps
   * every result whole, the old behaviour.
   */
  keepFullToolTurns?: number;
  /**
   * Output cap for each turn. Left unset, the provider's own default applies
   * (4096 on the OpenAI-compatible adapter), which a reasoning model can
   * spend entirely on its hidden thinking and answer with nothing.
   */
  maxOutputTokens?: number;
  /**
   * End-of-conversation compaction (arXiv 2611.05306, "EoCC"): once a turn's
   * context reaches this many tokens, the model writes a structured handoff
   * and the loop starts over from the task plus that handoff, instead of
   * re-sending a history that keeps growing. 0 or unset keeps the whole
   * history, the old behaviour. See writeHandoff.
   */
  handoffAtTokens?: number;
}

/** A result longer than this is cut once it ages out; shorter ones stay. */
const COMPACT_MIN_CHARS = 800;
/** How much of a cut result is kept: enough to recognise it and its shape. */
const COMPACT_HEAD_CHARS = 300;
const COMPACT_MARK = "[TRIMMED";

/**
 * Every turn re-sends the whole conversation, so a tool result costs its
 * size again on each later turn: a prospector that read a 3 KB state file
 * and ran a dozen place searches early on paid for all of it on every one
 * of its ~20 calls (110-130k tokens a run, nearly half the instance's
 * spend). By the time a result is a few turns old the model has already
 * acted on it, so it is cut to its opening plus a marker. Nothing is lost:
 * calling the same tool with the same arguments again returns the full
 * text from the run's cache without re-executing it.
 *
 * Mutates `messages` in place, once per result, so the history is cut at a
 * stable point — a provider's prompt cache keeps matching the prefix up to
 * the newest cut instead of missing on every turn. Returns the tool_use ids
 * it cut on this call.
 */
export function compactOldToolResults(messages: ChatMessage[], keepTurns: number): string[] {
  if (keepTurns <= 0) return [];
  const cut: string[] = [];
  let toolTurnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const blocks = m.content as ContentBlock[];
    if (!blocks.some((b) => b.type === "tool_result")) continue;
    toolTurnsSeen++;
    if (toolTurnsSeen <= keepTurns) continue;
    for (const b of blocks) {
      if (b.type !== "tool_result" || typeof b.content !== "string") continue;
      if (b.content.length <= COMPACT_MIN_CHARS || b.content.startsWith(COMPACT_MARK)) continue;
      const full = b.content.length;
      b.content =
        `${COMPACT_MARK} — ${full} chars, shown in full ${keepTurns} turns ago and already used. ` +
        `Calling the same tool with the same arguments returns the full text again.]\n` +
        b.content.slice(0, COMPACT_HEAD_CHARS) + "\n…";
      cut.push(b.tool_use_id);
    }
  }
  return cut;
}

export interface LlmLoopHooks {
  onThought?(payload: { content: string; tokens: number }): void;
  onFinal?(payload: { content: string; tokens: number }): void;
  onToolCall?(payload: { tool_name: string; tool_input: Record<string, unknown>; preview: string }): void;
  onToolResult?(payload: { tool_name: string; text: string; isError: boolean }): void;
  onRateLimitWait?(payload: { waitMs: number; attempt: number }): void;
  /**
   * Durable-state snapshot, emitted at every point a crash could lose work:
   * once the assistant turn is in (before any of its tools run) and after each
   * tool result. Persisting it lets a run continue after a kernel restart.
   * Called synchronously — serialize inside the hook, the arrays are live.
   */
  onCheckpoint?(checkpoint: LoopCheckpoint): void;
  /** The history was replaced by the task plus a handoff (see `handoffAtTokens`). */
  onHandoff?(payload: { handoff: string; contextTokens: number; tokens: number; messagesBefore: number }): void;
}

/** What a run needs to pick up where it stopped. */
export interface LoopCheckpoint {
  /** Conversation so far, ending in a (possibly partial) tool-result turn or an assistant turn. */
  messages: ChatMessage[];
  iterations: number;
  totalTokens: number;
  /** Wall-clock time the loop had already spent, counted against `timeoutMs`. */
  elapsedMs: number;
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
  /**
   * Continue an interrupted loop: budgets keep counting from these values.
   * Pass the checkpoint's messages through `prepareResumeMessages` first.
   */
  resumeFrom?: Pick<LoopCheckpoint, "iterations" | "totalTokens" | "elapsedMs">;
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
  /** Times the history was compacted into a handoff (0 when `handoffAtTokens` is off). */
  handoffs: number;
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

const MAX_EMPTY_NUDGES = 1;
const EMPTY_TURN_NUDGE =
  "[Your last reply was empty. Continue the task from the tool results above: " +
  "call the next tool you need, or write your final answer.]";

const UNKNOWN_OUTCOME =
  "[INTERRUPTED — the kernel restarted while this tool was running, so its outcome is unknown. " +
  "It may or may not have taken effect. Check the current state before calling it again.]";

/**
 * Make a checkpointed conversation valid to send again.
 *
 * A crash can land between an assistant turn and the results of its tool
 * calls. Every tool_use needs a matching tool_result, but re-executing the
 * tool is not safe — it may have sent the email or written the file before the
 * process died. So each missing result is filled with a note saying the
 * outcome is unknown, and the model decides whether to check and retry.
 */
export function prepareResumeMessages(input: ChatMessage[]): {
  messages: ChatMessage[];
  unknownToolCalls: string[];
} {
  const messages = input.slice();
  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistantIdx < 0) return { messages, unknownToolCalls: [] };

  const assistant = messages[lastAssistantIdx];
  const toolUses = Array.isArray(assistant.content)
    ? (assistant.content as ContentBlock[]).filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    : [];
  if (toolUses.length === 0) return { messages, unknownToolCalls: [] };

  const following = messages[lastAssistantIdx + 1];
  const existing: ContentBlock[] =
    following?.role === "user" && Array.isArray(following.content) ? (following.content as ContentBlock[]) : [];
  const answered = new Set(
    existing.filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id),
  );

  const unknownToolCalls = toolUses.filter((t) => !answered.has(t.id)).map((t) => t.id);
  if (unknownToolCalls.length === 0) return { messages, unknownToolCalls };

  const filled: ContentBlock[] = [
    ...existing,
    ...unknownToolCalls.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: UNKNOWN_OUTCOME,
      is_error: false,
    })),
  ];
  messages.splice(lastAssistantIdx + 1, existing.length > 0 ? 1 : 0, { role: "user", content: filled });
  return { messages, unknownToolCalls };
}

/** Opens every handoff the loop writes into the conversation. */
export const HANDOFF_MARK = "[HANDOFF";

/**
 * Asked of the model, with tools off, when the context crosses
 * `handoffAtTokens`. A brief of the work left, in fixed sections — not a
 * narrative summary, which over-weights whatever repeated most (arXiv
 * 2611.05306, appendix A). An earlier handoff in the conversation is merged
 * in, so a second compaction keeps what the first one carried.
 */
const HANDOFF_INSTRUCTION =
  "[CONTEXT HANDOFF] Your context is about to be reset. The next conversation will see only the original task and " +
  "what you write now; tool results above will be gone (the environment — files, records, anything your tools changed — " +
  "stays as it is). Write a handoff for yourself, with exactly these sections:\n" +
  "## Goal — the task in one or two sentences, with any completion criteria.\n" +
  "## Established facts — what you found that is still needed: exact values, ids, paths, names. Copy them verbatim.\n" +
  "## Changes made — every action that changed state (writes, sends, creates), so none is repeated.\n" +
  "## Verification — what you checked and its outcome.\n" +
  "## Dead ends — approaches that failed and why, so they are not retried.\n" +
  "## Remaining plan — the next concrete steps, in order.\n" +
  "If an earlier handoff appears above, carry everything in it that still holds into this one. " +
  "Do not call tools. Write only the handoff.";

const HANDOFF_MAX_OUTPUT_TOKENS = 2048;

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return (content as ContentBlock[])
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * The task the loop was given: the messages before the first assistant turn,
 * without any handoff an earlier compaction appended to them. Copies, so the
 * live history is never touched.
 */
export function taskMessages(messages: ChatMessage[]): ChatMessage[] {
  const firstAssistant = messages.findIndex((m) => m.role === "assistant");
  const lead = firstAssistant < 0 ? messages : messages.slice(0, firstAssistant);
  const out: ChatMessage[] = [];
  for (const m of lead) {
    if (typeof m.content === "string") {
      if (!m.content.startsWith(HANDOFF_MARK)) out.push({ ...m });
      continue;
    }
    const blocks = (m.content as ContentBlock[]).filter(
      (b) => !(b.type === "text" && b.text.startsWith(HANDOFF_MARK)),
    );
    if (blocks.length > 0) out.push({ ...m, content: blocks });
  }
  return out;
}

/**
 * Task plus handoff, as the next conversation starts. The handoff rides on
 * the task's last user turn when there is one, so roles keep alternating.
 */
export function buildHandoffConversation(task: ChatMessage[], handoff: string, n: number): ChatMessage[] {
  const text =
    `${HANDOFF_MARK} #${n}] The conversation was compacted to keep the context short. ` +
    `This is your own handoff from before the reset; continue the task from its remaining plan.\n\n${handoff.trim()}`;
  const out = task.slice();
  const last = out[out.length - 1];
  if (last?.role === "user") {
    const blocks: ContentBlock[] =
      typeof last.content === "string"
        ? [{ type: "text", text: last.content }]
        : (last.content as ContentBlock[]).slice();
    blocks.push({ type: "text", text });
    out[out.length - 1] = { ...last, content: blocks };
  } else {
    out.push({ role: "user", content: text });
  }
  return out;
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
  const { provider, systemText, model, messages, tools, executeTool, budgets, isCancelled, hooks, caller, resumeFrom } = config;
  const { maxIterations, maxTokens, maxErrors, timeoutMs } = budgets;
  const loopThreshold = budgets.toolLoopThreshold ?? 3;

  let iterations = resumeFrom?.iterations ?? 0;
  let totalTokens = resumeFrom?.totalTokens ?? 0;
  /** Tokens of the previous call — the estimate for the next one. */
  let lastTurnTokens = 0;
  let finalContent = "";
  const toolsUsed = new Set<string>();
  let consecutiveErrors = 0;
  let abortReason = "";
  let emptyNudges = 0;
  /** Stopped calling tools to keep one turn of budget for the answer. */
  let budgetWrapUp = false;

  const toolCallCounts = new Map<string, number>();
  const toolResultCache = new Map<string, string>();
  const keepFullToolTurns = budgets.keepFullToolTurns ?? 3;
  /** tool_use id → call key, so a cut result can be handed back whole. */
  const callKeyById = new Map<string, string>();
  /** Call keys whose result was cut from the history. */
  const trimmedKeys = new Set<string>();
  const handoffAtTokens = budgets.handoffAtTokens && budgets.handoffAtTokens > 0 ? budgets.handoffAtTokens : 0;
  let handoffs = 0;
  /** Context size of the last call: its prompt when the provider splits usage, else its total. */
  let lastContextTokens = 0;

  const priorElapsedMs = resumeFrom?.elapsedMs ?? 0;
  const startedAt = Date.now();
  const checkpoint = (pendingResults?: ContentBlock[]) => {
    hooks?.onCheckpoint?.({
      messages: pendingResults ? [...messages, { role: "user", content: pendingResults }] : messages,
      iterations,
      totalTokens,
      elapsedMs: priorElapsedMs + (Date.now() - startedAt),
    });
  };

  const remainingMs = timeoutMs - priorElapsedMs;
  let timedOut = remainingMs <= 0;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
  }, Math.max(0, remainingMs));

  try {
    while (iterations < maxIterations) {
      if (isCancelled?.()) { abortReason = "Cancelled by user"; break; }
      if (timedOut) { abortReason = `Timeout after ${Math.round(timeoutMs / 1000)}s`; break; }
      if (totalTokens >= maxTokens) { abortReason = `Token budget exhausted (${totalTokens}/${maxTokens})`; break; }
      // Usage is only known after a call, so checking the total alone lets the
      // turn that crosses the line run in full (174k on a 150k budget). Every
      // turn re-sends the whole history, so the last one is a floor for the
      // next: stop before a call that would land past the budget.
      // Keep one turn in reserve: stop calling tools while there is still room
      // for the answer, so a long run ends with a synthesis instead of an abort.
      if (lastTurnTokens > 0 && totalTokens + 2 * lastTurnTokens > maxTokens && totalTokens + lastTurnTokens <= maxTokens) {
        budgetWrapUp = true;
        break;
      }
      if (lastTurnTokens > 0 && totalTokens + lastTurnTokens > maxTokens) {
        abortReason = `Token budget would be exceeded by the next turn (${totalTokens} spent + ~${lastTurnTokens} for the next turn > ${maxTokens})`;
        break;
      }
      if (consecutiveErrors >= maxErrors) { abortReason = `${maxErrors} consecutive tool errors`; break; }

      // Compact before the call that would carry an over-threshold history.
      // Only mid-task (last turn is tool results): a handoff with nothing done
      // since the last reset would just restate it.
      const tail = messages[messages.length - 1];
      if (
        handoffAtTokens > 0 &&
        lastContextTokens >= handoffAtTokens &&
        tail?.role === "user" &&
        Array.isArray(tail.content) &&
        (tail.content as ContentBlock[]).some((b) => b.type === "tool_result")
      ) {
        let handoff = "";
        let handoffTokens = 0;
        try {
          // The instruction rides on the tool-result turn (a copy), so roles
          // keep alternating for providers that insist on it.
          const ask: ChatMessage = {
            role: "user",
            content: [...(tail.content as ContentBlock[]), { type: "text", text: HANDOFF_INSTRUCTION }],
          };
          const h = await provider.chatCompletion(
            [...messages.slice(0, -1), ask],
            {
              model: model || undefined,
              system: systemText,
              tools: undefined,
              max_tokens: HANDOFF_MAX_OUTPUT_TOKENS,
              caller: caller ? `${caller}/handoff` : "handoff",
            },
          );
          handoffTokens = h.tokens_used;
          handoff = h.tool_calls && h.tool_calls.length > 0 ? "" : (h.content ?? "").trim();
        } catch {
          handoff = "";
        }
        totalTokens += handoffTokens;
        if (handoff) {
          handoffs++;
          const messagesBefore = messages.length;
          const contextTokens = lastContextTokens;
          const next = buildHandoffConversation(taskMessages(messages), handoff, handoffs);
          messages.splice(0, messages.length, ...next);
          // The results these remember are gone from the history; a call
          // after the reset reads the environment afresh.
          toolCallCounts.clear();
          toolResultCache.clear();
          callKeyById.clear();
          trimmedKeys.clear();
          lastTurnTokens = 0;
          lastContextTokens = 0;
          hooks?.onHandoff?.({ handoff, contextTokens, tokens: handoffTokens, messagesBefore });
          checkpoint();
        } else {
          // Failed or empty: carry on with the full history, try again next turn.
          lastContextTokens = 0;
        }
        if (isCancelled?.()) { abortReason = "Cancelled by user"; break; }
        if (totalTokens >= maxTokens) { abortReason = `Token budget exhausted (${totalTokens}/${maxTokens})`; break; }
      }

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
        ...(budgets.maxOutputTokens ? { max_tokens: budgets.maxOutputTokens } : {}),
      };

      for (const id of compactOldToolResults(messages, keepFullToolTurns)) {
        const key = callKeyById.get(id);
        if (key) trimmedKeys.add(key);
      }

      const completion = await provider.chatCompletion(messages, opts);
      totalTokens += completion.tokens_used;
      lastTurnTokens = completion.tokens_used;
      // Anthropic counts cached prompt tokens apart from input_tokens.
      lastContextTokens =
        completion.input_tokens !== undefined
          ? completion.input_tokens + (completion.cache_read_tokens ?? 0) + (completion.cache_write_tokens ?? 0)
          : completion.tokens_used;

      if (isCancelled?.()) { abortReason = "Cancelled by user"; break; }

      // No tool calls → final text response
      if (!completion.tool_calls || completion.tool_calls.length === 0) {
        // Some models end the turn with nothing at all right after reading a
        // tool result: the run would close as "completed" having done
        // nothing. Ask once to carry on before taking silence as the answer.
        const last = messages[messages.length - 1];
        if (
          !completion.content?.trim() &&
          emptyNudges < MAX_EMPTY_NUDGES &&
          last?.role === "user" &&
          Array.isArray(last.content) &&
          (last.content as ContentBlock[]).some((b) => b.type === "tool_result")
        ) {
          emptyNudges++;
          (last.content as ContentBlock[]).push({ type: "text", text: EMPTY_TURN_NUDGE });
          continue;
        }
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
      checkpoint();

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
        callKeyById.set(tc.id, callKey);
        let refetchedTrimmed = false;
        let result: { text: string; isError: boolean };
        if (prevCount > 0 && trimmedKeys.has(callKey) && toolResultCache.has(callKey)) {
          // Its earlier copy was trimmed from the history: asking again is
          // the documented way back to the full text, not a loop.
          trimmedKeys.delete(callKey);
          refetchedTrimmed = true;
          result = { text: toolResultCache.get(callKey)!, isError: false };
        } else if (prevCount > 0) {
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
        const count = (toolCallCounts.get(loopKey) ?? 0) + (refetchedTrimmed ? 0 : 1);
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
        checkpoint(toolResultBlocks);
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
    (hitMaxIterations || budgetWrapUp) &&
    lastMessage?.role === "user" &&
    Array.isArray(lastMessage.content) &&
    (lastMessage.content as ContentBlock[]).some(b => b.type === "tool_result");

  if (stuckInToolUse) {
    try {
      const spent = budgetWrapUp
        ? `You have used almost all of your token budget (${totalTokens}/${maxTokens}).`
        : `You have used all ${maxIterations} tool-use turns.`;
      const synthesisSystem = `${systemText}\n\n[BUDGET EXHAUSTED] ${spent} You MUST now write your final answer using only the tool results already in this conversation. Do NOT request more tools — they are disabled. Be direct and concise.`;
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
      if (hitMaxIterations) finalContent += "\n[Reached maximum iterations]";
    }
    if (budgetWrapUp && !finalContent.trim()) {
      abortReason = `Token budget would be exceeded by the next turn (${totalTokens}/${maxTokens}) and the final answer came back empty`;
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
    handoffs,
  };
}
