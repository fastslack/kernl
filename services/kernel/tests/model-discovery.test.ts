import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ModelCatalog } from "../src/core/llm/model-catalog.js";
import { ModelBlocklist } from "../src/core/llm/model-blocklist.js";
import {
  suggestSuccessor,
  findBrokenRefs,
  discoverModels,
  formatDiscoveryNotification,
  normalizeSlug,
  type DiscoveryRegistry,
} from "../src/core/llm/model-discovery.js";
import type { KernelConfig } from "../src/core/config.js";

function fakeConfig(over: Partial<{ chain: Array<{ provider: string; model: string }>; evalModel: string; evalProvider: string }> = {}): KernelConfig {
  return {
    agents: {
      defaultModelChain: over.chain ?? [],
      defaultProvider: "minimax",
      defaultModel: "",
      evalProvider: over.evalProvider ?? "",
      evalModel: over.evalModel ?? "",
    },
    chat: { defaultProvider: "openai", defaultModel: "", extractionModel: "" },
  } as unknown as KernelConfig;
}

/** Registry whose providers return canned lists (or throw). */
function fakeRegistry(map: Record<string, (() => Promise<string[]>) | "throw">): DiscoveryRegistry {
  return {
    getRunningSlugs: () => Object.keys(map),
    getProvider: (slug) => {
      const entry = map[slug];
      if (!entry) return undefined;
      return {
        listModels: entry === "throw" ? async () => { throw new Error("unreachable"); } : entry,
      };
    },
  };
}

describe("suggestSuccessor", () => {
  let db: Database;
  let catalog: ModelCatalog;
  beforeEach(() => {
    db = new Database(":memory:");
    catalog = new ModelCatalog(db);
  });
  afterEach(() => db.close());

  it("picks the highest newer model of the same family", () => {
    catalog.recordDiscovery("minimax", ["MiniMax-M2.7", "MiniMax-M3", "MiniMax-Text-01"]);
    expect(suggestSuccessor(catalog, "minimax", "MiniMax-M2.7")).toBe("MiniMax-M3");
  });

  it("compares multi-segment versions numerically", () => {
    catalog.recordDiscovery("claude", ["claude-sonnet-4-5", "claude-sonnet-4-6"]);
    expect(suggestSuccessor(catalog, "claude", "claude-sonnet-4-5")).toBe("claude-sonnet-4-6");
  });

  it("returns null when no same-family candidate is newer", () => {
    catalog.recordDiscovery("minimax", ["MiniMax-M2.7", "MiniMax-Text-01"]);
    expect(suggestSuccessor(catalog, "minimax", "MiniMax-M2.7")).toBeNull();
  });

  it("does not cross families (different name shape)", () => {
    catalog.recordDiscovery("openai", ["gpt-4o", "gpt-4o-mini"]);
    // gpt-4o-mini has an extra suffix → different family signature
    expect(suggestSuccessor(catalog, "openai", "gpt-4o")).toBeNull();
  });

  it("does not suggest an equal version", () => {
    catalog.recordDiscovery("minimax", ["MiniMax-M3"]);
    expect(suggestSuccessor(catalog, "minimax", "MiniMax-M3")).toBeNull();
  });
});

describe("normalizeSlug", () => {
  it("maps config provider names to registry slugs", () => {
    expect(normalizeSlug("claude_code")).toBe("claude-code");
    expect(normalizeSlug("anthropic")).toBe("claude");
    expect(normalizeSlug("minimax")).toBe("minimax");
  });
});

