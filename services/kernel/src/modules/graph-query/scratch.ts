/**
 * Scratch graphs: a private, in-memory graph per run, where an agent may write.
 *
 * An agent that reasons over structure (a plan, a dependency map, a slice of
 * the main graph it wants to reshape) gets its own graph instead of writing to
 * the real one. Each run (or MCP client, when there is no run) leases one; it
 * is wiped and handed back when the run ends, when dropped, or after
 * `IDLE_MS` without use.
 *
 * Relate cannot close a database, so graphs are pooled and reused — at most
 * `MAX_GRAPHS` exist, ever — rather than opened per run. Each holds at most
 * `MAX_NODES` nodes.
 */
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import { blankLiterals } from "./gate.js";

export const MAX_GRAPHS = 4;
export const MAX_NODES = 20_000;
export const IDLE_MS = 30 * 60_000;

const FORBIDDEN = /\b(LOAD\s+CSV|USE|GRANT|DENY|REVOKE|TERMINATE|ALTER)\b|\b(apoc|gds|dbms|tx)\./i;

export function scratchGate(cypher: string): string | null {
  const text = blankLiterals(cypher.trim());
  if (!text) return "Empty query.";
  const m = FORBIDDEN.exec(text);
  if (m) return `Not allowed in a scratch graph: ${m[0]}.`;
  for (const c of text.matchAll(/\bCALL\s+([A-Za-z_][\w.]*)\s*\(/gi)) {
    if (!/^db\.(labels|relationshipTypes|propertyKeys|schema\.\w+|index\.(vector|fulltext)\.queryNodes)$/i.test(c[1])) {
      return `Procedure ${c[1]} is not allowed in a scratch graph.`;
    }
  }
  return null;
}

interface Lease {
  graph: GraphDriver;
  owner: string;
  lastUsed: number;
}

export class ScratchGraphs {
  private free: GraphDriver[] = [];
  private leases = new Map<string, Lease>();
  private created = 0;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private open: () => Promise<GraphDriver>, private now: () => number = Date.now) {}

  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  owners(): string[] {
    return [...this.leases.keys()];
  }

  /** The owner's graph, leasing one if it has none. */
  async get(owner: string): Promise<GraphDriver> {
    const l = this.leases.get(owner);
    if (l) {
      l.lastUsed = this.now();
      return l.graph;
    }
    await this.sweep();
    let graph = this.free.pop();
    if (!graph) {
      if (this.created >= MAX_GRAPHS) {
        throw new Error(`All ${MAX_GRAPHS} scratch graphs are in use by other runs. Try again when one finishes.`);
      }
      this.created++;
      try {
        graph = await this.open();
      } catch (e) {
        this.created--;
        throw e;
      }
    }
    this.leases.set(owner, { graph, owner, lastUsed: this.now() });
    return graph;
  }

  has(owner: string): boolean {
    return this.leases.has(owner);
  }

  /** Wipe the owner's graph and put it back in the pool. */
  async release(owner: string): Promise<boolean> {
    const l = this.leases.get(owner);
    if (!l) return false;
    this.leases.delete(owner);
    try {
      await wipe(l.graph);
      this.free.push(l.graph);
    } catch {
      // A graph that cannot be wiped is not handed to anyone else.
    }
    return true;
  }

  async sweep(): Promise<void> {
    const cutoff = this.now() - IDLE_MS;
    for (const l of [...this.leases.values()]) if (l.lastUsed < cutoff) await this.release(l.owner);
  }

  /** Run Cypher in the owner's scratch graph. Writes are allowed; the node cap is checked before each statement. */
  async run(owner: string, cypher: string, params: Record<string, unknown> = {}) {
    const bad = scratchGate(cypher);
    if (bad) throw new Error(bad);
    const g = await this.get(owner);
    const writes = /\b(CREATE|MERGE|SET)\b/i.test(blankLiterals(cypher));
    if (writes && (await nodeCount(g)) >= MAX_NODES) {
      throw new Error(`The scratch graph is full (${MAX_NODES} nodes). Delete what you no longer need, or drop it and start again.`);
    }
    return g.run(cypher, params);
  }

  async stats(owner: string): Promise<{ nodes: number; relationships: number } | null> {
    const l = this.leases.get(owner);
    if (!l) return null;
    const r = await l.graph.run("MATCH (n) WITH count(n) AS nodes OPTIONAL MATCH ()-[r]->() RETURN nodes, count(r) AS rels");
    return { nodes: Number(r.records[0]?.get("nodes") ?? 0), relationships: Number(r.records[0]?.get("rels") ?? 0) };
  }

  /**
   * Copy nodes and relationships (as the driver returns them, with element ids)
   * into the owner's graph. Each copy keeps its labels and properties and gets
   * `_src`, the element id it came from, and the label `_Slice`, so copying
   * again updates instead of duplicating. Relationships whose ends were not copied are skipped.
   */
  async copyIn(owner: string, slice: Slice): Promise<{ nodes: number; relationships: number; skipped: number }> {
    const g = await this.get(owner);
    const room = MAX_NODES - (await nodeCount(g));
    if (slice.nodes.length > room) throw new Error(`The slice has ${slice.nodes.length} nodes; the scratch graph has room for ${Math.max(0, room)}.`);
    await g.run("CREATE INDEX slice_src IF NOT EXISTS FOR (n:_Slice) ON (n._src)");
    const byLabels = new Map<string, Slice["nodes"]>();
    for (const n of slice.nodes) {
      const key = n.labels.filter(isName).sort().join(":");
      byLabels.set(key, [...(byLabels.get(key) ?? []), n]);
    }
    for (const [labels, nodes] of byLabels) {
      for (const rows of chunk(nodes.map((n) => ({ src: n.elementId, props: n.properties })), 500)) {
        await g.run(
          `UNWIND $rows AS row MERGE (n:_Slice {_src: row.src}) SET n += row.props${labels ? `, n:${labels.split(":").map(quote).join(":")}` : ""}`,
          { rows },
        );
      }
    }
    const have = new Set(slice.nodes.map((n) => n.elementId));
    const rels = slice.relationships.filter((r) => have.has(r.start) && have.has(r.end) && isName(r.type));
    const byType = new Map<string, Slice["relationships"]>();
    for (const r of rels) byType.set(r.type, [...(byType.get(r.type) ?? []), r]);
    for (const [type, list] of byType) {
      for (const rows of chunk(list.map((r) => ({ src: r.elementId, a: r.start, b: r.end, props: r.properties })), 500)) {
        await g.run(
          `UNWIND $rows AS row
           MATCH (a:_Slice {_src: row.a}) MATCH (b:_Slice {_src: row.b})
           MERGE (a)-[r:${quote(type)} {_src: row.src}]->(b) SET r += row.props`,
          { rows },
        );
      }
    }
    return { nodes: slice.nodes.length, relationships: rels.length, skipped: slice.relationships.length - rels.length };
  }
}

