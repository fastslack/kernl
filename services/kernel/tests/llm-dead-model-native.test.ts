import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { instrumentProvider } from "../src/core/llm/chat-instrumentation.js";
import { buildModelChain } from "../src/modules/agents/executor/model-chain.js";
import * as providerHealth from "../src/core/llm/provider-health.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-provider.js";

/**
 * Agents that run without Claude Code call the chat adapters directly, often with
 * no model: the adapter picks its default. A default the provider stopped serving
 * was logged as "(default)" and never retired (06/11).
 */

const DEAD = "acme/dead-model";
const NOT_SERVED = "nvidia API error 404: {\"status\":404,\"title\":\"Not Found\",\"detail\":\"Function 'ac74040f-9fc9-4c5e-ac74-279ba5161d69': Not found for account 'x'\"}";

function adapter(name: string, model: string, fail: boolean): ChatLlmProvider {
  return {
    name,
    available: () => true,
    getDefaultModel: () => model,
    async chatCompletion() {
      if (fail) throw new Error(NOT_SERVED);
      return { content: "ok", model, tool_calls: [], tokens_used: 1 } as never;
    },
  } as unknown as ChatLlmProvider;
}

beforeEach(() => providerHealth._resetForTests());
afterEach(() => { providerHealth.setModelFaultSink(null); providerHealth._resetForTests(); });

describe("an adapter called without a model", () => {
  it("reports the fault under the adapter's default model", async () => {
    const seen: Array<[string, string]> = [];
    providerHealth.setModelFaultSink((slug, model) => { seen.push([slug, model]); });
    const p = instrumentProvider(adapter("nvidia", DEAD, true));
    await expect(p.chatCompletion([{ role: "user", content: "hi" }], { caller: "unit" })).rejects.toThrow();
    expect(seen).toEqual([["nvidia", DEAD]]);
  });

  it("marks the default model dead after three failures in a row", async () => {
    const p = instrumentProvider(adapter("nvidia", DEAD, true));
    for (let i = 0; i < 3; i++) await p.chatCompletion([{ role: "user", content: "hi" }], { caller: "unit" }).catch(() => {});
    expect(providerHealth.isModelDead("nvidia", DEAD)).toBe(true);
  });
});

describe("an agent's model chain", () => {
  it("puts a link whose model is dead after the others", () => {
    for (let i = 0; i < 3; i++) providerHealth.recordModelOutcome("nvidia", DEAD, false);
    const providers = new Map<string, ChatLlmProvider>([
      ["nvidia", adapter("nvidia", DEAD, true)],
      ["minimax", adapter("minimax", "MiniMax-M3", false)],
    ]);
    const r = buildModelChain({
      agentName: "a", agentChain: [], toolCount: 0, defaultProvider: "nvidia", providers,
      globalChain: [{ provider: "nvidia", model: "" }, { provider: "minimax", model: "" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chain.map((e) => e.provider.name)).toEqual(["minimax", "nvidia"]);
  });
});
