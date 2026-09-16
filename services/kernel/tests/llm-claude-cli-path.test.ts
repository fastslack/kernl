/**
 * The sign-in command has to name a binary that exists. The kernel image keeps
 * no `claude` on PATH — the agent SDK ships it inside its platform package — so
 * printing a bare `claude` told people to run something that answers "not
 * found", directly under a banner telling them their sign-in was out of date.
 */
import { describe, it, expect } from "bun:test";
import { claudeCliPath, claudeCodeLoginCommand } from "../src/core/llm/claude-code-transition.js";

const SDK = "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";

describe("claudeCliPath", () => {
  it("finds the binary the agent SDK ships", () => {
    const found = claudeCliPath("/app", (p) => p === `/app/${SDK}`);
    expect(found).toBe(`/app/${SDK}`);
  });

  it("falls back to PATH when no bundled binary is there", () => {
    expect(claudeCliPath("/app", () => false)).toBe("claude");
  });
});

describe("claudeCodeLoginCommand", () => {
  it("wraps the real path in docker exec inside a container", () => {
    const cmd = claudeCodeLoginCommand({ XDG_CONFIG_HOME: "/app/data/xdg" }, true, `/app/${SDK}`);
    expect(cmd).toBe(
      `docker compose exec kernel sh -c 'CLAUDE_CONFIG_DIR="/app/data/xdg/kernl/claude" /app/${SDK}'`,
    );
    expect(cmd).not.toMatch(/ claude'$/);
  });

  it("stays a plain command outside a container", () => {
    const cmd = claudeCodeLoginCommand({ XDG_CONFIG_HOME: "/home/u/.config" }, false, "claude");
    expect(cmd).toBe('CLAUDE_CONFIG_DIR="/home/u/.config/kernl/claude" claude');
  });
});
