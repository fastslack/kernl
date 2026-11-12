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
 * The client package (`@relate/relate`, Apache-2.0) is a kernel dependency,
 * loaded lazily at start; if it cannot load, this driver reports a clear
 * error from start() and the rest of the kernel carries on.
 * `RELATE_CLIENT_MODULE` points at a client installed somewhere else, and the
 * client itself honours `RELATE_LIB` for the native engine library.
 *
 * Connections: one writer, a few readers. A connection runs one statement at
 * a time and Relate cannot cancel one, so on a single shared connection a
 * slow read (an agent's graph query, the explorer, analytics) held up every
 * other statement in the kernel — measured, a 4.5 s read kept a one-node
 * lookup waiting 4.5 s; on a second connection it took 2 ms. Statements that
 * only read (isReadStatement) go to the least busy of RELATE_READ_CONNECTIONS
 * readers (3 by default; 0 sends everything to the writer); anything else,
 * and anything unsure, goes to the writer. A read first waits for the writes
 * issued before it, so a caller never reads behind its own write. Errors the
 * engine marks retryable (a write-write conflict) are retried, and
 * withTransaction() runs several statements atomically on a connection of
 * their own.
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

import { existsSync, renameSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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
  /** Plan (EXPLAIN/PROFILE) and planner notifications. */
  _summary?: { plan?: unknown; notifications?: unknown[] };
}

export interface RelateConnection {
  queryAsync(cypher: string, params?: Record<string, unknown>): Promise<RelateResult>;
  /** Synchronous — blocks the event loop; tests and one-off tools only. */
  query(cypher: string, params?: Record<string, unknown>): RelateResult;
  /** Explicit transactions (synchronous; refused while an async query is in flight on the connection). */
  begin?(): void;
  /** Returns the commit's bookmark, or null when it committed nothing. Throws a retryable error on a write-write conflict. */
  commit?(): string | null;
  rollback?(): void;
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
export const loadRelateClient: RelateLoader = async () => {
  const specifier = process.env.RELATE_CLIENT_MODULE?.trim() || DEFAULT_CLIENT_MODULE;
  const mod = (await import(specifier)) as RelateModule & { default?: RelateModule };
  return mod.Database ? mod : (mod.default as RelateModule);
};

/**
 * Whether the client can be loaded, without loading it (no native library is
 * touched): an explicit RELATE_CLIENT_MODULE that exists, or `@relate/relate`
 * resolvable from where the kernel runs.
 */
export function relateClientInstalled(): boolean {
  const explicit = process.env.RELATE_CLIENT_MODULE?.trim();
  if (explicit) return existsSync(explicit);
  try {
    createRequire(import.meta.url).resolve(DEFAULT_CLIENT_MODULE);
    return true;
  } catch {
    return false;
  }
}

/** Stores opened by this process, by resolved path. See the header: they cannot be closed. */
const openStores = new Map<string, RelateDatabase>();

const dataDir = () => dirname(process.env.SQLITE_PATH ?? resolve("data", "kernel.db"));

/**
 * Default store location: a directory store next to the SQLite database, or
 * `RELATE_DATABASE`. A directory (not a single `.rl` file) because it can be
 * read and cloned beside the running kernel, and its checkpoints rewrite only
 * what changed — a `.rl` file is locked against every other reader and never
 * shrinks.
 */
export function defaultRelatePath(): string {
  const explicit = process.env.RELATE_DATABASE?.trim();
  if (explicit) return explicit;
  return resolve(dataDir(), "graph");
}

/** The single-file store earlier versions used by default; migrated on first start. */
export function legacyRelatePath(): string {
  return resolve(dataDir(), "graph.rl");
}

/**
 * Cap on the graph's logical size (RELATE_LOGICAL_GRAPH_SIZE_LIMIT, e.g.
 * "2gib"; "none" lifts it). The engine keeps the whole graph in memory and is
 * uncapped by default, so without one a runaway writer grows the kernel until
 * the OS kills it. Over the cap, writes that grow the graph are refused.
 */
export const DEFAULT_GRAPH_SIZE_LIMIT = "2gib";
const SIZE_RE = /^(none|0|\d+(\.\d+)?\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?)$/i;

// ── Routing: which statements may run on a reader ─────────────────────

/** Readers when RELATE_READ_CONNECTIONS is unset. */
export const DEFAULT_READ_CONNECTIONS = 3;

export function readConnectionCount(): number {
  const raw = process.env.RELATE_READ_CONNECTIONS?.trim();
  if (!raw) return DEFAULT_READ_CONNECTIONS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(n, 16)) : DEFAULT_READ_CONNECTIONS;
}

/** Clauses that change the graph or its schema. */
const WRITE_CLAUSE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|DETACH|FOREACH|ALTER|DEFINE|LOAD\s+CSV|IN\s+TRANSACTIONS)\b/i;
/** Procedures that only read. Any other CALL is treated as a write. */
const READ_PROCEDURE =
  /^(db\.(labels|relationshipTypes|propertyKeys|info|ping|stats\.retrieve|schema\.[A-Za-z]+|index\.(vector|fulltext)\.query(Nodes|Relationships))|dbms\.(components|info|listCapabilities|listConfig|showCurrentUser))$/;

