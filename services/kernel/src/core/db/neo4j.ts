import neo4j, { type Driver, type Session } from "neo4j-driver";
import { log } from "../logger.js";

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

export class Neo4jClient {
  private driver: Driver | null = null;
  private _available = false;

  get available(): boolean {
    return this._available;
  }

  async connect(config: Neo4jConfig): Promise<void> {
    try {
      this.driver = neo4j.driver(
        config.uri,
        neo4j.auth.basic(config.user, config.password),
        {
          maxConnectionPoolSize: 50,
          connectionAcquisitionTimeout: 30000,
          maxTransactionRetryTime: 15000,
          connectionTimeout: 10000,
        },
      );
      await this.driver.verifyConnectivity();
      this._available = true;
      log.info(`Neo4j connected: ${config.uri}`);
    } catch (err) {
      this._available = false;
      log.warn("Neo4j unavailable — graph features will be disabled", err);
    }
  }

  session(): Session {
    if (!this.driver || !this._available) {
      throw new Error("Neo4j is not connected");
    }
    return this.driver.session();
  }

  /** Run a single Cypher query in an auto-managed session */
  async run(cypher: string, params?: Record<string, unknown>) {
    const session = this.session();
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }

  /**
   * Run multiple operations sharing a single session.
   * Reduces connection overhead for dashboard queries that make 10+ calls.
   */
  async withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const session = this.session();
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this._available = false;
      log.info("Neo4j closed");
    }
  }
}
