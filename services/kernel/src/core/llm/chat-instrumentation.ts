import * as providerHealth from "./provider-health.js";
// Through the host, not ./call-log.js: extension bundles copy this file, and
// the boundary gate keeps call-log out of them.
import { recordLlmCall } from "../../sdk/facades.js";
import { getCatalogEntry } from "./provider-catalog.js";
import { logLlmStart, logLlmEnd, logLlmFail } from "./logger.js";
import type { ChatLlmProvider } from "./chat-provider.js";

/** Calls made only to learn about a model; see tool-verifier.ts. */
export const PROBE_CALLER = "tool-verify";

/**
 * Wrap a provider's `chatCompletion` to report latency + classify failures
 * into the shared health tracker. Mutates the instance once; safe to call
 * for instances stored under multiple Map keys (only wraps the function ref,
 * which we replace exactly once via the `__instrumented` marker).
 */
export function instrumentProvider<P extends ChatLlmProvider>(p: P): P {
  const marker = p as unknown as { __healthInstrumented?: boolean };
  if (marker.__healthInstrumented) return p;
  marker.__healthInstrumented = true;

  const original = p.chatCompletion.bind(p);
  // The call log groups by catalog slug ("claude-code"), adapters name
  // themselves by their legacy alias ("claude_code").
  const slug = getCatalogEntry(p.name)?.slug ?? p.name;
  p.chatCompletion = async (msgs, opts) => {
    const t0 = Date.now();
    const requestedModel = opts?.model;
    const caller = opts?.caller;
    // Pull a short preview of the last user message for verbose mode.
    let preview: string | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "user") continue;
      preview = typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join(" ");
      break;
    }
    logLlmStart({
      slug: p.name,
      model: requestedModel,
      messageCount: msgs.length,
      toolCount: opts?.tools?.length ?? 0,
      caller,
      preview,
    });

    try {
      const result = await original(msgs, opts);
      const durationMs = Date.now() - t0;
      providerHealth.recordSuccess(p.name, durationMs);
      logLlmEnd({
        slug: p.name,
        model: result.model || requestedModel,
        durationMs,
        tokens: result.tokens_used,
        toolCalls: result.tool_calls?.length ?? 0,
        caller,
        preview: result.content,
      });
      recordLlmCall({
        slug,
        model: result.model || requestedModel || "",
        ok: true,
        latencyMs: durationMs,
        // Adapters that only report a total leave the split undefined.
        inputTokens: result.input_tokens,
        outputTokens: result.output_tokens ?? (result.input_tokens === undefined ? result.tokens_used : undefined),
        cacheReadTokens: result.cache_read_tokens,
        cacheWriteTokens: result.cache_write_tokens,
        costUsd: result.cost_usd,
        caller,
        startedAt: t0,
        toolsSent: opts?.tools?.length ?? 0,
        toolCalls: result.tool_calls?.length ?? 0,
      }, { silent: true });
      return result;
    } catch (err) {
      const durationMs = Date.now() - t0;
      const kind = providerHealth.classifyError(err);
      const message = err instanceof Error ? err.message : String(err);
      // Probing models one by one (tool-verifier.ts) is expected to hit dead
      // ones; counting those as provider strikes put all of NVIDIA in backoff
      // for minutes while it ran. A probe says nothing about the provider.
      if (caller !== PROBE_CALLER) providerHealth.recordFailure(p.name, kind);
      // A model the provider advertises but does not serve retires itself
      // here, so the picker stops handing it to the next person.
      providerHealth.reportModelFault(p.name, requestedModel ?? "", kind, message);
      logLlmFail({
        slug: p.name,
        model: requestedModel,
        durationMs,
        kind,
        message,
        caller,
      });
      recordLlmCall({
        slug,
        model: requestedModel ?? "(default)",
        ok: false,
        latencyMs: durationMs,
        errorKind: kind,
        errorMsg: message,
        caller,
        startedAt: t0,
        toolsSent: opts?.tools?.length ?? 0,
      }, { silent: true });
      throw err;
    }
  };
  return p;
}
