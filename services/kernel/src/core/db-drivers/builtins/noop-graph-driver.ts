/**
 * NoopGraphDriver — the default-active graph backend.
 *
 * Used when the user hasn't (or doesn't want to) configure a real graph
 * database. Reports `cypher=false` and every other capability as `false`,
 * so consumers gating on capabilities skip their graph work entirely.
 *
 * `run()` and `withSession()` throw on call. This is intentional: any code
 * that reaches them has skipped the capability check it owes the registry.
 * Treat the throw as a "you forgot to gate on capabilities" assertion.
 */

import type {
  GraphDriver,
  GraphDriverStatus,
  GraphCapabilities,
  GraphSession,
  GraphResult,
} from "../graph-driver.js";
import type { ConfigField } from "../types.js";

export class NoopGraphDriver implements GraphDriver {
  readonly slug = "noop";
  readonly name = "None (graph features disabled)";
  readonly kind = "graph" as const;
  readonly deployment = "embedded" as const;

  readonly capabilities: GraphCapabilities = {
    cypher: false,
    gds: false,
    vectorSimilarity: false,
    mlPipelines: false,
    embedded: true,
    parameterised: false,
    transactions: false,
  };

  private started = false;

  getConfigSchema(): ConfigField[] {
    return [];
  }

  validateConfig(): { valid: boolean; errors?: string[] } {
    return { valid: true };
  }

  configure(): void {
    // Nothing to configure — this is the off-switch driver.
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  isReady(): boolean {
    // Reports ready when started — the registry's `getActive()` will return
    // this driver and consumers gate on capabilities (all false) to skip.
    return this.started;
  }

  getStatus(): GraphDriverStatus {
    return {
      slug: this.slug,
      name: this.name,
      kind: this.kind,
      deployment: this.deployment,
      ready: this.started,
      source: "builtin",
      capabilities: this.capabilities,
      info: { reason: "Graph backend disabled — enable Neo4j or Kùzu in /extensions" },
    };
  }

  async run(): Promise<GraphResult> {
    throw new Error(
      "NoopGraphDriver.run() called — caller skipped capabilities check. Gate on `driver.capabilities.cypher` before issuing queries.",
    );
  }

  async withSession<T>(_fn: (session: GraphSession) => Promise<T>): Promise<T> {
    throw new Error(
      "NoopGraphDriver.withSession() called — caller skipped capabilities check. Gate on `driver.capabilities.transactions` before opening a session.",
    );
  }
}
