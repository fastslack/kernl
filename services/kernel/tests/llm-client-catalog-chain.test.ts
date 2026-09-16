import { describe, it, expect, afterEach } from "bun:test";
import { buildLlmConfig, createPinnedLlmClient } from "../src/core/llm/client.js";
import { setCredentialSource } from "../src/core/llm/credentials.js";
import type { KernelConfig } from "../src/core/config.js";

function install(store: Record<string, Record<string, unknown>>) {
  setCredentialSource({ loadConfig: (s) => ({ ...(store[s] ?? {}) }), saveConfig: () => true });
}
const cfg = (chain: Array<{ provider: string; model: string }> = [], chatProvider = "") =>
  ({ agents: { defaultModelChain: chain }, chat: { defaultProvider: chatProvider, defaultModel: "" } }) as unknown as KernelConfig;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setCredentialSource(null); });

describe("llm() chain from the catalog", () => {
  it("fills an empty chain with the connected providers, NVIDIA first", () => {
    install({ groq: { apiKey: "gsk_1", connectedAt: "t" }, nvidia: { apiKey: "nvapi-1", connectedAt: "t" } });
    const c = buildLlmConfig(cfg());
    expect(c.slug).toBe("nvidia");
    expect(c.baseUrl).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(c.defaultModel).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(c.fallbackChain?.map((l) => l.slug)).toEqual(["groq"]);
  });

  it("respects an explicit chain, aliases included", () => {
    install({ groq: { apiKey: "gsk_1", connectedAt: "t" }, nvidia: { apiKey: "nvapi-1", connectedAt: "t" } });
    const c = buildLlmConfig(cfg([{ provider: "groq", model: "openai/gpt-oss-20b" }, { provider: "nim", model: "" }]));
    expect(c.slug).toBe("groq");
    expect(c.defaultModel).toBe("openai/gpt-oss-20b");
    expect(c.fallbackChain?.map((l) => l.slug)).toEqual(["nvidia"]);
  });

  it("drops providers without credentials or not connected", () => {
    install({ ollama: {} });
    expect(createPinnedLlmClient("nvidia", "", cfg())).toBeNull();
    expect(createPinnedLlmClient("ollama", "qwen3", cfg())).toBeNull();
    install({ ollama: { connectedAt: "t", baseUrl: "http://host.docker.internal:11434/v1" } });
    expect(createPinnedLlmClient("ollama", "qwen3", cfg())).not.toBeNull();
  });

  it("applies model quirks and strips reasoning on the chat path", async () => {
    install({ nvidia: { apiKey: "nvapi-1", connectedAt: "t" } });
    let body: Record<string, any> = {};
    globalThis.fetch = (async (_u: unknown, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "<think>x</think>hola" } }], model: "m" }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createPinnedLlmClient("nvidia", "", cfg())!;
    const r = await client.chat({ user: "hi", caller: "chain-probe" });
    expect(body.chat_template_kwargs).toEqual({ force_nonempty_content: true });
    expect(r.text).toBe("hola");
  });
});
