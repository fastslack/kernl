import type { GraphDriver } from "../core/db-drivers/graph-driver.js";

/**
 * Run `UNWIND $rows AS row …` over `rows` in batches, so one statement never
 * carries an unbounded parameter list. Returns how many rows were sent.
 */
export async function unwindInBatches(
  graph: GraphDriver,
  cypher: string,
  rows: Array<Record<string, unknown>>,
  batchSize = 500,
): Promise<number> {
  for (let i = 0; i < rows.length; i += batchSize) {
    await graph.run(cypher, { rows: rows.slice(i, i + batchSize) });
  }
  return rows.length;
}
