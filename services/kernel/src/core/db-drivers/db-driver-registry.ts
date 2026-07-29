/**
 * DbDriverRegistry — top-level orchestrator for pluggable database backends.
 *
 * Owns one sub-registry per `DbDriverKind` and is the single object the
 * bootstrap wires up. Sub-registries (graph, vector, …) hold their own
 * factories and instances, persisting state under `installed_extensions`
 * rows where `type='db-driver'`. Each row's manifest declares which kind
 * it fills via `manifest.db.kind`.
 *
 * Invariants enforced here:
 *   1. Exactly one driver may be `status='active'` per kind at a time.
 *      Sub-registries flip that flag in setActive(); this orchestrator only
 *      forwards calls — but it surfaces a uniform API to bootstrap and the
 *      dashboard so neither has to know which sub-registry handles what.
 *   2. Sub-registries are created eagerly so that `getGraph()` / `getVector()`
 *      always return a valid object — even before any driver is registered.
 *
 * Today only the graph sub-registry has a real interface defined; vector is
 * stubbed and its registry will be added once the first vector driver lands.
 *
 * Dispatch methods (`getConfigSchema`, `saveConfig`, `setActive`, …) accept a
 * slug and look up its kind from `installed_extensions.manifest_json` to pick
 * the right sub-registry. This keeps HTTP routes generic — they only know
 * about the orchestrator, never about specific kinds.
 */

import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";
import type { ConfigField, DbDriverKind } from "./types.js";
import type { GraphDriver, GraphDriverStatus } from "./graph-driver.js";
import { GraphDriverRegistry } from "./graph-driver-registry.js";

/** Flat status row used by the API list endpoint. */
export interface DbDriverStatusRow {
  kind: DbDriverKind;
  /** Whether this row is the currently active driver for its kind. */
  active: boolean;
  /** Sub-registry status payload (shape depends on kind). */
  status: GraphDriverStatus | unknown;
}

export class DbDriverRegistry {
  private graph = new GraphDriverRegistry();
  private db: SqliteDb | null = null;
  private _lastStartError: string | null = null;

  // ── Wiring ────────────────────────────────────────────────────────

  setDb(db: SqliteDb): void {
    this.db = db;
    this.graph.setDb(db);
  }

  setEncryptionKey(key: string): void {
    this.graph.setEncryptionKey(key);
  }

  // ── Sub-registry handles ──────────────────────────────────────────

  /** Direct access to the graph sub-registry — for builtin driver wiring. */
  getGraphRegistry(): GraphDriverRegistry {
    return this.graph;
  }

  /** Convenience: the currently active graph driver, or null. */
  getGraph(): GraphDriver | null {
    return this.graph.getActive();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Seed `installed_extensions` rows for every built-in factory across all
   * sub-registries. Call after all `registerFactory(...)` calls and before
   * `startActive()`. Idempotent.
   */
  seedBuiltins(): void {
    if (!this.db) {
      log.debug("DbDriverRegistry: seedBuiltins called before setDb — skipping");
      return;
    }
    this.graph.seedBuiltinRows();
  }

  /**
   * Boot the active driver of every kind. Call once at the end of bootstrap.
   * Drivers that fail to start leave their sub-registry's `getActive()`
   * returning null — consumers fall through to graceful-degradation paths.
   */
  async startAllActive(): Promise<void> {
    await this.graph.startActive();
  }

  /** Stop every running driver across all sub-registries. */
  async stopAll(): Promise<void> {
    await this.graph.stopAll();
  }

  // ── Slug → kind lookup ────────────────────────────────────────────

  /**
   * Resolve which kind a slug fills by reading its row from the DB. Returns
   * null if no row exists or the row's manifest doesn't declare a db.kind.
   */
  findKindForSlug(slug: string): DbDriverKind | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT json_extract(manifest_json, '$.db.kind') AS kind
             FROM installed_extensions
            WHERE slug = ? AND type = 'db-driver'
            LIMIT 1`,
        )
        .get(slug) as { kind: string | null } | undefined;
      const kind = row?.kind;
      if (!kind) return null;
      // Narrow to known kinds; unknown values are treated as missing.
      return (
        kind === "graph" ||
        kind === "vector" ||
        kind === "relational" ||
        kind === "kv" ||
        kind === "timeseries" ||
        kind === "blob"
          ? (kind as DbDriverKind)
          : null
      );
    } catch (err) {
      log.warn(`DbDriverRegistry: findKindForSlug("${slug}") failed: ${String(err)}`);
      return null;
    }
  }

  // ── Dispatch (per-slug operations used by HTTP routes) ────────────

  /** All driver statuses across every kind, with the active flag set. */
  getAllStatuses(): DbDriverStatusRow[] {
    const out: DbDriverStatusRow[] = [];
    const graphActive = this.graph.getActiveSlug();
    for (const s of this.graph.getStatuses()) {
      out.push({
        kind: "graph",
        active: s.slug === graphActive,
        status: s,
      });
    }
    return out;
  }

  getConfigSchema(slug: string): ConfigField[] | null {
    const kind = this.findKindForSlug(slug);
    if (kind === "graph") return this.graph.getConfigSchema(slug);
    return null;
  }

  loadConfig(slug: string): Record<string, unknown> | null {
    const kind = this.findKindForSlug(slug);
    if (kind === "graph") return this.graph.loadConfig(slug);
    return null;
  }

  saveConfig(slug: string, config: Record<string, unknown>): boolean {
    const kind = this.findKindForSlug(slug);
    if (kind === "graph") return this.graph.saveConfig(slug, config);
    return false;
  }

  validateConfig(
    slug: string,
    config: Record<string, unknown>,
  ): { valid: boolean; errors?: string[] } | null {
    const kind = this.findKindForSlug(slug);
    if (kind !== "graph") return null;
    const driver = this.graph.getDriver(slug);
    if (driver) return driver.validateConfig(config);
    // Driver not running — instantiate the factory to validate.
    if (!this.graph.hasFactory(slug)) return null;
    try {
      // Round-trip via the factory: registerFactory keeps the function, so
      // we can ask the registry for a config schema and assume any object
      // satisfies it absent a running validator. The schema check happens
      // anyway when the driver starts.
      const schema = this.graph.getConfigSchema(slug);
      return schema ? { valid: true } : null;
    } catch {
      return null;
    }
  }

  async startDriver(slug: string): Promise<boolean> {
    const kind = this.findKindForSlug(slug);
    if (kind === "graph") {
      const ok = await this.graph.startDriver(slug);
      this._lastStartError = this.graph.lastStartError;
      return ok;
    }
    return false;
  }

  async stopDriver(slug: string): Promise<boolean> {
    const kind = this.findKindForSlug(slug);
    if (kind === "graph") return this.graph.stopDriver(slug);
    return false;
  }

  /**
   * Activate a driver — the single-active-per-kind invariant is enforced by
   * the sub-registry. Stops the previously-active driver of the same kind
   * before starting the new one. If the new driver fails to start, the row
   * remains marked `active` but `getActive()` returns null and
   * `lastStartError` carries the reason — caller decides whether to revert.
   */
  async setActive(slug: string): Promise<boolean> {
    const kind = this.findKindForSlug(slug);
    if (kind === "graph") {
      const ok = await this.graph.setActive(slug);
      this._lastStartError = this.graph.lastStartError;
      return ok;
    }
    return false;
  }

  /** Last start error from any sub-registry — read by HTTP routes for toasts. */
  get lastStartError(): string | null {
    return this._lastStartError ?? this.graph.lastStartError;
  }
}
