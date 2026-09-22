/**
 * Types and small helpers shared by AgentExecutor and the modules it is split
 * into (executor/*.ts). Re-exported from ../executor.ts where public.
 */

export interface ExecutionResult {
  status: "completed" | "failed";
  result: string;
  error: string;
  steps_count: number;
  tokens_used: number;
}

export const DEFAULT_MAX_CHAIN_DEPTH = 5;
export const DEFAULT_INVOKE_TIMEOUT_MS = 300_000;

/** A run that failed before doing any work: no steps, no tokens, no result. */
export function failedBeforeStart(error: string): ExecutionResult {
  return {
    status: "failed",
    result: "",
    error,
    steps_count: 0,
    tokens_used: 0,
  };
}

/** Parse a JSON array that may be double-encoded (string of a string). */
export function parseJsonArray(raw: string): string[] {
  try {
    let parsed = JSON.parse(raw);
    // Handle double-encoded JSON: '""[...]""' → parse again
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
