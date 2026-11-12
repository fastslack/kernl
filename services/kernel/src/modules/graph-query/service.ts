/**
 * Read-only graph queries for agents — in Cypher, or asked in plain words.
 *
 * `schema()` describes the graph (labels with counts, how they connect,
 * their properties, the search indexes). `query()` runs a read-only
 * statement after three checks — the text (gate.ts), the planner's EXPLAIN
 * (no writing operator, no cartesian product) and the names it uses against
 * the schema, with "did you mean" hints — so a wrong query comes back with
 * what to fix instead of an empty answer. `ask()` turns a question into
 * Cypher through the LLM driver and corrects it from those same errors.
 *
 * The embedded engine cannot cancel a running query. A query that outlives
 * its timeout keeps running in the background; until it ends, new queries
 * are refused rather than piled on top of it.
 */

import type { GraphDriver, GraphResult } from "../../core/db-drivers/graph-driver.js";
import { log } from "../../core/logger.js";
import { blankLiterals, planGate, readPlan, staticGate } from "./gate.js";
import { type ClientPolicy, clientGate, filterSchema, redactRows } from "./privacy.js";

export interface GraphSchema {
  labels: Array<{ label: string; count: number; properties: string[] }>;
  relationships: Array<{ from: string; type: string; to: string; count: number }>;
  indexes: Array<{ name: string; type: string; labels: string[]; properties: string[] }>;
  at: number;
}

export interface QueryOutcome {
  ok: boolean;
  rows?: Array<Record<string, unknown>>;
  truncated?: boolean;
  ms?: number;
  error?: string;
  /** Planner warnings and schema hints worth reading even when it worked. */
  hints?: string[];
}

const SCHEMA_TTL_MS = 5 * 60_000;
/** Labels the kernel keeps for its own bookkeeping. */
const INTERNAL = /^(KernlGraphBackfill|AgentXpSync|__KernlMig)$/;

export class GraphQueryService {
  private cached: GraphSchema | null = null;
  private busy: Promise<unknown> | null = null;

  constructor(private getGraph: () => GraphDriver | null) {}

  private graph(): GraphDriver {
    const g = this.getGraph();
    if (!g?.capabilities.cypher) throw new Error("The graph is off.");
    return g;
  }

