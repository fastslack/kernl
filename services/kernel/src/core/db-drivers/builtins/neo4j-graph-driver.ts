/**
 * Neo4jGraphDriver — wraps the legacy `Neo4jClient` behind GraphDriver.
 *
 * Backed by the official `neo4j-driver` package against an external Neo4j
 * server (Bolt protocol). On `start()` we verify connectivity and probe for
 * GDS — if `gds.version()` succeeds, we enable the heavy capabilities;
 * otherwise we leave them off so consumers fall through to graceful paths.
 *
 * `Result` records returned by neo4j-driver already satisfy the
 * `GraphRecord` shape (they expose `keys`, `get(key)`, `toObject()`), so we
 * can pass them through with a structural cast — no per-row adaptation
 * needed. The same applies to native sessions wrapped via `GraphSession`.
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import { log } from "../../logger.js";
import type {
  GraphDriver,
  GraphDriverStatus,
  GraphCapabilities,
  GraphSession,
  GraphResult,
} from "../graph-driver.js";
import type { ConfigField } from "../types.js";

interface Neo4jDriverConfig {
  uri: string;
  user: string;
  password: string;
}

export class Neo4jGraphDriver implements GraphDriver {
  readonly slug = "neo4j";
  readonly name = "Neo4j (external server)";
  readonly kind = "graph" as const;
  readonly deployment = "external-server" as const;

  private driver: Driver | null = null;
  private connected = false;
  private gdsAvailable = false;
  private gdsVersion: string | null = null;
  private nativeVectorAvailable = false;
  private config: Neo4jDriverConfig | null = null;
  private lastError: string | null = null;

  get capabilities(): GraphCapabilities {
    // Cypher is gated on connectivity; GDS-derived capabilities are gated on
    // both connectivity AND a successful gds.version() probe at start().
    const cypher = this.connected;
    const gds = this.connected && this.gdsAvailable;
    return {
      cypher,
      gds,
      // Vector similarity is NOT a GDS-only feature: Neo4j ships
      // `vector.similarity.cosine()` and native vector indexes in the core
      // product (5.13+). Gating this on GDS used to deny a capability the
      // server actually had, so it is probed directly instead — either source
      // (native or GDS) satisfies it.
      vectorSimilarity: cypher && (this.nativeVectorAvailable || this.gdsAvailable),
      mlPipelines: gds,      // Pipelines need GDS too (some are Enterprise-only,
                             // but we don't probe license here — the query fails
                             // loudly enough at runtime).
      embedded: false,
      parameterised: cypher,
      transactions: cypher,
    };
  }

  // ── Config form (rendered by /extensions) ─────────────────────────

  getConfigSchema(): ConfigField[] {
    return [
      {
        key: "uri",
        label: "Bolt URI",
        type: "text",
        required: true,
        placeholder: "bolt://localhost:7687",
        default: "bolt://localhost:7687",
        description: "Neo4j Bolt endpoint (use bolt+s:// for TLS).",
      },
      {
        key: "user",
        label: "Username",
        type: "text",
        required: true,
        default: "neo4j",
      },
      {
        key: "password",
        label: "Password",
        type: "password",
        required: true,
        description: "Stored encrypted in installed_extensions.settings_json.",
      },
    ];
  }

  validateConfig(config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (typeof config.uri !== "string" || !config.uri.trim()) errors.push("uri is required");
    if (typeof config.user !== "string" || !config.user.trim()) errors.push("user is required");
    if (typeof config.password !== "string" || !config.password) errors.push("password is required");
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  configure(config: Record<string, unknown>): void {
    const v = this.validateConfig(config);
    if (!v.valid) {
      throw new Error(`Neo4jGraphDriver: invalid config — ${(v.errors ?? []).join(", ")}`);
    }
    this.config = {
      uri: String(config.uri),
      user: String(config.user),
      password: String(config.password),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Connection settings from the environment, or null when they're not fully
   * present. Mirrors the `NEO4J_*` block in `core/config.ts` — the same three
   * variables the shipped compose passes to the kernel.
   */
  canSelfConfigure(): boolean {
    return this.envConfig() !== null;
  }

  private envConfig(): Neo4jDriverConfig | null {
    const uri = (process.env.NEO4J_URI ?? "").trim();
    const user = (process.env.NEO4J_USER ?? "").trim();
    const password = process.env.NEO4J_PASSWORD ?? "";
    if (!uri || !user || !password) return null;
    return { uri, user, password };
  }

  async start(): Promise<void> {
    if (!this.config) {
      // Nothing saved through /extensions yet. The bundled compose already
      // sets NEO4J_URI/USER/PASSWORD and starts a Neo4j alongside the kernel,
      // so falling back to those makes the shipped stack reach its own graph
      // instead of failing activation and silently staying on the noop driver.
      const fromEnv = this.envConfig();
      if (!fromEnv) {
        throw new Error("Neo4jGraphDriver: configure() must be called before start()");
      }
      this.config = fromEnv;
      log.info(`Neo4jGraphDriver: no stored config — using NEO4J_* environment (${fromEnv.uri})`);
    }
    this.lastError = null;
    try {
      this.driver = neo4j.driver(
        this.config.uri,
        neo4j.auth.basic(this.config.user, this.config.password),
        {
          maxConnectionPoolSize: 50,
          connectionAcquisitionTimeout: 30000,
          maxTransactionRetryTime: 15000,
          connectionTimeout: 10000,
        },
      );
      await this.driver.verifyConnectivity();
      this.connected = true;
      log.info(`Neo4jGraphDriver connected: ${this.config.uri}`);
      await this.probeGds();
      await this.probeNativeVectors();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.connected = false;
      this.gdsAvailable = false;
      this.nativeVectorAvailable = false;
      log.warn(`Neo4jGraphDriver: start failed — ${msg}`);
      // Don't rethrow — the registry treats start() failures as "not ready"
      // and the rest of the system continues with capabilities all-false.
    }
  }

  /**
   * Detect GDS by calling its version function. We tolerate any failure mode
   * (procedure missing, permission denied, plugin not loaded) and treat them
   * all as "GDS unavailable" — the capability flags reflect that.
   */
  private async probeGds(): Promise<void> {
    if (!this.driver || !this.connected) return;
    const session = this.driver.session();
    try {
      const result = await session.run("RETURN gds.version() AS version");
      const v = result.records[0]?.get("version");
      this.gdsAvailable = !!v;
      this.gdsVersion = typeof v === "string" ? v : null;
      if (this.gdsAvailable) log.info(`Neo4jGraphDriver: GDS ${this.gdsVersion ?? "?"} detected`);
      else log.info("Neo4jGraphDriver: GDS not present — graph analytics disabled");
    } catch {
      this.gdsAvailable = false;
      this.gdsVersion = null;
      log.info("Neo4jGraphDriver: GDS probe failed — graph analytics disabled");
    } finally {
      await session.close().catch(() => {});
    }
  }

  /**
   * Detect the core product's vector functions. Probed rather than inferred
   * from a version string so the flag stays honest on any build that ships
   * them (and on any that quietly drops them). Same tolerate-everything shape
   * as `probeGds`.
   */
  private async probeNativeVectors(): Promise<void> {
    if (!this.driver || !this.connected) return;
    const session = this.driver.session();
    try {
      const result = await session.run(
        "RETURN vector.similarity.cosine([1.0, 0.0], [1.0, 0.0]) AS score",
      );
      this.nativeVectorAvailable = result.records[0]?.get("score") != null;
      if (this.nativeVectorAvailable) {
        log.info("Neo4jGraphDriver: native vector functions detected");
      } else {
        log.info("Neo4jGraphDriver: native vector functions absent");
      }
    } catch {
      this.nativeVectorAvailable = false;
      log.info("Neo4jGraphDriver: native vector probe failed — falling back to GDS, if present");
    } finally {
      await session.close().catch(() => {});
    }
  }

  async stop(): Promise<void> {
    if (this.driver) {
      await this.driver.close().catch(() => {});
      this.driver = null;
    }
    this.connected = false;
    this.gdsAvailable = false;
    this.gdsVersion = null;
    this.nativeVectorAvailable = false;
    log.info("Neo4jGraphDriver stopped");
  }

  isReady(): boolean {
    return this.connected;
  }

  getStatus(): GraphDriverStatus {
    return {
      slug: this.slug,
      name: this.name,
      kind: this.kind,
      deployment: this.deployment,
      ready: this.connected,
      source: "builtin",
      capabilities: this.capabilities,
      info: {
        uri: this.config?.uri,
        gdsVersion: this.gdsVersion,
      },
      error: this.lastError ?? undefined,
    };
  }

  // ── Operations ────────────────────────────────────────────────────

  async run(cypher: string, params?: Record<string, unknown>): Promise<GraphResult> {
    if (!this.driver || !this.connected) {
      throw new Error("Neo4jGraphDriver: not connected — call start() first");
    }
    const session = this.driver.session();
    try {
      const native = await session.run(cypher, params);
      // neo4j-driver records natively expose keys/get/toObject — structural
      // cast to GraphRecord avoids per-row wrapping.
      return native as unknown as GraphResult;
    } finally {
      await session.close();
    }
  }

  async withSession<T>(fn: (session: GraphSession) => Promise<T>): Promise<T> {
    if (!this.driver || !this.connected) {
      throw new Error("Neo4jGraphDriver: not connected — call start() first");
    }
    const native = this.driver.session();
    try {
      return await fn(adaptSession(native));
    } finally {
      await native.close();
    }
  }
}

// ── Session adapter ──────────────────────────────────────────────────

function adaptSession(native: Session): GraphSession {
  return {
    async run(cypher: string, params?: Record<string, unknown>) {
      const r = await native.run(cypher, params);
      return r as unknown as GraphResult;
    },
    async close() {
      await native.close();
    },
    // commit / rollback intentionally omitted — neo4j-driver auto-commits
    // statements run via Session#run unless you open an explicit transaction.
    // Consumers that need real transactions should add a Tx-aware variant
    // later; today nothing in the kernel uses one.
  };
}
