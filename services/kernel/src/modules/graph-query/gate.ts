/**
 * Read-only gate for Cypher written by agents.
 *
 * Two layers, both required:
 *   1. `staticGate` — the text: no writing clause, no procedure outside a
 *      short allow list, no unbounded variable-length path. Strings and
 *      comments are blanked first so their contents cannot trip or dodge it.
 *   2. `planGate` — the planner's own reading (EXPLAIN): no operator that
 *      writes, and no cartesian product. Catches anything the text check
 *      misses, on whichever engine is active.
 */

const WRITE_CLAUSES =
  /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|LOAD\s+CSV|IN\s+TRANSACTIONS|ALTER|GRANT|DENY|REVOKE|TERMINATE|USE)\b/i;
const ALLOWED_PROCEDURES = [
  /^db\.labels$/i,
  /^db\.relationshipTypes$/i,
  /^db\.propertyKeys$/i,
  /^db\.schema\.(nodeTypeProperties|relTypeProperties|visualization)$/i,
  /^db\.index\.(vector|fulltext)\.queryNodes$/i,
];
/** Words that name a writing operator in either engine's plan (SetProperty, LockingMerge, DetachDelete…). */
const WRITE_WORDS = new Set(["create", "merge", "set", "delete", "remove", "foreach", "load"]);
const writes = (operator: string) =>
  (operator.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []).some((w) => WRITE_WORDS.has(w.toLowerCase()));
export const MAX_HOPS = 6;

/** The query with string literals and comments replaced by blanks of the same length. */
export function blankLiterals(cypher: string): string {
  return cypher.replace(
    /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m) => (m.startsWith("`") ? m : " ".repeat(m.length)),
  );
}

export function staticGate(cypher: string): string | null {
  const text = blankLiterals(cypher.trim());
  if (!text) return "Empty query.";
  if (/^\s*(EXPLAIN|PROFILE)\b/i.test(text)) return "Leave out EXPLAIN/PROFILE; the query is planned for you.";
  const w = WRITE_CLAUSES.exec(text);
  if (w) return `Read-only: \`${w[1].toUpperCase()}\` is not allowed. Use MATCH … RETURN.`;
  if (/\b(apoc|gds|dbms|tx)\./i.test(text)) return "Only the db.* read procedures are allowed (no apoc, gds or dbms).";
  for (const m of text.matchAll(/\bCALL\s+([A-Za-z_][\w.]*)\s*\(/gi)) {
    if (!ALLOWED_PROCEDURES.some((re) => re.test(m[1]))) {
      return `Procedure ${m[1]} is not allowed. Allowed: db.labels, db.relationshipTypes, db.propertyKeys, db.schema.*, db.index.vector.queryNodes, db.index.fulltext.queryNodes.`;
    }
  }
  // Variable-length relationships need an upper bound: [*..3], [:KNOWS*1..2].
  for (const m of text.matchAll(/\[[^\]]*?\*\s*(\d*)\s*(\.\.\s*(\d*))?[^\]]*\]/g)) {
    const [, exact, range, max] = m;
    const upper = range ? (max ? Number(max) : Infinity) : exact ? Number(exact) : Infinity;
    if (upper > MAX_HOPS) return `Variable-length paths need an upper bound of at most ${MAX_HOPS} hops, e.g. [:KNOWS*1..3].`;
  }
  // Quantified path patterns: ((a)-->(b)){1,3} or +/*.
  for (const m of text.matchAll(/\)\s*(\{\s*(\d*)\s*,\s*(\d*)\s*\}|[+*])/g)) {
    if (m[1] === "+" || m[1] === "*" || !m[3] || Number(m[3]) > MAX_HOPS) {
      return `Quantified paths need an upper bound of at most ${MAX_HOPS}, e.g. {1,3}.`;
    }
  }
  return null;
}

export interface PlanReading {
  operators: string[];
  warnings: Array<{ code: string; description: string; remedy?: string }>;
}

/** Operators and warnings from either engine's plan, plus top-level notifications. */
export function readPlan(plan: unknown, notifications: unknown[] = []): PlanReading {
  const operators: string[] = [];
  const warnings: PlanReading["warnings"] = [];
  const addWarning = (w: Record<string, unknown>) => {
    const code = String(w.code ?? w.title ?? "");
    if (!code || warnings.some((x) => x.code === code)) return;
    warnings.push({ code, description: String(w.description ?? w.title ?? ""), remedy: w.remedy ? String(w.remedy) : undefined });
  };
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as Record<string, unknown>;
    const op = node.operator ?? node.operatorType;
    if (typeof op === "string") operators.push(op.replace(/@.*$/, ""));
    for (const w of (node.warnings as Array<Record<string, unknown>> | undefined) ?? []) addWarning(w);
    for (const c of (node.children as unknown[] | undefined) ?? []) walk(c);
  };
  const p = plan as Record<string, unknown> | null;
  walk(p && "root" in p ? p.root : p);
  for (const n of notifications) if (n && typeof n === "object") addWarning(n as Record<string, unknown>);
  return { operators, warnings };
}

export function planGate(reading: PlanReading): string | null {
  const writer = reading.operators.find(writes);
  if (writer) return `Read-only: the plan writes (${writer}).`;
  const cartesian = reading.warnings.find((w) => /CartesianProduct/i.test(w.code));
  if (cartesian) {
    return `The patterns are not connected, so every pair would be compared (cartesian product). ${cartesian.remedy ?? "Join them through a shared variable or a relationship."}`;
  }
  return null;
}
