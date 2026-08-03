/**
 * Is there an LLM that can actually run an agent?
 *
 * "Configured" collapsed three different facts into one flag, and the gap
 * between them is how an install ends up looking healthy while nothing works:
 *
 *   1. installed     — a binary or an endpoint exists
 *   2. authenticated — a credential is present
 *   3. usable        — a valid credential that can carry a tool loop
 *
 * `LlmProvider.isReady()` answers (1). The claude-code provider ships its CLI
 * inside the Agent SDK, so it answered `true` on a machine with no account at
 * all, and its own `capabilities.tools` is `false` — it cannot run the tool
 * loop a native agent needs. A gate built on that flag would wave through the
 * exact configuration this module exists to catch.
 *
 * So the verdict here is empirical: send a real request carrying one trivial
 * tool and require the provider to call it. A provider that answers in prose
 * fails, an expired key fails, and a provider that cannot take tools at all is
 * never asked. Nothing short of a tool call counts as ready.
 */

import type { ChatLlmProvider } from "./chat-adapters.js";
import type { ChatCompletionResult, ToolDefinitionForLlm } from "./chat-types.js";
import { hasStoredCredential } from "./claude-code-auth.js";
import { log } from "../logger.js";

/** Registered under both spellings; the adapter answers to either. */
function isClaudeCode(name: string): boolean {
  return name === "claude_code" || name === "claude-code";
}

export type LlmReadinessReason =
  /** A provider answered with a tool call. */
  | "ok"
  /**
   * No provider can run the *native* tool loop, but the Claude Code SDK is
   * installed and signed in — and it runs tools inside itself. Agents with
   * `executor_type: "claude_code"` work; agents left on the native executor do
   * not. Enough to let the product open, not enough to call it fully wired.
   */
  | "ok-sdk-only"
  /** Nothing is installed or configured — no provider reports itself ready. */
  | "no-provider"
  /** Providers exist, but none of them can carry a tool loop. */
  | "no-tool-capable"
  /** A provider was reachable and rejected the credential. */
  | "auth"
  /** A provider answered, but never called the tool. */
  | "no-tool-call"
  /** Transport, timeout, or anything else that isn't one of the above. */
  | "error";

export interface LlmReadiness {
  ok: boolean;
  reason: LlmReadinessReason;
  /** Which provider satisfied the probe, or the last one tried. */
  provider?: string;
  model?: string;
  /** Raw error or short explanation, for the operator. Never shown alone. */
  detail?: string;
  /** ISO timestamp of the probe this verdict came from. */
  checkedAt: string;
}

/** The whole point is that the model has to *do* something, not describe it. */
const PROBE_TOOL: ToolDefinitionForLlm = {
  name: "kernl_readiness_echo",
  description:
    "Echo a word back to the caller. This is a connectivity check: call this tool, do not answer in prose.",
  input_schema: {
    type: "object",
    properties: {
      word: { type: "string", description: "The word to echo back" },
    },
    required: ["word"],
  },
};

const PROBE_PROMPT =
  'Call the kernl_readiness_echo tool with word set to "ready". Reply with the tool call only, no prose.';

/** One provider gets this long before it is written off. The claude-code path
 *  spawns a CLI, so it needs more room than an HTTP fetch. */
function probeTimeoutFor(name: string): number {
  return name === "claude-code" || name === "claude_code" ? 45_000 : 20_000;
}

