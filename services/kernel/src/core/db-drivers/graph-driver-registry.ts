/**
 * GraphDriverRegistry — factory + instance store for graph backends.
 *
 * Mirrors SandboxDriverRegistry. One row per installed driver in
 * `installed_extensions` (with `type='db-driver'` and `manifest.db.kind='graph'`).
 * Exactly one driver may carry `status='active'` for the graph kind at a time;
 * activating a different driver deactivates the previous one in the same
 * transaction.
 *
 * The active driver instance is exposed via `getActive()` and is what
 * eventually replaces `Neo4jClient` in `ModuleContext`. Until that migration
 * happens, the registry can be wired up without consumers noticing — its
 * `getActive()` will simply return `null` whenever no graph driver has been
 * seeded / activated yet, and the legacy `Neo4jClient` keeps working in
 * parallel.
 */

import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";
import { decryptSecrets, encryptSecrets } from "../secrets.js";
import type { ConfigField, DbDriverSource } from "./types.js";
import type {
  GraphDriver,
  GraphDriverStatus,
  GraphCapabilities,
} from "./graph-driver.js";

export type GraphDriverFactory = () => GraphDriver;

interface RegisteredFactory {
  factory: GraphDriverFactory;
  source: DbDriverSource;
}

const KIND = "graph" as const;

export class GraphDriverRegistry {
  private factories = new Map<string, RegisteredFactory>();
  private drivers = new Map<string, GraphDriver>();
  private activeSlug: string | null = null;
  private db: SqliteDb | null = null;
  private encryptionKey = "";

  setDb(db: SqliteDb): void {
    this.db = db;
  }

  setEncryptionKey(key: string): void {
    this.encryptionKey = key;
  }

  // ── Registration ──────────────────────────────────────────────────

  registerFactory(
    slug: string,
    factory: GraphDriverFactory,
    source: DbDriverSource = "builtin",
  ): void {
    this.factories.set(slug, { factory, source });
    log.debug(`GraphDriverRegistry: registered factory "${slug}" (${source})`);
  }

  registerDriverFromExtension(slug: string, factory: GraphDriverFactory): void {
    this.registerFactory(slug, factory, "extension");
  }

  async unregister(slug: string): Promise<void> {
    if (this.drivers.has(slug)) {
      await this.stopDriver(slug).catch(() => {});
    }
    this.factories.delete(slug);
  }

  // ── Lookup ────────────────────────────────────────────────────────

  /** The currently active graph driver, or null if none is started. */
  getActive(): GraphDriver | null {
    if (!this.activeSlug) return null;
    return this.drivers.get(this.activeSlug) ?? null;
  }

  getActiveSlug(): string | null {
    return this.activeSlug;
  }

  getDriver(slug: string): GraphDriver | undefined {
    return this.drivers.get(slug);
  }

