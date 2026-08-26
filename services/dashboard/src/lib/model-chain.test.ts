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
import { readChain, writeChain, MAX_CHAIN_LINKS } from "./model-chain.js";

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
  describe("readChain coerces non-string values to strings", () => {
    it("coerces numeric provider to string", () => {
      const chain = JSON.stringify([{ provider: 123, model: "opus" }]);
      const result = readChain({ model_chain: chain });
      expect(result).toEqual([{ provider: "123", model: "opus" }]);
      expect(typeof result[0].provider).toBe("string");
      expect(typeof result[0].model).toBe("string");
    });

    it("coerces boolean model to string", () => {
      const chain = JSON.stringify([{ provider: "grok", model: true }]);
      const result = readChain({ model_chain: chain });
      expect(result).toEqual([{ provider: "grok", model: "true" }]);
      expect(typeof result[0].provider).toBe("string");
      expect(typeof result[0].model).toBe("string");
    });
  });

  describe("writeChain coerces non-string values to strings", () => {
    it("coerces numeric provider to string", () => {
      const result = writeChain([{ provider: 123 as any, model: "opus" }]);
      expect(result.provider).toBe("123");
      expect(typeof result.provider).toBe("string");
      expect(typeof result.model).toBe("string");
    });

    it("coerces boolean model to string", () => {
      const result = writeChain([{ provider: "grok", model: true as any }]);
      expect(result.model).toBe("true");
      expect(typeof result.model).toBe("string");
      expect(typeof result.provider).toBe("string");
    });
  });
});
