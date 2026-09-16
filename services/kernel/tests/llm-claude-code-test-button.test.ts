/**
 * Test must ask "is there a credential?", never "did the official CLI sign in?".
 *
 * Observed on a live install: an upgrade left the provider on the legacy token,
 * which the kernel still honours — a real call through the chain answered
 * "pong" in 2.8s — while the Test button refused to place that call at all and
 * reported "Claude Code has no session on this machine". The primary looked
 * dead in the one screen built to tell the user whether it works.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { registerConnectRoutes, type ChainLink } from "../src/core/llm/connect-routes.js";
import { setCredentialSource } from "../src/core/llm/credentials.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";

let server: KernelHttpServer;
let base: string;
let called: number;
let chain: ChainLink[];

const toolReply = () => ({
  content: "",
  model: "claude-sonnet-4-6",
  tokens_used: 1,
  tool_calls: [{ type: "tool_use", id: "1", name: "kernl_connect_echo", input: { word: "ok" } }],
});

async function start(hasClaudeCredential: () => boolean) {
  called = 0;
  chain = [];
  setCredentialSource({ loadConfig: () => ({}), saveConfig: () => true });
  server = new KernelHttpServer({
    config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
  });
  registerConnectRoutes(server, {
    registry: { startProvider: async () => true, stopProvider: async () => true },
    getChain: () => chain,
    setChain: (c) => { chain = c; },
    onChanged: () => {},
    buildAdapter: () => ({
      name: "fake",
      available: () => true,
      chatCompletion: async () => { called++; return toolReply(); },
    }) as unknown as ChatLlmProvider,
    detectLocal: async () => ({ found: false, baseUrl: "", models: [] }),
    // The install has no CLI session in either case — that is the whole point.
    detectClaudeSession: () => false,
    hasClaudeCredential,
    now: () => "2026-09-16T00:00:00.000Z",
    timeoutMs: () => 500,
  });
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

afterEach(async () => { await server.stop(); setCredentialSource(null); });

describe("Claude Code Test button", () => {
  it("places the call when the legacy token is the only credential", async () => {
    await start(() => true);
    const r = await (await fetch(`${base}/api/llm-providers/claude-code/test`, { method: "POST" })).json() as any;
    expect(called).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.toolCall).toBe(true);
  });

  it("still refuses when there is no credential at all", async () => {
    await start(() => false);
    const r = await (await fetch(`${base}/api/llm-providers/claude-code/test`, { method: "POST" })).json() as any;
    expect(called).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("no_session");
  });
});
