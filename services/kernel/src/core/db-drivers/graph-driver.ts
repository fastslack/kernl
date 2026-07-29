/**
 * Pluggable graph database driver.
 *
 * Implementations wrap a graph backend (Neo4j+GDS, Kùzu embedded, an
 * in-process noop, …) behind a single Cypher-flavoured surface. The
 * existing `Neo4jClient` (src/core/db/neo4j.ts) is the de-facto reference
 * for what consumers expect; `run()` returns records that respond to
 * `.get(key)` and the result exposes a coarse `summary` block.
 *
 * Capabilities are advertised statically so consumers can fail fast (or
 * downgrade gracefully) instead of attempting a query the backend can't
 * service. Modules that depend on heavyweight features — GDS analytics in
 * `trading/`, ML pipelines in `graph-intel/` — should gate on
 * `capabilities.gds` or `capabilities.mlPipelines` before issuing their
 * `CALL gds.*` queries.
 */

import type { BaseDbDriver, BaseDbDriverStatus } from "./types.js";

// ── Capabilities ──────────────────────────────────────────────────────

/**
 * Static feature flags advertised by a graph driver. Consumers read these
 * at the registry level (or via injected ctx.graph) to decide whether
 * their query is supported.
 */
export interface GraphCapabilities {
  /** Plain Cypher MATCH/CREATE/MERGE/etc. — the baseline. Always true in practice. */
  cypher: boolean;
  /** Graph Data Science procedures (gds.pageRank, gds.louvain, gds.fastRP, …). */
  gds: boolean;
  /** Vector similarity primitives (gds.similarity.cosine equivalent). */
  vectorSimilarity: boolean;
  /** GDS ML pipelines (nodeClassification, linkPrediction, …). */
  mlPipelines: boolean;
  /** Driver runs in-process — no external server, no separate port. */
  embedded: boolean;
  /** Supports parameterised queries (params object passed to run()). */
  parameterised: boolean;
  /** Supports multi-statement transactions via `withSession`. */
  transactions: boolean;
}

// ── Result shape ──────────────────────────────────────────────────────

/**
 * A single row of a graph query. Mirrors neo4j-driver's `Record` enough that
 * a Neo4j-backed driver can pass through its native records, while a Kùzu
 * (or other) adapter wraps its rows behind the same accessor API.
 */
export interface GraphRecord {
  /** Field names returned by the query, in declaration order. */
  readonly keys: readonly string[];
  /** Get a column by name — `undefined` if the key is not in the result. */
  get(key: string): unknown;
  /** Materialise the record into a plain object keyed by column name. */
  toObject(): Record<string, unknown>;
}

/**
 * Coarse mutation counters. Drivers that don't track these may return an
 * empty object; consumers that need them should treat absence as "unknown"
 * rather than zero.
 */
export interface GraphCounters {
  nodesCreated?: number;
  nodesDeleted?: number;
  relationshipsCreated?: number;
  relationshipsDeleted?: number;
  propertiesSet?: number;
  labelsAdded?: number;
  labelsRemoved?: number;
}

export interface GraphResultSummary {
  /** Mutation counters, when the driver exposes them. */
  counters?: GraphCounters;
  /** Optional execution-time hint (ms). */
  resultAvailableAfterMs?: number;
}

export interface GraphResult {
  records: GraphRecord[];
  summary?: GraphResultSummary;
}

// ── Session (for multi-statement work) ────────────────────────────────

/**
 * A driver-managed session. Backends that have no real session concept
 * (e.g. embedded single-threaded Kùzu) may return a thin shim that simply
 * forwards `run()` to the driver and ignores `commit`/`rollback`.
 */
export interface GraphSession {
  run(cypher: string, params?: Record<string, unknown>): Promise<GraphResult>;
  /** Commit any open transaction. No-op for auto-commit drivers. */
  commit?(): Promise<void>;
  /** Rollback any open transaction. No-op for auto-commit drivers. */
  rollback?(): Promise<void>;
  close(): Promise<void>;
}

// ── Status ────────────────────────────────────────────────────────────

export interface GraphDriverStatus extends BaseDbDriverStatus {
  kind: "graph";
  capabilities: GraphCapabilities;
}

// ── Driver contract ───────────────────────────────────────────────────

export interface GraphDriver extends BaseDbDriver {
  readonly kind: "graph";
  readonly capabilities: GraphCapabilities;

  /**
   * Convenience: execute a single auto-committed query. Backends with real
   * sessions allocate one transparently; embedded backends call into their
   * own engine directly.
   */
  run(cypher: string, params?: Record<string, unknown>): Promise<GraphResult>;

  /**
   * Allocate a session for multi-statement work. Caller is responsible for
   * `close()`. For backends without true sessions this returns a passthrough
   * that proxies `run()` to the driver and no-ops on `close`.
   */
  withSession<T>(fn: (session: GraphSession) => Promise<T>): Promise<T>;

  /** Health snapshot — extends BaseDbDriverStatus with graph capabilities. */
  getStatus(): GraphDriverStatus;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Convenience predicate for consumers: "can this driver run my query?".
 * Returns the missing capability name when the answer is no, else null.
 */
export function missingCapability(
  driver: GraphDriver,
  required: Array<keyof GraphCapabilities>,
): keyof GraphCapabilities | null {
  for (const cap of required) {
    if (!driver.capabilities[cap]) return cap;
  }
  return null;
}
