/**
 * The OpenAI-shaped providers build their chat adapter with positional
 * arguments (`apiKey, baseUrl, defaultModel`). Passing the model where the
 * base URL goes makes the request URL relative — Bun rejects it before it
 * ever leaves the process with "fetch() URL is invalid", which surfaced on
 * the providers page as a permanently red row.
 */
import { test, expect, afterEach } from "bun:test";
import { createOpenAiProvider } from "../src/core/llm/providers/openai-provider.js";
import { createGrokProvider } from "../src/core/llm/providers/grok-provider.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Runs one completion against a stub fetch and returns the URL it targeted. */
async function urlUsedBy(provider: any, config: Record<string, unknown>): Promise<string> {
  provider.configure(config);
  await provider.start();
  let seen = "";
  globalThis.fetch = (async (url: any) => {
    seen = String(url);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "stub" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;
  await provider.chatCompletion([{ role: "user", content: "hi" }]);
  return seen;
}

test("openai posts to its default base URL when the form left it empty", async () => {
  const url = await urlUsedBy(createOpenAiProvider(), { apiKey: "sk-test", baseUrl: "", defaultModel: "" });
  expect(url).toBe("https://api.openai.com/v1/chat/completions");
});

test("openai honours a custom base URL", async () => {
  const url = await urlUsedBy(createOpenAiProvider(), { apiKey: "sk-test", baseUrl: "http://localhost:8080/v1", defaultModel: "gpt-4o-mini" });
  expect(url).toBe("http://localhost:8080/v1/chat/completions");
});

test("grok posts to the xAI endpoint", async () => {
  const url = await urlUsedBy(createGrokProvider(), { apiKey: "xai-test", defaultModel: "grok-4-fast-non-reasoning" });
  expect(url).toBe("https://api.x.ai/v1/chat/completions");
});
