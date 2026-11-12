import type { GraphDriver } from "../core/db-drivers/graph-driver.js";

/** What a step of graph work needs: the driver itself, or a transaction. */
export type GraphRunner = Pick<GraphDriver, "run">;

/**
 * Run `fn` as one transaction when the driver has them (all of its writes
 * commit, or none does), else straight on the driver as before. `fn` must
 * talk to the graph only through its argument and be safe to run again: a
 * driver may retry it whole after a write-write conflict.
 */
export function inGraphTransaction<T>(graph: GraphDriver, fn: (tx: GraphRunner) => Promise<T>): Promise<T> {
  return graph.withTransaction ? graph.withTransaction(fn) : fn(graph);
}

/**
 * Run `UNWIND $rows AS row …` over `rows` in batches, so one statement never
 * carries an unbounded parameter list. Returns how many rows were sent.
 */
export async function unwindInBatches(
  graph: GraphRunner,
  cypher: string,
  rows: Array<Record<string, unknown>>,
  batchSize = 500,
): Promise<number> {
  for (let i = 0; i < rows.length; i += batchSize) {
    await graph.run(cypher, { rows: rows.slice(i, i + batchSize) });
  }
  return rows.length;
}
