/**
 * "Does this provider work for Kernl?" for one provider, right now.
 *
 * Kernl's agents are a model plus tools, so the test is a real request that
 * carries one trivial tool and requires the model to call it. A provider that
 * answers in prose fails with `no_tools`: the key works, agents would not.
 */

import type { ChatLlmProvider } from "./chat-adapters.js";
import { classifyProviderError, type ProviderErrorCode } from "./provider-errors.js";

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  toolCall: boolean;
  error?: { code: ProviderErrorCode; detail: string };
}

const PROBE_TOOL = {
  name: "kernl_connect_echo",
  description: "Echo a word back. Call this tool; do not answer in prose.",
  input_schema: {
    type: "object",
    properties: { word: { type: "string", description: "The word to echo back" } },
    required: ["word"],
  },
};
const PROBE_PROMPT = 'Call the kernl_connect_echo tool with word set to "ok". Reply with the tool call only.';

export async function probeAdapter(
  adapter: ChatLlmProvider,
  opts: { model?: string; timeoutMs: number; local?: boolean },
): Promise<ProbeResult> {
  const started = Date.now();
  if (!adapter.available()) {
    return {
      ok: false, latencyMs: 0, model: opts.model ?? "", toolCall: false,
      error: { code: opts.local ? "unreachable" : "auth", detail: "missing credentials" },
    };
  }
  // The Claude Code shim runs one turn and ignores tools; it only has to answer.
  const toolLoop = adapter.supportsToolLoop !== false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      adapter.chatCompletion(
        [{ role: "user", content: toolLoop ? PROBE_PROMPT : "Reply with the single word: ok" }],
        {
          ...(opts.model ? { model: opts.model } : {}),
          ...(toolLoop ? { tools: [PROBE_TOOL] } : {}),
          // Reasoning models spend tokens thinking before they call the tool.
          max_tokens: 1024,
          caller: "provider-connect",
        },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not respond in ${opts.timeoutMs}ms`)), opts.timeoutMs);
      }),
    ]);
    const latencyMs = Date.now() - started;
    const toolCall = result.tool_calls?.some((c) => c.name === PROBE_TOOL.name) ?? false;
    if (toolLoop && !toolCall) {
      return { ok: false, latencyMs, model: result.model, toolCall, error: { code: "no_tools", detail: (result.content ?? "").slice(0, 300) } };
    }
    return { ok: true, latencyMs, model: result.model, toolCall };
  } catch (err) {
    return {
      ok: false, latencyMs: Date.now() - started, model: opts.model ?? "", toolCall: false,
      error: classifyProviderError(err, { local: opts.local }),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
