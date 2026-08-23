/**
 * The gate that keeps the product unreachable until an LLM can run an agent.
 *
 * The bug this exists to prevent, observed on a live kernel: every provider
 * env var was empty, so nothing was configured at all, and Settings still
 * showed Claude Code with a green "ready" tick. `isReady()` meant "the binary
 * exists", the Agent SDK ships that binary, and its own `capabilities.tools`
 * is false — so the one provider the UI called ready was simultaneously
 * unauthenticated and incapable of the tool loop every native agent needs.
 *
 * A readiness check built on that flag would have waved the install straight
 * through. So the verdict is empirical: send a real request carrying a tool
 * and require the provider to call it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  probeLlmReadiness,
  ensureLlmReadiness,
  initLlmReadiness,
  markLlmReadinessStale,
  readinessForGate,
  resetLlmReadinessForTests,
} from "../src/core/llm/readiness.js";
import { isLlmGated, createLlmReadinessGate } from "../src/core/llm/readiness-gate.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";
import type { ChatCompletionResult } from "../src/core/llm/chat-types.js";

type FakeOpts = {
  name: string;
  available?: boolean;
  supportsToolLoop?: boolean;
  /** What chatCompletion does. Default: answer with the expected tool call. */
  respond?: () => Promise<ChatCompletionResult>;
};

let calls: string[] = [];

function fake(opts: FakeOpts): ChatLlmProvider {
  const provider = {
    name: opts.name,
    available: () => opts.available ?? true,
    async chatCompletion(): Promise<ChatCompletionResult> {
      calls.push(opts.name);
      if (opts.respond) return opts.respond();
      return {
        content: "",
        model: `${opts.name}-model`,
        tokens_used: 12,
        tool_calls: [
          { type: "tool_use", id: "t1", name: "kernl_readiness_echo", input: { word: "ready" } },
        ],
      };
    },
  } as unknown as ChatLlmProvider;
  if (opts.supportsToolLoop !== undefined) {
    (provider as { supportsToolLoop?: boolean }).supportsToolLoop = opts.supportsToolLoop;
  }
  return provider;
}

function mapOf(...providers: ChatLlmProvider[]): Map<string, ChatLlmProvider> {
  return new Map(providers.map((p) => [p.name, p]));
}

beforeEach(() => {
  calls = [];
  resetLlmReadinessForTests();
});