function classify(err: unknown): { reason: LlmReadinessReason; detail: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (/401|403|unauthor|invalid[_ -]?api[_ -]?key|authentication|not logged in/i.test(raw)) {
    return { reason: "auth", detail: raw };
  }
  return { reason: "error", detail: raw };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not respond in ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run the probe against a provider map, newest verdict wins.
 *
 * Providers are tried in map order and the first tool call ends it, so the
 * usual cost is a single request of a few dozen tokens. A provider that
 * declares `supportsToolLoop === false` is skipped rather than failed: it is
 * not broken, it just cannot do this job.
 */
export async function probeLlmReadiness(
  providers: Map<string, ChatLlmProvider>,
): Promise<LlmReadiness> {
  const checkedAt = new Date().toISOString();

  // The same instance is registered under aliases (claude_code / claude-code);
  // probing it twice would double the cost and the wait for no new information.
  const seen = new Set<ChatLlmProvider>();
  const candidates: ChatLlmProvider[] = [];
  let sawAnyReady = false;
  let sdkProvider: ChatLlmProvider | null = null;

  for (const provider of providers.values()) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    if (!provider.available()) continue;
    sawAnyReady = true;
    if (provider.supportsToolLoop === false) {
      // Cannot carry the *native* loop. The Claude Code SDK still runs tools,
      // just inside itself, which is what `executor_type: "claude_code"`
      // agents use — so remember it as a fallback rather than writing it off.
      if (isClaudeCode(provider.name)) sdkProvider = provider;
      continue;
    }
    candidates.push(provider);
  }

  const sdkFallback = (): LlmReadiness | null => {
    if (!sdkProvider || !hasStoredCredential()) return null;
    return {
      ok: true,
      reason: "ok-sdk-only",
      provider: sdkProvider.name,
      checkedAt,
      detail:
        "Only the Claude Code SDK is available. Agents set to the claude_code executor will run; " +
        "agents on the native executor will not, because no provider can run a native tool loop.",
    };
  };

  if (candidates.length === 0) {
    return (
      sdkFallback() ??
      (sawAnyReady
        ? {
            ok: false,
            reason: "no-tool-capable",
            checkedAt,
            detail:
              "The only providers configured cannot execute tool calls, so no agent can run. " +
              "Configure a provider that supports tools, or sign in to Claude Code and set your " +
              "agents to the claude_code executor.",
          }
        : {
            ok: false,
            reason: "no-provider",
            checkedAt,
            detail: "No LLM provider is configured. Add an API key or sign in to one.",
          })
    );
  }

  let last: LlmReadiness | null = null;

  for (const provider of candidates) {
    const t0 = Date.now();
    try {
      const result: ChatCompletionResult = await withTimeout(
        provider.chatCompletion([{ role: "user", content: PROBE_PROMPT }], {
          tools: [PROBE_TOOL],
          max_tokens: 128,
          caller: "llm-readiness",
        }),
        probeTimeoutFor(provider.name),
        provider.name,
      );

      const called = result.tool_calls?.some((c) => c.name === PROBE_TOOL.name) ?? false;
      if (called) {
        log.info(`LLM readiness: ${provider.name} answered with a tool call in ${Date.now() - t0}ms`);
        return { ok: true, reason: "ok", provider: provider.name, model: result.model, checkedAt };
      }

      // Answered, but in prose. The credential works and the wire format does
      // not — an agent handing this provider its catalogue would loop without
      // ever executing anything.
      last = {
        ok: false,
        reason: "no-tool-call",
        provider: provider.name,
        model: result.model,
        checkedAt,
        detail:
          `${provider.name} replied without calling the tool. ` +
          `The credential works, but this model will not execute tool calls.`,
      };
    } catch (err) {
      const { reason, detail } = classify(err);
      last = { ok: false, reason, provider: provider.name, checkedAt, detail };
    }
    log.warn(`LLM readiness: ${provider.name} failed the probe — ${last?.reason}: ${last?.detail}`);
  }

  // Every tool-capable provider failed. A signed-in SDK still gets the product
  // open for claude_code-executor agents, which beats a hard block.
  return (
    sdkFallback() ??
    last ?? { ok: false, reason: "error", checkedAt, detail: "Probe produced no result." }
  );
}

// ── Cached verdict ────────────────────────────────────────────────────────
//
// The HTTP gate runs on every API request, so it must never wait on a live
// probe. It reads the cache; a stale entry is served once while a refresh runs
// behind it. Boot fills the cache, saving provider config and a credential
// failure inside an agent run both mark it stale.

let cached: LlmReadiness | null = null;
let stale = true;
let inFlight: Promise<LlmReadiness> | null = null;
let providerSource: (() => Map<string, ChatLlmProvider>) | null = null;

/** Point the module at the live provider map. Called once during bootstrap. */
export function initLlmReadiness(source: () => Map<string, ChatLlmProvider>): void {
  providerSource = source;
  stale = true;
}

/** The last verdict, or null before the first probe finishes. */
export function getLlmReadiness(): LlmReadiness | null {
  return cached;
}

/**
 * Force the next check to re-probe.
 *
 * Called when provider config is saved, and when an agent run dies on
 * credentials or an empty chain — the failure path already knows something
 * changed, so the cache learns about it without polling.
 */
export function markLlmReadinessStale(why: string): void {
  if (!stale) log.info(`LLM readiness marked stale: ${why}`);
  stale = true;
}

/**
 * Probe if needed and return the verdict.
 *
 * Concurrent callers share one in-flight probe, so a burst of requests after a
 * restart cannot turn into a burst of paid calls.
 */
export async function ensureLlmReadiness(force = false): Promise<LlmReadiness> {
  if (!providerSource) {
    return {
      ok: false,
      reason: "no-provider",
      checkedAt: new Date().toISOString(),
      detail: "Readiness probe is not wired up yet.",
    };
  }
  if (!force && !stale && cached) return cached;
  if (inFlight) return inFlight;

  inFlight = probeLlmReadiness(providerSource())
    .then((r) => {
      cached = r;
      stale = false;
      return r;
    })
    .catch((err) => {
      // A probe that throws must not pin `stale` false, or one bad moment
      // would lock the verdict in until the next restart.
      const fallback: LlmReadiness = {
        ok: false,
        reason: "error",
        checkedAt: new Date().toISOString(),
        detail: err instanceof Error ? err.message : String(err),
      };
      cached = fallback;
      return fallback;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * The synchronous answer the HTTP gate uses.
 *
 * Never waits. A stale entry is returned as-is and a refresh is kicked off in
 * the background, so request latency stays flat whatever the provider is doing.
 */
export function readinessForGate(): LlmReadiness | null {
  if (stale && providerSource && !inFlight) {
    void ensureLlmReadiness().catch(() => {});
  }
  return cached;
}

/** Test seam — drops all cached state. */
export function resetLlmReadinessForTests(): void {
  cached = null;
  stale = true;
  inFlight = null;
  providerSource = null;
}
