/**
 * SandboxDriverRegistry — factory + instance store for sandbox backends.
 *
 * Mirrors NotificationRegistry. Factories are keyed by slug ("docker",
 * "cubesandbox", …); instances live in a separate map populated when
 * the driver is started. Config is persisted in `installed_extensions`
 * rows with `type='sandbox-driver'` (or `type='builtin-sandbox-driver'`
 * for bundled ones — same table, different source marker).
 */

import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";
import type {
  SandboxDriver,
  SandboxDriverStatus,
  SandboxRunOptions,
  SandboxHandle,
  ConfigField,
} from "./driver.js";
import { decryptSecrets, encryptSecrets } from "../secrets.js";

export type SandboxDriverFactory = () => SandboxDriver;

export type SandboxDriverSource = "builtin" | "extension";

interface RegisteredFactory {
  factory: SandboxDriverFactory;
  source: SandboxDriverSource;
}

export class SandboxDriverRegistry {
  private factories = new Map<string, RegisteredFactory>();
  private drivers = new Map<string, SandboxDriver>();
  private preStartHooks = new Map<string, (driver: SandboxDriver) => void>();
  private db: SqliteDb | null = null;
  private encryptionKey = "";

  setDb(db: SqliteDb): void {
    this.db = db;
  }

  setEncryptionKey(key: string): void {
    this.encryptionKey = key;
  }

  // ── Registration ──────────────────────────────────────────────────

  /** Register a built-in driver (bundled with the kernel). */
  registerFactory(slug: string, factory: SandboxDriverFactory, source: SandboxDriverSource = "builtin"): void {
    this.factories.set(slug, { factory, source });
    log.debug(`SandboxDriverRegistry: registered factory "${slug}" (${source})`);
  }

  /**
   * Install a driver that comes from an installed extension. The extension
   * manifest declared `type: "sandbox-driver"` with `backend.entry` pointing
   * at a JS module that exports `createDriver(): SandboxDriver`.
   *
   * We don't reach out to disk here — the caller already imported the
   * module and supplies the factory. Keeps this class FS-free for tests.
   */
  registerDriverFromExtension(slug: string, factory: SandboxDriverFactory): void {
    this.registerFactory(slug, factory, "extension");
  }

  /** Remove a driver (stops running instance first). */
  async unregister(slug: string): Promise<void> {
    if (this.drivers.has(slug)) {
      await this.stopDriver(slug).catch(() => {});
    }
    this.factories.delete(slug);
    this.preStartHooks.delete(slug);
  }

  /** Hook fired just before start() — used to inject kernel-dependent state. */
  registerPreStartHook(slug: string, hook: (driver: SandboxDriver) => void): void {
    this.preStartHooks.set(slug, hook);
  }

  // ── Lookup ────────────────────────────────────────────────────────

  getDriver(slug: string): SandboxDriver | undefined {
    return this.drivers.get(slug);
  }

  getAvailableSlugs(): string[] {
    return [...this.factories.keys()];
  }

  getRunningSlugs(): string[] {
    return [...this.drivers.keys()];
  }

  hasFactory(slug: string): boolean {
    return this.factories.has(slug);
  }

  // ── Config persistence ────────────────────────────────────────────

  /**
   * Load settings_json from `installed_extensions` for this driver slug.
   * Returns `{}` when the row doesn't exist (fresh install / built-in
   * without persisted overrides).
   */
  loadConfig(slug: string): Record<string, unknown> {
    if (!this.db) return {};
    try {
      const row = this.db
        .prepare(
          "SELECT settings_json FROM installed_extensions WHERE slug = ? AND type = 'sandbox-driver'",
        )
        .get(slug) as { settings_json: string } | undefined;
      if (!row) return {};
      const raw = JSON.parse(row.settings_json || "{}") as Record<string, unknown>;
      return this.encryptionKey ? decryptSecrets(raw, this.encryptionKey) : raw;
    } catch (err) {
      log.warn(`SandboxDriverRegistry: loadConfig("${slug}") failed: ${String(err)}`);
      return {};
    }
  }

  /**
   * Persist settings_json for a driver. Works for both extension drivers
   * (whose row exists) and built-in drivers (auto-creates a stub row under
   * `type='sandbox-driver'` so the dashboard can list it uniformly).
   */
  saveConfig(slug: string, config: Record<string, unknown>): boolean {
    if (!this.db) return false;
    try {
      const secure = this.encryptionKey ? encryptSecrets(config, this.encryptionKey) : config;
      const now = new Date().toISOString();
      const res = this.db
        .prepare(
          "UPDATE installed_extensions SET settings_json = ?, updated_at = ? WHERE slug = ? AND type = 'sandbox-driver'",
        )
        .run(JSON.stringify(secure), now, slug);
      return res.changes > 0;
    } catch (err) {
      log.error(`SandboxDriverRegistry: saveConfig("${slug}") failed`, err);
      return false;
    }
  }

