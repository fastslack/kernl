/**
 * A streamed chat turn (Chief's direct channel, /chat) that no Claude Code
 * account can take: the rest of the global chain answers it as text instead
 * of the conversation ending on "429 … quota exhausted". The account rotation
 * itself is covered in claude-code-usage-limit.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { ChatService, _resetSoulCacheForTests } from "../src/modules/chat/service.js";
import { EventBus } from "../src/core/event-bus.js";
import * as providerHealth from "../src/core/llm/provider-health.js";
import { clearProviderExhausted, initProviderStatus } from "../src/core/llm/chat-adapters.js";
import { ClaudeUsageLimitError } from "../src/sdk/claude-limits.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";
import type { ChatMessage, ChatStreamEvent } from "../src/core/llm/chat-types.js";
import type { KernelConfig } from "../src/core/config.js";

const CHAIN = [
  { provider: "claude_code", model: "sonnet" },
  { provider: "openai", model: "gpt-5-nano" },
];

function config(chain: Array<{ provider: string; model: string }>): KernelConfig {
  return JSON.parse(JSON.stringify({
    language: "en",
    timezone: "UTC",
    agents: { defaultProvider: "", defaultModel: "", defaultModelChain: chain },
    claudeCode: {},
    chat: { defaultProvider: "claude-code", defaultModel: "", systemPrompt: "", maxEpisodeMessages: 200, contextBudget: 8000 },
  })) as KernelConfig;
}

const limitError = (partial = false) => {
  const err = new ClaudeUsageLimitError(
    { kind: "rate_limit", limitType: "seven_day", detail: "You've hit your weekly limit · resets 8pm (UTC)" },
    "claude-fable-5-2",
  );
  err.partial = partial;
  return err;
};

let db: Database;
let fallbackCalls: Array<{ model?: string; messages: ChatMessage[]; tools?: unknown }>;

function makeService(opts: { stream: () => Promise<unknown>; chain?: typeof CHAIN; openai?: boolean }) {
  const svc = new ChatService(db as unknown as never, () => null, new EventBus(), config(opts.chain ?? CHAIN));
  const claude = {
    name: "claude-code",
    available: () => true,
    chatCompletionStream: opts.stream,
  };
  const openai: ChatLlmProvider = {
    name: "openai",
    available: () => true,
    async chatCompletion(messages, o) {
      fallbackCalls.push({ model: o?.model, messages: JSON.parse(JSON.stringify(messages)), tools: o?.tools });
      return { content: "hola, soy el respaldo", model: "gpt-5-nano", tokens_used: 7 } as never;
    },
  };
  const providers = new Map<string, unknown>([["claude-code", claude]]);
  if (opts.openai !== false) providers.set("openai", openai);
  const internals = svc as unknown as { providers: Map<string, unknown>; contextEngine: { retrieve: () => Promise<unknown> } };
  internals.providers = providers;
  internals.contextEngine.retrieve = async () => ({ contextText: "", method: "test", memories: [], totalTokens: 0 });
  return svc;
}

beforeEach(() => {
  _resetSoulCacheForTests();
  providerHealth._resetForTests();
  initProviderStatus(new Database(":memory:") as unknown as never);
  clearProviderExhausted();
  db = new Database(":memory:");
  runMigrations(db as unknown as never, "chat", chatMigrations);
  fallbackCalls = [];
});
afterEach(() => {
  providerHealth._resetForTests();
  clearProviderExhausted();
});

describe("chatStream when every Claude Code account is out of quota", () => {
  it("answers with the next provider of the global chain, without tools, and says so", async () => {
    const svc = makeService({ stream: async () => { throw limitError(); } });
    const ep = svc.createEpisode({ provider: "claude-code", model: "claude-fable-5-2" });
    const events: ChatStreamEvent[] = [];
    const res = await svc.chatStream(ep.id, "hola", (ev) => events.push(ev));

    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]!.model).toBe("gpt-5-nano");
    expect(fallbackCalls[0]!.tools).toBeUndefined();
    expect(fallbackCalls[0]!.messages.at(-1)).toEqual({ role: "user", content: "hola" });

    expect(events.some((e) => e.type === "error")).toBe(false);
    const text = events.find((e) => e.type === "assistant_text") as { text: string } | undefined;
    expect(text?.text).toStartWith("hola, soy el respaldo");
    expect(text?.text).toContain("Claude Code no tiene cuota");
    expect(events.at(-1)?.type).toBe("done");
    expect(res.message?.content).toStartWith("hola, soy el respaldo");
    // The episode stays on Claude Code: the next turn tries the subscription first.
    expect(svc.getEpisode(ep.id)?.llm_provider).toBe("claude-code");
  });

  it("does not answer again after the limit cut a turn that already produced output", async () => {
    const svc = makeService({ stream: async () => { throw limitError(true); } });
    const ep = svc.createEpisode({ provider: "claude-code" });
    const events: ChatStreamEvent[] = [];
    await expect(svc.chatStream(ep.id, "hola", (ev) => events.push(ev))).rejects.toBeInstanceOf(ClaudeUsageLimitError);
    expect(fallbackCalls).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("surfaces the 429 when the chain has no other provider", async () => {
    const svc = makeService({ stream: async () => { throw limitError(); }, openai: false });
    const ep = svc.createEpisode({ provider: "claude-code" });
    await expect(svc.chatStream(ep.id, "hola", () => {})).rejects.toThrow(/429 usage limit reached/);
  });

  it("leaves any other failure alone", async () => {
    const svc = makeService({ stream: async () => { throw new Error("boom"); } });
    const ep = svc.createEpisode({ provider: "claude-code" });
    await expect(svc.chatStream(ep.id, "hola", () => {})).rejects.toThrow("boom");
    expect(fallbackCalls).toHaveLength(0);
  });
});
