/**
 * RelateGraphDriver — embedded graph backend on Relate (relatedb.ai).
 *
 * Relate is an in-process Cypher 25 engine written in Rust: no server, no
 * port, one store file (or `:memory:`). It speaks Neo4j's dialect closely
 * enough that the kernel's queries run unchanged — constraints, `CREATE
 * VECTOR INDEX … OPTIONS`, `db.index.vector.queryNodes`,
 * `db.index.fulltext.queryNodes`, `MERGE … ON CREATE/ON MATCH`. What it does
 * not have is GDS, so `gds` and `mlPipelines` stay false and the analytics
 * consumers that gate on them skip their work.
 *
 * The client package (`@relate/relate`, Apache-2.0) is loaded lazily and is
 * NOT a kernel dependency: until it is installed this driver reports a clear
 * "not installed" error from start() and the rest of the kernel carries on.
 * `RELATE_CLIENT_MODULE` points at a client installed somewhere else, and the
 * client itself honours `RELATE_LIB` for the native engine library.
 *
 * Two behaviours of the client shape this file:
 *
 * - It has no way to close a store: the handle lives until the process exits,
 *   and opening the same path again in-process fails. Handles are therefore
 *   cached per path for the life of the process, and stop() only marks the
 *   driver not-ready (after a checkpoint) instead of closing anything.
 * - It returns every INTEGER as a plain JS `number`, while consumers written
 *   against neo4j-driver call `.toNumber()` on counts and ids. Results are
 *   adapted to the neo4j-driver shapes the kernel already handles: whole
 *   numbers become a `Number` subclass with `toNumber()`, nodes and
 *   relationships gain `identity`/`start`/`end`. A whole-valued FLOAT is
 *   indistinguishable from an INTEGER in the client's output, so it is
 *   wrapped too; `Number(v)`, arithmetic and JSON serialisation all still
 *   see the plain value.
 */

import { dirname, resolve } from "node:path";
import { log } from "../../logger.js";
import type {
  GraphCapabilities,
  GraphCounters,
  GraphDriver,
  GraphDriverStatus,
  GraphRecord,
  GraphResult,
  GraphSession,
} from "../graph-driver.js";
import type { ConfigField } from "../types.js";

// ── Client surface (the subset of @relate/relate this driver uses) ────

export interface RelateStats {
  nodes_created?: number;
  nodes_deleted?: number;
  relationships_created?: number;
  relationships_deleted?: number;
  properties_set?: number;
  labels_added?: number;
  labels_removed?: number;
}

export interface RelateResult {
  columns: string[];
  rows: Record<string, unknown>[];
  stats?: RelateStats;
}

export interface RelateConnection {
  queryAsync(cypher: string, params?: Record<string, unknown>): Promise<RelateResult>;
}

export interface RelateDatabase {
  connect(namespace?: string): RelateConnection;
  checkpoint(): void;
}

export interface RelateModule {
  Database: { open(uri: string, options?: { readOnly?: boolean }): RelateDatabase };
}

export type RelateLoader = () => Promise<RelateModule>;

const DEFAULT_CLIENT_MODULE = "@relate/relate";

/** Load the client by a non-literal specifier so the bundler leaves it external. */
const defaultLoader: RelateLoader = async () => {
  const specifier = process.env.RELATE_CLIENT_MODULE?.trim() || DEFAULT_CLIENT_MODULE;
  const mod = (await import(specifier)) as RelateModule & { default?: RelateModule };
  return mod.Database ? mod : (mod.default as RelateModule);
};

/** Stores opened by this process, by resolved path. See the header: they cannot be closed. */
const openStores = new Map<string, RelateDatabase>();

/** Default store location: next to the SQLite database, or `RELATE_DATABASE`. */
export function defaultRelatePath(): string {
  const explicit = process.env.RELATE_DATABASE?.trim();
  if (explicit) return explicit;
  const sqlite = process.env.SQLITE_PATH ?? resolve("data", "kernel.db");
  return resolve(dirname(sqlite), "graph.rl");
}

// ── Value adaptation (Relate → neo4j-driver shapes) ───────────────────

/**
 * Stand-in for neo4j-driver's `Integer`: answers `toNumber()`/`toInt()` like
 * one, and is still a `Number` for `Number(v)`, arithmetic and JSON.
 */
