/**
 * Which models can call tools — what the Chief's, the agents' and the chat's
 * pickers filter on. The numbers that motivated it, measured 2026-10-08 on a
 * live install: NVIDIA lists 68 chat models and LiteLLM knows the tool support
 * of none of them; OpenAI lists 83, LiteLLM covers 77, and three of those are
 * definite no's (`o4-mini-deep-research`, `sora-2`, `sora-2-pro`).
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  isToolsUnsupportedError,
  observeToolSupport,
  storeLiteLlmToolSupport,
  toolSupportFor,
  toolsByRule,
} from "../src/core/llm/model-caps.js";
import { matchToolSupport } from "../src/core/llm/model-prices.js";
import { attachDb, record } from "../src/core/llm/call-log.js";

const table = {
  "gpt-5.6": { litellm_provider: "openai", mode: "chat", supports_function_calling: true },
  "o4-mini-deep-research": { litellm_provider: "openai", mode: "responses", supports_function_calling: false },
  "sora-2": { litellm_provider: "openai", mode: "video_generation" },
  "minimax/MiniMax-M2": { litellm_provider: "minimax", mode: "chat", supports_function_calling: true },
  "chat-old": { litellm_provider: "openai", mode: "chat" },
};

describe("LiteLLM's verdicts", () => {
  it("keeps explicit answers and treats non-chat entries as no", () => {
    const v = matchToolSupport(table, "openai", ["gpt-5.6", "o4-mini-deep-research", "sora-2", "chat-old", "gpt-unlisted"]);
    expect(Object.fromEntries(v)).toEqual({ "gpt-5.6": true, "o4-mini-deep-research": false, "sora-2": false });
  });

  it("strips the provider prefix and ignores providers it cannot map", () => {
    expect(matchToolSupport(table, "minimax", ["MiniMax-M2"]).get("MiniMax-M2")).toBe(true);
    expect(matchToolSupport(table, "ollama", ["gpt-5.6"]).size).toBe(0);
  });
});

describe("name rules", () => {
  it("only says no for families that never take tools", () => {
    for (const id of ["babbage-002", "davinci-002", "gpt-3.5-turbo-instruct", "chat-latest", "chatgpt-4o-latest", "sora-2-pro", "o1-mini"]) {
      expect(toolsByRule(id)).toBe(false);
    }
    // Everything else is unknown, never a guessed yes.
    for (const id of ["gpt-5.6", "meta/llama-3.3-70b-instruct", "01-ai/yi-large", "o3"]) {
      expect(toolsByRule(id)).toBeUndefined();
    }
  });
});

describe("merging the sources", () => {
  it("observed beats LiteLLM, LiteLLM beats the rules, the rest stays unknown", () => {
    const db = new Database(":memory:");
    storeLiteLlmToolSupport(db as never, "openai", new Map([["gpt-5.6", true], ["chat-latest", true]]));
    observeToolSupport(db as never, "openai", "chat-latest", false);
    // A later LiteLLM refresh must not undo what this Kernl saw.
    storeLiteLlmToolSupport(db as never, "openai", new Map([["chat-latest", true]]));
    const v = toolSupportFor(db as never, "openai", ["gpt-5.6", "chat-latest", "babbage-002", "gpt-unknown"]);
    expect(v.get("gpt-5.6")).toBe(true);
    expect(v.get("chat-latest")).toBe(false);
    expect(v.get("babbage-002")).toBe(false);
    expect(v.get("gpt-unknown")).toBeUndefined();
  });

  it("answers from the rules without a database", () => {
    expect(toolSupportFor(null, "openai", ["babbage-002"]).get("babbage-002")).toBe(false);
  });
});

describe("learning from calls", () => {
  it("a returned tool call proves yes, a refused tool request proves no, plain text proves nothing", () => {
    const db = new Database(":memory:");
    attachDb(db as never);
    const base = { slug: "nvidia", latencyMs: 10, startedAt: Date.now() };
    record({ ...base, model: "meta/llama-3.3-70b-instruct", ok: true, toolsSent: 12, toolCalls: 1 }, { silent: true });
    record({ ...base, model: "01-ai/yi-large", ok: false, toolsSent: 12, errorMsg: "400 Bad Request: tool calling is not supported for this model" }, { silent: true });
    record({ ...base, model: "google/gemma-3", ok: true, toolsSent: 12, toolCalls: 0 }, { silent: true });
    record({ ...base, model: "mistral/x", ok: true, toolsSent: 0, toolCalls: 0 }, { silent: true });
    const v = toolSupportFor(db as never, "nvidia", ["meta/llama-3.3-70b-instruct", "01-ai/yi-large", "google/gemma-3", "mistral/x"]);
    expect(v.get("meta/llama-3.3-70b-instruct")).toBe(true);
    expect(v.get("01-ai/yi-large")).toBe(false);
    expect(v.get("google/gemma-3")).toBeUndefined();
    expect(v.get("mistral/x")).toBeUndefined();
  });

  it("recognises the providers' 'no tools' wording and nothing else", () => {
    expect(isToolsUnsupportedError("This model does not support tools")).toBe(true);
    expect(isToolsUnsupportedError("Function calling is not supported for this model.")).toBe(true);
    expect(isToolsUnsupportedError("tool use is not supported")).toBe(true);
    // NVIDIA NIM (vLLM) served without tool parsing, 2026-10-08.
    expect(isToolsUnsupportedError('nvidia API error 400: {"error":{"message":"\\"auto\\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}}')).toBe(true);
    expect(isToolsUnsupportedError("400 Bad Request: max_tokens is too large")).toBe(false);
    expect(isToolsUnsupportedError("rate limit exceeded")).toBe(false);
  });
});

describe("a model NVIDIA lists but no longer serves", () => {
  it("is the model's fault, not NVIDIA's", async () => {
    const { classifyError } = await import("../src/core/llm/provider-health.js");
    // 46 of 68 listed models answered this on 2026-10-08; counted against the
    // provider, they put NVIDIA in backoff while the verifier ran.
    const msg = 'nvidia API error 404: {"status":404,"title":"Not Found","detail":"Function \'23bd454d-b225-49a3-8118-582a62fc5123\': Not found for account \'x\'"}';
    expect(classifyError(new Error(msg))).toBe("model");
    expect(classifyError(new Error("nvidia API error 503: upstream unavailable"))).not.toBe("model");
  });
});