/** The statement with string literals, quoted names and comments blanked out. */
function blankLiteralsForRouting(cypher: string): string {
  return cypher
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, "''");
}

/**
 * True only when the statement certainly does not write: no writing clause
 * and no procedure outside the read-only list. Unsure means false — the
 * writer runs anything, a reader only loses its point when it waits.
 */
export function isReadStatement(cypher: string): boolean {
  const text = blankLiteralsForRouting(cypher);
  for (const m of text.matchAll(/\bCALL\s+([A-Za-z_][\w.]*)\s*\(/gi)) {
    if (!READ_PROCEDURE.test(m[1])) return false;
  }
  // `n.set`, `{merge: 1}` and `(n:Set)` are names, not clauses.
  const clauses = text.replace(/\.\s*[A-Za-z_]\w*/g, ".x").replace(/[A-Za-z_]\w*\s*:(?!:)/g, "k:").replace(/:\s*[A-Za-z_]\w*/g, ":x");
  if (WRITE_CLAUSE.test(clauses)) return false;
  return /\b(MATCH|RETURN|SHOW|CALL|EXPLAIN|PROFILE)\b/i.test(clauses);
}

const isRetryable = (err: unknown) => (err as { retryable?: unknown } | null)?.retryable === true;

/** Run again while the engine says the failure is worth retrying (a write-write conflict). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isRetryable(err)) throw err;
      await new Promise((r) => setTimeout(r, 4 * 2 ** i + Math.random() * 8));
    }
  }
}

const settle = () => undefined;

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

/** A `VECTOR` value comes back as `{dtype, values}`; callers get the list of floats they always got. */
function isCypherVector(v: unknown): v is { dtype: string; values: ArrayLike<number> } {
  return v !== null && typeof v === "object" && v.constructor?.name === "CypherVector" && "values" in v;
}

export function adaptValue(v: unknown): unknown {
  if (typeof v === "bigint") return new RelateInteger(Number(v));
  if (typeof v === "number") return Number.isInteger(v) ? new RelateInteger(v) : v;
  if (Array.isArray(v)) return v.map(adaptValue);
  if (isCypherVector(v)) return Array.from(v.values as ArrayLike<number>, Number);
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
    summary: {
      counters: toCounters(r.stats),
      ...(r._summary?.plan ? { plan: r._summary.plan } : {}),
      ...(r._summary?.notifications?.length ? { notifications: r._summary.notifications } : {}),
    },
  };
}

// ── Driver ────────────────────────────────────────────────────────────

export class RelateGraphDriver implements GraphDriver {
  readonly slug = "relate";
  readonly name = "Relate (embedded)";
  readonly kind = "graph" as const;
  readonly deployment = "embedded" as const;

