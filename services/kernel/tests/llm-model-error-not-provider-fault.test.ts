/**
 * Observed in the live chat: a conversation pinned to NVIDIA carried a model
 * NVIDIA no longer serves. NVIDIA answered 400 three times, each one recorded
 * as a provider failure, so NVIDIA went into a backoff window. The next send
 * resolved to MiniMax — which is not even in the user's fallback chain — and
 * was handed NVIDIA's model name, so MiniMax replied "invalid params, unknown
 * model 'deepseek-ai/deepseek-coder-6.7b-instruct'". The dashboard printed
 * that under the heading "nvidia".
 *
 * Two independent faults, one per describe block below.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { classifyError, recordFailure, isBlocked, getHealth, _resetForTests } from "../src/core/llm/provider-health.js";
import { resolveProviderFor, type ChatLlmProvider } from "../src/core/llm/chat-adapters.js";

beforeEach(() => { _resetForTests(); });

const adapter = (name: string, ok = true): ChatLlmProvider =>
  ({ name, available: () => ok, chatCompletion: async () => ({ content: "", model: name, tokens_used: 0 }) }) as unknown as ChatLlmProvider;

describe("a model the provider does not serve is not the provider's fault", () => {
  it("recognises how the providers actually word it", () => {
    expect(classifyError(new Error(`minimax API error 400: {"message":"invalid params, unknown model 'deepseek-ai/deepseek-coder-6.7b-instruct' (2013)"}`))).toBe("model");
    expect(classifyError(new Error("The model `gpt-9` does not exist or you do not have access to it"))).toBe("model");
    expect(classifyError(new Error("404 model_not_found"))).toBe("model");
    expect(classifyError(new Error("model claude-opus-9 is not available"))).toBe("model");
  });

  it("still classifies the faults that ARE the provider's", () => {
    expect(classifyError(new Error("429 rate limit exceeded"))).toBe("rate-limit");
    expect(classifyError(new Error("401 unauthorized"))).toBe("auth");
    expect(classifyError(new Error("402 insufficient_quota"))).toBe("exhausted");
    expect(classifyError(new Error("socket hang up"))).toBe("transient");
  });

  it("records it without blocking the provider or counting a strike", () => {
    recordFailure("nvidia", "model");
    recordFailure("nvidia", "model");
    recordFailure("nvidia", "model");
    expect(isBlocked("nvidia")).toBe(false);
    expect(getHealth("nvidia").failures).toBe(0);
    expect(getHealth("nvidia").lastFailureKind).toBe("model");
  });

  it("a real provider fault still blocks", () => {
    recordFailure("nvidia", "transient");
    expect(isBlocked("nvidia")).toBe(true);
  });
});

describe("a model never travels to a substitute provider", () => {
  it("keeps the model when the provider asked for is the one that answers", () => {
    const providers = new Map([["nvidia", adapter("nvidia")], ["minimax", adapter("minimax")]]);
    const r = resolveProviderFor(providers, "nvidia", "nvidia/nemotron-3-super-120b-a12b");
    expect(r?.substituted).toBe(false);
    expect(r?.provider.name).toBe("nvidia");
    expect(r?.model).toBe("nvidia/nemotron-3-super-120b-a12b");
  });

  it("drops the model when someone else stands in", () => {
    const providers = new Map([["nvidia", adapter("nvidia", false)], ["minimax", adapter("minimax")]]);
    const r = resolveProviderFor(providers, "nvidia", "nvidia/nemotron-3-super-120b-a12b");
    expect(r?.substituted).toBe(true);
    expect(r?.provider.name).not.toBe("nvidia");
    expect(r?.model).toBe("");
  });

  it("is null when nothing can answer", () => {
    const providers = new Map([["nvidia", adapter("nvidia", false)]]);
    expect(resolveProviderFor(providers, "nvidia", "m")).toBeNull();
  });
});
