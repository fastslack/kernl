/**
 * The engine room (A4), the graph's blueprint (C4) and question-and-path (C5):
 * the dashboard's view of Relate at work inside Kernl.
 *
 *   snapshot()   statements since a cursor (one pulse each), reads and writes
 *                per second with engine p50/p95, the costliest statements, and
 *                what the planner warns about (MissingIndex, with its remedy)
 *   profile()    PROFILE of a recorded read with its last parameters, as a tree
 *   applyIndex() the CREATE INDEX the planner itself suggested, nothing else
 *   blueprint()  db.schema.visualization with counts, indexes and constraints
 *   path()       SHORTEST paths between two things found by name
 */

import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import { engineTap, type EngineStatement } from "../../core/graph-engine-tap.js";
import { GraphExplorer, toNode, type ExplorerNode } from "./explorer.js";
import { foldText } from "../brain/ask.js";

export interface PlanTreeNode {
  operator: string;
  details: string;
  rows: number;
  dbHits: number;
  ms: number;
  start: string | null;
  children: PlanTreeNode[];
}

export interface EngineWarning {
  title: string;
  description: string;
  remedy: string;
  code: string;
  statement: string;
  /** The statement the planner warned about, as the kernel sent it. */
  cypher: string;
  seen: number;
}

/** Only the shape of index Relate's MissingIndex remedy proposes. */
const SAFE_REMEDY = /^CREATE INDEX [A-Za-z_]\w* FOR \(n:[A-Za-z_]\w*\) ON \(n\.[A-Za-z_]\w*(?:, n\.[A-Za-z_]\w*)*\)$/;

type RawPlan = {
  operator?: string; details?: string; children?: RawPlan[];
  actual?: { rows?: number; db_hits?: number; time_ms?: number; start?: { reason?: string } | null };
};

export function planTree(plan: unknown): PlanTreeNode | null {
  const root = (plan as { root?: RawPlan } | null)?.root;
  if (!root) return null;
  const walk = (n: RawPlan): PlanTreeNode => ({
    operator: String(n.operator ?? "?"),
    details: String(n.details ?? "").slice(0, 200),
    rows: Number(n.actual?.rows ?? 0),
    dbHits: Number(n.actual?.db_hits ?? 0),
    ms: Math.round(Number(n.actual?.time_ms ?? 0) * 1000) / 1000,
    start: n.actual?.start?.reason ? String(n.actual.start.reason) : null,
    children: (n.children ?? []).map(walk),
  });
  return walk(root);
}

const statementView = (s: EngineStatement) => ({
  key: s.key, label: s.label, write: s.write, count: s.count,
  avgMs: s.count ? s.totalMs / s.count : 0, maxMs: s.maxMs, failures: s.failures,
  cypher: s.cypher.slice(0, 1200), profileable: !s.write && s.lastParams !== null,
});

export class EngineRoom {
  private warnCache: { at: number; list: EngineWarning[] } | null = null;
  private explorer: GraphExplorer;

  constructor(private graph: () => GraphDriver | null | undefined) {
    this.explorer = new GraphExplorer(graph);
  }

  private g(): GraphDriver {
    const g = this.graph();
    if (!g?.capabilities.cypher) throw new Error("The graph is off.");
    return g;
  }

  async snapshot(since: number) {
    const g = this.graph();
    return {
      engine: g?.name ?? "",
      embedded: !!g?.capabilities.embedded,
      lastSeq: engineTap.lastSeq,
      items: engineTap.since(since),
      stats: engineTap.stats(),
      top: engineTap.topStatements(10).map(statementView),
      warnings: g?.capabilities.cypher ? await this.warnings().catch(() => []) : [],
    };
  }

