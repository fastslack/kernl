import type { GraphDriver } from "../core/db-drivers/graph-driver.js";
import type { GraphRunner } from "./graph-batch.js";

/**
 * Embeddings in the graph, written once for both kinds of engine.
 *
 * Where the driver reports `vectorSearch` (Relate, Cypher 25) an embedding is
 * stored as a `VECTOR<FLOAT32>` rather than a list of floats — searched 2–3×
 * faster — and a vector index can carry filter properties, so the `SEARCH`
 * clause filters *inside* the index: "the 10 nearest chat memories" instead of
 * "the 10 nearest memories, minus those that are not chat", which comes back
 * empty when the nearest ten happen to be something else. Elsewhere the same
 * calls fall back to lists and `db.index.vector.queryNodes`, as before.
 */

export function hasVectorSearch(graph: Pick<GraphDriver, "capabilities">): boolean {
  return graph.capabilities.vectorSearch === true;
}

/**
 * The Cypher expression to store `expr` (a list of floats, or null) as an
 * embedding. An empty list becomes null: a vector has at least one dimension.
 */
export function asVector(graph: Pick<GraphDriver, "capabilities">, expr: string): string {
  if (!hasVectorSearch(graph)) return expr;
  return `CASE WHEN ${expr} IS NULL OR size(${expr}) = 0 THEN null ELSE vector(${expr}, size(${expr}), FLOAT32) END`;
}

export interface VectorIndexSpec {
  name: string;
  label: string;
  dimensions: number;
  /** Defaults to `embedding`. */
  property?: string;
  /** Properties a search may filter on inside the index (`vectorSearch` only). */
  filters?: string[];
}

