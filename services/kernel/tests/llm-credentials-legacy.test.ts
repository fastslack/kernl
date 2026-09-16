import { describe, it, expect } from "bun:test";
import { legacyToStoredPatch, legacyCredentialTarget } from "../src/core/llm/credentials-legacy.js";

describe("legacy env-var → registry mapping", () => {
  it("maps legacy env names to stored fields", () => {
    expect(legacyCredentialTarget("XAI_API_KEY")).toEqual({ slug: "grok", field: "apiKey" });
    expect(legacyCredentialTarget("OLLAMA_BASE_URL")).toBeUndefined();
    expect(legacyToStoredPatch("MINIMAX_BASE_URL", "https://api.minimax.cn/v1")?.patch).toEqual({ region: "china" });
    expect(legacyToStoredPatch("NVIDIA_DEFAULT_MODEL", "x")?.patch).toEqual({ defaultModel: "x" });
    expect(legacyToStoredPatch("NVIDIA_API_KEY", "k")?.patch.apiKey).toBe("k");
  });
});
