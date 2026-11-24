/**
 * An agent with every tool enabled (800+) and progressive discovery off sent the first 128 tool schemas on every
 * turn — about 17k tokens — and lost the rest at random: a one-line "hola" to a lead cost ~95k tokens in four calls.
 * Above what a provider takes, the run now starts from the bootstrap set and activates tools on demand.
 */
import { describe, it, expect } from "bun:test";
import { usesProgressiveDiscovery, AUTO_PROGRESSIVE_ABOVE } from "../src/modules/agents/executor.js";

describe("usesProgressiveDiscovery", () => {
  it("follows the agent's own setting while the catalog fits", () => {
    expect(usesProgressiveDiscovery(false, 40)).toBe(false);
    expect(usesProgressiveDiscovery(true, 40)).toBe(true);
    expect(usesProgressiveDiscovery(false, AUTO_PROGRESSIVE_ABOVE)).toBe(false);
  });

  it("turns on by itself above what a provider takes", () => {
    expect(usesProgressiveDiscovery(false, AUTO_PROGRESSIVE_ABOVE + 1)).toBe(true);
    expect(usesProgressiveDiscovery(false, 842)).toBe(true);
  });
});
