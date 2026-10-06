/**
 * One concept for the user, two columns in the database.
 *
 * `agents` carries both a loose (provider, model) pair and a `model_chain`
 * JSON array, where an empty chain means "use the loose pair". Exposing that
 * to a person would be handing them a schema decision, so the drawer shows a
 * single ordered list and this module is the only place the two shapes meet.
 *
 * The loose pair is never dropped when a chain exists: executor.ts:640 keeps
 * `provider` for downstream code, so writing a chain also mirrors its head.
 */

import { describe, it, expect } from "bun:test";
import { readChain, writeChain, MAX_CHAIN_LINKS, runsOnClaudeCode, primaryModelPatch, engineFor } from "./model-chain.js";

describe("readChain", () => {
  it("reads the loose pair when there is no chain", () => {
    expect(readChain({ provider: "claude", model: "opus", model_chain: "" }))
      .toEqual([{ provider: "claude", model: "opus" }]);
  });

  it("reads the chain when there is one", () => {
    const chain = JSON.stringify([
      { provider: "grok", model: "grok-4" },
      { provider: "claude", model: "opus" },
    ]);
    expect(readChain({ provider: "grok", model: "grok-4", model_chain: chain }))
      .toEqual([
        { provider: "grok", model: "grok-4" },
        { provider: "claude", model: "opus" },
      ]);
  });

  it("falls back to the loose pair when the chain is not valid JSON", () => {
    expect(readChain({ provider: "claude", model: "opus", model_chain: "{broken" }))
      .toEqual([{ provider: "claude", model: "opus" }]);
  });

  it("falls back to the loose pair when the chain is JSON but not an array", () => {
    expect(readChain({ provider: "claude", model: "opus", model_chain: '{"a":1}' }))
      .toEqual([{ provider: "claude", model: "opus" }]);
  });

  it("returns an empty list for an agent with nothing configured", () => {
    expect(readChain({})).toEqual([]);
  });

  it("drops chain entries that carry neither provider nor model", () => {
    const chain = JSON.stringify([
      { provider: "grok", model: "grok-4" },
      { provider: "", model: "" },
    ]);
    expect(readChain({ model_chain: chain })).toEqual([{ provider: "grok", model: "grok-4" }]);
  });
});

describe("writeChain", () => {
  it("writes only the loose pair for a single link", () => {
    expect(writeChain([{ provider: "claude", model: "opus" }]))
      .toEqual({ provider: "claude", model: "opus", model_chain: "" });
  });

  it("writes the chain and mirrors its head into the loose pair", () => {
    const out = writeChain([
      { provider: "grok", model: "grok-4" },
      { provider: "claude", model: "opus" },
    ]);
    expect(out.provider).toBe("grok");
    expect(out.model).toBe("grok-4");
    expect(JSON.parse(out.model_chain)).toEqual([
      { provider: "grok", model: "grok-4" },
      { provider: "claude", model: "opus" },
    ]);
  });

  it("clears everything for an empty list", () => {
    expect(writeChain([])).toEqual({ provider: "", model: "", model_chain: "" });
  });

  it("caps the chain at MAX_CHAIN_LINKS", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ provider: `p${i}`, model: `m${i}` }));
    expect(JSON.parse(writeChain(four).model_chain)).toHaveLength(MAX_CHAIN_LINKS);
  });
});

describe("round trip", () => {
  it("survives a single link unchanged", () => {
    const links = [{ provider: "claude", model: "opus" }];
    expect(readChain(writeChain(links))).toEqual(links);
  });

  it("survives a three-link chain unchanged", () => {
    const links = [
      { provider: "grok", model: "grok-4" },
      { provider: "claude", model: "opus" },
      { provider: "lmstudio", model: "local" },
    ];
    expect(readChain(writeChain(links))).toEqual(links);
  });
});

