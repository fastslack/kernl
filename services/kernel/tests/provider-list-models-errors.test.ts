/**
 * `listModels()` must PROPAGATE upstream failures, not swallow them into `[]`.
 *
 * Why this matters: `testAllProviders()` (core/llm/test-providers.ts) treats
 * "did not throw" as success. A provider that returns `[]` on a 401 makes the
 * settings page paint a green "ready" pill for a key that is dead — with an
 * empty model dropdown and no error text anywhere.
 *
 * claude/openai/lmstudio already propagate; minimax/grok/nvidia were the three
 * that still swallowed. Model discovery isolates throws by design
 * (model-discovery.ts:220 catch → skip), so propagating is safe.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createMinimaxProvider } from "../src/core/llm/providers/minimax-provider.js";
import { createGrokProvider } from "../src/core/llm/providers/grok-provider.js";
import { createNvidiaProvider } from "../src/core/llm/providers/nvidia-provider.js";
import { testAllProviders } from "../src/core/llm/test-providers.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(res: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => res()) as unknown as typeof fetch;
}

const CASES = [
  { slug: "minimax", make: createMinimaxProvider, envKey: "MINIMAX_API_KEY" },
  { slug: "grok", make: createGrokProvider, envKey: "GROK_API_KEY" },
  { slug: "nvidia", make: createNvidiaProvider, envKey: "NVIDIA_API_KEY" },
] as const;

describe("listModels() propagates upstream failures", () => {
  for (const { slug, make, envKey } of CASES) {
    it(`${slug}: throws with status + detail on a non-ok response`, async () => {
      stubFetch(() => new Response("invalid api key", { status: 401 }));
      const p = make();
      p.configure({ apiKey: "bad-key" });
      await p.start();
      expect(p.listModels!()).rejects.toThrow(/401/);
    });

    it(`${slug}: throws on a network-level failure`, async () => {
      globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
      const p = make();
      p.configure({ apiKey: "some-key" });
      await p.start();
      expect(p.listModels!()).rejects.toThrow();
    });

    it(`${slug}: still returns [] (no throw) when no key is configured`, async () => {
      const saved = process.env[envKey];
      delete process.env[envKey];
      try {
        const p = make();
        p.configure({ apiKey: "" });
        await p.start();
        expect(await p.listModels!()).toEqual([]);
      } finally {
        if (saved !== undefined) process.env[envKey] = saved;
      }
    });
  }
});

describe("testAllProviders surfaces the failure instead of a green pill", () => {
  it("reports ok:false with the upstream error for a bad minimax key", async () => {
    stubFetch(() => new Response("invalid api key", { status: 401 }));
    const provider = createMinimaxProvider();
    provider.configure({ apiKey: "bad-key" });
    await provider.start();

    const registry = {
      getStatuses: () => [{ slug: "minimax", name: "MiniMax", ready: true }],
      getProvider: (s: string) => (s === "minimax" ? provider : undefined),
    };

    const results = await testAllProviders(registry as never);
    expect(results.minimax.ok).toBe(false);
    expect(results.minimax.error).toMatch(/401/);
  });
});
