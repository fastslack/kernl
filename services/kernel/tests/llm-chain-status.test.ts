import { describe, it, expect, afterEach } from "bun:test";
import { describeChainLink } from "../src/core/llm/chain-status.js";
import { rememberClaudeLimit, clearClaudeLimits } from "../src/sdk/claude-limits.js";

const primary = { slug: "claude_code", provider: "claude_code", model: "sonnet", available: true };
afterEach(clearClaudeLimits);

describe("live chain diagnostics", () => {
  it("shows a Claude subscription limit instead of active, with its notice and reset", () => {
    const resetsAt = Date.now() + 120_000;
    rememberClaudeLimit("claude-sonnet-5-5", { kind: "rate_limit", detail: "You've hit your weekly limit · resets 2pm (UTC)", resetsAt });
    const link = describeChainLink(primary, true);
    expect(link.status).toBe("rate-limit");
    expect(link.reason).toBe("You've hit your weekly limit · resets 2pm (UTC)");
    expect(link.resetsAt).toBe(resetsAt);
    expect(link.blockedForMs).toBeGreaterThan(0);
  });

  it("explains a blocked model even when its provider is healthy", () => {
    const link = describeChainLink(primary, true, undefined, { reason: "not-found", error_raw: "Model was removed" });
    expect(link.status).toBe("degraded");
    expect(link.reason).toBe("Model was removed");
  });

  it("explains every provider failure category", () => {
    for (const [kind, status] of [["exhausted", "quota"], ["rate-limit", "rate-limit"], ["auth", "auth"], ["transient", "degraded"]] as const) {
      const link = describeChainLink({ ...primary, slug: "openai" }, true, { blocked: true, failures: 1, lastFailureKind: kind, blockedFor: 4000 });
      expect(link.status).toBe(status);
      expect(link.reason).toBeTruthy();
      expect(link.blockedForMs).toBe(4000);
    }
  });
});
