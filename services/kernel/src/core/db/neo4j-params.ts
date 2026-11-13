import neo4j from "neo4j-driver";

const PAGING = /\b(?:LIMIT|SKIP|OFFSET)\s+\$([A-Za-z_][A-Za-z0-9_]*)/gi;

/**
 * Neo4j wants an integer after LIMIT and SKIP, and the JavaScript driver sends
 * every number as a float: `LIMIT $n` with n = 5000 fails with "'5000.0' is
 * not a valid value". Relate takes it either way, so the same Cypher broke only
 * on Neo4j. The parameters a statement pages with are sent as integers here;
 * every other number is left as it was (a stored property keeps its type).
 */
export function integerPagingParams(cypher: string, params?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!params) return params;
  let out: Record<string, unknown> | undefined;
  for (const m of cypher.matchAll(PAGING)) {
    const name = m[1];
    const v = params[name];
    if (typeof v === "number" && Number.isFinite(v)) {
      out ??= { ...params };
      out[name] = neo4j.int(Math.trunc(v));
    }
  }
  return out ?? params;
}
