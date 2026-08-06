/**
 * An agent's provider chain must not include a provider that cannot run a
 * tool-use loop.
 *
 * Observed on a live kernel:
 *
 *   ▶ LLM claude_code [agent:Nadia] · 1 msgs, 555 tools
 *   ✗ LLM claude_code [agent:Nadia] · transient: Claude Code returned an
 *     error result: Reached maximum number of turns (1)
 *
 * 555 tools were handed to `claude_code`, whose chatCompletion() is a
 * deliberate single-turn shim (`maxTurns: 1`, `allowedTools: []`). The model
 * still tries to act, needs a second turn, and the SDK aborts. Every native
 * agent whose chain reaches that provider fails this way, which is why it
 * looked intermittent rather than systematic — it depends on which providers
 * were healthy at that moment.
 *
 * chat-adapters.ts documents the guard — "Tool-using callers should pass
 * `disableToolFallbacks`" — but no such option was ever implemented; the
 * identifier appears once in the codebase, in that comment.
 *
 * Whether a provider can sustain a tool loop is the provider's own property,
 * so it is declared there and honoured here.
 */

import { describe, it, expect } from "bun:test";
import { selectToolCapable } from "../src/modules/agents/executor.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";

function provider(name: string, supportsToolLoop?: boolean): ChatLlmProvider {
  return {
    name,
    available: () => true,
    ...(supportsToolLoop === undefined ? {} : { supportsToolLoop }),
    chatCompletion: async () => ({ content: "", tokens_used: 0, model: "stub" }),
  } as ChatLlmProvider;
}

const entry = (p: ChatLlmProvider) => ({ provider: p, model: "", configProvider: p.name });

describe("selectToolCapable", () => {
  it("drops a single-turn provider when the run will send tools", () => {
    const chain = [entry(provider("claude_code", false)), entry(provider("grok"))];
    const { chain: kept, dropped } = selectToolCapable(chain, 555);
    expect(kept.map((e) => e.provider.name)).toEqual(["grok"]);
    expect(dropped).toEqual(["claude_code"]);
  });

  it("keeps it when the run sends no tools — plain completions are what it is for", () => {
    const chain = [entry(provider("claude_code", false)), entry(provider("grok"))];
    const { chain: kept, dropped } = selectToolCapable(chain, 0);
    expect(kept.map((e) => e.provider.name)).toEqual(["claude_code", "grok"]);
    expect(dropped).toEqual([]);
  });

  it("treats a provider that says nothing as capable", () => {
    // Every other provider drives its own tool loop; absence of the flag must
    // not silently disable them.
    const chain = [entry(provider("grok")), entry(provider("claude"))];
    const { chain: kept } = selectToolCapable(chain, 12);
    expect(kept).toHaveLength(2);
  });

  it("preserves chain order among the survivors", () => {
    const chain = [
      entry(provider("grok")),
      entry(provider("claude_code", false)),
      entry(provider("claude")),
    ];
    const { chain: kept } = selectToolCapable(chain, 3);
    expect(kept.map((e) => e.provider.name)).toEqual(["grok", "claude"]);
  });

  it("empties the chain when nothing left can run tools, rather than failing obscurely", () => {
    // Better a precise "no provider can run tool calls" than a turn-limit
    // error from a provider that was never going to work.
    const chain = [entry(provider("claude_code", false))];
    const { chain: kept, dropped } = selectToolCapable(chain, 40);
    expect(kept).toEqual([]);
    expect(dropped).toEqual(["claude_code"]);
  });
});
