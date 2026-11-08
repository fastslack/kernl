import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { buildLlmConfig, LlmClient } from "../src/core/llm/client.js";
import { setCredentialSource } from "../src/core/llm/credentials.js";
import * as providerHealth from "../src/core/llm/provider-health.js";
import type { KernelConfig } from "../src/core/config.js";

/**
 * A provider that keeps listing a model it no longer serves answers every call
 * with a 404 about that model. Kernl used to try it on every call, forever
 * (06/11: 230 failed calls in a day to a retired default model).
 */

const DEAD = "acme/dead-model";
const NOT_SERVED = JSON.stringify({ status: 404, title: "Not Found", detail: "Function 'ac74040f-9fc9-4c5e-ac74-279ba5161d69': Not found for account 'x'" });

function install(store: Record<string, Record<string, unknown>>) {
  setCredentialSource({ loadConfig: (s) => ({ ...(store[s] ?? {}) }), saveConfig: () => true });
}
const cfg = (chain: Array<{ provider: string; model: string }>) =>
  ({ agents: { defaultModelChain: chain }, chat: { defaultProvider: "", defaultModel: "" } }) as unknown as KernelConfig;

const realFetch = globalThis.fetch;
let hits: string[] = [];

beforeEach(() => {
  providerHealth._resetForTests();
  hits = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("nvidia")) {
      hits.push("nvidia");
      return new Response(NOT_SERVED, { status: 404 });
    }
    hits.push("groq");
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "g" }), { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setCredentialSource(null);
  providerHealth.setModelFaultSink(null);
  providerHealth._resetForTests();
});

function client(chain: Array<{ provider: string; model: string }>) {
  install({
    nvidia: { apiKey: "nvapi-1", connectedAt: "t", defaultModel: DEAD },
    groq: { apiKey: "gsk_1", connectedAt: "t" },
  });
  return new LlmClient(buildLlmConfig(cfg(chain)));
}

describe("a model the provider no longer serves", () => {
  it("stops being called after 3 failures in a row, and the next link answers", async () => {
    const c = client([{ provider: "nvidia", model: "" }, { provider: "groq", model: "" }]);
    for (let i = 0; i < 3; i++) expect((await c.chat({ user: "hi", caller: "t" })).text).toBe("ok");
    expect(hits.filter((h) => h === "nvidia")).toHaveLength(3);
    hits = [];
    expect((await c.chat({ user: "hi", caller: "t" })).text).toBe("ok");
    expect(hits).toEqual(["groq"]);
  });

  it("is reported under the model actually called when the link used the provider's default", async () => {
    const seen: Array<[string, string]> = [];
    providerHealth.setModelFaultSink((slug, model) => { seen.push([slug, model]); });
    const c = client([{ provider: "nvidia", model: "" }, { provider: "groq", model: "" }]);
    await c.chat({ user: "hi", caller: "t" });
    expect(seen).toEqual([["nvidia", DEAD]]);
  });

  it("is still tried when it is the only link left", async () => {
    const c = client([{ provider: "nvidia", model: "" }]);
    for (let i = 0; i < 4; i++) await c.chat({ user: "hi", caller: "t" }).catch(() => {});
    expect(hits.filter((h) => h === "nvidia")).toHaveLength(4);
  });

  it("gets another chance once the retry window has passed", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) providerHealth.recordModelOutcome("nvidia", DEAD, false, t0);
    expect(providerHealth.isModelDead("nvidia", DEAD, t0 + 60_000)).toBe(true);
    expect(providerHealth.isModelDead("nvidia", DEAD, t0 + providerHealth.DEAD_MODEL_RETRY_MS + 1)).toBe(false);
  });

  it("a success in between resets the count", () => {
    providerHealth.recordModelOutcome("nvidia", DEAD, false);
    providerHealth.recordModelOutcome("nvidia", DEAD, false);
    providerHealth.recordModelOutcome("nvidia", DEAD, true);
    providerHealth.recordModelOutcome("nvidia", DEAD, false);
    expect(providerHealth.isModelDead("nvidia", DEAD)).toBe(false);
  });
});
