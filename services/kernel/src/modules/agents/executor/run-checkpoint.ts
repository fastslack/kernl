/**
 * The persisted state of a native agent run, enough to continue it in a new
 * process: the loop's own checkpoint plus where the run was in its model
 * chain and its step numbering. Stored as JSON in `agent_run_checkpoints`.
 */

import type { ChatMessage } from "../../../core/llm/chat-types.js";
import type { LoopCheckpoint } from "../../../core/llm/tool-loop.js";

export interface RunCheckpoint extends LoopCheckpoint {
  v: 1;
  /** Index of the model-chain entry the run had committed to. */
  chainIdx: number;
  /** Last step number written to agent_run_steps, so new steps continue after it. */
  stepNumber: number;
}

export function serializeCheckpoint(loop: LoopCheckpoint, chainIdx: number, stepNumber: number): string {
  const checkpoint: RunCheckpoint = { v: 1, ...loop, chainIdx, stepNumber };
  return JSON.stringify(checkpoint);
}

/** Parse a stored checkpoint; null when it is unreadable or from another format. */
export function parseCheckpoint(data: string): RunCheckpoint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const c = parsed as Partial<RunCheckpoint> | null;
  if (!c || c.v !== 1 || !Array.isArray(c.messages) || c.messages.length === 0) return null;
  const nums = [c.iterations, c.totalTokens, c.elapsedMs, c.chainIdx, c.stepNumber];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  return {
    v: 1,
    messages: c.messages as ChatMessage[],
    iterations: c.iterations!,
    totalTokens: c.totalTokens!,
    elapsedMs: c.elapsedMs!,
    chainIdx: c.chainIdx!,
    stepNumber: c.stepNumber!,
  };
}
