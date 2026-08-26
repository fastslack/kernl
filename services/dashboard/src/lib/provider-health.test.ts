/**
 * The chain row's verdict, decided against a real providers payload.
 *
 * The case that matters is the one from the spec: a chain whose head is the
 * claude_code shim. The agent stores it as `claude_code`, the status payload
 * calls it `claude-code`, and the whole feature is pointless if those two
 * spellings fail to meet — the row would render as "not installed" and hide
 * the reason the run died.
 */

import { describe, it, expect } from "bun:test";
import {
  providerKey,
  findProvider,
  toolCapable,
  linkHealth,
  chainUsable,
  type ProviderStatus,
} from "./provider-health.js";

const CLAUDE_CODE: ProviderStatus = {
  slug: "claude-code",
  name: "CLI shim (SDK)",
  ready: true,
  supportsToolLoop: false,
  capabilities: { tools: false },
};
const OPENAI: ProviderStatus = {
  slug: "openai",
  name: "OpenAI",
  ready: true,
  supportsToolLoop: true,
  capabilities: { tools: true },
};
const GROK_OFFLINE: ProviderStatus = {
  slug: "grok",
  name: "xAI Grok",
  ready: false,
  error: "No API key configured",
  supportsToolLoop: true,
};
const ALL = [CLAUDE_CODE, OPENAI, GROK_OFFLINE];

describe("providerKey", () => {
  it("collapses the underscore and hyphen spellings onto one key", () => {
    expect(providerKey("claude_code")).toBe(providerKey("claude-code"));
  });
  it("is case-insensitive and tolerates junk", () => {
    expect(providerKey("LM Studio")).toBe("lmstudio");
    expect(providerKey("")).toBe("");
    expect(providerKey(undefined as unknown as string)).toBe("");
  });
});

describe("findProvider", () => {
  it("finds the shim by the name the chain stores", () => {
    expect(findProvider(ALL, "claude_code")?.slug).toBe("claude-code");
  });
  it("finds by slug", () => {
    expect(findProvider(ALL, "openai")?.slug).toBe("openai");
  });
  it("falls back to the display name", () => {
    expect(findProvider(ALL, "xAI Grok")?.slug).toBe("grok");
  });
  it("returns nothing for an empty or unknown name", () => {
    expect(findProvider(ALL, "")).toBeUndefined();
    expect(findProvider(ALL, "cohere")).toBeUndefined();
  });
});

describe("toolCapable", () => {
  it("says no when the kernel declares it", () => {
    expect(toolCapable(CLAUDE_CODE)).toBe(false);
  });
  it("says no on capabilities alone, for kernels that predate the flag", () => {
    expect(toolCapable({ slug: "x", name: "X", ready: true, capabilities: { tools: false } }))
      .toBe(false);
  });
  it("says yes only when the flag says yes", () => {
    expect(toolCapable(OPENAI)).toBe(true);
  });
  it("admits it does not know when nothing says", () => {
    expect(toolCapable({ slug: "x", name: "X", ready: true })).toBeUndefined();
    expect(toolCapable({ slug: "x", name: "X", ready: true, capabilities: { tools: true } }))
      .toBeUndefined();
    expect(toolCapable(undefined)).toBeUndefined();
  });
});

describe("linkHealth", () => {
  it("marks the shim as tool-incapable when the run needs tools", () => {
    const h = linkHealth({ provider: "claude_code", model: "sonnet" }, ALL, true);
    expect(h.state).toBe("no-tools");
    expect(h.usable).toBe(false);
    expect(h.label).toBe("cannot run tools");
  });

  it("stops marking it when the executor is the SDK's own loop", () => {
    const h = linkHealth({ provider: "claude_code", model: "sonnet" }, ALL, false);
    expect(h.state).toBe("ok");
    expect(h.usable).toBe(true);
  });

  it("reports a missing key before it reports anything else", () => {
    const h = linkHealth({ provider: "grok", model: "grok-4" }, ALL, true);
    expect(h.state).toBe("not-configured");
    expect(h.detail).toContain("No API key configured");
    expect(h.usable).toBe(false);
  });

  it("reports quota without writing the link off", () => {
    const h = linkHealth({ provider: "openai", model: "gpt-5" }, [{ ...OPENAI, exhausted: true }], true);
    expect(h.state).toBe("exhausted");
    expect(h.usable).toBe(true);
  });

  it("calls an empty provider the kernel default, not an error", () => {
    const h = linkHealth({ provider: "", model: "" }, ALL, true);
    expect(h.state).toBe("unset");
    expect(h.usable).toBe(true);
  });

  it("names a provider this kernel does not have", () => {
    const h = linkHealth({ provider: "cohere", model: "command" }, ALL, true);
    expect(h.state).toBe("unknown");
    expect(h.usable).toBe(false);
  });

  it("passes a ready, tool-capable provider", () => {
    expect(linkHealth({ provider: "openai", model: "gpt-5" }, ALL, true).state).toBe("ok");
  });
});

describe("chainUsable", () => {
  it("is false for the chain from the spec — shim plus an unconfigured provider", () => {
    const chain = [
      { provider: "claude_code", model: "claude-sonnet-4-5" },
      { provider: "grok", model: "grok-4-fast-reasoning" },
    ];
    expect(chainUsable(chain, ALL, true)).toBe(false);
  });

  it("becomes true once one usable provider is in it", () => {
    const chain = [
      { provider: "claude_code", model: "claude-sonnet-4-5" },
      { provider: "openai", model: "gpt-5" },
    ];
    expect(chainUsable(chain, ALL, true)).toBe(true);
  });

  it("becomes true for the same broken chain on the SDK executor", () => {
    const chain = [{ provider: "claude_code", model: "claude-sonnet-4-5" }];
    expect(chainUsable(chain, ALL, false)).toBe(true);
  });

  it("treats an empty chain as the kernel's problem, not a dead end", () => {
    expect(chainUsable([], ALL, true)).toBe(true);
  });
});
