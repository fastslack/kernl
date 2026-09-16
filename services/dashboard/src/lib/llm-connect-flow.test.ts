import { describe, it, expect } from "bun:test";
import { connectInputFor, canConnect, type CatalogProvider } from "./llm-connect.js";

const base = {
  name: "X", recommended: false, keyUrl: "", keyHint: "", logo: "", blurb: { es: "", en: "" }, tag: { es: "", en: "" },
  pricing: { es: "", en: "" }, steps: { es: [], en: [] }, models: {}, docsUrl: "", connected: false, model: "",
  keyMasked: "", region: "", lastTest: null, regions: [], baseUrlEditable: false, baseUrl: "",
};
const nvidia = { ...base, slug: "nvidia", group: "free", kind: "openai-compatible", needsKey: true } as CatalogProvider;
const ollama = { ...base, slug: "ollama", group: "local", kind: "openai-compatible", needsKey: false, baseUrlEditable: true } as CatalogProvider;
const minimax = { ...nvidia, slug: "minimax", group: "paid", regions: [{ id: "global", label: { es: "", en: "" }, baseUrl: "" }] } as CatalogProvider;

describe("connect form", () => {
  it("sends only what the provider accepts, trimmed", () => {
    expect(connectInputFor(nvidia, { apiKey: " nvapi-1 ", model: "m", region: "x", baseUrl: "http://x" }))
      .toEqual({ apiKey: "nvapi-1", model: "m" });
    expect(connectInputFor(ollama, { apiKey: "", model: "qwen3", region: "", baseUrl: " http://host.docker.internal:11434/v1 " }))
      .toEqual({ model: "qwen3", baseUrl: "http://host.docker.internal:11434/v1" });
    expect(connectInputFor(minimax, { apiKey: "k", model: "", region: "china", baseUrl: "" }))
      .toEqual({ apiKey: "k", region: "china" });
  });

  it("enables Connect only when it can succeed", () => {
    expect(canConnect(nvidia, { apiKey: "", baseUrl: "" }, false)).toBe(false);
    expect(canConnect(nvidia, { apiKey: "k", baseUrl: "" }, false)).toBe(true);
    expect(canConnect({ ...nvidia, keyMasked: "nvapi-***" }, { apiKey: "", baseUrl: "" }, false)).toBe(true);
    expect(canConnect(nvidia, { apiKey: "k", baseUrl: "" }, true)).toBe(false);
    expect(canConnect(ollama, { apiKey: "", baseUrl: "" }, false)).toBe(false);
    expect(canConnect(ollama, { apiKey: "", baseUrl: "http://x" }, false)).toBe(true);
  });
});
