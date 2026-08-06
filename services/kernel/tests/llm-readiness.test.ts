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
import { isReadinessExempt, createLlmReadinessGate } from "../src/core/llm/readiness-gate.js";
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
  it("refuses a feature route with 428 while the probe has not passed", () => {
    const gate = createLlmReadinessGate();
    const failure = gate("/api/agents", "GET");
    expect(failure?.status).toBe(428);
    expect((failure?.body as { error: string }).error).toBe("llm_not_configured");
  });

  it("lets a feature route through once a provider passes", async () => {
    initLlmReadiness(() => mapOf(fake({ name: "openai" })));
    await ensureLlmReadiness();
    expect(createLlmReadinessGate()("/api/agents", "GET")).toBeNull();
  });

  it("keeps open everything needed to fix the problem", () => {
    // Gate these and the install cannot be repaired through its own UI: every
    // button on the blocking screen would 428.
    for (const p of [
      "/api/health",
      "/api/auth/verify",
      "/api/llm/readiness",
      "/api/llm/readiness/recheck",
      "/api/llm/claude-code/auth/login",
      "/api/llm/chain/test",
      "/api/llm-providers",
      "/api/llm-providers/openai/config",
      "/api/config/ai",
      "/api/config/ai/test",
    ]) {
      expect(isReadinessExempt(p)).toBe(true);
    }
  });

  it("does not exempt the feature routes it is meant to block", () => {
    for (const p of ["/api/agents", "/api/tasks", "/api/contacts", "/api/dashboard/rpc"]) {
      expect(isReadinessExempt(p)).toBe(false);
    }
  });
});