export class RelateInteger extends Number {
  toNumber(): number {
    return this.valueOf();
  }
  toInt(): number {
    return this.valueOf();
  }
  inSafeRange(): boolean {
    return Number.isSafeInteger(this.valueOf());
  }
  toJSON(): number {
    return this.valueOf();
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function adaptValue(v: unknown): unknown {
  if (typeof v === "bigint") return new RelateInteger(Number(v));
  if (typeof v === "number") return Number.isInteger(v) ? new RelateInteger(v) : v;
  if (Array.isArray(v)) return v.map(adaptValue);
  if (v === null || typeof v !== "object" || !isPlainObject(v)) return v;

  const obj = v as Record<string, unknown>;
  if (obj.kind === "node" && typeof obj.elementId === "string") {
    return {
      ...obj,
      identity: adaptValue(obj.id),
      labels: obj.labels ?? [],
      properties: adaptValue(obj.properties ?? {}),
    };
  }
  if (obj.kind === "relationship" && typeof obj.elementId === "string") {
    return {
      ...obj,
      identity: adaptValue(obj.id),
      start: adaptValue(obj.startId),
      end: adaptValue(obj.endId),
      startNodeElementId: obj.startElementId,
      endNodeElementId: obj.endElementId,
      properties: adaptValue(obj.properties ?? {}),
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(obj)) out[k] = adaptValue(x);
  return out;
}

function toRecord(columns: string[], row: Record<string, unknown>): GraphRecord {
  return {
    keys: columns,
    get: (key: string) => adaptValue(row[key]),
    toObject: () => {
      const out: Record<string, unknown> = {};
      for (const k of columns) out[k] = adaptValue(row[k]);
      return out;
    },
  };
}

function toCounters(stats: RelateStats | undefined): GraphCounters | undefined {
  if (!stats) return undefined;
  return {
    nodesCreated: stats.nodes_created,
    nodesDeleted: stats.nodes_deleted,
    relationshipsCreated: stats.relationships_created,
    relationshipsDeleted: stats.relationships_deleted,
    propertiesSet: stats.properties_set,
    labelsAdded: stats.labels_added,
    labelsRemoved: stats.labels_removed,
  };
}

export function adaptResult(r: RelateResult): GraphResult {
  const columns = r.columns ?? [];
  return {
    records: (r.rows ?? []).map((row) => toRecord(columns, row)),
    summary: { counters: toCounters(r.stats) },
  };
}

// ── Driver ────────────────────────────────────────────────────────────

export class RelateGraphDriver implements GraphDriver {
  readonly slug = "relate";
  readonly name = "Relate (embedded)";
  readonly kind = "graph" as const;
  readonly deployment = "embedded" as const;

  private path: string | null = null;
  private db: RelateDatabase | null = null;
  private conn: RelateConnection | null = null;
  private ready = false;
  private vectorIndex = false;
  private fulltextIndex = false;
  private cypherVersion: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly loader: RelateLoader = defaultLoader) {}

  get capabilities(): GraphCapabilities {
    const cypher = this.ready;
    return {
      cypher,
      gds: false,
      vectorSimilarity: cypher && this.vectorIndex,
      mlPipelines: false,
      embedded: true,
      parameterised: cypher,
      transactions: cypher,
    };
  }

  // ── Config form (rendered by /extensions) ─────────────────────────

  getConfigSchema(): ConfigField[] {
    return [
      {
        key: "path",
        label: "Store file",
        type: "text",
        required: false,
        placeholder: defaultRelatePath(),
        default: defaultRelatePath(),
        description:
          "Path to the Relate store (.rl file or directory). Empty uses graph.rl next to the SQLite database. `:memory:` keeps the graph only while the kernel runs.",
      },
    ];
  }

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    if (config.path !== undefined && config.path !== null && typeof config.path !== "string") {
      return { valid: false, errors: ["path must be a string"] };
    }
    if (typeof config.path === "string" && /^(bolt|neo4j)(\+s|\+ssc)?:\/\//i.test(config.path.trim())) {
      return { valid: false, errors: ["path is a local store, not a server URI"] };
    }
    return { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    const v = this.validateConfig(config);
    if (!v.valid) {
      throw new Error(`RelateGraphDriver: invalid config — ${(v.errors ?? []).join(", ")}`);
    }
    const p = typeof config.path === "string" ? config.path.trim() : "";
    this.path = p || null;
  }

  /** Opt-in only: an explicit `RELATE_DATABASE` asks for this backend. */
  canSelfConfigure(): boolean {
    return !!process.env.RELATE_DATABASE?.trim();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  private resolvedPath(): string {
    const p = this.path ?? defaultRelatePath();
    return p === ":memory:" || p.startsWith("file://") ? p : resolve(p);
  }

  async start(): Promise<void> {
    this.lastError = null;
    const path = this.resolvedPath();
    try {
      let mod: RelateModule;
      try {
        mod = await this.loader();
      } catch (err) {
        throw new Error(
          `Relate client not installed (${err instanceof Error ? err.message : String(err)}). ` +
            "Install @relate/relate and its platform package, or set RELATE_CLIENT_MODULE to a client path.",
        );
      }
      // `:memory:` is per-driver by nature; a file store is shared process-wide.
      let db = path === ":memory:" ? undefined : openStores.get(path);
      if (!db) {
        db = mod.Database.open(path);
        if (path !== ":memory:") openStores.set(path, db);
      }
      this.db = db;
      this.conn = db.connect();
      await this.conn.queryAsync("RETURN 1 AS ok");
      await this.probeCapabilities();
      this.ready = true;
      log.info(
        `RelateGraphDriver ready: ${path} (Cypher ${this.cypherVersion ?? "?"}, vector=${this.vectorIndex}, fulltext=${this.fulltextIndex})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.ready = false;
      this.conn = null;
      log.warn(`RelateGraphDriver: start failed — ${msg}`);
      // Same contract as Neo4jGraphDriver: never rethrow — the registry reads
      // isReady() and the kernel keeps running with capabilities all-false.
    }
  }

  /** Ask the engine what it supports instead of assuming it from a version. */
  private async probeCapabilities(): Promise<void> {
    this.vectorIndex = false;
    this.fulltextIndex = false;
    this.cypherVersion = null;
    try {
      const r = await this.conn!.queryAsync(
        "CALL dbms.listCapabilities() YIELD name, value RETURN name, value",
      );
      for (const row of r.rows ?? []) {
        if (row.name === "vector.index") this.vectorIndex = row.value === true;
        else if (row.name === "fulltext.index") this.fulltextIndex = row.value === true;
        else if (row.name === "cypher.version") this.cypherVersion = String(row.value);
      }
    } catch {
      // Older engines lack the procedure; fall back to the vector function.
      try {
        const r = await this.conn!.queryAsync(
          "RETURN vector.similarity.cosine([1.0, 0.0], [1.0, 0.0]) AS score",
        );
        this.vectorIndex = r.rows?.[0]?.score != null;
      } catch {
        this.vectorIndex = false;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.db && this.ready) {
      try {
        this.db.checkpoint();
      } catch (err) {
        log.warn(`RelateGraphDriver: checkpoint on stop failed — ${String(err)}`);
      }
    }
    // The store handle stays cached in `openStores`: the client cannot close
    // it, and a later start() on the same path must reuse it.
    this.ready = false;
    this.conn = null;
    this.db = null;
    log.info("RelateGraphDriver stopped");
  }

  isReady(): boolean {
    return this.ready;
  }

  getStatus(): GraphDriverStatus {
    return {
      slug: this.slug,
      name: this.name,
      kind: this.kind,
      deployment: this.deployment,
      ready: this.ready,
      source: "builtin",
      capabilities: this.capabilities,
      info: {
        path: this.resolvedPath(),
        cypherVersion: this.cypherVersion,
        fulltextIndex: this.fulltextIndex,
      },
      error: this.lastError ?? undefined,
    };
  }

  // ── Operations ────────────────────────────────────────────────────

  async run(cypher: string, params?: Record<string, unknown>): Promise<GraphResult> {
    if (!this.conn || !this.ready) {
      throw new Error("RelateGraphDriver: not ready — call start() first");
    }
    return adaptResult(await this.conn.queryAsync(cypher, params ?? {}));
  }

  async withSession<T>(fn: (session: GraphSession) => Promise<T>): Promise<T> {
    if (!this.db || !this.ready) {
      throw new Error("RelateGraphDriver: not ready — call start() first");
    }
    // A connection of its own, so a session's statements queue together
    // instead of interleaving with the driver's shared connection. Statements
    // auto-commit, as they do through Neo4jGraphDriver's session adapter.
    const conn = this.db.connect();
    return fn({
      async run(cypher: string, params?: Record<string, unknown>) {
        return adaptResult(await conn.queryAsync(cypher, params ?? {}));
      },
      async close() {
        // Connections hold no resources the client lets us release.
      },
    });
  }
}