export interface Slice {
  nodes: Array<{ elementId: string; labels: string[]; properties: Record<string, unknown> }>;
  relationships: Array<{ elementId: string; type: string; start: string; end: string; properties: Record<string, unknown> }>;
}

const isName = (s: string) => /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(s);
const quote = (s: string) => `\`${s.replace(/`/g, "")}\``;

/** Every node and relationship found anywhere in the rows (also inside lists and paths), once each. */
export function collectSlice(rows: Array<Record<string, unknown>>): Slice {
  const nodes = new Map<string, Slice["nodes"][number]>();
  const rels = new Map<string, Slice["relationships"][number]>();
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const id = typeof o.elementId === "string" ? o.elementId : null;
    if (id && Array.isArray(o.labels) && o.properties && typeof o.properties === "object") {
      if (!nodes.has(id)) nodes.set(id, { elementId: id, labels: o.labels as string[], properties: plainProps(o.properties as Record<string, unknown>) });
      return;
    }
    const start = (o.startNodeElementId ?? o.startElementId) as string | undefined;
    const end = (o.endNodeElementId ?? o.endElementId) as string | undefined;
    if (id && typeof o.type === "string" && start && end) {
      if (!rels.has(id)) rels.set(id, { elementId: id, type: o.type, start, end, properties: plainProps((o.properties ?? {}) as Record<string, unknown>) });
      return;
    }
    // Paths from either engine: { segments: [...] } / { start, end, segments } or an array (handled above).
    if (Array.isArray(o.segments)) {
      for (const s of o.segments as Array<Record<string, unknown>>) {
        walk(s.start, depth + 1);
        walk(s.relationship, depth + 1);
        walk(s.end, depth + 1);
      }
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  for (const r of rows) walk(r, 0);
  return { nodes: [...nodes.values()], relationships: [...rels.values()] };
}

/** Property values as plain parameters: integers as numbers, embeddings left out (they are big and model-specific). */
function plainProps(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "embedding" || k === "_src") continue;
    const x = toParam(v);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

function toParam(v: unknown): unknown {
  if (v == null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) {
    const xs = v.map(toParam).filter((x) => x !== undefined && (typeof x !== "object" || x === null));
    return xs.length === v.length ? xs : undefined;
  }
  if (typeof v === "object") {
    const o = v as { toNumber?: () => number; toString?: () => string };
    if (typeof o.toNumber === "function") return o.toNumber();
    // Dates, times, points: their text form survives; maps are not property values.
    const s = typeof o.toString === "function" ? o.toString() : "";
    return s && s !== "[object Object]" ? s : undefined;
  }
  return undefined;
}

async function nodeCount(g: GraphDriver): Promise<number> {
  const r = await g.run("MATCH (n) RETURN count(n) AS n");
  return Number(r.records[0]?.get("n") ?? 0);
}

async function wipe(g: GraphDriver): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const r = await g.run("MATCH (n) WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS n");
    if (Number(r.records[0]?.get("n") ?? 0) === 0) break;
  }
  // Indexes and constraints an agent created: drop them so the next run starts clean.
  for (const kind of ["CONSTRAINTS", "INDEXES"] as const) {
    try {
      const r = await g.run(`SHOW ${kind} YIELD name RETURN name`);
      for (const rec of r.records) {
        const name = String(rec.get("name"));
        if (isName(name)) await g.run(`DROP ${kind === "INDEXES" ? "INDEX" : "CONSTRAINT"} ${quote(name)} IF EXISTS`);
      }
    } catch {
      /* engine without SHOW: nothing to drop */
    }
  }
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
