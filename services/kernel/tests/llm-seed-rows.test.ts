import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { LlmProviderRegistry } from "../src/core/llm/provider-registry.js";
import type { LlmProvider } from "../src/core/llm/provider.js";

function fakeProvider(slug: string, name: string): LlmProvider {
  const capabilities = { tools: false, streaming: false, thinking: false, vision: false, promptCaching: false, contextWindow: 1000 };
  return {
    slug, name, capabilities,
    configure() {}, async start() {}, async stop() {},
    isReady() { return false; },
    getStatus() { return { slug, name, ready: false, capabilities }; },
    getConfigSchema() { return []; },
    async chatCompletion() { return { content: "", model: "", stop_reason: "stop" }; },
  } as unknown as LlmProvider;
}

const SCHEMA = `CREATE TABLE installed_extensions (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, version TEXT, type TEXT, status TEXT,
  manifest_json TEXT, source_json TEXT, install_path TEXT, granted_permissions_json TEXT,
  settings_json TEXT, error TEXT, installed_at TEXT, updated_at TEXT, last_loaded_at TEXT
);`;

describe("seedBuiltinRows", () => {
  let db: any;
  beforeEach(() => { db = new Database(":memory:"); db.exec(SCHEMA); });

  it("seeds minimax row with category 'ai' from its manifest", () => {
    const reg = new LlmProviderRegistry();
    reg.setDb(db as any);
    reg.registerFactory("minimax", () => fakeProvider("minimax", "MiniMax"), "builtin");
    reg.seedBuiltinRows();
    const row = db.prepare("SELECT manifest_json, type, settings_json FROM installed_extensions WHERE slug='minimax'").get();
    expect(row).toBeTruthy();
    expect(row.type).toBe("llm-provider");
    expect(JSON.parse(row.manifest_json).category).toBe("ai");
  });

  it("is idempotent and preserves settings_json", () => {
    const reg = new LlmProviderRegistry();
    reg.setDb(db as any);
    reg.registerFactory("minimax", () => fakeProvider("minimax", "MiniMax"), "builtin");
    reg.seedBuiltinRows();
    db.prepare("UPDATE installed_extensions SET settings_json=? WHERE slug='minimax'").run('{"apiKey":"x"}');
    reg.seedBuiltinRows();
    const row = db.prepare("SELECT settings_json FROM installed_extensions WHERE slug='minimax'").get();
    expect(JSON.parse(row.settings_json).apiKey).toBe("x");
  });

  it("migrates an existing row with category 'llm' to 'ai'", () => {
    const reg = new LlmProviderRegistry();
    reg.setDb(db as any);
    reg.registerFactory("minimax", () => fakeProvider("minimax", "MiniMax"), "builtin");
    // Simulate a stale pre-existing row with the old category.
    db.prepare(
      `INSERT INTO installed_extensions (id, slug, name, version, type, status, manifest_json,
       source_json, install_path, granted_permissions_json, settings_json, error, installed_at, updated_at, last_loaded_at)
       VALUES ('builtin.llm.minimax','minimax','MiniMax','1.0.0','llm-provider','active',
       ?, '{"type":"bundled"}','', '[]', '{}', '', 'now','now', NULL)`,
    ).run(JSON.stringify({ slug: "minimax", category: "llm" }));
    reg.seedBuiltinRows();
    const row = db.prepare("SELECT manifest_json FROM installed_extensions WHERE slug='minimax'").get();
    expect(JSON.parse(row.manifest_json).category).toBe("ai");
  });
});
