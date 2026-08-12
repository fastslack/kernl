/**
 * Pluggable database backends — shared types across all driver kinds.
 *
 * Mirrors the SandboxDriver / NotificationProvider patterns: every db-driver
 * (graph, vector, kv, …) declares capabilities, exposes a config schema,
 * and goes through the same install / configure / start / stop lifecycle.
 *
 * The orchestrating `DbDriverRegistry` (db-driver-registry.ts) owns one
 * sub-registry per kind (GraphDriverRegistry, VectorDriverRegistry, …) and
 * enforces a single-active-driver-per-kind invariant, persisted in the
 * `installed_extensions` table with `type='db-driver'`.
 */

import type { ConfigField } from "../notify/provider.js";

export type { ConfigField };

// ── Kinds ─────────────────────────────────────────────────────────────

/**
 * The database "slot" a driver fills. Exactly one driver may be active per
 * kind per kernel instance. New kinds are added to this union as the kernel
 * grows; existing drivers are kind-locked at install time via their manifest.
 */
export type DbDriverKind =
  | "graph"
  | "vector"
  | "relational"
  | "kv"
  | "timeseries"
  | "blob";

/** Where the driver's data/process actually lives. */
export type DbDeployment = "embedded" | "external-server" | "cloud";

/** Provenance — built-in (compiled in) vs installed-via-extension. */
export type DbDriverSource = "builtin" | "extension";

// ── Status (shared base shape across kinds) ───────────────────────────

/**
 * Common status shape returned by every driver's `getStatus()`. Sub-kinds
 * extend this with capability blocks specific to their interface (graph
 * adds `GraphCapabilities`, vector adds `VectorCapabilities`, …).
 */
export interface BaseDbDriverStatus {
  slug: string;
  name: string;
  kind: DbDriverKind;
  deployment: DbDeployment;
  /** Whether the driver is connected and ready to serve queries. */
  ready: boolean;
  source: DbDriverSource;
  /** Free-form diagnostic info (server version, db path, etc.). */
  info?: Record<string, unknown>;
  /** Last connection / health error, if any. */
  error?: string;
}

// ── Driver lifecycle (shared across kinds) ────────────────────────────

/**
 * Every db-driver implementation includes this lifecycle surface. The
 * kind-specific operation methods (`run`, `upsert`, `get`, …) live on the
 * sub-interface that extends this — see graph-driver.ts, vector-driver.ts.
 */
export interface BaseDbDriver {
  readonly slug: string;
  readonly name: string;
  readonly kind: DbDriverKind;
  readonly deployment: DbDeployment;

  /** Config fields rendered by the dashboard /extensions form. */
  getConfigSchema(): ConfigField[];
  /** Validate user-supplied config before persisting. */
  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] };
  /** Apply config — called once before start(). */
  configure(config: Record<string, unknown>): void;
  /**
   * Whether this driver could start with no stored config, because the
   * environment already describes a backend it can reach. Consulted only when
   * seeding a fresh install, to pick which driver starts out active — a
   * deployment that ships a graph server and its credentials should not have to
   * be switched off the no-op driver by hand. Never overrides an existing
   * choice. Drivers that always need explicit config may omit it.
   */
  canSelfConfigure?(): boolean;

  /** Open connection / spawn embedded process / verify reachability. */
  start(): Promise<void>;
  /** Close connection, flush state. */
  stop(): Promise<void>;
  /** Whether the driver is connected and ready to serve queries. */
  isReady(): boolean;
  /** Health snapshot. Sub-kinds typically widen this return type. */
  getStatus(): BaseDbDriverStatus;
}
