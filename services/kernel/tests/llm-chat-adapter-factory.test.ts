import { describe, it, expect, afterEach } from "bun:test";
import { buildChatAdapter, createChatProviders } from "../src/core/llm/chat-adapters.js";
import { setCredentialSource } from "../src/core/llm/credentials.js";

let store: Record<string, Record<string, unknown>> = {};
function install(s: Record<string, Record<string, unknown>>) {
  store = s;
  setCredentialSource({ loadConfig: (x) => ({ ...(store[x] ?? {}) }), saveConfig: () => true });
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setCredentialSource(null); });

type Seen = { url: string; headers: Record<string, string>; body: Record<string, any> };
function capture(content = "<think>let me see</think>ok"): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: unknown, init: any) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { content } }], model: "stub",
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return seen;
}

describe("buildChatAdapter", () => {
  it("builds NVIDIA from the registry with the catalog model and its quirks", async () => {
    install({ nvidia: { apiKey: "nvapi-abc" } });
    const seen = capture();
    const r = await buildChatAdapter("nvidia")!.chatCompletion([{ role: "user", content: "hi" }]);
    expect(seen[0].url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(seen[0].headers.Authorization).toBe("Bearer nvapi-abc");
    expect(seen[0].body.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(seen[0].body.chat_template_kwargs).toEqual({ force_nonempty_content: true });
    expect(seen[0].body.temperature).toBe(1);
    expect(seen[0].body.top_p).toBe(0.95);
    expect(r.content).toBe("ok");
    expect(r.input_tokens).toBe(7);
    expect(r.output_tokens).toBe(3);
  });

  it("a caller's temperature beats the quirk", async () => {
    install({ nvidia: { apiKey: "k" } });
    const seen = capture();
    await buildChatAdapter("nim")!.chatCompletion([{ role: "user", content: "hi" }], { temperature: 0.2 });
    expect(seen[0].body.temperature).toBe(0.2);
  });

  it("uses an override key without touching the store", async () => {
    install({});
    const seen = capture();
    await buildChatAdapter("groq", { apiKey: "gsk_new" })!.chatCompletion([{ role: "user", content: "hi" }]);
    expect(seen[0].headers.Authorization).toBe("Bearer gsk_new");
    expect(store.groq).toBeUndefined();
  });

  it("joins provider URLs correctly", async () => {
    install({ deepseek: { apiKey: "k" }, gemini: { apiKey: "AQ.k" }, minimax: { apiKey: "k" } });
    const seen = capture();
    await buildChatAdapter("deepseek")!.chatCompletion([{ role: "user", content: "hi" }]);
    await buildChatAdapter("gemini")!.chatCompletion([{ role: "user", content: "hi" }]);
    await buildChatAdapter("minimax", { region: "china" })!.chatCompletion([{ role: "user", content: "hi" }]);
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.deepseek.com/chat/completions",
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      "https://api.minimax.cn/v1/chat/completions",
    ]);
  });

  it("returns null for an unknown provider", () => {
    install({});
    expect(buildChatAdapter("nope")).toBeNull();
  });
});

describe("createChatProviders", () => {
  it("registers every slug and alias with one instance each", () => {
    install({ nvidia: { apiKey: "k" } });
    const map = createChatProviders();
    expect(map.get("nim")).toBe(map.get("nvidia"));
    expect(map.get("claude_code")).toBe(map.get("claude-code"));
    expect(map.get("nvidia")!.available()).toBe(true);
    expect(map.get("groq")!.available()).toBe(false);
  });

  it("leaves out local servers nobody connected", () => {
    install({});
    expect(createChatProviders().has("ollama")).toBe(false);
    install({ ollama: { connectedAt: "t" } });
    const ollama = createChatProviders().get("ollama")!;
    expect(ollama.available()).toBe(true);
  });

  it("accepts the legacy key-object call and ignores the keys", () => {
    install({ nvidia: { apiKey: "from-registry" } });
    const map = createChatProviders({ nvidiaApiKey: "ignored", anthropicApiKey: "ignored" });
    expect(map.get("nvidia")!.available()).toBe(true);
    expect(map.get("claude")!.available()).toBe(false);
  });
});
