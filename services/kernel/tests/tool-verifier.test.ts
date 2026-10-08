/**
 * Asking unknown models whether they call tools. NVIDIA's 68 chat models had
 * no evidence from any source, so the Chief's picker marked every one "not
 * verified"; the verifier sends each the same probe "Probar" uses and keeps
 * the answer.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { modelsToVerify, verifyProvider } from "../src/core/llm/tool-verifier.js";
import { observeToolSupport, toolSupportFor } from "../src/core/llm/model-caps.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-provider.js";

/** An adapter whose models behave as scripted: call the tool, answer in prose, or hang. */
function fakeAdapter(behaviour: Record<string, "tool" | "prose" | "fail">): ChatLlmProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    name: "nvidia",
    asked,
    available: () => true,
    async chatCompletion(_msgs, opts) {
      const model = opts?.model ?? "";
      asked.push(model);
      const b = behaviour[model];
      if (b === "fail") throw new Error("503 Service Unavailable");
      return {
        content: b === "tool" ? "" : "ok",
        model,
        tool_calls: b === "tool" ? [{ id: "1", name: "kernl_connect_echo", input: { word: "ok" } }] : [],
        tokens_used: 10,
      } as never;
    },
  };
}

describe("which models a pass may spend a request on", () => {
  const price = (_s: string, m: string) => ({ cheap: 2, pricey: 60 } as Record<string, number>)[m];

  it("checks every unknown model of a free provider", () => {
    expect(modelsToVerify("nvidia", ["a", "b", "c"], price)).toEqual(["a", "b", "c"]);
  });

  it("checks only cheap, priced models of a paid provider", () => {
    expect(modelsToVerify("openai", ["cheap", "pricey", "unpriced"], price)).toEqual(["cheap"]);
  });

  it("never asks Claude Code", () => {
    expect(modelsToVerify("claude-code", ["opus"], price)).toEqual([]);
  });
});

describe("verifyProvider", () => {
  it("records yes for a tool call, no for prose, and nothing for a failure", async () => {
    const db = new Database(":memory:");
    const adapter = fakeAdapter({ "meta/llama-3.3-70b-instruct": "tool", "writer/palmyra-creative-122b": "prose", "01-ai/yi-large": "fail" });
    const models = Object.keys({ "meta/llama-3.3-70b-instruct": 1, "writer/palmyra-creative-122b": 1, "01-ai/yi-large": 1 });
    const report = await verifyProvider("nvidia", {
      db: db as never,
      adapters: new Map([["nvidia", adapter]]),
      listModels: async () => models,
      outputPrice: () => undefined,
      timeoutMs: 1000,
    });
    expect(report).toEqual({ slug: "nvidia", checked: 3, yes: 1, no: 1, inconclusive: 1 });
    const v = toolSupportFor(db as never, "nvidia", models);
    expect(v.get("meta/llama-3.3-70b-instruct")).toBe(true);
    expect(v.get("writer/palmyra-creative-122b")).toBe(false);
    expect(v.get("01-ai/yi-large")).toBeUndefined();
  });

  it("does not ask again about a model that already has an answer", async () => {
    const db = new Database(":memory:");
    observeToolSupport(db as never, "nvidia", "known", true);
    const adapter = fakeAdapter({ known: "tool", fresh: "tool" });
    await verifyProvider("nvidia", {
      db: db as never,
      adapters: new Map([["nvidia", adapter]]),
      listModels: async () => ["known", "fresh"],
      outputPrice: () => undefined,
    });
    expect(adapter.asked).toEqual(["fresh"]);
  });
});