  getAvailableSlugs(): string[] {
    return [...this.factories.keys()];
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
          "SELECT settings_json FROM installed_extensions WHERE slug = ? AND type = 'db-driver'",
        )
        .get(slug) as { settings_json: string } | undefined;
      if (!row) return {};
      const raw = JSON.parse(row.settings_json || "{}") as Record<string, unknown>;
      return this.encryptionKey ? decryptSecrets(raw, this.encryptionKey) : raw;
    } catch (err) {
      log.warn(`GraphDriverRegistry: loadConfig("${slug}") failed: ${String(err)}`);
      return {};
    }
  }

  saveConfig(slug: string, config: Record<string, unknown>): boolean {
    if (!this.db) return false;
    try {
      const secure = this.encryptionKey
        ? encryptSecrets(config, this.encryptionKey)
        : config;
      const now = new Date().toISOString();
      const res = this.db
        .prepare(
          "UPDATE installed_extensions SET settings_json = ?, updated_at = ? WHERE slug = ? AND type = 'db-driver'",
        )
        .run(JSON.stringify(secure), now, slug);
      return res.changes > 0;
    } catch (err) {
      log.error(`GraphDriverRegistry: saveConfig("${slug}") failed`, err);
      return false;
    }
  }

  /**
   * Seed a stub `installed_extensions` row for every built-in factory that
   * lacks one. The first built-in seeded becomes `status='active'`; later
   * ones are seeded as `status='installed'`. Idempotent — re-running doesn't
   * change existing rows.
   */
  seedBuiltinRows(): void {
    if (!this.db) return;
    let anyActiveSeeded = this.hasActiveRow();
    for (const [slug, reg] of this.factories) {
      if (reg.source !== "builtin") continue;
      try {
        const existing = this.db
          .prepare("SELECT id, status FROM installed_extensions WHERE slug = ?")
          .get(slug) as { id: string; status: string } | undefined;
        if (existing) {
          if (existing.status === "active") anyActiveSeeded = true;
          continue;
        }
        const driver = reg.factory();
        const now = new Date().toISOString();
        const status = anyActiveSeeded ? "installed" : "active";
        if (status === "active") anyActiveSeeded = true;
        const manifest = {
          $schema: "kernl://extension/v1",
          id: `builtin.db.graph.${slug}`,
          slug,
          name: driver.name,
          version: "1.0.0",
          type: "db-driver",
          description: `Built-in graph driver: ${driver.name}`,
          author: "Kernl",
          license: "MIT",
          category: "database",
          db: {
            kind: KIND,
            capabilities: capabilityList(driver.capabilities),
            deployment: driver.deployment,
          },
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
            manifest.id,
            slug,
            driver.name,
            manifest.version,
            "db-driver",
            status,
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
        log.info(
          `GraphDriverRegistry: seeded row for built-in driver "${slug}" (${status})`,
        );
      } catch (err) {
        log.warn(`GraphDriverRegistry: seed for "${slug}" failed: ${String(err)}`);
      }
    }
  }

  // ── Active-driver invariant ───────────────────────────────────────

  /**
   * Switch the active graph driver. Stops the currently-active instance,
   * flips DB rows so exactly one carries `status='active'` for kind='graph',
   * then starts the requested driver. If the new driver fails to come up
   * (either start() throws, or the driver swallows the error and reports
   * ready=false), the previous active driver is restored — the system never
   * ends up with no active driver. Returns true on success, false on revert.
   */
  async setActive(slug: string): Promise<boolean> {
    if (!this.factories.has(slug)) {
      log.warn(`GraphDriverRegistry: setActive("${slug}") — no such factory`);
      return false;
    }
    const previousActive = this.activeSlug;
    if (previousActive && previousActive !== slug) {
      await this.stopDriver(previousActive).catch(() => {});
    }
    this.markActiveRow(slug);
    const started = await this.startDriver(slug);
    // Verify ready: drivers like Neo4j catch connection errors inside start()
    // (graceful degradation) so startDriver returns true while isReady() is
    // false. Treat that as a failure for activation purposes.
    const driver = this.drivers.get(slug);
    const trulyReady = started && !!driver?.isReady();
    if (trulyReady) {
      this.activeSlug = slug;
      return true;
    }
    // Roll back: stop the half-started instance and restore the previous one.
    await this.stopDriver(slug).catch(() => {});
    if (previousActive && previousActive !== slug) {
      this.markActiveRow(previousActive);
      const restored = await this.startDriver(previousActive);
      if (restored) this.activeSlug = previousActive;
    }
    return false;
  }

  private hasActiveRow(): boolean {
    if (!this.db) return false;
    try {
      const row = this.db
        .prepare(
          `SELECT id FROM installed_extensions
            WHERE type = 'db-driver' AND status = 'active'
              AND json_extract(manifest_json, '$.db.kind') = ?
            LIMIT 1`,
        )
        .get(KIND) as { id: string } | undefined;
      return !!row;
    } catch {
      return false;
    }
  }

  private markActiveRow(slug: string): void {
    if (!this.db) return;
    try {
      const now = new Date().toISOString();
      // Demote any existing active row of this kind.
      this.db
        .prepare(
          `UPDATE installed_extensions
              SET status = 'installed', updated_at = ?
            WHERE type = 'db-driver'
              AND status = 'active'
              AND json_extract(manifest_json, '$.db.kind') = ?
              AND slug <> ?`,
        )
        .run(now, KIND, slug);
      this.db
        .prepare(
          `UPDATE installed_extensions
              SET status = 'active', updated_at = ?
            WHERE type = 'db-driver' AND slug = ?`,
        )
        .run(now, slug);
    } catch (err) {
      log.warn(`GraphDriverRegistry: markActiveRow("${slug}") failed: ${String(err)}`);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  lastStartError: string | null = null;

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
      await driver.start();
      this.drivers.set(slug, driver);
      log.info(`GraphDriver "${slug}" started`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastStartError = msg;
      log.error(`GraphDriverRegistry: start("${slug}") failed`, err);
      return false;
    }
  }

  async stopDriver(slug: string): Promise<boolean> {
    const driver = this.drivers.get(slug);
    if (!driver) return false;
    try {
      await driver.stop();
      this.drivers.delete(slug);
      if (this.activeSlug === slug) this.activeSlug = null;
      return true;
    } catch (err) {
      log.error(`GraphDriverRegistry: stop("${slug}") failed`, err);
      return false;
    }
  }

  /**
   * Boot the active graph driver as recorded in the DB. Called once at
   * bootstrap. If no active row exists, leaves `activeSlug=null` — consumers
   * that ask for the driver get null and fall through to graceful-degradation
   * paths.
   */
  async startActive(): Promise<void> {
    if (!this.db) return;
    try {
      const row = this.db
        .prepare(
          `SELECT slug FROM installed_extensions
            WHERE type = 'db-driver' AND status = 'active'
              AND json_extract(manifest_json, '$.db.kind') = ?
            LIMIT 1`,
        )
        .get(KIND) as { slug: string } | undefined;
      if (!row) return;
      if (!this.factories.has(row.slug)) {
        log.debug(
          `GraphDriverRegistry: no factory for active slug "${row.slug}" — skipping`,
        );
        return;
      }
      const ok = await this.startDriver(row.slug);
      if (ok) this.activeSlug = row.slug;
    } catch (err) {
      log.warn(`GraphDriverRegistry: startActive failed: ${String(err)}`);
    }
  }

  async stopAll(): Promise<void> {
    for (const [slug, driver] of this.drivers) {
      try {
        await driver.stop();
      } catch (err) {
        log.error(`GraphDriverRegistry: stop("${slug}") failed`, err);
      }
    }
    this.drivers.clear();
    this.activeSlug = null;
  }

  // ── Status / introspection ────────────────────────────────────────

  /**
   * One status row per registered factory, regardless of running state.
   * The active driver (if any) is marked via `ready=true` and its slug
   * matches `getActiveSlug()`.
   */
  getStatuses(): GraphDriverStatus[] {
    const out: GraphDriverStatus[] = [];
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
            kind: KIND,
            deployment: tmp.deployment,
            ready: false,
            source: reg.source,
            capabilities: tmp.capabilities,
          });
        } catch (err) {
          out.push({
            slug,
            name: slug,
            kind: KIND,
            deployment: "embedded",
            ready: false,
            source: reg.source,
            capabilities: emptyCapabilities(),
            error: err instanceof Error ? err.message : "factory threw",
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

// ── Helpers ───────────────────────────────────────────────────────────

function emptyCapabilities(): GraphCapabilities {
  return {
    cypher: false,
    gds: false,
    vectorSimilarity: false,
    mlPipelines: false,
    embedded: false,
    parameterised: false,
    transactions: false,
  };
}

function capabilityList(caps: GraphCapabilities): string[] {
  return Object.entries(caps)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}
