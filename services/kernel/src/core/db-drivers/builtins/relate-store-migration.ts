/**
 * Copy a Relate store into a new one — in practice, the single-file `.rl`
 * store earlier versions used into the directory store used now.
 *
 * Why the move: a `.rl` file is held exclusively by its writer (nothing else
 * can even read it while the kernel runs, so no live backup or inspection)
 * and it never shrinks. A directory store can be read and cloned beside its
 * writer, and its checkpoints rewrite only the shards that changed.
 *
 * The Node client has no `clone`, so this copies through Cypher: the source
 * opens read-only (no lock, no migration of the old file), nodes and then
 * relationships are copied in batches through a temporary key, and the
 * schema follows from SHOW CONSTRAINTS / SHOW INDEXES. Counts are checked at
 * the end; a mismatch throws and the caller keeps the old store.
 *
 * Run it in a child process when it is a one-off (see
 * `runRelateStoreMigrationTask`): the client cannot close a store, so an
 * in-process copy would hold both stores' memory and locks until exit.
 */

import type { RelateModule, RelateConnection } from "./relate-graph-driver.js";

export interface StoreMigrationResult {
  nodes: number;
  relationships: number;
  schema: number;
  schemaSkipped: number;
  ms: number;
}

const TEMP_LABEL = "__KernlMig";
const TEMP_KEY = "__kernl_mig";
const TEMP_INDEX = "kernl_store_migration";
/** Rows per write: small enough that one commit's WAL record stays far under 64 MiB with embeddings. */
const NODE_BATCH = 500;
const REL_BATCH = 2_000;

async function count(conn: RelateConnection, cypher: string): Promise<number> {
  const r = await conn.queryAsync(cypher);
  return Number(r.rows?.[0]?.n ?? 0);
}

export async function migrateRelateStore(
  mod: RelateModule,
  fromPath: string,
  toPath: string,
  log: (msg: string) => void = () => {},
): Promise<StoreMigrationResult> {
  const t0 = Date.now();
  const src = mod.Database.open(fromPath, { readOnly: true }).connect();
  const dstDb = mod.Database.open(toPath);
  const dst = dstDb.connect();

  const totalNodes = await count(src, "MATCH (n) RETURN count(n) AS n");
  const totalRels = await count(src, "MATCH ()-[r]->() RETURN count(r) AS n");
  log(`copying ${totalNodes} nodes and ${totalRels} relationships from ${fromPath}`);

  await dst.queryAsync(`CREATE INDEX ${TEMP_INDEX} IF NOT EXISTS FOR (n:${TEMP_LABEL}) ON (n.${TEMP_KEY})`);

  // One read per kind, then batched writes. Paging the source with ORDER BY …
  // SKIP re-sorts the whole graph on every page — minutes on a mid-sized
  // store — while one full read takes well under a second, and the graph is
  // already resident in memory anyway.
  const nodes = (await src.queryAsync(
    "MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props",
  )).rows ?? [];
  let copied = 0;
  for (let i = 0; i < nodes.length; i += NODE_BATCH) {
    const rows = nodes.slice(i, i + NODE_BATCH);
    // Keyed by their source element id while relationships are wired.
    await dst.queryAsync(
      `UNWIND $rows AS r
       CREATE (n:${TEMP_LABEL})
       SET n = r.props
       SET n.${TEMP_KEY} = r.id
       WITH n, r WHERE size(r.labels) > 0
       SET n:$(r.labels)`,
      { rows },
    );
    copied += rows.length;
  }
  nodes.length = 0;

  // Relationships, matched to their copied endpoints through the temporary key.
  const rels = (await src.queryAsync(
    `MATCH (a)-[r]->(b)
     RETURN elementId(a) AS a, elementId(b) AS b, type(r) AS t, properties(r) AS p`,
  )).rows ?? [];
  let wired = 0;
  for (let i = 0; i < rels.length; i += REL_BATCH) {
    const rows = rels.slice(i, i + REL_BATCH);
    await dst.queryAsync(
      `UNWIND $rows AS r
       MATCH (a:${TEMP_LABEL} {${TEMP_KEY}: r.a})
       MATCH (b:${TEMP_LABEL} {${TEMP_KEY}: r.b})
       CREATE (a)-[x:$(r.t)]->(b)
       SET x = r.p`,
      { rows },
    );
    wired += rows.length;
  }
  rels.length = 0;

  // Drop the temporary key and label, in bounded steps.
  for (;;) {
    const r = await dst.queryAsync(
      `MATCH (n:${TEMP_LABEL}) WITH n LIMIT 5000
       REMOVE n:${TEMP_LABEL}, n.${TEMP_KEY}
       RETURN count(n) AS n`,
    );
    if (Number(r.rows?.[0]?.n ?? 0) === 0) break;
  }
  await dst.queryAsync(`DROP INDEX ${TEMP_INDEX} IF EXISTS`);

  // Schema: constraints first (they bring their own backing indexes), then
  // the remaining indexes. A statement the new store already satisfies is skipped.
  let schema = 0;
  let schemaSkipped = 0;
  const statements: string[] = [];
  const constraints = await src.queryAsync("SHOW CONSTRAINTS YIELD createStatement RETURN createStatement");
  for (const r of constraints.rows ?? []) if (r.createStatement) statements.push(String(r.createStatement));
  const indexes = await src.queryAsync("SHOW INDEXES YIELD name, type, createStatement RETURN name, type, createStatement");
  for (const r of indexes.rows ?? []) {
    if (r.type === "LOOKUP" || !r.createStatement || r.name === TEMP_INDEX) continue;
    statements.push(String(r.createStatement));
  }
  for (const s of statements) {
    try {
      await dst.queryAsync(s);
      schema++;
    } catch {
      schemaSkipped++;
    }
  }

  const gotNodes = await count(dst, "MATCH (n) RETURN count(n) AS n");
  const gotRels = await count(dst, "MATCH ()-[r]->() RETURN count(r) AS n");
  if (gotNodes !== totalNodes || gotRels !== totalRels || copied !== totalNodes || wired !== totalRels) {
    throw new Error(
      `store migration incomplete: nodes ${gotNodes}/${totalNodes}, relationships ${gotRels}/${totalRels}`,
    );
  }
  dstDb.checkpoint();
  return { nodes: gotNodes, relationships: gotRels, schema, schemaSkipped, ms: Date.now() - t0 };
}
