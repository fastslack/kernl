/**
 * Driver/builtin-handler result normalization — the single place that decides
 * whether a no-LLM run SUCCEEDED or FAILED.
 *
 * Why this exists: handlers used to return a plain string in every case,
 * including failure ("upstream failed / error: ..."). The scheduler stored that
 * as `completed`, so an agent polling a dead mirror reported 100% success
 * forever and kept its cron slot. Handlers now signal failure explicitly
 * (`{ ok: false, error }`) or by throwing; this module maps either into the
 * shape the run recorder wants.
 *
 * Both no-LLM entry points normalize through here — the scheduler's cron path
 * (`scheduler.executeBuiltin`) and the executor's short-circuit for manual /
 * chained / API runs (`executor.execute`) — so "Run now" and the cron agree.
 */

import type { AgentDriverResult } from "../../core/types.js";

export interface DriverOutcome {
  ok: boolean;
  /** Body for `agent_runs.result` — always a string, never undefined. */
  text: string;
  /** Single-line reason for `agent_runs.error`. Empty when ok. */
  error: string;
}

/** Type guard for the explicit failure shape. */
export function isDriverFailure(raw: unknown): raw is { ok: false; error: string; detail?: string } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { ok?: unknown }).ok === false &&
    typeof (raw as { error?: unknown }).error === "string"
  );
}

/**
 * Map whatever a handler returned into a run outcome.
 *
 * - `string`                      → success, verbatim as the result body.
 * - `{ ok: false, error, detail }`→ failure; `detail` (or the error line) is the body.
 * - anything else (undefined, a number, a stray object) → success with a
 *   stringified body. Handlers predate the contract; a sloppy return value must
 *   never crash the scheduler tick, and it is NOT evidence of failure.
 */
export function normalizeDriverResult(raw: AgentDriverResult | undefined | null): DriverOutcome {
  if (isDriverFailure(raw)) {
    const error = raw.error.trim() || "handler reported failure without a message";
    return { ok: false, text: raw.detail ?? error, error };
  }
  if (typeof raw === "string") return { ok: true, text: raw, error: "" };
  if (raw === undefined || raw === null) return { ok: true, text: "", error: "" };
  return { ok: true, text: String(raw), error: "" };
}

/** Map a thrown value into a failure outcome. */
export function driverThrewOutcome(err: unknown): DriverOutcome {
  const error = err instanceof Error ? err.message : String(err);
  return { ok: false, text: "", error };
}
