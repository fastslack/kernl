/**
 * A failed run should hand over its fix, not a paragraph.
 *
 * The executor already names the remedy in prose (executor.ts:621): "Configure
 * a provider that supports tools (Settings → AI), or set this agent's executor
 * to claude_code". Both of those are one control away in the drawer, so the
 * message is matched and turned into buttons.
 *
 * Matching is deliberately narrow. Only signatures the executor actually
 * emits get a remedy; everything else falls through to plain text. A
 * taxonomy invented for two cases is a taxonomy nobody maintains.
 */

import { describe, it, expect } from "bun:test";
import { analyzeRunFailure } from "./run-failure.js";

const TOOL_BLOCKED =
  'No LLM provider in the chain can run tool calls. Dropped: claude_code. ' +
  'Configure a provider that supports tools (Settings → AI), or set this ' +
  'agent\'s executor to "claude_code" to use the CLI\'s own tool loop.';

const NO_PROVIDER =
  "No available LLM provider for chain: claude/opus, grok/(default)";

describe("analyzeRunFailure", () => {
  it("offers both remedies the executor names for a tool-blocked chain", () => {
    const f = analyzeRunFailure(TOOL_BLOCKED);
    const kinds = f.remedies.map((r) => r.kind);
    expect(kinds).toContain("pick-tool-capable-provider");
    expect(kinds).toContain("switch-executor-claude-code");
    expect(kinds).toContain("retry");
  });

  it("surfaces which providers were dropped", () => {
    expect(analyzeRunFailure(TOOL_BLOCKED).detail).toBe("claude_code");
    expect(analyzeRunFailure(TOOL_BLOCKED).droppedKey).toBe("agent.failure.dropped");
  });

  it("handles multiple dropped providers", () => {
    const multiDrop =
      'No LLM provider in the chain can run tool calls. Dropped: claude_code, lmstudio. ' +
      'Configure a provider that supports tools (Settings → AI).';
    expect(analyzeRunFailure(multiDrop).detail).toBe("claude_code, lmstudio");
  });

  it("offers provider configuration when the chain is empty for another reason", () => {
    const f = analyzeRunFailure(NO_PROVIDER);
    const kinds = f.remedies.map((r) => r.kind);
    expect(kinds).toContain("configure-provider");
    expect(kinds).not.toContain("switch-executor-claude-code");
  });

  it("detects Google auth expiry from google-client 401 responses", () => {
    const f = analyzeRunFailure("Authentication expired. Run kernel_google_auth to re-authenticate.");
    expect(f.remedies.map((r) => r.kind)).toContain("reauth-google");
  });

  it("detects Google auth missing from getAccessToken", () => {
    const f = analyzeRunFailure("Not authenticated. Run kernel_google_auth first.");
    expect(f.remedies.map((r) => r.kind)).toContain("reauth-google");
  });

  it("detects Google OAuth refresh failure", () => {
    const f = analyzeRunFailure("invalid_grant");
    expect(f.remedies.map((r) => r.kind)).toContain("reauth-google");
  });

  it("falls through to plain text with only a retry for an unknown error", () => {
    const f = analyzeRunFailure("ECONNRESET while reading workspace");
    expect(f.remedies.map((r) => r.kind)).toEqual(["retry"]);
    expect(f.detail).toBe("ECONNRESET while reading workspace");
  });

  it("does not crash on an empty error", () => {
    expect(analyzeRunFailure("").remedies.map((r) => r.kind)).toEqual(["retry"]);
  });

  // The overview tab reads title-then-buttons, and these were the last two
  // Spanish strings in an otherwise English drawer. Pinned so a future edit
  // cannot half-translate them back.
  it("returns i18n keys, not prose, so either locale can render it", () => {
    const blocked = analyzeRunFailure(TOOL_BLOCKED);
    expect(blocked.titleKey).toBe("agent.failure.no_tool_capable");
    expect(blocked.remedies.map((r) => r.labelKey)).toEqual([
      "agent.failure.pick_provider",
      "agent.failure.switch_executor",
      "agent.failure.retry",
    ]);

    const noProvider = analyzeRunFailure(NO_PROVIDER);
    expect(noProvider.titleKey).toBe("agent.failure.no_provider_available");
    expect(noProvider.remedies.map((r) => r.labelKey)).toEqual(["agent.failure.configure_providers", "agent.failure.retry"]);

    const google = analyzeRunFailure("invalid_grant");
    expect(google.titleKey).toBe("agent.failure.google_expired");
    expect(google.remedies.map((r) => r.labelKey)).toEqual(["agent.failure.reauth_google", "agent.failure.retry"]);

    expect(analyzeRunFailure("ECONNRESET").titleKey).toBe("agent.failure.generic");
  });

  it("does not confuse Claude Code SDK auth with Google auth (regression)", () => {
    const f = analyzeRunFailure('LLM Claude-Code-SDK 401 not authenticated: invalid credentials (run `claude` and /login)');
    const kinds = f.remedies.map((r) => r.kind);
    expect(kinds).not.toContain("reauth-google");
    expect(kinds).toEqual(["retry"]);
  });
});