  async schema(fresh = false): Promise<GraphSchema> {
    if (!fresh && this.cached && Date.now() - this.cached.at < SCHEMA_TTL_MS) return this.cached;
    const g = this.graph();
    const labels = (await g.run("CALL db.labels() YIELD label RETURN label")).records
      .map((r) => String(r.get("label")))
      .filter((l) => !INTERNAL.test(l));
    const props = new Map<string, Set<string>>();
    try {
      const r = await g.run("CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName RETURN nodeLabels, propertyName");
      for (const rec of r.records) {
        const name = rec.get("propertyName");
        if (!name) continue;
        for (const l of (rec.get("nodeLabels") as string[]) ?? []) props.set(l, (props.get(l) ?? new Set()).add(String(name)));
      }
    } catch {
      /* properties are a nicety */
    }
    const out: GraphSchema = { labels: [], relationships: [], indexes: [], at: Date.now() };
    for (const label of labels) {
      const n = Number((await g.run(`MATCH (n:\`${label.replace(/`/g, "")}\`) RETURN count(n) AS n`)).records[0]?.get("n") ?? 0);
      out.labels.push({ label, count: n, properties: [...(props.get(label) ?? [])].sort() });
    }
    out.labels.sort((a, b) => b.count - a.count);
    const rels = await g.run(
      `MATCH (a)-[r]->(b)
       RETURN labels(a)[0] AS from, type(r) AS type, labels(b)[0] AS to, count(*) AS n
       ORDER BY n DESC LIMIT 200`,
    );
    out.relationships = rels.records
      .map((r) => ({ from: String(r.get("from")), type: String(r.get("type")), to: String(r.get("to")), count: Number(r.get("n")) }))
      .filter((r) => !INTERNAL.test(r.from) && !INTERNAL.test(r.to));
    try {
      const idx = await g.run("SHOW INDEXES YIELD name, type, labelsOrTypes, properties RETURN name, type, labelsOrTypes, properties");
      out.indexes = idx.records
        .map((r) => ({
          name: String(r.get("name")),
          type: String(r.get("type")),
          labels: (r.get("labelsOrTypes") as string[]) ?? [],
          properties: (r.get("properties") as string[]) ?? [],
        }))
        .filter((i) => i.type === "VECTOR" || i.type === "FULLTEXT");
    } catch {
      /* not every engine lists them */
    }
    this.cached = out;
    return out;
  }

  /** Short text form of the schema, for a prompt. */
  async schemaText(policy?: ClientPolicy): Promise<string> {
    const s = policy ? filterSchema(await this.schema(), policy) : await this.schema();
    const lines = ["Node labels (count: properties):"];
    for (const l of s.labels) lines.push(`  :${l.label} (${l.count}): ${l.properties.filter((p) => p !== "embedding").join(", ")}`);
    lines.push("Relationships:");
    for (const r of s.relationships) lines.push(`  (:${r.from})-[:${r.type}]->(:${r.to})  ×${r.count}`);
    if (s.indexes.length) {
      lines.push("Search indexes:");
      for (const i of s.indexes) {
        const how = i.type === "VECTOR"
          ? `CALL db.index.vector.queryNodes('${i.name}', 10, $vector) YIELD node, score`
          : `CALL db.index.fulltext.queryNodes('${i.name}', 'some words') YIELD node, score`;
        lines.push(`  ${i.name}: ${i.type} on ${i.labels.join("|")}(${i.properties.join(", ")}) — ${how}`);
      }
    }
    return lines.join("\n");
  }

  /** Names in the query that the graph does not have, with the nearest it does. */
  async nameProblems(cypher: string): Promise<string[]> {
    const s = await this.schema();
    const text = blankLiterals(cypher);
    const labels = s.labels.map((l) => l.label);
    const types = [...new Set(s.relationships.map((r) => r.type))];
    const problems: string[] = [];
    for (const m of text.matchAll(/\(\s*\w*\s*((?::\s*`?[A-Za-z_]\w*`?\s*[|&]?\s*)+)/g)) {
      for (const name of m[1].split(/[:|&\s`]+/).filter(Boolean)) {
        if (!labels.includes(name)) problems.push(`No node has the label :${name}.${didYouMean(name, labels)}`);
      }
    }
    for (const m of text.matchAll(/\[\s*\w*\s*:\s*((?:`?[A-Za-z_]\w*`?\s*\|?\s*)+)/g)) {
      for (const name of m[1].split(/[|\s`*]+/).filter((x) => x && !/^\d/.test(x))) {
        if (!types.includes(name)) problems.push(`No relationship has the type :${name}.${didYouMean(name, types)}`);
      }
    }
    return [...new Set(problems)];
  }

  /** Check a statement without running it: null when it may run. */
  async validate(cypher: string): Promise<{ error: string | null; hints: string[] }> {
    const gate = staticGate(cypher);
    if (gate) return { error: gate, hints: [] };
    const names = await this.nameProblems(cypher);
    if (names.length) return { error: names.join(" "), hints: [] };
    let plan: GraphResult;
    try {
      plan = await this.graph().run(`EXPLAIN ${cypher}`);
    } catch (err) {
      return { error: `The query does not parse: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, hints: [] };
    }
    const reading = readPlan(plan.summary?.plan, plan.summary?.notifications ?? []);
    if (!reading.operators.length) {
      // No plan to inspect: only the text check stands, so refuse rather than guess.
      return { error: "The engine returned no plan for this query, so it cannot be checked as read-only.", hints: [] };
    }
    const bad = planGate(reading);
    return { error: bad, hints: reading.warnings.map((w) => `${w.description}${w.remedy ? ` — ${w.remedy}` : ""}`) };
  }

  /** Extra checks for an outside MCP client (privacy.ts): its access level, private labels, and indexes that cover them. */
  async clientCheck(cypher: string, policy: ClientPolicy): Promise<string | null> {
    const bad = clientGate(cypher, policy);
    if (bad) return bad;
    if (!policy.privateLabels.size) return null;
    const s = await this.schema();
    for (const m of blankLiterals(cypher).matchAll(/\bCALL\s+db\.index\.(?:vector|fulltext)\.queryNodes\s*\(/gi)) {
      // From the original text: in the blanked one the literal is spaces.
      const lit = cypher.slice(m.index! + m[0].length).trimStart().match(/^(['"])(.*?)\1/);
      if (!lit) return "MCP clients must name the search index as a literal.";
      const idx = s.indexes.find((i) => i.name === lit[2]);
      if (idx && idx.labels.some((l) => policy.privateLabels.has(l))) {
        return `The index ${idx.name} covers private labels; MCP clients cannot search it.`;
      }
    }
    return null;
  }

  async query(cypher: string, opts: { params?: Record<string, unknown>; limit?: number; timeoutMs?: number; raw?: boolean; policy?: ClientPolicy } = {}): Promise<QueryOutcome> {
    if (this.busy) return { ok: false, error: "The graph is still running an earlier query that ran out of time. Try again shortly with a narrower query." };
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const statement = cypher.trim().replace(/;\s*$/, "");
    if (opts.policy) {
      const refused = await this.clientCheck(statement, opts.policy).catch((e: Error) => e.message);
      if (refused) return { ok: false, error: refused };
    }
    let checked: Awaited<ReturnType<GraphQueryService["validate"]>>;
    try {
      checked = await this.validate(statement);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (checked.error) return { ok: false, error: checked.error, hints: checked.hints };

    // Cap the rows the engine produces, not only the ones returned.
    // A bare procedure call (no RETURN) cannot sit in a subquery; its rows are sliced after.
    const blank = blankLiterals(statement);
    const wrap = /\bRETURN\b/i.test(blank) && !/\bLIMIT\s+\d+\s*$/i.test(blank);
    const run = wrap ? `CALL () { ${statement} } RETURN * LIMIT ${limit + 1}` : statement;
    const t0 = Date.now();
    const exec = this.graph().run(run, opts.params ?? {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), opts.timeoutMs ?? 8000); });
    try {
      const r = await Promise.race([exec, timeout]);
      if (r === "timeout") {
        this.busy = exec.catch(() => {}).finally(() => { this.busy = null; });
        log.warn(`graph query ran out of time: ${statement.slice(0, 200)}`);
        return { ok: false, error: "The query ran out of time. Narrow it: start from an indexed property or a search index, add a LIMIT, use fewer hops." };
      }
      // `raw` keeps the driver's values (nodes with their element ids) for callers that copy them.
      let rows = r.records.map((rec) => (opts.raw ? rec.toObject() : plain(rec.toObject())) as Record<string, unknown>);
      let redacted = 0;
      if (opts.policy) ({ rows, redacted } = redactRows(rows, opts.policy));
      return {
        ok: true,
        rows: rows.slice(0, limit),
        truncated: rows.length > limit || undefined,
        ms: Date.now() - t0,
        hints: redacted
          ? [...checked.hints, `${redacted} private node(s) left out.`]
          : checked.hints.length ? checked.hints : rows.length === 0 ? ["No rows. Check the property names and values against the schema."] : undefined,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err), hints: checked.hints };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A question in plain words → Cypher → rows, correcting the query from its errors. */
  async ask(
    question: string,
    complete: (system: string, user: string) => Promise<string>,
    opts: { limit?: number; attempts?: number; policy?: ClientPolicy } = {},
  ): Promise<QueryOutcome & { question: string; cypher?: string; attempts: number }> {
    const system = [
      "You translate questions about a personal knowledge graph into ONE read-only Cypher query.",
      "Rules: only MATCH/OPTIONAL MATCH/WITH/WHERE/RETURN/ORDER BY/LIMIT/UNWIND/CALL of the listed search indexes;",
      "never write; use only the labels, relationship types and properties below; join patterns through shared",
      "variables; bound variable-length paths (e.g. *1..3); return readable properties, not whole nodes; add a LIMIT.",
      'Answer with JSON only: {"cypher": "..."}',
      "",
      await this.schemaText(opts.policy),
    ].join("\n");
    let user = `Question: ${question}`;
    const max = Math.max(1, Math.min(opts.attempts ?? 3, 5));
    let last: QueryOutcome = { ok: false, error: "no attempt" };
    let cypher: string | undefined;
    for (let attempt = 1; attempt <= max; attempt++) {
      const text = await complete(system, user);
      cypher = extractCypher(text);
      if (!cypher) {
        last = { ok: false, error: "The model did not return a query." };
      } else {
        last = await this.query(cypher, { limit: opts.limit, policy: opts.policy });
        if (last.ok) return { ...last, question, cypher, attempts: attempt };
      }
      user = `Question: ${question}\n\nYour previous query:\n${cypher ?? "(none)"}\n\nIt failed: ${last.error}${
        last.hints?.length ? `\nHints: ${last.hints.join(" ")}` : ""}\n\nReturn a corrected query.`;
    }
    return { ...last, question, cypher, attempts: max };
  }
}

/** The query from a model answer: JSON {"cypher"}, a fenced block, or the text itself. */
export function extractCypher(text: string): string | undefined {
  const t = text.trim();
  try {
    const j = JSON.parse(t.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (j && typeof j.cypher === "string" && j.cypher.trim()) return j.cypher.trim();
  } catch {
    /* not JSON */
  }
  const fenced = /```(?:cypher)?\s*([\s\S]*?)```/i.exec(t);
  const body = (fenced ? fenced[1] : t).trim();
  return /\b(MATCH|CALL|UNWIND|WITH|RETURN)\b/i.test(body) ? body : undefined;
}

/** JSON-safe rows: integers as numbers, nodes as their properties, vectors elided. */
export function plain(v: unknown, depth = 0): unknown {
  if (v == null || typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") return v.length > 500 ? `${v.slice(0, 499)}…` : v;
  if (typeof v === "bigint") return Number(v);
  if (depth > 4) return "…";
  if (Array.isArray(v)) {
    if (v.length > 32 && v.every((x) => typeof x === "number")) return `[vector of ${v.length}]`;
    return v.slice(0, 100).map((x) => plain(x, depth + 1));
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown> & { toNumber?: () => number };
    if (typeof o.toNumber === "function") return o.toNumber();
    if ("labels" in o && "properties" in o) {
      return { _labels: o.labels, ...(plain(o.properties, depth + 1) as Record<string, unknown>) };
    }
    if ("type" in o && "properties" in o && ("start" in o || "startNodeElementId" in o || "startElementId" in o)) {
      return { _type: o.type, ...(plain(o.properties, depth + 1) as Record<string, unknown>) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = k === "embedding" ? "[vector]" : plain(x, depth + 1);
    return out;
  }
  return String(v);
}

function didYouMean(name: string, known: string[]): string {
  const lower = name.toLowerCase();
  const scored = known
    .map((k) => ({ k, d: k.toLowerCase() === lower ? 0 : distance(lower, k.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(name.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  return scored.length ? ` Did you mean ${scored.map((x) => `:${x.k}`).join(" or ")}?` : "";
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}