describe("corruption edge cases", () => {
  describe("readChain coerces non-string values to empty sentinel", () => {
    it("coerces numeric provider to empty string (not configured)", () => {
      const chain = JSON.stringify([{ provider: 123, model: "opus" }]);
      const result = readChain({ model_chain: chain });
      expect(result).toEqual([{ provider: "", model: "opus" }]);
      expect(typeof result[0].provider).toBe("string");
      expect(typeof result[0].model).toBe("string");
    });

    it("coerces boolean model to empty string (not configured)", () => {
      const chain = JSON.stringify([{ provider: "grok", model: true }]);
      const result = readChain({ model_chain: chain });
      expect(result).toEqual([{ provider: "grok", model: "" }]);
      expect(typeof result[0].provider).toBe("string");
      expect(typeof result[0].model).toBe("string");
    });

    it("degrades to loose pair when link is fully corrupted", () => {
      const chain = JSON.stringify([{ provider: true, model: true }]);
      const result = readChain({
        model_chain: chain,
        provider: "claude",
        model: "opus",
      });
      expect(result).toEqual([{ provider: "claude", model: "opus" }]);
    });
  });

  describe("writeChain coerces non-string values to empty sentinel", () => {
    it("coerces numeric provider to empty string (not configured)", () => {
      const result = writeChain([{ provider: 123 as any, model: "opus" }]);
      expect(result.provider).toBe("");
      expect(typeof result.provider).toBe("string");
      expect(typeof result.model).toBe("string");
    });

    it("coerces boolean model to empty string (not configured)", () => {
      const result = writeChain([{ provider: "grok", model: true as any }]);
      expect(result.model).toBe("");
      expect(typeof result.model).toBe("string");
      expect(typeof result.provider).toBe("string");
    });
  });
});

describe("runsOnClaudeCode", () => {
  it("accepts Claude models and a Claude provider's default", () => {
    expect(runsOnClaudeCode({ provider: "claude-code", model: "claude-opus-5" })).toBe(true);
    expect(runsOnClaudeCode({ provider: "claude_code", model: "" })).toBe(true);
    expect(runsOnClaudeCode({ provider: "anthropic", model: "claude-sonnet-5-5" })).toBe(true);
  });
  it("refuses any other model", () => {
    expect(runsOnClaudeCode({ provider: "minimax", model: "MiniMax-M3" })).toBe(false);
    expect(runsOnClaudeCode({ provider: "openai", model: "" })).toBe(false);
  });
});

describe("primaryModelPatch", () => {
  it("moves a claude_code agent to the kernel executor when the model is not Claude", () => {
    const p = primaryModelPatch({ executor_type: "claude_code" }, [], { provider: "minimax", model: "MiniMax-M3" });
    expect(p.executor_type).toBe("native");
    expect(p.provider).toBe("minimax");
    expect(p.model).toBe("MiniMax-M3");
  });
  it("keeps the executor for a Claude model, and keeps the fallbacks", () => {
    const p = primaryModelPatch({ executor_type: "claude_code" }, [
      { provider: "claude-code", model: "claude-opus-4-6" }, { provider: "openai", model: "gpt-5" },
    ], { provider: "claude-code", model: "claude-opus-5" });
    expect(p.executor_type).toBeUndefined();
    expect(JSON.parse(p.model_chain)).toEqual([
      { provider: "claude-code", model: "claude-opus-5" }, { provider: "openai", model: "gpt-5" },
    ]);
  });
  it("leaves a native agent on the kernel for a non-Claude-Code model", () => {
    expect(primaryModelPatch({ executor_type: "native" }, [], { provider: "minimax", model: "MiniMax-M3" }).executor_type).toBeUndefined();
    expect(primaryModelPatch({}, [], { provider: "openai", model: "gpt-5" }).executor_type).toBeUndefined();
  });
  it("moves a native agent to the claude_code executor when a Claude Code model is picked", () => {
    expect(primaryModelPatch({ executor_type: "native" }, [], { provider: "claude-code", model: "claude-opus-5" }).executor_type).toBe("claude_code");
    expect(primaryModelPatch({}, [], { provider: "claude_code", model: "" }).executor_type).toBe("claude_code");
  });
  it("moves a claude_code agent to the kernel when a Claude model comes from the API provider", () => {
    expect(primaryModelPatch({ executor_type: "claude_code" }, [], { provider: "claude", model: "claude-sonnet-5" }).executor_type).toBe("native");
  });
});

describe("engineFor", () => {
  it("is claude_code only for the Claude Code SDK provider, however it is spelled", () => {
    expect(engineFor({ provider: "claude-code", model: "claude-opus-5" })).toBe("claude_code");
    expect(engineFor({ provider: "claude_code", model: "" })).toBe("claude_code");
    expect(engineFor({ provider: "Claude Code", model: "" })).toBe("claude_code");
    expect(engineFor({ provider: "claude", model: "claude-opus-5" })).toBe("native");
    expect(engineFor({ provider: "", model: "" })).toBe("native");
  });
});
