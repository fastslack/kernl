/**
 * A provider that cannot sustain a tool loop must say so in its status.
 *
 * The agent executor already drops such providers from a chain
 * (`selectToolCapable`, executor.ts:52) and fails with a message naming the
 * remedy. The dashboard cannot offer that remedy as a control unless the
 * status payload carries the flag, so it is surfaced here.
 *
 * The flag lives on the chat adapter, not on the registry driver — two
 * parallel hierarchies share these slugs — so the decoration is a join, and
 * a slug with no adapter must stay `undefined` rather than claim `true`.
 */

import { describe, it, expect } from "bun:test";
import { decorateToolLoop } from "../src/core/llm/provider-routes.js";
import type { LlmProviderStatus } from "../src/core/llm/provider.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";

function status(slug: string): LlmProviderStatus {
  return { slug, name: slug, ready: true };
}

function adapter(supportsToolLoop?: boolean): ChatLlmProvider {
  return { supportsToolLoop } as unknown as ChatLlmProvider;
}

describe("decorateToolLoop", () => {
  it("reports false for an adapter that declares it", () => {
    const out = decorateToolLoop(
      [status("claude_code")],
      new Map([["claude_code", adapter(false)]]),
    );
    expect(out[0].supportsToolLoop).toBe(false);
  });

  it("reports true for an adapter that says nothing", () => {
    const out = decorateToolLoop(
      [status("claude")],
      new Map([["claude", adapter()]]),
    );
    expect(out[0].supportsToolLoop).toBe(true);
  });

  it("leaves the flag undefined when no adapter exists for the slug", () => {
    const out = decorateToolLoop([status("ghost")], new Map());
    expect(out[0].supportsToolLoop).toBeUndefined();
  });

  it("is a no-op when the provider map is unavailable", () => {
    const out = decorateToolLoop([status("claude")], null);
    expect(out[0].supportsToolLoop).toBeUndefined();
    expect(out[0].slug).toBe("claude");
  });
});
