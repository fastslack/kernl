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
 * explicitly opts in to Relate (embedded) or Neo4j from /extensions.
 *
 * Among drivers that report `canSelfConfigure()`, registration order breaks
 * the tie, so `relate` comes before `neo4j`: an explicit `RELATE_DATABASE`
 * wins over a `NEO4J_*` block the stack may still carry.
 */

import type { GraphDriverRegistry } from "../graph-driver-registry.js";
import { NoopGraphDriver } from "./noop-graph-driver.js";
import { Neo4jGraphDriver } from "./neo4j-graph-driver.js";
import { RelateGraphDriver } from "./relate-graph-driver.js";

export { NoopGraphDriver } from "./noop-graph-driver.js";
export { Neo4jGraphDriver } from "./neo4j-graph-driver.js";
export { RelateGraphDriver } from "./relate-graph-driver.js";

/**
 * Register every built-in graph driver with the supplied registry. Safe to
 * call multiple times — `registerFactory` overwrites existing entries.
 */
export function registerBuiltinGraphDrivers(registry: GraphDriverRegistry): void {
  registry.registerFactory("noop", () => new NoopGraphDriver(), "builtin");
  registry.registerFactory("relate", () => new RelateGraphDriver(), "builtin");
  registry.registerFactory("neo4j", () => new Neo4jGraphDriver(), "builtin");
}
