/**
 * LLM calls running right now, for the LIVE pill's "en curso" view.
 *
 * The call log only learns about a call when it ends, so a three-minute agent
 * turn is invisible until it is over. Whoever starts a call registers it here
 * and ends it in a `finally`; GET /api/llm/chain reads the list.
 *
 * Calls nest: the llm() driver reaches Claude Code through an adapter that is
 * itself instrumented. Only the outermost layer registers — it knows the
 * chain link being tried — and every layer inside it is a no-op, so one call
 * never shows twice.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface InFlightLlmCall {
  id: string;
  /** Provider slug or legacy alias, as the caller knows it; the chain route normalises. */
  slug: string;
  /** Requested model; undefined when the provider's default was used. */
  model?: string;
  caller?: string;
  startedAt: number;
}

// One map for the kernel and every extension bundle that carries a copy of
// this file, same as claude-limits.ts: an agent run in a bundle has to show
// up in the kernel's chain route.
const INFLIGHT_KEY = Symbol.for("kernl.llmInFlight.v1");
const SEQ_KEY = Symbol.for("kernl.llmInFlightSeq.v1");
const SCOPE_KEY = Symbol.for("kernl.llmInFlightScope.v1");

/** Set while a tracked call runs; shared across bundles like the map. */
function scope(): AsyncLocalStorage<true> {
  const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<true> | undefined>;
  return (g[SCOPE_KEY] ??= new AsyncLocalStorage<true>());
}

function registry(): Map<string, InFlightLlmCall> {
  const g = globalThis as unknown as Record<symbol, Map<string, InFlightLlmCall> | undefined>;
  return (g[INFLIGHT_KEY] ??= new Map<string, InFlightLlmCall>());
}

function nextId(): string {
  const g = globalThis as unknown as Record<symbol, number | undefined>;
  g[SEQ_KEY] = (g[SEQ_KEY] ?? 0) + 1;
  return `llm-${g[SEQ_KEY]}`;
}

/**
 * Mark a call as running. Returns the function that ends it — call it in a
 * `finally`; calling it again is a no-op.
 */
export function beginLlmCall(call: { slug: string; model?: string; caller?: string }): () => void {
  if (scope().getStore()) return () => {};
  const id = nextId();
  registry().set(id, { id, slug: call.slug, model: call.model || undefined, caller: call.caller, startedAt: Date.now() });
  return () => { registry().delete(id); };
}

/**
 * Run `fn` as one LLM call: registered for its duration (unless an outer
 * layer already registered it) and marked so nested layers do not register
 * it again.
 */
export async function trackLlmCall<T>(call: { slug: string; model?: string; caller?: string }, fn: () => Promise<T>): Promise<T> {
  const end = beginLlmCall(call);
  try {
    return await scope().run(true, fn);
  } finally {
    end();
  }
}

/** Every call still running, oldest first. */
export function listInFlight(): InFlightLlmCall[] {
  return [...registry().values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** Tests only. */
export function clearInFlight(): void {
  registry().clear();
}
