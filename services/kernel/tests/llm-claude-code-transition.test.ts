import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setCredentialSource } from "../src/core/llm/credentials.js";
import { applyClaudeCodeTransition, claudeCodeLoginCommand, hasClaudeCodeCredential } from "../src/core/llm/claude-code-transition.js";

let store: Record<string, Record<string, unknown>>;
beforeEach(() => {
  store = {};
  setCredentialSource({ loadConfig: (s) => ({ ...(store[s] ?? {}) }), saveConfig: (s, c) => { store[s] = { ...c }; return true; } });
});
afterEach(() => setCredentialSource(null));

describe("Claude Code transition", () => {
  it("drops a stored token once the CLI has its own session", () => {
    store["claude-code"] = { oauthToken: "sk-ant-oat01-x", connectedAt: "t" };
    expect(applyClaudeCodeTransition({ hasCliSession: () => true })).toBe("cli");
    expect(store["claude-code"]).toEqual({ connectedAt: "t" });
  });

  it("keeps the stored token while there is no CLI session", () => {
    store["claude-code"] = { oauthToken: "sk-ant-oat01-x" };
    expect(applyClaudeCodeTransition({ hasCliSession: () => false })).toBe("legacy-token");
    expect(store["claude-code"].oauthToken).toBe("sk-ant-oat01-x");
    expect(hasClaudeCodeCredential()).toBe(true);
  });

  it("none when there is neither", () => {
    expect(applyClaudeCodeTransition({ hasCliSession: () => false })).toBe("none");
  });

  it("the login command points the CLI at Kernl's config dir", () => {
    // The binary is passed in: resolving it from the machine's own
    // node_modules would make this assert whatever the checkout happens to
    // have. Which binary gets chosen is llm-claude-cli-path.test.ts's job.
    const env = { XDG_CONFIG_HOME: "/app/data/xdg" } as NodeJS.ProcessEnv;
    expect(claudeCodeLoginCommand(env, true, "claude")).toBe(`docker compose exec kernel sh -c 'CLAUDE_CONFIG_DIR="/app/data/xdg/kernl/claude" claude'`);
    expect(claudeCodeLoginCommand(env, false, "claude")).toBe(`CLAUDE_CONFIG_DIR="/app/data/xdg/kernl/claude" claude`);
  });

  it("resets the memoised SDK provider exactly when it deletes a stored token", () => {
    let calls = 0;
    const onCredentialChanged = () => { calls++; };

    store["claude-code"] = { oauthToken: "sk-ant-oat01-x", connectedAt: "t" };
    expect(applyClaudeCodeTransition({ hasCliSession: () => true, onCredentialChanged })).toBe("cli");
    expect(calls).toBe(1);

    store["claude-code"] = { oauthToken: "sk-ant-oat01-x" };
    expect(applyClaudeCodeTransition({ hasCliSession: () => false, onCredentialChanged })).toBe("legacy-token");
    expect(calls).toBe(1);

    store["claude-code"] = {};
    expect(applyClaudeCodeTransition({ hasCliSession: () => false, onCredentialChanged })).toBe("none");
    expect(calls).toBe(1);
  });
});
