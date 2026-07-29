/**
 * LlmProviderRegistry — factory + instance store for LLM backends.
 *
 * Espejo exacto de SandboxDriverRegistry. Factories son keyed por slug
 * ("claude", "openai", "grok", "lmstudio", …); instances viven en un mapa
 * separate map populated when the driver starts. Config persists in
 * `installed_extensions` rows con `type='llm-provider'`.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";
import type {
  LlmProvider,
  LlmProviderStatus,
  ChatMessage,
  ChatCompletionOptions,
  ChatCompletionResult,
  ConfigField,
} from "./provider.js";
import { decryptSecrets, encryptSecrets } from "../secrets.js";

export type LlmProviderFactory = () => LlmProvider;
export type LlmProviderSource = "builtin" | "extension";

interface RegisteredFactory {
  factory: LlmProviderFactory;
  source: LlmProviderSource;
}

export class LlmProviderRegistry {
  private factories = new Map<string, RegisteredFactory>();
  private providers = new Map<string, LlmProvider>();
  private preStartHooks = new Map<string, (provider: LlmProvider) => void>();
  private exhausted = new Set<string>();
  private db: SqliteDb | null = null;
  private encryptionKey = "";
  lastStartError: string | null = null;

  setDb(db: SqliteDb): void {
    this.db = db;
  }

  setEncryptionKey(key: string): void {
    this.encryptionKey = key;
  }

  // ── Registration ──────────────────────────────────────────────────

  registerFactory(slug: string, factory: LlmProviderFactory, source: LlmProviderSource = "builtin"): void {
    this.factories.set(slug, { factory, source });
    log.debug(`LlmProviderRegistry: registered factory "${slug}" (${source})`);
  }

  registerDriverFromExtension(slug: string, factory: LlmProviderFactory): void {
    this.registerFactory(slug, factory, "extension");
  }

  async unregister(slug: string): Promise<void> {
    if (this.providers.has(slug)) {
      await this.stopProvider(slug).catch(() => {});
    }
    this.factories.delete(slug);
    this.preStartHooks.delete(slug);
  }

  registerPreStartHook(slug: string, hook: (provider: LlmProvider) => void): void {
    this.preStartHooks.set(slug, hook);
  }

  // ── Lookup ────────────────────────────────────────────────────────

  getProvider(slug: string): LlmProvider | undefined {
    return this.providers.get(slug);
  }

  getAvailableSlugs(): string[] {
    return [...this.factories.keys()];
  }

  getRunningSlugs(): string[] {
    return [...this.providers.keys()];
  }

  hasFactory(slug: string): boolean {
    return this.factories.has(slug);
  }

  // ── Config persistence ────────────────────────────────────────────

  loadConfig(slug: string): Record<string, unknown> {
    if (!this.db) return {};
    try {
      const row = this.db
        .prepare(
          "SELECT settings_json FROM installed_extensions WHERE slug = ? AND type = 'llm-provider'",
        )
        .get(slug) as { settings_json: string } | undefined;
      if (!row) return {};
      const raw = JSON.parse(row.settings_json || "{}") as Record<string, unknown>;
      return this.encryptionKey ? decryptSecrets(raw, this.encryptionKey) : raw;
    } catch (err) {
      log.warn(`LlmProviderRegistry: loadConfig("${slug}") failed: ${String(err)}`);
      return {};
    }
  }

  saveConfig(slug: string, config: Record<string, unknown>): boolean {
    if (!this.db) return false;
    try {
      const secure = this.encryptionKey ? encryptSecrets(config, this.encryptionKey) : config;
      const now = new Date().toISOString();
      const res = this.db
        .prepare(
          "UPDATE installed_extensions SET settings_json = ?, updated_at = ? WHERE slug = ? AND type = 'llm-provider'",
        )
        .run(JSON.stringify(secure), now, slug);
      return res.changes > 0;
    } catch (err) {
      log.error(`LlmProviderRegistry: saveConfig("${slug}") failed`, err);
      return false;
    }
  }

  /** Lee el manifest bundled de un provider desde
   *  assets/extensions/ai/models/<slug>/extension.json. Returns null when absent. */
  private readProviderManifest(slug: string): Record<string, unknown> | null {
    const root = process.env.KERNEL_ASSETS_DIR
      ? resolve(process.env.KERNEL_ASSETS_DIR)
      : resolve(process.cwd(), "assets");
    const path = resolve(root, "extensions/ai/models", slug, "extension.json");
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>; }
    catch { return null; }
  }

  /** Seed a row for every builtin factory that has no row in installed_extensions.
   *  Lee el manifest bundled (assets/extensions/ai/models/<slug>/extension.json) para
   *  name/logo/category/description. If the row exists but its manifest differs
   *  (logo o category), lo refresca (idempotente — preserva settings_json). */
  seedBuiltinRows(): void {
    if (!this.db) return;
    for (const [slug, reg] of this.factories) {
      if (reg.source !== "builtin") continue;
      try {
        const fileManifest = this.readProviderManifest(slug);
        const existing = this.db
          .prepare("SELECT id, manifest_json FROM installed_extensions WHERE slug = ?")
          .get(slug) as { id: string; manifest_json: string } | undefined;
        if (existing) {
          // Upgrade path: refresh manifest_json when the logo or category changed
          // against the bundled manifest (migrates old rows with category="llm").
          if (!fileManifest) continue;
          let m: Record<string, unknown> = {};
          try { m = JSON.parse(existing.manifest_json) as Record<string, unknown>; } catch { m = {}; }
          if (m.logo === fileManifest.logo && m.category === fileManifest.category) continue;
          this.db
            .prepare("UPDATE installed_extensions SET manifest_json = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(fileManifest), new Date().toISOString(), existing.id);
          log.info(`LlmProviderRegistry: refreshed manifest for built-in provider "${slug}"`);
          continue;
        }
        const provider = reg.factory();
        const now = new Date().toISOString();
        const manifest: Record<string, unknown> = fileManifest ?? {
          $schema: "kernl://extension/v1",
          id: `com.kernl.llm.${slug}`,
          slug,
          name: provider.name,
          version: "1.0.0",
          type: "llm-provider",
          description: `Built-in LLM provider: ${provider.name}`,
          author: "Kernl",
          license: "MIT",
          category: "ai",
          built_in: true,
        };
        this.db
          .prepare(
            `INSERT INTO installed_extensions
              (id, slug, name, version, type, status, manifest_json, source_json,
               install_path, granted_permissions_json, settings_json, error,
               installed_at, updated_at, last_loaded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            manifest.id as string,
            slug,
            provider.name,
            manifest.version as string,
            "llm-provider",
            "active",
            JSON.stringify(manifest),
            JSON.stringify({ type: "bundled" }),
            "",
            JSON.stringify([]),
            "{}",
            "",
            now,
            now,
            null,
          );
        log.info(`LlmProviderRegistry: seeded row for built-in provider "${slug}"`);
      } catch (err) {
        log.warn(`LlmProviderRegistry: seed for "${slug}" failed: ${String(err)}`);
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async startProvider(slug: string): Promise<boolean> {
    this.lastStartError = null;
    if (this.providers.has(slug)) {
      await this.stopProvider(slug);
    }
    const reg = this.factories.get(slug);
    if (!reg) {
      this.lastStartError = `No factory registered for "${slug}"`;
      return false;
    }
    try {
      const provider = reg.factory();
      const cfg = this.loadConfig(slug);
      // Always call configure (even with an empty cfg) so the provider
      // pueda caer a defaults de env var. Los drivers deben ser idempotentes.
      provider.configure(cfg);
      const hook = this.preStartHooks.get(slug);
      if (hook) hook(provider);
      await provider.start();
      this.providers.set(slug, provider);
      this.exhausted.delete(slug);
      log.info(`LlmProvider "${slug}" started`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastStartError = msg;
      log.error(`LlmProviderRegistry: start("${slug}") failed`, err);
      return false;
    }
  }

  async stopProvider(slug: string): Promise<boolean> {
    const provider = this.providers.get(slug);
    if (!provider) return false;
    try {
      await provider.stop();
      this.providers.delete(slug);
      return true;
    } catch (err) {
      log.error(`LlmProviderRegistry: stop("${slug}") failed`, err);
      return false;
    }
  }

  async startAll(): Promise<void> {
    if (!this.db) {
      for (const slug of this.factories.keys()) {
        await this.startProvider(slug).catch(() => {});
      }
      return;
    }
    const activeItems = this.db
      .prepare(
        "SELECT slug FROM installed_extensions WHERE type = 'llm-provider' AND status = 'active'",
      )
      .all() as Array<{ slug: string }>;
    for (const item of activeItems) {
      if (!this.factories.has(item.slug)) {
        log.debug(`LlmProviderRegistry: no factory for "${item.slug}" (not loaded) — skipping`);
        continue;
      }
      await this.startProvider(item.slug).catch(() => {});
    }
  }

  async stopAll(): Promise<void> {
    for (const [slug, provider] of this.providers) {
      try { await provider.stop(); }
      catch (err) { log.error(`LlmProviderRegistry: stop("${slug}") failed`, err); }
    }
    this.providers.clear();
  }

  // ── Dispatch ──────────────────────────────────────────────────────

  /**
   * Resolve a provider by slug. Drop-in replacement for the current
   * chat/llm-adapter `resolveProvider()`. Returns undefined if it doesn't exist or didn't start.
   */
  resolve(slug: string): LlmProvider | undefined {
    const provider = this.providers.get(slug);
    if (!provider) return undefined;
    if (!provider.isReady()) return undefined;
    return provider;
  }

  /**
   * Complete a chat using the provider with the given slug. Helper for callers
   * that already know which provider they want.
   */
  async chatCompletion(
    slug: string,
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const provider = this.providers.get(slug);
    if (!provider) throw new Error(`LLM provider "${slug}" is not running`);
    if (!provider.isReady()) throw new Error(`LLM provider "${slug}" is not ready`);
    return provider.chatCompletion(messages, opts);
  }

  // ── Quota tracking (compat con chat/llm-adapter) ──────────────────

  markExhausted(slug: string): void {
    this.exhausted.add(slug);
    log.warn(`LlmProviderRegistry: provider "${slug}" marked exhausted`);
  }

  clearExhausted(slug: string): void {
    this.exhausted.delete(slug);
  }

  isExhausted(slug: string): boolean {
    return this.exhausted.has(slug);
  }

  // ── Status / introspection ────────────────────────────────────────

  getStatuses(): LlmProviderStatus[] {
    const out: LlmProviderStatus[] = [];
    for (const [slug, reg] of this.factories) {
      const running = this.providers.get(slug);
      if (running) {
        out.push({
          ...running.getStatus(),
          source: reg.source,
          exhausted: this.exhausted.has(slug),
        });
      } else {
        try {
          const tmp = reg.factory();
          out.push({
            slug,
            name: tmp.name,
            ready: false,
            source: reg.source,
            capabilities: tmp.capabilities,
            exhausted: this.exhausted.has(slug),
          });
        } catch {
          out.push({
            slug,
            name: slug,
            ready: false,
            source: reg.source,
            error: "factory threw while instantiating",
          });
        }
      }
    }
    return out;
  }

  getConfigSchema(slug: string): ConfigField[] | null {
    const running = this.providers.get(slug);
    if (running) return running.getConfigSchema();
    const reg = this.factories.get(slug);
    if (!reg) return null;
    try { return reg.factory().getConfigSchema(); }
    catch { return null; }
  }
}