describe("probeLlmReadiness", () => {
  it("passes only when the provider actually calls the tool", async () => {
    const r = await probeLlmReadiness(mapOf(fake({ name: "openai" })));
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.provider).toBe("openai");
  });

  it("fails a provider that answers in prose instead of calling the tool", async () => {
    // The credential works and the model still will not act — an agent handing
    // it a tool catalogue would loop without ever executing anything.
    const r = await probeLlmReadiness(
      mapOf(
        fake({
          name: "chatty",
          respond: async () => ({
            content: "Sure! I would call kernl_readiness_echo with word=ready.",
            model: "chatty-1",
            tokens_used: 20,
          }),
        }),
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-tool-call");
  });

  it("reports auth separately from other failures", async () => {
    const r = await probeLlmReadiness(
      mapOf(
        fake({
          name: "openai",
          respond: async () => {
            throw new Error("401 Unauthorized: invalid api key");
          },
        }),
      ),
    );
    expect(r.reason).toBe("auth");
  });

  it("classifies a non-auth failure as an error", async () => {
    const r = await probeLlmReadiness(
      mapOf(
        fake({
          name: "openai",
          respond: async () => {
            throw new Error("ECONNREFUSED");
          },
        }),
      ),
    );
    expect(r.reason).toBe("error");
  });

  it("says no-provider when nothing is configured", async () => {
    const r = await probeLlmReadiness(mapOf(fake({ name: "openai", available: false })));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-provider");
  });

  it("says no-tool-capable when the only live provider cannot take tools", async () => {
    // A tool-incapable provider that is not the SDK is a dead end: nothing can
    // run, and it is never asked to try.
    const r = await probeLlmReadiness(
      mapOf(fake({ name: "some-shim", supportsToolLoop: false })),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-tool-capable");
    expect(calls).toEqual([]);
  });

  it("lets a signed-in Claude Code SDK through, flagged as SDK-only", async () => {
    // The SDK cannot carry the *native* loop but runs tools inside itself, so
    // agents on the claude_code executor work. Blocking that install would be
    // wrong — but calling it fully wired would be too, because native-executor
    // agents still cannot run. Hence its own reason code.
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
    const r = await probeLlmReadiness(
      mapOf(fake({ name: "claude_code", supportsToolLoop: false })),
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("ok-sdk-only");
    expect(calls).toEqual([]);
  });

  it("still blocks an unauthenticated Claude Code SDK", async () => {
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const r = await probeLlmReadiness(
        mapOf(fake({ name: "claude_code", supportsToolLoop: false })),
      );
      // No credential anywhere → the SDK fallback does not apply.
      if (!r.ok) expect(r.reason).toBe("no-tool-capable");
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    }
  });

  it("skips the tool-incapable provider and passes on the next one", async () => {
    const r = await probeLlmReadiness(
      mapOf(fake({ name: "claude_code", supportsToolLoop: false }), fake({ name: "openai" })),
    );
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("openai");
    expect(calls).toEqual(["openai"]);
  });

  it("probes an aliased provider once, not once per alias", async () => {
    const shared = fake({ name: "claude_code" });
    const aliased = new Map<string, ChatLlmProvider>([
      ["claude_code", shared],
      ["claude-code", shared],
    ]);
    await probeLlmReadiness(aliased);
    expect(calls).toEqual(["claude_code"]);
  });

  it("stops at the first success rather than probing the whole map", async () => {
    await probeLlmReadiness(mapOf(fake({ name: "first" }), fake({ name: "second" })));
    expect(calls).toEqual(["first"]);
  });
});

describe("readiness cache", () => {
  it("reuses the verdict until something marks it stale", async () => {
    initLlmReadiness(() => mapOf(fake({ name: "openai" })));
    await ensureLlmReadiness();
    await ensureLlmReadiness();
    expect(calls).toEqual(["openai"]);

    markLlmReadinessStale("test");
    await ensureLlmReadiness();
    expect(calls).toEqual(["openai", "openai"]);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    initLlmReadiness(() => mapOf(fake({ name: "openai" })));
    await Promise.all([ensureLlmReadiness(), ensureLlmReadiness(), ensureLlmReadiness()]);
    expect(calls).toEqual(["openai"]);
  });

  it("never blocks the gate on a live probe", () => {
    initLlmReadiness(() => mapOf(fake({ name: "openai" })));
    // Nothing has been probed yet, so there is no verdict to hand back — and
    // the gate must return synchronously rather than wait for one.
    expect(readinessForGate()).toBeNull();
  });
});

describe("the gate", () => {
  it("refuses an LLM-backed route with 428 while the probe has not passed", () => {
    const gate = createLlmReadinessGate();
    // `/api/agents` (the listing) is deliberately NOT gated any more — only
    // the routes that actually call a model are.
    const failure = gate("/api/agents/run", "POST");
    expect(failure?.status).toBe(428);
    expect((failure?.body as { error: string }).error).toBe("llm_not_configured");
  });

  it("lets an LLM-backed route through once a provider passes", async () => {
    initLlmReadiness(() => mapOf(fake({ name: "openai" })));
    await ensureLlmReadiness();
    expect(createLlmReadinessGate()("/api/agents/run", "POST")).toBeNull();
  });

  it("serves the local-data API even while the probe is failing", () => {
    const gate = createLlmReadinessGate();
    for (const p of ["/api/agents", "/api/dashboard/life", "/api/chat/messages", "/mcp"]) {
      expect(gate(p, "GET")).toBeNull();
    }
  });

  it("gates only the routes that actually call a model", () => {
    for (const p of [
      "/api/chat/message",
      "/api/chat/message/stream",
      "/api/agents/run",
      "/api/agents/trigger",
      "/api/agents/generate-from-prompt",
      "/api/offices/create",
    ]) {
      expect(isLlmGated(p)).toBe(true);
    }
  });

  it("leaves the local-data API alone — it never needed a model", () => {
    // The regression this inversion exists for: twenty extension categories
    // and the whole life/CRM surface used to 428 because a *different*
    // subsystem had no key.
    for (const p of [
      "/api/tasks",
      "/api/contacts",
      "/api/dashboard/life",
      "/api/dashboard/calendar",
      "/api/notifications",
      "/api/pii/status",
      "/api/dashboard/rpc",
      "/mcp",
      "/api/health",
      "/api/llm-providers",
      "/api/config/ai",
    ]) {
      expect(isLlmGated(p)).toBe(false);
    }
  });

  it("reading a conversation you already have is not gated", () => {
    // `/api/chat/message` must not swallow `/api/chat/messages` by prefix —
    // that would make your own history unreadable without a provider.
    expect(isLlmGated("/api/chat/messages")).toBe(false);
    expect(isLlmGated("/api/chat/episodes")).toBe(false);
    expect(isLlmGated("/api/chat/images")).toBe(false);
    expect(isLlmGated("/api/chat/distilled-facts")).toBe(false);
    expect(isLlmGated("/api/chat/start")).toBe(false);
  });

  it("a run listing is not a run", () => {
    expect(isLlmGated("/api/agents/runs/active")).toBe(false);
    expect(isLlmGated("/api/agents/42/runs")).toBe(false);
    expect(isLlmGated("/api/agents")).toBe(false);
  });
});
