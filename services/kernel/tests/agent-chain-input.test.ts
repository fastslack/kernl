/**
 * What the two general agent writers will accept for `model_chain`.
 *
 * The panel reads the column as a JSON string and sends back what it read, so
 * the string form has to round-trip exactly. The array form stays supported
 * because every existing caller inside the kernel speaks it.
 *
 * The distinction that carries the risk is `undefined` vs `[]`: `updateAgent`
 * writes only the keys it is given, so a value it cannot parse must come back
 * as "nothing was said" and not as "clear the chain".
 */

import { describe, it, expect } from "bun:test";
import {
  normalizeModelChainInput,
  normalizeExecutorType,
  MAX_MODEL_CHAIN,
} from "../src/modules/agents/chain-input.js";

describe("normalizeModelChainInput", () => {
  it("parses the serialised column the panel read", () => {
    const raw = '[{"provider":"openai","model":"gpt-5"},{"provider":"grok","model":"grok-4"}]';
    expect(normalizeModelChainInput(raw)).toEqual([
      { provider: "openai", model: "gpt-5" },
      { provider: "grok", model: "grok-4" },
    ]);
  });

  it("accepts the array form kernel callers already use", () => {
    expect(normalizeModelChainInput([{ provider: "openai", model: "gpt-5" }]))
      .toEqual([{ provider: "openai", model: "gpt-5" }]);
  });

  it("treats an empty string as an explicit clear", () => {
    expect(normalizeModelChainInput("")).toEqual([]);
    expect(normalizeModelChainInput("   ")).toEqual([]);
    expect(normalizeModelChainInput([])).toEqual([]);
  });

  it("says nothing when the caller said nothing", () => {
    expect(normalizeModelChainInput(undefined)).toBeUndefined();
    expect(normalizeModelChainInput(null)).toBeUndefined();
  });

  it("says nothing rather than clearing the chain on garbage", () => {
    expect(normalizeModelChainInput("{not json")).toBeUndefined();
    expect(normalizeModelChainInput('{"provider":"openai"}')).toBeUndefined();
    expect(normalizeModelChainInput(42)).toBeUndefined();
  });

  it("drops rows that carry neither a provider nor a model", () => {
    expect(normalizeModelChainInput([{ provider: "", model: "" }, { provider: "openai", model: "" }]))
      .toEqual([{ provider: "openai", model: "" }]);
  });

  it("coerces non-string members to the empty sentinel rather than String()", () => {
    expect(normalizeModelChainInput([{ provider: "openai", model: 7 }]))
      .toEqual([{ provider: "openai", model: "" }]);
  });

  it("caps the chain at the depth the executor walks", () => {
    const long = Array.from({ length: 6 }, (_, i) => ({ provider: `p${i}`, model: "m" }));
    expect(normalizeModelChainInput(long)?.length).toBe(MAX_MODEL_CHAIN);
  });
});

describe("normalizeExecutorType", () => {
  it("passes the two engines through", () => {
    expect(normalizeExecutorType("native")).toBe("native");
    expect(normalizeExecutorType("claude_code")).toBe("claude_code");
  });
  it("rejects anything else", () => {
    expect(normalizeExecutorType("sdk")).toBeUndefined();
    expect(normalizeExecutorType(undefined)).toBeUndefined();
    expect(normalizeExecutorType(1)).toBeUndefined();
  });
});
