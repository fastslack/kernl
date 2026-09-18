import { describe, it, expect } from "bun:test";
import {
  groupProviders, keyLooksWrong, errorView, modelOptions, chainSummary, timeAgo, pick, hostOf,
  type CatalogProvider,
} from "./llm-connect.js";

const p = (over: Partial<CatalogProvider>): CatalogProvider => ({
  slug: "x", name: "X", group: "paid", recommended: false, kind: "openai-compatible", needsKey: true,
  keyUrl: "https://example.com/keys", keyHint: "", logo: "", blurb: { es: "", en: "" }, tag: { es: "", en: "" },
  pricing: { es: "", en: "" }, steps: { es: [], en: [] }, models: {}, baseUrlEditable: false, regions: [],
  docsUrl: "", connected: false, model: "", keyMasked: "", baseUrl: "", region: "", lastTest: null, ...over,
});

describe("llm-connect helpers", () => {
  it("groups in free, local, paid, subscription order and drops empty groups", () => {
    const g = groupProviders([p({ slug: "a", group: "paid" }), p({ slug: "b", group: "free" }), p({ slug: "c", group: "free" })]);
    expect(g.map((x) => x.group)).toEqual(["free", "paid"]);
    expect(g[0].providers.map((x) => x.slug)).toEqual(["b", "c"]);
  });

  it("warns on a key that does not match the hint, never without a hint", () => {
    expect(keyLooksWrong(p({ keyHint: "^nvapi-" }), "sk-123456")).toBe(true);
    expect(keyLooksWrong(p({ keyHint: "^nvapi-" }), " nvapi-abc ")).toBe(false);
    expect(keyLooksWrong(p({ keyHint: "" }), "anything")).toBe(false);
    expect(keyLooksWrong(p({ keyHint: "^(" }), "bad regex")).toBe(false);
  });

  it("maps every error code to a message and a way out", () => {
    expect(errorView("auth")).toEqual({ messageKey: "llm.err.auth", actionKey: "llm.err.auth_action", action: "open_key" });
    expect(errorView("quota").action).toBe("add_backup");
    expect(errorView("timeout").action).toBe("fast_model");
    expect(errorView("no_tools").action).toBe("pick_model");
    expect(errorView("model").action).toBe("pick_model");
    expect(errorView("unreachable").action).toBe("redetect");
    expect(errorView("no_session").action).toBe("copy_command");
    expect(errorView("network").action).toBe("retry");
    expect(errorView(undefined).messageKey).toBe("llm.err.unknown");
  });

  it("orders model options recommended, fast, candidates, current, live — without duplicates", () => {
    const opts = modelOptions(p({ model: "custom/m", models: { recommended: "r", fast: "f", candidates: ["c", "r"] } }), ["f", "live/1"]);
    expect(opts).toEqual([
      { value: "r", kind: "recommended" }, { value: "f", kind: "fast" }, { value: "c", kind: "candidate" },
      { value: "custom/m", kind: "current" }, { value: "live/1", kind: "other" },
    ]);
  });

  it("summarises the chain with provider names and effective models", () => {
    const providers = [p({ slug: "nvidia", name: "NVIDIA", model: "nemo" }), p({ slug: "groq", name: "Groq", model: "oss" })];
    expect(chainSummary([{ provider: "nvidia", model: "" }, { provider: "groq", model: "oss-20b" }], providers)).toEqual({
      primary: { slug: "nvidia", name: "NVIDIA", model: "nemo" },
      fallbacks: [{ slug: "groq", name: "Groq", model: "oss-20b" }],
    });
    expect(chainSummary([], providers).primary).toBeNull();
  });

  it("time ago buckets", () => {
    const now = Date.parse("2026-09-15T12:00:00Z");
    expect(timeAgo("2026-09-15T11:59:40Z", now)).toEqual({ key: "llm.ago_now", n: 0 });
    expect(timeAgo("2026-09-15T11:55:00Z", now)).toEqual({ key: "llm.ago_min", n: 5 });
    expect(timeAgo("2026-09-15T09:00:00Z", now)).toEqual({ key: "llm.ago_hour", n: 3 });
    expect(timeAgo("2026-09-13T12:00:00Z", now)).toEqual({ key: "llm.ago_day", n: 2 });
  });

  it("pick and hostOf", () => {
    expect(pick({ es: "hola", en: "hi" }, "es")).toBe("hola");
    expect(pick({ es: "hola", en: "hi" }, "fr")).toBe("hi");
    expect(hostOf("https://build.nvidia.com/settings")).toBe("build.nvidia.com");
    expect(hostOf("not a url")).toBe("");
  });
});
