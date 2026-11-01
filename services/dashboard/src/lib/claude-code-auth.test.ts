import { describe, it, expect } from "bun:test";
import { isClaudeCodeAuthError } from "./claude-code-auth.js";

/**
 * The rule that turns a dead-end agent reply into a sign-in button. It has to
 * catch the provider's real error envelopes without firing on a model that
 * merely mentions logging in.
 */
describe("isClaudeCodeAuthError", () => {
  it("matches what the chat actually showed", () => {
    expect(isClaudeCodeAuthError("Error: Claude Code returned an error result: Not logged in · Please run /login")).toBe(true);
  });

  it("matches the kernel's own chain error", () => {
    expect(
      isClaudeCodeAuthError("LLM Claude-Code-SDK 401 not authenticated: Not logged in (run `claude` and /login)"),
    ).toBe(true);
  });

  it("matches a subscription the organization switched off", () => {
    expect(
      isClaudeCodeAuthError(
        "Claude Code returned an error result: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
      ),
    ).toBe(true);
  });

  it("matches a run the kernel held for the reconnection", () => {
    expect(isClaudeCodeAuthError("Claude access lost — waiting for reconnection: claude_code: subscription access lost on claude-sonnet-5-5.")).toBe(true);
  });

  it("matches an expired OAuth session", () => {
    expect(isClaudeCodeAuthError("Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth token has expired")).toBe(true);
  });

  it("does not fire on a model talking about logins", () => {
    // Otherwise every answer about authentication sprouts a sign-in button.
    expect(isClaudeCodeAuthError("To log in to the app, run `npm start` and open the login page.")).toBe(false);
    expect(isClaudeCodeAuthError("Here is how OAuth works…")).toBe(false);
  });

  it("ignores empty and non-string content", () => {
    expect(isClaudeCodeAuthError("")).toBe(false);
    expect(isClaudeCodeAuthError(null)).toBe(false);
    expect(isClaudeCodeAuthError(undefined)).toBe(false);
  });
});
