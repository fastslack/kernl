/**
 * Pluggable vector database driver — interface stub.
 *
 * No implementations ship in this scaffold; the kind exists so the registry
 * can recognise it and so `embeddings`-using modules have a target shape to
 * migrate against later. Today, vector data lives in SQLite alongside the
 * embedding source rows (see `src/modules/graph-intel/embeddings.ts`); a
 * future `sqlite-vec` driver would wrap that in-place and a `qdrant` /
 * `chroma` / `pgvector` driver could supersede it without touching consumers.
 */

import type { BaseDbDriver, BaseDbDriverStatus } from "./types.js";

// ── Capabilities ──────────────────────────────────────────────────────

export interface VectorCapabilities {
  /** Distance metrics the backend supports natively. */
  metrics: Array<"cosine" | "l2" | "ip">;
  /** Maximum dimensionality the backend will accept (0 = unlimited). */
  maxDimensions: number;
  /** Supports filterable metadata alongside the vector. */
  metadataFilters: boolean;
  /** Supports updating vectors by id (vs. delete+insert). */
  upsert: boolean;
  /** Supports namespaces / collections within a single instance. */
  collections: boolean;
  /** Driver runs in-process — no external server. */
  embedded: boolean;
}

// ── Operation types ───────────────────────────────────────────────────

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorSearchHit {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  /** Returned only when `includeVectors=true` was requested. */
  vector?: number[];
}

export interface VectorSearchOptions {
  topK?: number;
  /** Backend-specific metadata filter. Drivers reject unsupported shapes. */
  filter?: Record<string, unknown>;
  includeVectors?: boolean;
}

// ── Status ────────────────────────────────────────────────────────────

export interface VectorDriverStatus extends BaseDbDriverStatus {
  kind: "vector";
  capabilities: VectorCapabilities;
}

// ── Driver contract ───────────────────────────────────────────────────

export interface VectorDriver extends BaseDbDriver {
  readonly kind: "vector";
  readonly capabilities: VectorCapabilities;

  /** Insert or update a batch of vectors in the named collection. */
  upsert(collection: string, records: VectorRecord[]): Promise<void>;

  /** Delete vectors by id. Drivers MAY ignore missing ids silently. */
  deleteByIds(collection: string, ids: string[]): Promise<void>;

  /** Nearest-neighbour search. Returns hits sorted best-to-worst. */
  search(
    collection: string,
    queryVector: number[],
    opts?: VectorSearchOptions,
  ): Promise<VectorSearchHit[]>;

  /** Drop a whole collection. No-op if it doesn't exist. */
  dropCollection(collection: string): Promise<void>;

  getStatus(): VectorDriverStatus;
}
