/**
 * What the dashboard's graph explorer reads: a label's sample, a search, and a
 * node's neighbourhood — as nodes and links a force layout can draw.
 *
 * The dashboard belongs to the owner, so it sees the whole graph; agents and
 * MCP clients go through the tools and their checks instead.
 */
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import { ENTITY_TEXT_INDEX } from "../brain/ask.js";

export interface ExplorerNode {
  id: string;
  labels: string[];
  name: string;
  props: Record<string, unknown>;
}

export interface ExplorerLink {
  id: string;
  source: string;
  target: string;
  type: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
/** Properties that are not worth shipping to a browser. */
const SKIP = new Set(["embedding", "embedding_model", "text_vector"]);

function displayName(p: Record<string, unknown>): string {
  for (const k of ["name", "title", "subject", "label", "goal", "content", "text", "id"]) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v.split("\n")[0].slice(0, 80);
  }
  return "";
}

function propValue(v: unknown): unknown {
  if (v == null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") {
    return typeof v === "string" && v.length > 300 ? `${v.slice(0, 299)}…` : v;
  }
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.length > 20 ? `[${v.length} values]` : v.map(propValue);
  const o = v as { toNumber?: () => number; toString?: () => string };
  if (typeof o.toNumber === "function") return o.toNumber();
  const s = typeof o.toString === "function" ? o.toString() : "";
  return s && s !== "[object Object]" ? s : JSON.stringify(v).slice(0, 300);
}

export function toNode(v: unknown): ExplorerNode | null {
  const o = v as { elementId?: string; labels?: string[]; properties?: Record<string, unknown> } | null;
  if (!o?.elementId || !Array.isArray(o.labels)) return null;
  const props: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o.properties ?? {})) if (!SKIP.has(k)) props[k] = propValue(x);
  return { id: o.elementId, labels: o.labels, name: displayName(props), props };
}

export function toLink(v: unknown): ExplorerLink | null {
  const o = v as { elementId?: string; type?: string; startNodeElementId?: string; endNodeElementId?: string; startElementId?: string; endElementId?: string } | null;
  const source = o?.startNodeElementId ?? o?.startElementId;
  const target = o?.endNodeElementId ?? o?.endElementId;
  if (!o?.elementId || !o.type || !source || !target) return null;
  return { id: o.elementId, source, target, type: o.type };
}

export class GraphExplorer {
  constructor(private graph: () => GraphDriver | null | undefined) {}

  private g(): GraphDriver {
    const g = this.graph();
    if (!g?.capabilities.cypher) throw new Error("The graph is off.");
    return g;
  }

  /** Up to `limit` nodes of a label and the links among them. */
  async sample(label: string, limit = 150): Promise<{ nodes: ExplorerNode[]; links: ExplorerLink[] }> {
    if (!NAME.test(label)) throw new Error("bad label");
    const g = this.g();
    const r = await g.run(`MATCH (n:\`${label}\`) WITH n LIMIT $limit RETURN n`, { limit: Math.floor(limit) });
    const nodes = r.records.map((x) => toNode(x.get("n"))).filter((n): n is ExplorerNode => !!n);
    const ids = nodes.map((n) => n.id);
    const l = ids.length
      ? await g.run(
          `UNWIND $ids AS id MATCH (a) WHERE elementId(a) = id MATCH (a)-[r]->(b) WHERE elementId(b) IN $ids RETURN r LIMIT 2000`,
          { ids },
        )
      : { records: [] };
    return { nodes, links: l.records.map((x) => toLink(x.get("r"))).filter((x): x is ExplorerLink => !!x) };
  }

  /** Nodes whose name or title matches, through the entity search index when it exists. */
  async search(text: string, label = "", limit = 30): Promise<ExplorerNode[]> {
    const g = this.g();
    const q = text.trim();
    if (!q) return [];
    if (label && !NAME.test(label)) throw new Error("bad label");
    const lim = Math.floor(limit);
    try {
      const words = q.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (words && !label) {
        const r = await g.run(`CALL db.index.fulltext.queryNodes('${ENTITY_TEXT_INDEX}', $q) YIELD node RETURN node LIMIT $limit`, { q: words, limit: lim });
        const hits = r.records.map((x) => toNode(x.get("node"))).filter((n): n is ExplorerNode => !!n);
        if (hits.length) return hits;
      }
    } catch {
      /* no index yet: fall back to a scan */
    }
    const match = label ? `MATCH (n:\`${label}\`)` : "MATCH (n)";
    const r = await g.run(
      `${match} WHERE toLower(coalesce(n.name, n.title, n.subject, n.label, '')) CONTAINS toLower($q) RETURN n LIMIT $limit`,
      { q, limit: lim },
    );
    return r.records.map((x) => toNode(x.get("n"))).filter((n): n is ExplorerNode => !!n);
  }

  /** The node, its neighbours (and theirs at depth 2), at most `limit` nodes. */
  async neighborhood(id: string, depth = 1, limit = 150): Promise<{ nodes: ExplorerNode[]; links: ExplorerLink[] }> {
    const g = this.g();
    const nodes = new Map<string, ExplorerNode>();
    const links = new Map<string, ExplorerLink>();
    const self = await g.run("MATCH (n) WHERE elementId(n) = $id RETURN n", { id });
    const root = toNode(self.records[0]?.get("n"));
    if (!root) return { nodes: [], links: [] };
    nodes.set(root.id, root);
    let frontier = [root.id];
    for (let d = 0; d < Math.min(Math.max(depth, 1), 2) && nodes.size < limit; d++) {
      const r = await g.run(
        `UNWIND $ids AS id MATCH (a) WHERE elementId(a) = id
         CALL (a) { MATCH (a)-[r]-(b) RETURN r, b LIMIT $per }
         RETURN r, b`,
        { ids: frontier, per: Math.max(5, Math.floor(limit / Math.max(1, frontier.length))) },
      );
      const next: string[] = [];
      for (const rec of r.records) {
        const b = toNode(rec.get("b"));
        const l = toLink(rec.get("r"));
        if (!b || !l) continue;
        if (!nodes.has(b.id)) {
          if (nodes.size >= limit) continue;
          nodes.set(b.id, b);
          next.push(b.id);
        }
        links.set(l.id, l);
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return { nodes: [...nodes.values()], links: [...links.values()].filter((l) => nodes.has(l.source) && nodes.has(l.target)) };
  }
}
