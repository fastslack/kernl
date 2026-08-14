/**
 * An agent run that dies because no LLM is configured used to be a dead end:
 * the kernel writes "Configure a provider that supports tools (Settings → AI)"
 * into the error text, the 3D flow prints that text — truncated at 140 chars,
 * so the instruction was the part that got cut — and the reader is left to find
 * the screen on their own.
 *
 * This is the recogniser behind the "Configure LLM →" chip. The strings below
 * are copied verbatim from the kernel, so a change on that side breaks a test
 * here rather than silently dropping the chip.
 */

import { describe, it, expect } from "bun:test";
import { isLlmConfigError, LLM_SETTINGS_HREF } from "./llm-error.js";

describe("isLlmConfigError", () => {
  it("catches a chain with no tool-capable provider", () => {
    // services/kernel/src/modules/agents/executor.ts
    const text =
      "No LLM provider in the chain can run tool calls. Dropped: claude_code. " +
      'Configure a provider that supports tools (Settings → AI), or set this agent\'s executor to "claude_code" to use the CLI\'s own tool loop.';
    expect(isLlmConfigError(text)).toBe(true);
  });

  it("catches a chain with no provider at all", () => {
    expect(isLlmConfigError("No available LLM provider for chain: (default)/(default)")).toBe(true);
  });

  it("catches the readiness verdict", () => {
    expect(isLlmConfigError("No LLM provider is configured. Add an API key or sign in to one.")).toBe(true);
  });

  it("catches a provider that was never set up", () => {
    expect(isLlmConfigError("Provider not configured")).toBe(true);
  });

  it("catches a provider rejecting the key", () => {
    expect(isLlmConfigError("openai: 401 Unauthorized — invalid api key")).toBe(true);
    expect(isLlmConfigError("anthropic provider returned insufficient_quota")).toBe(true);
  });

  it("stays out of failures that have nothing to do with the LLM", () => {
    expect(isLlmConfigError("Failed to add feed: UNIQUE constraint failed: rss_feeds.slug")).toBe(false);
    expect(isLlmConfigError("No reply after 5 min. The run may still be going")).toBe(false);
    expect(isLlmConfigError("")).toBe(false);
    expect(isLlmConfigError(undefined)).toBe(false);
  });

  it("does not claim a bare 401 from some other API", () => {
    // A tool hitting a third-party endpoint fails like this all the time; it is
    // not a reason to send the reader to the provider settings.
    expect(isLlmConfigError("GET https://api.example.com/v2/items — 401 Unauthorized")).toBe(false);
  });
});

describe("LLM_SETTINGS_HREF", () => {
  it("lands on the providers card, not just the AI section", () => {
    expect(LLM_SETTINGS_HREF).toBe("/settings?section=ai&card=providers");
  });
});
