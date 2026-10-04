import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { matchPrices, ModelPriceStore } from "../src/core/llm/model-prices.js";

// A slice of LiteLLM's model_prices_and_context_window.json, in its real shape:
// per-token USD, a `litellm_provider`, and most keys prefixed with the provider.
const LITELLM = {
  sample_spec: { input_cost_per_token: 0, litellm_provider: "openai", mode: "chat" },
  "gpt-4o-mini": { input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7, litellm_provider: "openai", mode: "chat" },
  "gpt-5-nano": { input_cost_per_token: 5e-8, output_cost_per_token: 4e-7, litellm_provider: "openai", mode: "chat" },
  "text-embedding-3-small": { input_cost_per_token: 2e-8, output_cost_per_token: 0, litellm_provider: "openai", mode: "embedding" },
  "deepseek/deepseek-chat": { input_cost_per_token: 2.8e-7, output_cost_per_token: 4.2e-7, litellm_provider: "deepseek", mode: "chat" },
  "openrouter/openai/gpt-4o-mini": { input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7, litellm_provider: "openrouter", mode: "chat" },
  "minimax/MiniMax-M2.5": { input_cost_per_token: 3e-7, output_cost_per_token: 1.2e-6, litellm_provider: "minimax", mode: "chat" },
  "claude-haiku-4-5-20251001": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, litellm_provider: "anthropic", mode: "chat" },
};

describe("matchPrices", () => {
  it("prices the provider's own models, per million tokens", () => {
    const got = matchPrices(LITELLM, "openai", ["gpt-4o-mini", "gpt-5-nano", "gpt-unknown"]);
    expect(got).toEqual([
      { provider: "openai", model: "gpt-4o-mini", inputPerMTok: 0.15, outputPerMTok: 0.6 },
      { provider: "openai", model: "gpt-5-nano", inputPerMTok: 0.05, outputPerMTok: 0.4 },
    ]);
  });

  it("strips LiteLLM's provider prefix and maps kernel slugs to LiteLLM providers", () => {
    expect(matchPrices(LITELLM, "deepseek", ["deepseek-chat"])[0]).toMatchObject({ model: "deepseek-chat", inputPerMTok: 0.28 });
    expect(matchPrices(LITELLM, "openrouter", ["openai/gpt-4o-mini"])[0]).toMatchObject({ model: "openai/gpt-4o-mini" });
    expect(matchPrices(LITELLM, "claude", ["claude-haiku-4-5-20251001"])[0]).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 });
  });

  it("matches ids case-insensitively but reports the provider's own spelling", () => {
    expect(matchPrices(LITELLM, "minimax", ["minimax-m2.5"])[0]).toMatchObject({ model: "minimax-m2.5", inputPerMTok: 0.3 });
  });

  it("never prices a model from another provider or a non-chat mode", () => {
    // gpt-4o-mini exists under openai and openrouter; deepseek must not borrow it.
    expect(matchPrices(LITELLM, "deepseek", ["gpt-4o-mini"])).toEqual([]);
    expect(matchPrices(LITELLM, "openai", ["text-embedding-3-small"])).toEqual([]);
  });

  it("knows nothing about local runtimes or providers LiteLLM does not cover", () => {
    expect(matchPrices(LITELLM, "lmstudio", ["gpt-4o-mini"])).toEqual([]);
    expect(matchPrices(LITELLM, "ollama", ["gpt-4o-mini"])).toEqual([]);
    expect(matchPrices(LITELLM, "claude-code", ["sonnet"])).toEqual([]);
  });
});

describe("ModelPriceStore", () => {
  let store: ModelPriceStore;
  beforeEach(() => {
    store = new ModelPriceStore(new Database(":memory:"));
  });

  it("replaces a provider's prices on each refresh", () => {
    store.replace("openai", [{ provider: "openai", model: "gpt-4o-mini", inputPerMTok: 0.15, outputPerMTok: 0.6 }]);
    store.replace("openai", [{ provider: "openai", model: "gpt-5-nano", inputPerMTok: 0.05, outputPerMTok: 0.4 }]);
    expect(store.list().map((p) => p.model)).toEqual(["gpt-5-nano"]);
  });

  it("ranks the cheapest models of the given providers, input + output", () => {
    store.replace("openai", [
      { provider: "openai", model: "gpt-4o-mini", inputPerMTok: 0.15, outputPerMTok: 0.6 },
      { provider: "openai", model: "gpt-5-nano", inputPerMTok: 0.05, outputPerMTok: 0.4 },
    ]);
    store.replace("deepseek", [{ provider: "deepseek", model: "deepseek-chat", inputPerMTok: 0.28, outputPerMTok: 0.42 }]);
    store.replace("claude", [{ provider: "claude", model: "claude-haiku-4-5-20251001", inputPerMTok: 1, outputPerMTok: 5 }]);

    expect(store.cheapest(["openai", "deepseek", "claude"], 3).map((p) => p.model))
      .toEqual(["gpt-5-nano", "deepseek-chat", "gpt-4o-mini"]);
    // A provider that is not ready right now is left out.
    expect(store.cheapest(["deepseek"], 3).map((p) => p.model)).toEqual(["deepseek-chat"]);
  });
});