const ident = (s: string) => "`" + s.replace(/`/g, "``") + "`";

/**
 * Create the index, and on an engine with `vectorSearch`: rebuild it when its
 * filter properties changed, and turn embeddings stored as lists (by an older
 * Kernl, or copied from Neo4j) into vectors, a batch at a time.
 */
export async function ensureVectorIndex(graph: GraphDriver, spec: VectorIndexSpec): Promise<void> {
  if (!graph.capabilities.vectorSimilarity) return;
  const prop = spec.property ?? "embedding";
  const filters = hasVectorSearch(graph) ? spec.filters ?? [] : [];
  if (hasVectorSearch(graph)) {
    const r = await graph.run(
      "SHOW VECTOR INDEXES YIELD name, properties WHERE name = $name RETURN properties",
      { name: spec.name },
    );
    const have = r.records[0]?.get("properties") as string[] | undefined;
    const want = [prop, ...filters];
    if (have && (have.length !== want.length || have.some((p, i) => p !== want[i]))) {
      await graph.run(`DROP INDEX ${ident(spec.name)} IF EXISTS`);
    }
  }
  const withClause = filters.length ? ` WITH [${filters.map((f) => `n.${ident(f)}`).join(", ")}]` : "";
  await graph.run(
    `CREATE VECTOR INDEX ${ident(spec.name)} IF NOT EXISTS
     FOR (n:${ident(spec.label)}) ON (n.${ident(prop)})${withClause}
     OPTIONS { indexConfig: {
       \`vector.dimensions\`: ${Math.trunc(spec.dimensions)},
       \`vector.similarity_function\`: 'cosine'
     }}`,
  );
  if (hasVectorSearch(graph)) await convertListEmbeddings(graph, spec.label, prop);
}

/** Rewrite list-typed embeddings of `label` as vectors. Returns how many. */
export async function convertListEmbeddings(graph: GraphRunner & Pick<GraphDriver, "capabilities">, label: string, property = "embedding", batch = 500): Promise<number> {
  const p = `n.${ident(property)}`;
  let total = 0;
  for (;;) {
    const r = await graph.run(
      `MATCH (n:${ident(label)}) WHERE ${p} IS :: LIST<INTEGER | FLOAT> NOT NULL
       WITH n LIMIT ${Math.trunc(batch)}
       SET ${p} = ${asVector(graph, p)}
       RETURN count(n) AS c`,
    );
    const c = Number(r.records[0]?.get("c") ?? 0);
    total += c;
    if (c < batch) return total;
  }
}

export interface VectorSearchSpec {
  index: string;
  label: string;
  /** Variable the matched node is bound to; the score is bound to `score`. */
  alias: string;
  /** Cypher expressions, usually parameters: `$k`, `$vector`. */
  k: string;
  vector: string;
  /**
   * Equality filters (`property → expression`). Inside the index where the
   * engine can, so `k` counts only matching nodes; else applied afterwards.
   * Every property here must be among the index's `filters`.
   */
  filters?: Record<string, string>;
  /** Any further predicate, applied to the `k` results. */
  where?: string;
}

/**
 * The opening clauses of a nearest-neighbour query, binding `alias` and
 * `score` (cosine on 0–1, 0.5 for orthogonal vectors, on both paths).
 */
export function vectorSearchClause(graph: Pick<GraphDriver, "capabilities">, s: VectorSearchSpec): string {
  const a = s.alias;
  const eq = Object.entries(s.filters ?? {}).map(([prop, expr]) => `${a}.${ident(prop)} = ${expr}`);
  if (hasVectorSearch(graph)) {
    const inner = eq.length ? ` WHERE ${eq.join(" AND ")}` : "";
    return (
      `MATCH (${a}:${ident(s.label)}) SEARCH ${a} IN (VECTOR INDEX ${ident(s.index)} FOR ${s.vector}${inner} LIMIT ${s.k}) SCORE AS score` +
      (s.where ? ` WHERE ${s.where}` : "")
    );
  }
  const preds = s.where ? [...eq, `(${s.where})`] : eq;
  return (
    `CALL db.index.vector.queryNodes('${s.index.replace(/'/g, "\\'")}', ${s.k}, ${s.vector}) YIELD node AS ${a}, score` +
    (preds.length ? ` WHERE ${preds.join(" AND ")}` : "")
  );
}

export function hasFulltextSearch(graph: Pick<GraphDriver, "capabilities">): boolean {
  return graph.capabilities.fulltextSearch === true;
}

export interface FulltextSearchSpec {
  /** Variable bound to each hit. */
  alias: string;
  /** The full-text index's name (a literal: SEARCH takes no parameter here). */
  index: string;
  /** Cypher expression for the query text, usually a parameter: `$q`. */
  query: string;
  /** Hits taken from the index, before any WHERE that follows. */
  k: number;
  /** The label every hit carries, when the index covers one. */
  label?: string;
}

/**
 * The opening clauses of a full-text query, binding `alias` and `score`:
 * Relate's `SEARCH … IN (FULLTEXT INDEX …)` where the engine has it, the
 * `db.index.fulltext.queryNodes` procedure elsewhere (Neo4j). A WHERE may
 * follow either form. On Relate the index yields `k` hits before that WHERE.
 */
export function fulltextSearchClause(graph: Pick<GraphDriver, "capabilities">, s: FulltextSearchSpec): string {
  const a = s.alias;
  if (hasFulltextSearch(graph)) {
    return `MATCH (${a}${s.label ? `:${ident(s.label)}` : ""}) SEARCH ${a} IN (FULLTEXT INDEX ${ident(s.index)} FOR ${s.query} LIMIT ${Math.max(1, Math.floor(s.k))}) SCORE AS score`;
  }
  return `CALL db.index.fulltext.queryNodes('${s.index.replace(/'/g, "\\'")}', ${s.query}) YIELD node AS ${a}, score`;
}

/**
 * Run the query `build` makes around a nearest-neighbour clause. When the
 * index lacks a filter property — built by an older Kernl, copied from Neo4j,
 * or not yet rebuilt by its owner — the engine rejects SEARCH; ask again the
 * way an engine without it would, so a search degrades instead of failing.
 */
export async function runVectorSearch(
  graph: GraphDriver,
  spec: VectorSearchSpec,
  build: (clause: string) => string,
  params: Record<string, unknown>,
): ReturnType<GraphDriver["run"]> {
  try {
    return await graph.run(build(vectorSearchClause(graph, spec)), params);
  } catch (err) {
    if (!hasVectorSearch(graph) || !/WrongPropertyForVectorSearchFilter/.test(String(err))) throw err;
    const plain = { capabilities: { ...graph.capabilities, vectorSearch: false } };
    return graph.run(build(vectorSearchClause(plain, spec)), params);
  }
}