  /**
   * Seed `installed_extensions` rows for every registered built-in factory
   * that doesn't have one yet. Idempotent — safe to call on every boot.
   */
  seedBuiltinRows(): void {
    if (!this.db) return;
    for (const [slug, reg] of this.factories) {
      if (reg.source !== "builtin") continue;
      try {
        const existing = this.db
          .prepare("SELECT id FROM installed_extensions WHERE slug = ?")
          .get(slug);
        if (existing) continue;
        const driver = reg.factory();
        const now = new Date().toISOString();
        const manifest = {
          $schema: "kernl://extension/v1",
          id: `builtin.sandbox.${slug}`,
          slug,
          name: driver.name,
          version: "1.0.0",
          type: "sandbox-driver",
          description: `Built-in sandbox driver: ${driver.name}`,
          author: "Kernl",
          license: "MIT",
          category: "sandbox",
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
            manifest.id,
            slug,
            driver.name,
            manifest.version,
            "sandbox-driver",
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
        log.info(`SandboxDriverRegistry: seeded row for built-in driver "${slug}"`);
      } catch (err) {
        log.warn(`SandboxDriverRegistry: seed for "${slug}" failed: ${String(err)}`);
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  lastStartError: string | null = null;

  /** Instantiate + configure + start a specific driver. */
  async startDriver(slug: string): Promise<boolean> {
    this.lastStartError = null;
    if (this.drivers.has(slug)) {
      await this.stopDriver(slug);
    }
    const reg = this.factories.get(slug);
    if (!reg) {
      this.lastStartError = `No factory registered for "${slug}"`;
      return false;
    }
    try {
      const driver = reg.factory();
      const cfg = this.loadConfig(slug);
      if (Object.keys(cfg).length > 0) {
        driver.configure(cfg);
      }
      const hook = this.preStartHooks.get(slug);
      if (hook) hook(driver);
      await driver.start();
      this.drivers.set(slug, driver);
      log.info(`SandboxDriver "${slug}" started`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastStartError = msg;
      log.error(`SandboxDriverRegistry: start("${slug}") failed`, err);
      return false;
    }
  }

  async stopDriver(slug: string): Promise<boolean> {
    const driver = this.drivers.get(slug);
    if (!driver) return false;
    try {
      await driver.stop();
      this.drivers.delete(slug);
      return true;
    } catch (err) {
      log.error(`SandboxDriverRegistry: stop("${slug}") failed`, err);
      return false;
    }
  }

  /** Boot all drivers that have an `active` extension row. */
  async startAll(): Promise<void> {
    if (!this.db) {
      // Without DB we still start the built-ins so tests work.
      for (const slug of this.factories.keys()) {
        await this.startDriver(slug).catch(() => {});
      }
      return;
    }
    const activeItems = this.db
      .prepare(
        "SELECT slug FROM installed_extensions WHERE type = 'sandbox-driver' AND status = 'active'",
      )
      .all() as Array<{ slug: string }>;
    for (const item of activeItems) {
      if (!this.factories.has(item.slug)) {
        log.debug(`SandboxDriverRegistry: no factory for "${item.slug}" (not loaded) — skipping`);
        continue;
      }
      await this.startDriver(item.slug).catch(() => {});
    }
  }

  async stopAll(): Promise<void> {
    for (const [slug, driver] of this.drivers) {
      try {
        await driver.stop();
      } catch (err) {
        log.error(`SandboxDriverRegistry: stop("${slug}") failed`, err);
      }
    }
    this.drivers.clear();
  }

  // ── Run dispatch ──────────────────────────────────────────────────

  /**
   * Prepare a run on the requested driver. Throws a descriptive error when
   * the driver is absent, not started, or not ready.
   */
  async prepareRun(slug: string, opts: SandboxRunOptions): Promise<SandboxHandle> {
    const driver = this.drivers.get(slug);
    if (!driver) throw new Error(`Sandbox driver "${slug}" is not running`);
    if (!driver.isReady()) throw new Error(`Sandbox driver "${slug}" is not ready`);
    return driver.prepareRun(opts);
  }

  async cleanup(handle: SandboxHandle): Promise<void> {
    const driver = this.drivers.get(handle.driver);
    if (!driver) return;
    await driver.cleanup(handle).catch((err) => {
      log.warn(`SandboxDriverRegistry: cleanup("${handle.driver}") failed: ${String(err)}`);
    });
  }

  // ── Status / introspection ────────────────────────────────────────

  getStatuses(): SandboxDriverStatus[] {
    const out: SandboxDriverStatus[] = [];
    for (const [slug, reg] of this.factories) {
      const running = this.drivers.get(slug);
      if (running) {
        out.push({ ...running.getStatus(), source: reg.source });
      } else {
        try {
          const tmp = reg.factory();
          out.push({
            slug,
            name: tmp.name,
            ready: false,
            source: reg.source,
            capabilities: tmp.capabilities,
          });
        } catch {
          out.push({
            slug,
            name: slug,
            ready: false,
            source: reg.source,
            capabilities: {
              snapshots: false,
              networkIsolation: "none",
              coldStartMs: 0,
              workspaceModel: "bind-mount",
              exec: false,
              resourceLimits: false,
            },
            error: "factory threw while instantiating",
          });
        }
      }
    }
    return out;
  }

  getConfigSchema(slug: string): ConfigField[] | null {
    const running = this.drivers.get(slug);
    if (running) return running.getConfigSchema();
    const reg = this.factories.get(slug);
    if (!reg) return null;
    try {
      return reg.factory().getConfigSchema();
    } catch {
      return null;
    }
  }
}
