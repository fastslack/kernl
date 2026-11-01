import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";

// pingClaudeCode: the primary account refreshes through the pinned client, any
// other account through an adapter whose child env points at its own dir.

let active = true;
const pinned: string[] = [];
const adapters: Array<string | undefined> = [];

const realClient = await import("../src/core/llm/client.js");
const realFactory = await import("../src/core/llm/chat-factory.js");
mock.module("../src/core/llm/client.js", () => ({
  ...realClient,
  createPinnedLlmClient: (...args: Parameters<typeof realClient.createPinnedLlmClient>) => {
    if (!active) return realClient.createPinnedLlmClient(...args);
    pinned.push(String(args[0]));
    return { chat: async () => ({}) } as never;
  },
}));
mock.module("../src/core/llm/chat-factory.js", () => ({
  ...realFactory,
  buildChatAdapter: (...args: Parameters<typeof realFactory.buildChatAdapter>) => {
    if (!active) return realFactory.buildChatAdapter(...args);
    adapters.push((args[2] as { claudeCode?: { accountId?: string } } | undefined)?.claudeCode?.accountId);
    return { chatCompletion: async () => ({}) } as never;
  },
}));

const { pingClaudeCode } = await import("../src/core/sandbox/claude-session.js");
const { setClaudeAccountResolver, setClaudePrimaryTokenProbe } = await import("../src/sdk/claude-accounts.js");

afterAll(() => { active = false; });

describe("pingClaudeCode", () => {
  beforeEach(() => {
    pinned.length = 0;
    adapters.length = 0;
    setClaudePrimaryTokenProbe(() => false);
    setClaudeAccountResolver(() => [{ id: "A", label: "Work" }, { id: "B", label: "" }]);
  });
  afterEach(() => {
    setClaudeAccountResolver(null);
    setClaudePrimaryTokenProbe(null);
  });

  it("uses the pinned client for no account and for the primary", async () => {
    const { primaryClaudeAccountId } = await import("../src/sdk/claude-accounts.js");
    await pingClaudeCode();
    await pingClaudeCode(primaryClaudeAccountId());
    expect(pinned).toHaveLength(2);
    expect(adapters).toEqual([]);
  });

  it("uses an adapter for another account", async () => {
    const { primaryClaudeAccountId } = await import("../src/sdk/claude-accounts.js");
    const other = primaryClaudeAccountId() === "A" ? "B" : "A";
    await pingClaudeCode(other);
    expect(pinned).toEqual([]);
    expect(adapters).toEqual([other]);
  });
});