  /**
   * What the planner says about the reads the kernel runs most: each is
   * EXPLAINed (planned, not run) with its last parameters. Cached for 30 s.
   */
  async warnings(force = false): Promise<EngineWarning[]> {
    if (!force && this.warnCache && Date.now() - this.warnCache.at < 30_000) return this.warnCache.list;
    const g = this.g();
    const byRemedy = new Map<string, EngineWarning>();
    await engineTap.unrecorded(async () => {
      for (const s of engineTap.explainable(20)) {
        try {
          const r = await g.run(`EXPLAIN ${s.cypher}`, s.lastParams ?? {});
          const notes = ((r.summary as { notifications?: unknown[] } | undefined)?.notifications ?? []) as Array<Record<string, unknown>>;
          for (const n of notes) {
            const remedy = String(n.remedy ?? "");
            if (!remedy) continue;
            // Relate reports AllNodesScan for `MATCH (n) SEARCH n IN (… INDEX …)`, whose plan
            // in fact starts from the index (one db hit): a known false positive (RELATE-NOTES #8).
            if (/AllNodesScan/.test(String(n.code ?? "")) && /\bSEARCH\s+\w+\s+IN\s*\(/i.test(s.cypher)) continue;
            const w = byRemedy.get(remedy);
            if (w) { w.seen += s.count; continue; }
            byRemedy.set(remedy, {
              title: String(n.title ?? "Notice"), description: String(n.description ?? ""), remedy,
              code: String(n.code ?? ""), statement: s.label, cypher: s.cypher.slice(0, 1200), seen: s.count,
            });
          }
        } catch { /* a statement that no longer plans: skip it */ }
      }
    });
    const list = [...byRemedy.values()].sort((a, b) => b.seen - a.seen);
    this.warnCache = { at: Date.now(), list };
    return list;
  }

  /** PROFILE a recorded read again, with its last parameters. Writes are never re-run. */
  async profile(key: string) {
    const s = engineTap.statement(key);
    if (!s) throw new Error("No such statement in the engine room's memory.");
    if (s.write || s.lastParams === null) throw new Error("Only reads with small parameters can be profiled again.");
    const g = this.g();
    const r = await engineTap.unrecorded(() => g.run(`PROFILE ${s.cypher}`, s.lastParams ?? {}));
    const sum = r.summary as { plan?: unknown; resultAvailableAfterMs?: number; phasesMs?: unknown } | undefined;
    const tree = planTree(sum?.plan);
    let dbHits = 0;
    const walk = (n: PlanTreeNode) => { dbHits += n.dbHits; n.children.forEach(walk); };
    if (tree) walk(tree);
    return { statement: statementView(s), ms: sum?.resultAvailableAfterMs ?? null, phases: sum?.phasesMs ?? null, rows: r.records.length, dbHits, tree };
  }

  /** Apply an index Relate suggested — only one listed in the current warnings, in the shape it proposes. */
  async applyIndex(remedy: string) {
    const r = remedy.trim();
    if (!SAFE_REMEDY.test(r)) throw new Error("Not an index the planner proposed.");
    const known = (await this.warnings()).some((w) => w.remedy === r);
    if (!known) throw new Error("The planner does not suggest that index (any more).");
    const g = this.g();
    const res = await g.run(r);
    this.warnCache = null;
    return { applied: r, ms: res.summary?.resultAvailableAfterMs ?? null };
  }

  /** The graph's plan as an architect would draw it: labels, relationships, counts, indexes, constraints. */
  async blueprint() {
    const g = this.g();
    const t0 = performance.now();
    const viz = await g.run("CALL db.schema.visualization()");
    // Counted label by label (the label index), not by walking every node: the
    // planner flagged the one-pass version as an AllNodesScan.
    const labelNames = (await g.run("CALL db.labels() YIELD label RETURN label")).records.map((x) => String(x.get("label")));
    const counted: Array<[string, number]> = [];
    for (const l of labelNames) {
      if (!/^[A-Za-z_]\w*$/.test(l)) continue;
      const c = await g.run(`MATCH (n:${l}) RETURN count(n) AS c`);
      counted.push([l, Number(c.records[0]?.get("c") ?? 0)]);
    }
    const nodeCounts = { records: counted.map(([label, c]) => ({ get: (k: string) => (k === "label" ? label : c) })) };
    const relCounts = await g.run("MATCH (a)-[r]->(b) RETURN type(r) AS type, labels(a)[0] AS from, labels(b)[0] AS to, count(*) AS c");
    let indexes: Array<Record<string, unknown>> = [];
    let constraints: Array<Record<string, unknown>> = [];
    try { indexes = (await g.run("SHOW INDEXES")).records.map((x) => x.toObject()); } catch { /* not every engine */ }
    try { constraints = (await g.run("SHOW CONSTRAINTS")).records.map((x) => x.toObject()); } catch { /* idem */ }
    const v = viz.records[0];
    const labelsOf = new Map<string, string>();
    for (const n of (v?.get("nodes") as Array<{ elementId?: string; labels?: string[] }>) ?? []) if (n.elementId && n.labels?.[0]) labelsOf.set(n.elementId, n.labels[0]);
    const counts = new Map(nodeCounts.records.map((x) => [String(x.get("label")), Number(x.get("c"))]));
    const labels = [...new Set([...labelsOf.values(), ...counts.keys()])].map((l) => ({
      label: l,
      count: counts.get(l) ?? 0,
      indexes: indexes.filter((i) => Array.isArray(i.labelsOrTypes) && (i.labelsOrTypes as string[]).includes(l))
        .map((i) => ({ type: String(i.type ?? ""), properties: (i.properties as string[] | null) ?? [], name: String(i.name ?? "") })),
      constraints: constraints.filter((c) => Array.isArray(c.labelsOrTypes) && (c.labelsOrTypes as string[]).includes(l))
        .map((c) => ({ type: String(c.type ?? ""), properties: (c.properties as string[] | null) ?? [] })),
    })).sort((a, b) => b.count - a.count);
    // Relationship types between labels, as counted (the visualization lists types between label pairs too).
    const rels = relCounts.records.map((x) => ({ type: String(x.get("type")), from: String(x.get("from") ?? ""), to: String(x.get("to") ?? ""), count: Number(x.get("c")) }))
      .sort((a, b) => b.count - a.count);
    return { labels, relationships: rels, ms: Math.round((performance.now() - t0) * 100) / 100 };
  }

  /** The thing a name means: an exact name first (a company over a fact that mentions it), else the best hit. */
  private async find(text: string): Promise<ExplorerNode | undefined> {
    const hits = await this.explorer.search(text, "", 15);
    // Compared without accents: "Lucia" means Lucía Ferreyra, not a fact that mentions her.
    const want = foldText(text.trim());
    const named = (n: ExplorerNode) => foldText(n.name.trim());
    const thing = (n: ExplorerNode) => n.labels[0] !== "Fact";
    return hits.find((n) => named(n) === want)
      ?? hits.find((n) => thing(n) && named(n).startsWith(want))
      ?? hits.find((n) => thing(n) && named(n).includes(want))
      ?? hits[0];
  }

  /**
   * How two things connect: each is found by name (the explorer's search), then
   * the engine's SHORTEST finds up to three paths of at most six hops.
   */
  async path(fromText: string, toText: string) {
    const a = await this.find(fromText);
    const b = await this.find(toText);
    if (!a || !b) return { from: a ?? null, to: b ?? null, paths: [], ms: null, cypher: PATH_CYPHER.trim() };
    const g = this.g();
    const r = await g.run(PATH_CYPHER, { a: a.id, b: b.id });
    const paths = r.records.map((rec) => {
      const nodes = ((rec.get("ns") as unknown[]) ?? []).map(toNode).filter((n): n is ExplorerNode => !!n);
      const rels = ((rec.get("rs") as Array<{ type?: string; from?: string }>) ?? []).map((x) => ({ type: String(x.type ?? ""), from: String(x.from ?? "") }));
      return { nodes: nodes.map((n) => ({ id: n.id, label: n.labels[0] ?? "", name: n.name })), rels };
    });
    return { from: { id: a.id, label: a.labels[0] ?? "", name: a.name }, to: { id: b.id, label: b.labels[0] ?? "", name: b.name }, paths, ms: r.summary?.resultAvailableAfterMs ?? null, cypher: PATH_CYPHER.trim() };
  }
}

export const PATH_CYPHER = `
MATCH (a) WHERE elementId(a) = $a
MATCH (b) WHERE elementId(b) = $b
MATCH p = SHORTEST 3 (a)-[*..6]-(b)
RETURN nodes(p) AS ns, [r IN relationships(p) | {type: type(r), from: elementId(startNode(r))}] AS rs`;
