/**
 * Built-in db-driver registration helpers.
 *
 * One call site (`registerBuiltinGraphDrivers(registry)`) wires every
 * compiled-in graph backend into a `GraphDriverRegistry`. Bootstrap calls
 * this once after creating the registry and before `seedBuiltinRows()` so
 * the seeded rows reference real factories.
 *
 * Registration order matters: the first built-in seeded becomes
 * `status='active'` if no active row already exists. We register `noop`
 * first so a fresh install boots into "graph features off" — the user
 * explicitly opts in to Neo4j (or Kùzu, eventually) from /extensions.
 */

import type { GraphDriverRegistry } from "../graph-driver-registry.js";
import { NoopGraphDriver } from "./noop-graph-driver.js";
import { Neo4jGraphDriver } from "./neo4j-graph-driver.js";

export { NoopGraphDriver } from "./noop-graph-driver.js";
export { Neo4jGraphDriver } from "./neo4j-graph-driver.js";

/**
 * Register every built-in graph driver with the supplied registry. Safe to
 * call multiple times — `registerFactory` overwrites existing entries.
 */
export function registerBuiltinGraphDrivers(registry: GraphDriverRegistry): void {
  registry.registerFactory("noop", () => new NoopGraphDriver(), "builtin");
  registry.registerFactory("neo4j", () => new Neo4jGraphDriver(), "builtin");
}
