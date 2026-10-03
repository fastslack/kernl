/**
 * What to do about a failure on the chief's office board, given the agent as
 * it is NOW (failure-explain.ts says what the error was).
 *
 * A failure card used to stay on the board after the problem was gone: the
 * chief raised an agent's step limit from 15 to 40 and re-ran it, and the
 * card still said "ran out of steps (15) — adjust limits" nine hours later.
 * So, in order:
 *
 *   1. Already resolved? A later run that completed, or (out of steps) a
 *      limit that is already above the one it hit.
 *   2. Running again right now? Then there is nothing to do but wait.
 *   3. A mechanical fix: raise the limit it hit (capped, so a task that never
 *      fits cannot ratchet the limit up forever) and run it again, or just
 *      run it again when the cause was outside the agent (a kernel restart,
 *      a provider rate limit).
 *   4. Otherwise nothing mechanical: the chief can look into it.
 */

import type { FailureExplanation } from './failure-explain.js';

export interface AgentLimits {
  max_iterations?: number;
  timeout_ms?: number;
  max_tokens?: number;
}

export interface RecentRun {
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
}

export type LimitField = 'max_iterations' | 'timeout_ms' | 'max_tokens';

export type FixPlan =
  /** Nothing to do: it already ran fine, or the limit it hit was raised. */
  | { kind: 'resolved'; how: 'ran_ok'; at: number }
  | { kind: 'resolved'; how: 'limit_raised'; field: LimitField; from: number; to: number }
  /** A newer run is in flight. */
  | { kind: 'running' }
  /** One click: raise `field` from → to, then run again. */
  | { kind: 'raise'; field: LimitField; from: number; to: number }
  /** One click: run again — the cause was outside the agent. */
  | { kind: 'rerun' }
  /** The model session / provider needs the operator; no agent can fix it. */
  | { kind: 'llm' }
  /** No mechanical fix: hand it to the chief. */
  | { kind: 'chief' };

/** How far a single click may push each limit. Past it, the chief decides. */
export const LIMIT_CAP: Record<LimitField, number> = {
  max_iterations: 100,
  timeout_ms: 30 * 60_000,
  max_tokens: 400_000,
};

/** Double it, at least +10 for steps, never past the cap. */
export function raisedLimit(field: LimitField, current: number): number {
  const doubled = field === 'max_iterations' ? Math.max(current * 2, current + 10) : current * 2;
  return Math.min(LIMIT_CAP[field], doubled);
}

const runTs = (r: RecentRun) => Date.parse(r.started_at ?? r.created_at ?? '');

export function planFix(
  ex: FailureExplanation,
  agent: AgentLimits | null | undefined,
  recentRuns: RecentRun[],
  failedAt: number,
): FixPlan {
  const after = recentRuns.filter((r) => runTs(r) > failedAt);
  const ok = after
    .filter((r) => r.status === 'completed')
    .sort((a, b) => runTs(b) - runTs(a))[0];
  if (ok) return { kind: 'resolved', how: 'ran_ok', at: Date.parse(ok.completed_at ?? '') || runTs(ok) };

  if (ex.kind === 'max_turns' && agent?.max_iterations) {
    const hit = Number(ex.params.n);
    if (Number.isFinite(hit) && agent.max_iterations > hit) {
      return { kind: 'resolved', how: 'limit_raised', field: 'max_iterations', from: hit, to: agent.max_iterations };
    }
  }

  if (after.some((r) => r.status === 'running' || r.status === 'pending')) return { kind: 'running' };

  switch (ex.kind) {
    case 'max_turns': {
      const hit = Number(ex.params.n) || agent?.max_iterations || 0;
      const current = Math.max(hit, agent?.max_iterations ?? 0);
      return current > 0 && current < LIMIT_CAP.max_iterations
        ? { kind: 'raise', field: 'max_iterations', from: current, to: raisedLimit('max_iterations', current) }
        : { kind: 'chief' };
    }
    case 'timeout': {
      const current = agent?.timeout_ms ?? 0;
      return current > 0 && current < LIMIT_CAP.timeout_ms
        ? { kind: 'raise', field: 'timeout_ms', from: current, to: raisedLimit('timeout_ms', current) }
        : { kind: 'chief' };
    }
    case 'budget': {
      const current = agent?.max_tokens ?? 0;
      return current > 0 && current < LIMIT_CAP.max_tokens
        ? { kind: 'raise', field: 'max_tokens', from: current, to: raisedLimit('max_tokens', current) }
        : { kind: 'chief' };
    }
    case 'restart':
    case 'rate':
      return { kind: 'rerun' };
    case 'auth':
    case 'provider':
      return { kind: 'llm' };
    default:
      return { kind: 'chief' };
  }
}

/** A limit as a person reads it: steps as a count, time in minutes, tokens in k. */
export function fmtLimit(field: LimitField, v: number): string {
  if (field === 'timeout_ms') {
    const min = v / 60_000;
    return min >= 1 ? `${Math.round(min * 10) / 10} min` : `${Math.round(v / 1000)} s`;
  }
  if (field === 'max_tokens') return v >= 1000 ? `${Math.round(v / 1000)}k` : String(v);
  return String(v);
}