  private path: string | null = null;
  private memoryLimit: string | null = null;
  /** The store actually open — the configured one, or the old file when its move failed. */
  private openedPath: string | null = null;
  private capacityWarned = false;
  private db: RelateDatabase | null = null;
  /** The writer: every statement that may write, in the order issued. */
  private conn: RelateConnection | null = null;
  /** Read-only statements, spread by how many each one is running. */
  private readers: RelateConnection[] = [];
  private readerLoad = new Map<RelateConnection, number>();
  /** Settles once every write issued so far has finished (never rejects). */
  private writeTail: Promise<unknown> = Promise.resolve();
  private ready = false;
  private vectorIndex = false;
  private vectorSearch = false;
  private fulltextIndex = false;
  private cypherVersion: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly loader: RelateLoader = loadRelateClient) {}

  get capabilities(): GraphCapabilities {
    const cypher = this.ready;
    return {
      cypher,
      gds: false,
      vectorSimilarity: cypher && this.vectorIndex,
      vectorSearch: cypher && this.vectorIndex && this.vectorSearch,
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
          "Path to the Relate store (a directory, or a .rl file). Empty uses a `graph` directory next to the SQLite database. `:memory:` keeps the graph only while the kernel runs.",
      },
      {
        key: "memoryLimit",
        label: "Memory limit",
        type: "text",
        required: false,
        placeholder: DEFAULT_GRAPH_SIZE_LIMIT,
        default: DEFAULT_GRAPH_SIZE_LIMIT,
        description:
          "Largest logical size the graph may grow to (e.g. 512mib, 2gib; none = no limit). The graph lives in memory; past the limit, writes that grow it are refused instead of the kernel running out of memory.",
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
    if (config.memoryLimit !== undefined && config.memoryLimit !== null && config.memoryLimit !== "" &&
        (typeof config.memoryLimit !== "string" || !SIZE_RE.test(config.memoryLimit.trim()))) {
      return { valid: false, errors: ["memoryLimit must be a size like 512mib or 2gib, or none"] };
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
    const m = typeof config.memoryLimit === "string" ? config.memoryLimit.trim() : "";
    this.memoryLimit = m || null;
  }

  /**
   * The default graph for a fresh install whenever its client is there — the
   * desktop payload and the Docker image both ship it. An explicit
   * `RELATE_DATABASE` asks for it too. Never overrides a driver already chosen.
   */
  canSelfConfigure(): boolean {
    if (process.env.RELATE_DATABASE?.trim()) return true;
    // An operator who pointed the install at a Neo4j server (NEO4J_URI, as
    // docker-compose.neo4j.yml does) meant that server.
    if (process.env.NEO4J_URI?.trim()) return false;
    return relateClientInstalled();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  private resolvedPath(): string {
    const p = this.path ?? defaultRelatePath();
    return p === ":memory:" || p.startsWith("file://") ? p : resolve(p);
  }

  async start(): Promise<void> {
    this.lastError = null;
    let path = this.resolvedPath();
    try {
      // The engine reads its size cap from the environment when a store opens.
      if (!process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT) {
        const limit = this.memoryLimit ?? DEFAULT_GRAPH_SIZE_LIMIT;
        if (!/^(none|0)$/i.test(limit)) process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT = limit;
      }
      path = await this.migrateLegacyStore(path);
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
      this.openedPath = path;
      this.conn = db.connect();
      await this.conn.queryAsync("RETURN 1 AS ok");
      await this.probeCapabilities();
      this.readers = Array.from({ length: readConnectionCount() }, () => db.connect());
      this.readerLoad = new Map(this.readers.map((c) => [c, 0]));
      this.writeTail = Promise.resolve();
      this.ready = true;
      log.info(
        `RelateGraphDriver ready: ${path} (Cypher ${this.cypherVersion ?? "?"}, vector=${this.vectorIndex}, search=${this.vectorSearch}, ` +
          `fulltext=${this.fulltextIndex}, readers=${this.readers.length})`,
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

  /**
   * An install that kept the default single-file store (`graph.rl`) moves to
   * the default directory store once. The copy runs in a child process (the
   * client cannot close a store, so an in-process copy would hold both stores'
   * memory and locks for the life of the kernel); the old file is kept, renamed
   * `graph.rl.migrated`. If anything fails, the kernel keeps using the old file.
   */
  private async migrateLegacyStore(path: string): Promise<string> {
    const usingDefault = !this.path && !process.env.RELATE_DATABASE?.trim();
    const legacy = legacyRelatePath();
    if (!usingDefault || path !== defaultRelatePath() || existsSync(path) || !existsSync(legacy)) return path;
    log.info(`RelateGraphDriver: moving the graph from ${legacy} to the directory store ${path}…`);
    try {
      await runStoreMigrationChild(legacy, path);
      renameSync(legacy, `${legacy}.migrated`);
      log.info(`RelateGraphDriver: graph moved to ${path} (old file kept as ${legacy}.migrated)`);
      return path;
    } catch (err) {
      rmSync(path, { recursive: true, force: true });
      log.warn(
        `RelateGraphDriver: could not move the graph to a directory store — staying on ${legacy} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      );
      return legacy;
    }
  }

  /** Ask the engine what it supports instead of assuming it from a version. */
  private async probeCapabilities(): Promise<void> {
    this.vectorIndex = false;
    this.vectorSearch = false;
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
      // Vector values and SEARCH came with Cypher 25; ask for the value itself.
      if (this.vectorIndex && Number.parseInt(this.cypherVersion ?? "", 10) >= 25) {
        const v = await this.conn!.queryAsync("RETURN vector([1.0, 0.0], 2, FLOAT32) IS NOT NULL AS ok").catch(() => null);
        this.vectorSearch = v?.rows?.[0]?.ok === true;
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
    this.readers = [];
    this.readerLoad.clear();
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
        path: this.openedPath ?? this.resolvedPath(),
        memoryLimit: process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT ?? "none",
        readConnections: this.readers.length,
        cypherVersion: this.cypherVersion,
        fulltextIndex: this.fulltextIndex,
      },
      error: this.lastError ?? undefined,
    };
  }

  // ── Operations ────────────────────────────────────────────────────

  async run(cypher: string, params?: Record<string, unknown>): Promise<GraphResult> {
    const writer = this.conn;
    if (!writer || !this.ready) {
      throw new Error("RelateGraphDriver: not ready — call start() first");
    }
    if (this.readers.length > 0 && isReadStatement(cypher)) return this.runOnReader(cypher, params);
    const p = withRetry(() => writer.queryAsync(cypher, params ?? {}));
    this.afterWrite(p);
    try {
      return adaptResult(await p);
    } catch (err) {
      this.noteCapacity(err);
      throw err;
    }
  }

  /** Reads issued from now on wait for `p` as well as every earlier write. */
  private afterWrite(p: Promise<unknown>): void {
    const before = this.writeTail;
    this.writeTail = p.then(settle, settle).then(() => before);
  }

  private async runOnReader(cypher: string, params?: Record<string, unknown>): Promise<GraphResult> {
    // Program order: a read sees every write issued before it.
    await this.writeTail;
    let conn = this.readers[0];
    for (const c of this.readers) if (this.readerLoad.get(c)! < this.readerLoad.get(conn)!) conn = c;
    this.readerLoad.set(conn, this.readerLoad.get(conn)! + 1);
    try {
      return adaptResult(await withRetry(() => conn.queryAsync(cypher, params ?? {})));
    } catch (err) {
      this.noteCapacity(err);
      throw err;
    } finally {
      this.readerLoad.set(conn, Math.max(0, (this.readerLoad.get(conn) ?? 1) - 1));
    }
  }

  /**
   * Several statements as one transaction, on a connection of their own:
   * all of them commit or none does. On a write-write conflict with another
   * connection the whole of `fn` runs again (up to five times), so `fn` must
   * be safe to repeat — it should only talk to the graph through `tx`.
   */
  async withTransaction<T>(fn: (tx: GraphSession) => Promise<T>): Promise<T> {
    const db = this.db;
    if (!db || !this.ready) {
      throw new Error("RelateGraphDriver: not ready — call start() first");
    }
    const attempt = async (): Promise<T> => {
      const conn = db.connect();
      if (!conn.begin || !conn.commit || !conn.rollback) {
        throw new Error("RelateGraphDriver: this Relate client has no explicit transactions");
      }
      conn.begin();
      try {
        const out = await fn({
          async run(cypher: string, params?: Record<string, unknown>) {
            return adaptResult(await conn.queryAsync(cypher, params ?? {}));
          },
          async close() {},
        });
        conn.commit();
        return out;
      } catch (err) {
        try {
          conn.rollback();
        } catch {
          // Already ended by the failed commit.
        }
        throw err;
      }
    };
    const p = withRetry(attempt);
    this.afterWrite(p);
    try {
      return await p;
    } catch (err) {
      this.noteCapacity(err);
      throw err;
    }
  }

  /** Say once, loudly, when the graph has reached its memory limit. */
  private noteCapacity(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (this.capacityWarned || !/capacity exceeded|TransactionOutOfMemory/i.test(`${msg} ${(err as { code?: string })?.code ?? ""}`)) return;
    this.capacityWarned = true;
    log.error(
      `RelateGraphDriver: the graph reached its memory limit (${process.env.RELATE_LOGICAL_GRAPH_SIZE_LIMIT ?? "?"}) — ` +
      `writes that grow it are refused. Raise "Memory limit" for the relate driver in /extensions. (${msg})`,
    );
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

// ── One-off store migration in a child process ───────────────────────

export const STORE_MIGRATION_TASK = "relate-store-migration";

/** Runs the kernel entry point again as a child that only migrates the store, then exits. */
function runStoreMigrationChild(from: string, to: string): Promise<void> {
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) {
    return Promise.reject(new Error("cannot locate the kernel entry point to run the migration"));
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        KERNL_INTERNAL_TASK: STORE_MIGRATION_TASK,
        KERNL_RELATE_MIGRATE_FROM: from,
        KERNL_RELATE_MIGRATE_TO: to,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout?.on("data", (d) => log.info(`RelateGraphDriver migration: ${String(d).trim()}`));
    child.stderr?.on("data", (d) => { stderr += String(d); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30 * 60_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`migration exited with ${code}: ${stderr.trim().split("\n").slice(-2).join(" ")}`));
    });
  });
}

/**
 * The child side, called from the entry point before bootstrap when
 * KERNL_INTERNAL_TASK says so. Prints a one-line summary; exits non-zero on failure.
 */
export async function runStoreMigrationTask(): Promise<void> {
  const from = process.env.KERNL_RELATE_MIGRATE_FROM ?? "";
  const to = process.env.KERNL_RELATE_MIGRATE_TO ?? "";
  try {
    const { migrateRelateStore } = await import("./relate-store-migration.js");
    const r = await migrateRelateStore(await loadRelateClient(), from, to);
    process.stdout.write(
      `${r.nodes} nodes, ${r.relationships} relationships, ${r.schema} schema statements in ${r.ms} ms\n`,
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  }
}
