/**
 * Characterization tests for ChatService's LLM plumbing:
 *   - the system-prompt prelude `chat()` and `chatStream()` send,
 *   - `_chatCompletionWithChain` link order, de-duplication, fatal bail-out
 *     and the combined "All chat providers failed" error.
 *
 * Providers are fakes swapped into the service, so nothing leaves the process.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { ChatService, _resetSoulCacheForTests } from "../src/modules/chat/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { promptChatIdentity, promptTodayDate } from "../src/core/i18n/prompts.js";
import * as providerHealth from "../src/core/llm/provider-health.js";
import { clearProviderExhausted, initProviderStatus } from "../src/core/llm/chat-adapters.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";
import type { ChatCompletionOptions, ChatMessage } from "../src/core/llm/chat-types.js";
import type { KernelConfig } from "../src/core/config.js";

function stubConfig(lang: "en" | "es"): KernelConfig {
  return JSON.parse(JSON.stringify({
    language: lang,
    timezone: "UTC",
    agents: {
      defaultProvider: "", defaultModel: "",
      defaultModelChain: [
        { provider: "p2", model: "m2" },
        { provider: "p1", model: "" },     // duplicate of the primary → skipped
        { provider: "p3", model: "m3" },   // unavailable → skipped
        { provider: "ghost", model: "x" }, // not registered → skipped
        { provider: "p4", model: "" },
      ],
    },
    claudeCode: {},
    chat: { defaultProvider: "p1", defaultModel: "", systemPrompt: "Custom rules.", maxEpisodeMessages: 200, contextBudget: 8000 },
  })) as KernelConfig;
}

type Call = { name: string; messages: ChatMessage[]; opts?: ChatCompletionOptions };

function fakeProvider(name: string, calls: Call[], behave: () => Promise<unknown>, available = true): ChatLlmProvider {
  return {
    name,
    available: () => available,
    async chatCompletion(messages, opts) {
      calls.push({ name, messages: JSON.parse(JSON.stringify(messages)), opts: opts ? { ...opts } : opts });
      return behave() as never;
    },
  };
}

const ok = (content: string) => async () => ({ content, model: "fake", tokens_used: 5 });
const fail = (msg: string) => async () => { throw new Error(msg); };

let db: Database;
function makeService(lang: "en" | "es", providers: Record<string, ChatLlmProvider>) {
  db = new Database(":memory:");
  runMigrations(db as unknown as never, "chat", chatMigrations);
  const svc = new ChatService(db as unknown as never, () => null, new EventBus(), stubConfig(lang));
  const internals = svc as unknown as {
    providers: Map<string, ChatLlmProvider>;
    systemPrompt: string;
    contextEngine: { retrieve: () => Promise<unknown> };
  };
  internals.providers = new Map(Object.entries(providers));
  internals.contextEngine.retrieve = async () => ({ contextText: "CTX-BLOCK", method: "test", memories: [], totalTokens: 0 });
  svc.setDistiller({ formatForPrompt: () => "RECALL-BLOCK" } as never);
  return { svc, base: internals.systemPrompt };
}

function dynamicPrompt(base: string, lang: "en" | "es"): string {
  const stamped = base.includes("Today's date") || base.includes("Fecha de hoy");
  return stamped ? base : `${base}\n${promptTodayDate(lang, new Date().toISOString().slice(0, 10))}`;
}

beforeEach(() => {
  _resetSoulCacheForTests();
  providerHealth._resetForTests();
  initProviderStatus(new Database(":memory:") as unknown as never);
  clearProviderExhausted();
});
afterEach(() => {
  providerHealth._resetForTests();
  clearProviderExhausted();
});

describe("ChatService.chat — prompt + fallback chain", () => {
  it("sends the prelude as system and walks the chain (dedup, skip unavailable/unknown)", async () => {
    const calls: Call[] = [];
    const { svc, base } = makeService("en", {
      p1: fakeProvider("p1", calls, fail("p1 API error 500: down")),
      p2: fakeProvider("p2", calls, fail("p2 API error 429: slow")),
      p3: fakeProvider("p3", calls, ok("never"), false),
      p4: fakeProvider("p4", calls, ok("from p4")),
    });
    const ep = svc.createEpisode({ provider: "p1", model: "m1" });
    const res = await svc.chat(ep.id, "hello there", { skipExtraction: true });

    expect(calls.map((c) => [c.name, c.opts?.model])).toEqual([["p1", "m1"], ["p2", "m2"], ["p4", undefined]]);
    const expectedSystem = [
      dynamicPrompt(base, "en"),
      "CTX-BLOCK",
      "RECALL-BLOCK",
      promptChatIdentity("en", "p1", " (m1)"),
    ].join("\n\n");
    for (const c of calls) {
      expect(Object.keys(c.opts!)).toEqual(["model", "system", "tools"]);
      expect(c.opts!.system).toBe(expectedSystem);
      expect(c.opts!.tools).toBeUndefined();
      expect(c.messages).toEqual([{ role: "user", content: "hello there" }]);
    }
    expect(res.message.content).toBe("from p4");
    expect(res.tokens_used).toBe(5);
  });

  it("Spanish prelude uses the Spanish identity line", async () => {
    const calls: Call[] = [];
    const { svc, base } = makeService("es", { p1: fakeProvider("p1", calls, ok("hola")) });
    const ep = svc.createEpisode({ provider: "p1", model: "" });
    await svc.chat(ep.id, "hola", { skipExtraction: true });
    expect(calls[0].opts!.system).toBe([
      dynamicPrompt(base, "es"), "CTX-BLOCK", "RECALL-BLOCK", promptChatIdentity("es", "p1", ""),
    ].join("\n\n"));
    expect(calls[0].opts!.model).toBeUndefined();
  });

  it("a 400 schema/validation error bails immediately with the original error", async () => {
    const calls: Call[] = [];
    const err = new Error("p1 API error 400: invalid tool schema");
    const { svc } = makeService("en", {
      p1: fakeProvider("p1", calls, async () => { throw err; }),
      p2: fakeProvider("p2", calls, ok("never")),
      p4: fakeProvider("p4", calls, ok("never")),
    });
    const ep = svc.createEpisode({ provider: "p1", model: "m1" });
    let caught: unknown;
    try { await svc.chat(ep.id, "x", { skipExtraction: true }); } catch (e) { caught = e; }
    expect(caught).toBe(err);
    expect(calls.map((c) => c.name)).toEqual(["p1"]);
  });

  it("a 400 that is not a schema error still falls through", async () => {
    const calls: Call[] = [];
    const { svc } = makeService("en", {
      p1: fakeProvider("p1", calls, fail("p1 API error 400: context too long")),
      p2: fakeProvider("p2", calls, ok("p2 answers")),
    });
    const ep = svc.createEpisode({ provider: "p1", model: "m1" });
    const r = await svc.chat(ep.id, "x", { skipExtraction: true });
    expect(r.message.content).toBe("p2 answers");
  });

  it("every link failing throws the combined diagnostic", async () => {
    const calls: Call[] = [];
    const long = "e".repeat(400);
    const { svc } = makeService("en", {
      p1: fakeProvider("p1", calls, fail("p1 API error 500: down")),
      p2: fakeProvider("p2", calls, fail(long)),
      p4: fakeProvider("p4", calls, fail("p4 timeout")),
    });
    const ep = svc.createEpisode({ provider: "p1", model: "m1" });
    await expect(svc.chat(ep.id, "x", { skipExtraction: true })).rejects.toThrow(
      `All chat providers failed:\n  [1] p1: p1 API error 500: down\n  [2] p2: ${"e".repeat(300)}\n  [3] p4: p4 timeout`,
    );
  });
});

describe("ChatService.chatStream — prompt", () => {
  it("sends the prelude + identity + episode instructions to the claude_code stream", async () => {
    let seenOpts: Record<string, unknown> | undefined;
    const streamProvider = {
      name: "claude_code",
      supportsToolLoop: false,
      available: () => true,
      chatCompletion: async () => ({ content: "", model: "x", tokens_used: 0 }),
      chatCompletionStream: async (_msg: string, _sink: unknown, opts: Record<string, unknown>) => {
        seenOpts = opts;
        return { finalText: "streamed", tokensUsed: 3 };
      },
    };
    for (const lang of ["en", "es"] as const) {
      const { svc, base } = makeService(lang, { claude_code: streamProvider as never });
      const ep = svc.createEpisode({ provider: "claude_code", model: "sonnet", instructions: "  Be brief.  " });
      const events: string[] = [];
      const r = await svc.chatStream(ep.id, "hi", (ev) => events.push(ev.type));
      const header = lang === "es" ? "## Instrucciones del episodio" : "## Episode instructions";
      expect(seenOpts!.system).toBe([
        dynamicPrompt(base, lang),
        "RECALL-BLOCK",
        promptChatIdentity(lang, "claude_code", " (sonnet)"),
        `${header}\nBe brief.`,
      ].join("\n\n"));
      expect(seenOpts!.model).toBe("sonnet");
      expect(r.message.content).toBe("streamed");
      expect(events).toEqual(["done"]);
    }
  });

  it("no instructions → no instructions block; no model → no hint", async () => {
    let seenOpts: Record<string, unknown> | undefined;
    const streamProvider = {
      name: "claude_code", available: () => true,
      chatCompletion: async () => ({ content: "", model: "x", tokens_used: 0 }),
      chatCompletionStream: async (_m: string, _s: unknown, opts: Record<string, unknown>) => { seenOpts = opts; return { finalText: "", tokensUsed: 0 }; },
    };
    const { svc, base } = makeService("en", { claude_code: streamProvider as never });
    const ep = svc.createEpisode({ provider: "claude_code", model: "" });
    // createEpisode falls back to chat.defaultModel ("") when none is given.
    await svc.chatStream(ep.id, "hi", () => {});
    expect(seenOpts!.system).toBe([dynamicPrompt(base, "en"), "RECALL-BLOCK", promptChatIdentity("en", "claude_code", "")].join("\n\n"));
    expect(seenOpts!.model).toBeUndefined();
  });
});
