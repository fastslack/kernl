/** Text a user reads must point at the screen that fixes it, not at internals. */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatDiscoveryNotification } from "../src/core/llm/model-discovery.js";

describe("user-facing LLM hints", () => {
  it("chain-test hints name no env var and no API path", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/core/llm/provider-routes.ts"), "utf-8");
    const hints = src.slice(src.indexOf("function buildHint"), src.indexOf("const body = (await server.parseBody<{ prompt?: string"));
    expect(hints).not.toMatch(/[A-Z]+_DEFAULT_MODEL|_API_KEY|\/api\/llm-providers/);
    expect(hints).toContain("Settings → AI");
  });

  it("the discovery notification links to Settings → AI", () => {
    const n = formatDiscoveryNotification({ added: [], removed: [], brokenRefs: [{ slug: "nvidia", model: "x", location: "config", suggestion: "y" }] } as never);
    expect(n?.body).toContain("Settings → AI");
    expect(n?.body).not.toContain("/providers");
  });
});
