import { describe, it, expect } from "bun:test";
import {
  PROVIDER_CATALOG, getCatalogEntry, canonicalSlug, fallbackOrder,
  chatCompletionsUrl, modelsUrl, quirksFor,
} from "../src/core/llm/provider-catalog.js";

describe("provider catalog", () => {
  it("has the 12 providers with unique slugs and aliases", () => {
    const slugs = PROVIDER_CATALOG.map((e) => e.slug);
    expect(slugs).toEqual([
      "nvidia", "gemini", "groq", "openrouter", "ollama", "lmstudio",
      "claude", "openai", "deepseek", "grok", "minimax", "claude-code",
    ]);
    const all = PROVIDER_CATALOG.flatMap((e) => [e.slug, ...e.aliases]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("recommends exactly one provider, NVIDIA", () => {
    expect(PROVIDER_CATALOG.filter((e) => e.recommended).map((e) => e.slug)).toEqual(["nvidia"]);
  });

  it("every entry is complete in both languages", () => {
    for (const e of PROVIDER_CATALOG) {
      for (const l of ["es", "en"] as const) {
        expect(e.blurb[l].length).toBeGreaterThan(10);
        expect(e.tag[l].length).toBeGreaterThan(0);
        expect(e.pricing[l].length).toBeGreaterThan(0);
        expect(e.steps[l].length).toBeGreaterThanOrEqual(2);
      }
      expect(e.steps.es.length).toBe(e.steps.en.length);
      expect(e.logo).toMatch(/^\/api\/extensions\/brand\/[a-z0-9-]+\.svg$/);
      if (e.keyHint) expect(() => new RegExp(e.keyHint!)).not.toThrow();
    }
  });

  it("cloud providers use https and carry a key page and a recommended model", () => {
    for (const e of PROVIDER_CATALOG.filter((x) => x.needsKey)) {
      expect(e.baseUrl).toMatch(/^https:\/\//);
      expect(e.keyUrl).toMatch(/^https:\/\//);
      expect(e.models.recommended).toBeTruthy();
    }
  });

  it("local providers need no key and know where to probe", () => {
    for (const slug of ["ollama", "lmstudio"]) {
      const e = getCatalogEntry(slug)!;
      expect(e.needsKey).toBe(false);
      expect(e.localProbe?.hosts).toContain("host.docker.internal");
    }
  });

  it("resolves aliases to canonical slugs", () => {
    expect(canonicalSlug("anthropic")).toBe("claude");
    expect(canonicalSlug("claude_code")).toBe("claude-code");
    expect(canonicalSlug("xai")).toBe("grok");
    expect(canonicalSlug("nim")).toBe("nvidia");
    expect(canonicalSlug("unknown-thing")).toBe("unknown-thing");
    expect(getCatalogEntry("nim")?.slug).toBe("nvidia");
  });

  it("falls back recommended → free → paid → local → subscription", () => {
    expect(fallbackOrder()).toEqual([
      "nvidia", "gemini", "groq", "openrouter",
      "claude", "openai", "deepseek", "grok", "minimax",
      "ollama", "lmstudio", "claude-code",
    ]);
  });

  it("joins endpoint paths without doubling or losing segments", () => {
    expect(chatCompletionsUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/chat/completions");
    expect(chatCompletionsUrl("https://generativelanguage.googleapis.com/v1beta/openai/"))
      .toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(chatCompletionsUrl("https://x/v1/chat/completions")).toBe("https://x/v1/chat/completions");
    expect(modelsUrl("https://integrate.api.nvidia.com/v1/")).toBe("https://integrate.api.nvidia.com/v1/models");
  });

  it("carries the Nemotron quirks and nothing for unknown models", () => {
    const q = quirksFor("nvidia", "nvidia/nemotron-3-super-120b-a12b");
    expect(q?.extraBody).toEqual({ chat_template_kwargs: { force_nonempty_content: true } });
    expect(q?.temperature).toBe(1);
    expect(quirksFor("nvidia", "some/other-model")).toBeUndefined();
    expect(quirksFor("nim", "nvidia/nemotron-3-super-120b-a12b")).toBeDefined();
  });
});
