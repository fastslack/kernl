/**
 * OpenAI's reasoning models (GPT-5, o-series) answered every request with a 400:
 * "Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens'", so
 * connecting gpt-5-nano failed with "Algo falló al conectar".
 */
import { describe, it, expect } from "bun:test";
import { fitOpenAiParams, usesResponsesApi, buildResponsesBody, parseResponsesResult } from "../src/core/llm/chat-openai.js";
import type { ChatMessage } from "../src/core/llm/chat-types.js";

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

  it("sends GPT-6 turns with tools to the Responses API, and only those", () => {
    expect(usesResponsesApi("openai", "gpt-6.2-sol", true)).toBe(true);
    expect(usesResponsesApi("openai", "gpt-6.2-sol", false)).toBe(false);
    expect(usesResponsesApi("openai", "gpt-5.6-terra", true)).toBe(false);
    expect(usesResponsesApi("openrouter", "gpt-6.2-sol", true)).toBe(false);
    // GPT-6 also gets the reasoning-model params on chat/completions.
    const plain: Record<string, unknown> = { max_tokens: 4096, temperature: 0.2 };
    fitOpenAiParams(plain, "openai", "gpt-6.2-sol");
    expect(plain).toEqual({ max_completion_tokens: 8192 });
  });

  it("builds a Responses request from a kernel tool conversation", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hola" },
      { role: "assistant", content: [{ type: "text", text: "Miro." }, { type: "tool_use", id: "call_1", name: "tasks_list", input: { limit: 3 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "[]" }] },
    ];
    const tools = [{ name: "tasks_list", description: "List tasks", input_schema: { type: "object", properties: {} } }];
    const body = buildResponsesBody(messages, "gpt-6.2-sol", { system: "Sos el Lead.", max_tokens: 1024, temperature: 0.3, tools }, tools);
    expect(body).toEqual({
      model: "gpt-6.2-sol",
      instructions: "Sos el Lead.",
      max_output_tokens: 8192,
      store: false,
      parallel_tool_calls: false,
      tools: [{ type: "function", name: "tasks_list", description: "List tasks", parameters: { type: "object", properties: {} } }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hola" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Miro." }] },
        { type: "function_call", call_id: "call_1", name: "tasks_list", arguments: '{"limit":3}' },
        { type: "function_call_output", call_id: "call_1", output: "[]" },
      ],
    });
  });

  it("reads a Responses answer: text, tool calls, no reasoning", () => {
    const r = parseResponsesResult({
      model: "gpt-6.2-sol-2026",
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: "Listo." }] },
        { type: "function_call", call_id: "call_9", name: "tasks_create", arguments: '{"title":"x"}' },
      ],
      usage: { total_tokens: 30, input_tokens: 20, output_tokens: 10 },
    }, "gpt-6.2-sol");
    expect(r).toEqual({
      content: "Listo.", model: "gpt-6.2-sol-2026", tokens_used: 30, input_tokens: 20, output_tokens: 10,
      tool_calls: [{ type: "tool_use", id: "call_9", name: "tasks_create", input: { title: "x" } }],
    });
  });
});
