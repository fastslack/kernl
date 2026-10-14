/**
 * OpenAI's reasoning models (GPT-5, o-series) answered every request with a 400:
 * "Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens'", so
 * connecting gpt-5-nano failed with "Algo falló al conectar".
 */
import { describe, it, expect } from "bun:test";
import { fitOpenAiParams } from "../src/core/llm/chat-openai.js";

describe("fitOpenAiParams", () => {
  it("sends max_completion_tokens to the official API", () => {
    const body: Record<string, unknown> = { model: "gpt-4.1-mini", max_tokens: 1024, temperature: 0.2 };
    fitOpenAiParams(body, "openai", "gpt-4.1-mini");
    expect(body).toEqual({ model: "gpt-4.1-mini", max_completion_tokens: 1024, temperature: 0.2 });
  });

  it("drops sampling the reasoning models refuse", () => {
    for (const model of ["gpt-5-nano", "gpt-5", "gpt-5.1-mini", "o3-mini", "o4-mini"]) {
      const body: Record<string, unknown> = { max_tokens: 64, temperature: 0, top_p: 0.9 };
      fitOpenAiParams(body, "openai", model);
      // The cap also covers the reasoning: a small one comes back empty.
      expect(body).toEqual({ max_completion_tokens: 8192 });
    }
    const keep: Record<string, unknown> = { temperature: 1 };
    fitOpenAiParams(keep, "openai", "gpt-5-nano");
    expect(keep).toEqual({ temperature: 1 });
  });

  it("leaves OpenAI-compatible providers alone", () => {
    const body: Record<string, unknown> = { max_tokens: 64, temperature: 0 };
    fitOpenAiParams(body, "nvidia", "openai/gpt-oss-20b");
    fitOpenAiParams(body, "openrouter", "openai/gpt-5-nano");
    expect(body).toEqual({ max_tokens: 64, temperature: 0 });
  });

  it("does not mistake other names for reasoning models", () => {
    const body: Record<string, unknown> = { max_tokens: 64, temperature: 0.3 };
    fitOpenAiParams(body, "openai", "omni-moderation-latest");
    const big: Record<string, unknown> = { max_tokens: 20000 };
    fitOpenAiParams(big, "openai", "gpt-5");
    expect(big).toEqual({ max_completion_tokens: 20000 });
    expect(body).toEqual({ max_completion_tokens: 64, temperature: 0.3 });
  });
});
