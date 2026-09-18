import { describe, it, expect } from "bun:test";
import { resolveStreamProvider } from "../src/modules/chat/service.js";

describe("resolveStreamProvider", () => {
  it("resolves to the claude-code provider when the default is empty and the chain names it", () => {
    const resolved = resolveStreamProvider("", "", [{ provider: "claude_code", model: "" }]);
    expect(resolved).toBe("claude-code");
  });

  it("prefers the episode's own provider over the chain", () => {
    expect(resolveStreamProvider("openai", "", [{ provider: "claude_code", model: "" }])).toBe("openai");
  });

  it("prefers the config default over the chain", () => {
    expect(resolveStreamProvider("", "grok", [{ provider: "claude_code", model: "" }])).toBe("grok");
  });

  it("resolves to empty when nothing names a provider", () => {
    expect(resolveStreamProvider("", "", [])).toBe("");
    expect(resolveStreamProvider("", "", undefined)).toBe("");
  });
});
