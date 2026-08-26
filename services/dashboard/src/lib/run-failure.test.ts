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
    expect(analyzeRunFailure(TOOL_BLOCKED).detail).toContain("claude_code");
  });

  it("offers provider configuration when the chain is empty for another reason", () => {
    const f = analyzeRunFailure(NO_PROVIDER);
    const kinds = f.remedies.map((r) => r.kind);
    expect(kinds).toContain("configure-provider");
    expect(kinds).not.toContain("switch-executor-claude-code");
  });

  it("keeps the Google re-auth remedy the panel already had", () => {
    const f = analyzeRunFailure("Google token expired: invalid_grant");
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
});