describe("findBrokenRefs", () => {
  let db: Database;
  let catalog: ModelCatalog;
  beforeEach(() => {
    db = new Database(":memory:");
    catalog = new ModelCatalog(db);
    // M2.7 is gone, M3 is the live successor.
    catalog.recordDiscovery("minimax", ["MiniMax-M2.7", "MiniMax-M3"]);
    catalog.recordDiscovery("minimax", ["MiniMax-M3"]);
  });
  afterEach(() => db.close());

  it("flags a global config chain ref that points at a gone model + suggests successor", () => {
    const refs = findBrokenRefs({
      catalog,
      config: fakeConfig({ chain: [{ provider: "minimax", model: "MiniMax-M2.7" }] }),
      db,
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "config", configKey: "AGENTS_DEFAULT_MODEL_CHAIN", slug: "minimax", model: "MiniMax-M2.7", suggestion: "MiniMax-M3" });
  });

  it("flags AGENTS_EVAL_MODEL falling back to defaultProvider", () => {
    const refs = findBrokenRefs({ catalog, config: fakeConfig({ evalModel: "MiniMax-M2.7" }), db });
    expect(refs.map((r) => r.configKey)).toContain("AGENTS_EVAL_MODEL");
  });

  it("flags a per-agent model_chain ref (with slug alias normalization)", () => {
    db.exec("CREATE TABLE agents (id TEXT, name TEXT, model_chain TEXT, deleted_at TEXT)");
    db.prepare("INSERT INTO agents (id, name, model_chain) VALUES (?, ?, ?)").run(
      "a1",
      "Job Application Drafter",
      JSON.stringify([{ provider: "minimax", model: "MiniMax-M2.7" }]),
    );
    const refs = findBrokenRefs({ catalog, config: fakeConfig(), db });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "agent", agentId: "a1", location: "agent: Job Application Drafter", suggestion: "MiniMax-M3" });
  });

  it("does not flag a model that is still available", () => {
    const refs = findBrokenRefs({ catalog, config: fakeConfig({ chain: [{ provider: "minimax", model: "MiniMax-M3" }] }), db });
    expect(refs).toEqual([]);
  });
});

describe("discoverModels", () => {
  let db: Database;
  let catalog: ModelCatalog;
  let blocklist: ModelBlocklist;
  beforeEach(() => {
    db = new Database(":memory:");
    catalog = new ModelCatalog(db);
    blocklist = new ModelBlocklist(db);
  });
  afterEach(() => db.close());

  it("records new models as added", async () => {
    const report = await discoverModels({
      registry: fakeRegistry({ minimax: async () => ["MiniMax-M3", "MiniMax-Text-01"] }),
      catalog,
      blocklist,
      config: fakeConfig(),
      db,
    });
    expect(report.added.map((m) => m.model).sort()).toEqual(["MiniMax-M3", "MiniMax-Text-01"]);
    expect(report.removed).toEqual([]);
  });

  it("a provider that throws produces ZERO removals (no false 'gone')", async () => {
    // Seed M2.7 as available via a good run.
    await discoverModels({ registry: fakeRegistry({ minimax: async () => ["MiniMax-M2.7"] }), catalog, blocklist, config: fakeConfig(), db });
    // Now the provider is unreachable.
    const report = await discoverModels({ registry: fakeRegistry({ minimax: "throw" }), catalog, blocklist, config: fakeConfig(), db });
    expect(report.removed).toEqual([]);
    expect(catalog.isGone("minimax", "MiniMax-M2.7")).toBe(false);
  });

  it("a provider returning an empty list produces ZERO removals", async () => {
    await discoverModels({ registry: fakeRegistry({ minimax: async () => ["MiniMax-M2.7"] }), catalog, blocklist, config: fakeConfig(), db });
    const report = await discoverModels({ registry: fakeRegistry({ minimax: async () => [] }), catalog, blocklist, config: fakeConfig(), db });
    expect(report.removed).toEqual([]);
    expect(catalog.isGone("minimax", "MiniMax-M2.7")).toBe(false);
  });

  it("surfaces a broken config ref after a model disappears", async () => {
    const config = fakeConfig({ chain: [{ provider: "minimax", model: "MiniMax-M2.7" }] });
    await discoverModels({ registry: fakeRegistry({ minimax: async () => ["MiniMax-M2.7", "MiniMax-M3"] }), catalog, blocklist, config, db });
    const report = await discoverModels({ registry: fakeRegistry({ minimax: async () => ["MiniMax-M3"] }), catalog, blocklist, config, db });
    expect(report.removed.map((m) => m.model)).toEqual(["MiniMax-M2.7"]);
    expect(report.brokenRefs).toHaveLength(1);
    expect(report.brokenRefs[0].suggestion).toBe("MiniMax-M3");
  });
});

describe("formatDiscoveryNotification", () => {
  it("returns null when nothing changed", () => {
    expect(formatDiscoveryNotification({ added: [], removed: [], brokenRefs: [] })).toBeNull();
  });

  it("builds a body when there are new models or broken refs", () => {
    const note = formatDiscoveryNotification({
      added: [{ slug: "minimax", model: "MiniMax-M3" }],
      removed: [],
      brokenRefs: [{ location: "config: AGENTS_EVAL_MODEL", kind: "config", configKey: "AGENTS_EVAL_MODEL", slug: "minimax", model: "MiniMax-M2.7", suggestion: "MiniMax-M3" }],
    });
    expect(note).not.toBeNull();
    expect(note!.body).toContain("MiniMax-M3");
    expect(note!.body).toContain("MiniMax-M2.7");
  });
});
