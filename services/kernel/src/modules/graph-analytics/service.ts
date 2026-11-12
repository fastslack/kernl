/**
 * Graph analytics on any engine: PageRank, communities, components and
 * betweenness over the part of the graph you name, written back as node
 * properties (pageRank, communityId, componentId, betweenness — the names the
 * dashboard and the pro graph-intel extension already read).
 *
 * Where it runs, in order of preference (`engine: auto`):
 *   1. gds    — the active graph has Graph Data Science (a Neo4j with the plugin).
 *   2. remote — GDS_REMOTE_URI points at a Neo4j with GDS. Only the shape goes
 *               there: numbered nodes and edges, no labels, no properties, no
 *               ids from your graph. The scratch data is removed afterwards.
 *   3. local  — plain TypeScript in the kernel (algorithms.ts), on graphs up to
 *               MAX_NODES / MAX_EDGES.
 */
import { randomBytes } from "node:crypto";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import { Neo4jClient } from "../../core/db/neo4j.js";
import { type Projection, betweenness, components, louvain, pageRank } from "./algorithms.js";

export const ALGORITHMS = ["pagerank", "communities", "components", "betweenness"] as const;
export type Algorithm = (typeof ALGORITHMS)[number];
export type Engine = "gds" | "remote" | "local";

export const PROPERTY: Record<Algorithm, string> = {
  pagerank: "pageRank",
  communities: "communityId",
  components: "componentId",
  betweenness: "betweenness",
};

export const MAX_NODES = 200_000;
export const MAX_EDGES = 1_000_000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const q = (s: string) => `\`${s}\``;

export interface AnalyzeInput {
  algorithm: Algorithm;
  labels: string[];
  relationships?: string[];
  engine?: "auto" | Engine;
  write?: boolean;
  top?: number;
  /** betweenness: sources to sample (default min(n, 500)). */
  samples?: number;
}

export interface RemoteConfig {
  uri: string;
  user: string;
  password: string;
}

export function remoteFromEnv(env: Record<string, string | undefined> = process.env): RemoteConfig | null {
  const uri = env.GDS_REMOTE_URI?.trim();
  if (!uri) return null;
  return { uri, user: env.GDS_REMOTE_USER?.trim() || "neo4j", password: env.GDS_REMOTE_PASSWORD ?? "" };
}

/** What a remote GDS needs: run a statement, close. Tests pass a fake. */
export interface RemoteSession {
  run(cypher: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

async function openRemote(cfg: RemoteConfig): Promise<RemoteSession> {
  const client = new Neo4jClient();
  await client.connect({ uri: cfg.uri, user: cfg.user, password: cfg.password });
  return {
    async run(cypher, params) {
      const r = await client.run(cypher, params);
      return r.records.map((x) => x.toObject() as Record<string, unknown>);
    },
    close: () => client.close(),
  };
}

export class GraphAnalytics {
  private running = false;

  constructor(
    private graph: () => GraphDriver | null | undefined,
    private remote: () => RemoteConfig | null = () => remoteFromEnv(),
    private connectRemote: (cfg: RemoteConfig) => Promise<RemoteSession> = openRemote,
  ) {}

  engines(): Engine[] {
    const g = this.graph();
    const out: Engine[] = [];
    if (g?.capabilities.gds) out.push("gds");
    if (this.remote()) out.push("remote");
    out.push("local");
    return out;
  }

  private g(): GraphDriver {
    const g = this.graph();
    if (!g?.capabilities.cypher) throw new Error("The graph is off.");
    return g;
  }

  async analyze(input: AnalyzeInput) {
    if (this.running) throw new Error("Another analysis is running. Try again when it finishes.");
    for (const n of [...input.labels, ...(input.relationships ?? [])]) {
      if (!NAME.test(n)) throw new Error(`Not a label or relationship type: ${JSON.stringify(n)}`);
    }
    if (!input.labels.length) throw new Error("Name at least one label.");
    const available = this.engines();
    const engine: Engine = !input.engine || input.engine === "auto" ? available[0] : input.engine;
    if (!available.includes(engine)) {
      throw new Error(engine === "gds" ? "The active graph has no Graph Data Science." : "No remote GDS is configured (GDS_REMOTE_URI).");
    }
    this.running = true;
    const t0 = Date.now();
    try {
      const { ids, proj } = await this.load(input.labels, input.relationships);
      let values: ArrayLike<number>;
      if (engine === "local") values = runLocal(input, proj);
      else if (engine === "remote") values = await this.runRemote(input, proj);
      else values = await this.runGds(input, ids);
      const property = PROPERTY[input.algorithm];
      if (input.write !== false) await this.writeBack(ids, values, property);
      return {
        engine,
        algorithm: input.algorithm,
        property: input.write !== false ? property : undefined,
        nodes: proj.n,
        relationships: proj.src.length,
        ms: Date.now() - t0,
        ...(await this.summarize(input, ids, values)),
      };
    } finally {
      this.running = false;
    }
  }

  /** Numbered nodes of the labels and the edges between them (any direction as stored). */
  async load(labels: string[], relationships?: string[]): Promise<{ ids: string[]; proj: Projection }> {
    const g = this.g();
    const index = new Map<string, number>();
    const ids: string[] = [];
    for (const l of labels) {
      const r = await g.run(`MATCH (n:${q(l)}) RETURN elementId(n) AS id`);
      for (const rec of r.records) {
        const id = String(rec.get("id"));
        if (index.has(id)) continue;
        index.set(id, ids.length);
        ids.push(id);
        if (ids.length > MAX_NODES) throw new Error(`More than ${MAX_NODES} nodes: narrow the labels.`);
      }
    }
    const src: number[] = [];
    const dst: number[] = [];
    // A relationship between nodes with several of the labels matches once per label pair: count it once.
    const seen = new Set<string>();
    const types = relationships?.length ? `:${relationships.map(q).join("|")}` : "";
    for (const a of labels) {
      for (const b of labels) {
        const r = await g.run(`MATCH (a:${q(a)})-[r${types}]->(b:${q(b)}) RETURN elementId(r) AS r, elementId(a) AS a, elementId(b) AS b`);
        for (const rec of r.records) {
          const rid = String(rec.get("r"));
          if (seen.has(rid)) continue;
          seen.add(rid);
          const x = index.get(String(rec.get("a")));
          const y = index.get(String(rec.get("b")));
          if (x === undefined || y === undefined) continue;
          src.push(x);
          dst.push(y);
          if (src.length > MAX_EDGES) throw new Error(`More than ${MAX_EDGES} relationships: narrow the labels or types.`);
        }
      }
    }
    return { ids, proj: { n: ids.length, src: Int32Array.from(src), dst: Int32Array.from(dst) } };
  }

  private async runRemote(input: AnalyzeInput, proj: Projection): Promise<Float64Array> {
    const cfg = this.remote();
    if (!cfg) throw new Error("No remote GDS is configured (GDS_REMOTE_URI).");
    const s = await this.connectRemote(cfg);
    const tag = `KernlTmp_${randomBytes(6).toString("hex")}`;
    const name = `kernl_${tag}`;
    try {
      await s.run(`CREATE INDEX ${q(`${tag}_i`)} IF NOT EXISTS FOR (n:${q(tag)}) ON (n.i)`);
      for (let i = 0; i < proj.n; i += 10_000) {
        await s.run(`UNWIND range($from, $to) AS i CREATE (:${q(tag)} {i: i})`, { from: i, to: Math.min(proj.n, i + 10_000) - 1 });
      }
      for (let i = 0; i < proj.src.length; i += 10_000) {
        const rows: number[][] = [];
        for (let j = i; j < Math.min(proj.src.length, i + 10_000); j++) rows.push([proj.src[j], proj.dst[j]]);
        await s.run(`UNWIND $rows AS row MATCH (a:${q(tag)} {i: row[0]}) MATCH (b:${q(tag)} {i: row[1]}) CREATE (a)-[:E]->(b)`, { rows });
      }
      const undirected = input.algorithm !== "pagerank";
      await s.run(
        `CALL gds.graph.project($name, $label, {E: {orientation: $orientation}}) YIELD graphName RETURN graphName`,
        { name, label: tag, orientation: undirected ? "UNDIRECTED" : "NATURAL" },
      );
      const call = {
        pagerank: "gds.pageRank.stream($name) YIELD nodeId, score AS value",
        communities: "gds.louvain.stream($name) YIELD nodeId, communityId AS value",
        components: "gds.wcc.stream($name) YIELD nodeId, componentId AS value",
        betweenness: "gds.betweenness.stream($name) YIELD nodeId, score AS value",
      }[input.algorithm];
      const rows = await s.run(`CALL ${call} RETURN gds.util.asNode(nodeId).i AS i, value`, { name });
      const out = new Float64Array(proj.n);
      for (const r of rows) out[Number(r.i)] = Number(r.value);
      return out;
    } finally {
      // Leave nothing behind on the remote server.
      await s.run("CALL gds.graph.drop($name, false) YIELD graphName RETURN graphName", { name }).catch(() => undefined);
      for (let i = 0; i < 1000; i++) {
        const r = await s.run(`MATCH (n:${q(tag)}) WITH n LIMIT 10000 DETACH DELETE n RETURN count(*) AS c`).catch(() => [{ c: 0 }]);
        if (!Number(r[0]?.c)) break;
      }
      await s.run(`DROP INDEX ${q(`${tag}_i`)} IF EXISTS`).catch(() => undefined);
      await s.close().catch(() => undefined);
    }
  }

  private async runGds(input: AnalyzeInput, ids: string[]): Promise<Float64Array> {
    const g = this.g();
    const name = `kernl_${randomBytes(6).toString("hex")}`;
    const undirected = input.algorithm !== "pagerank";
    const rels = input.relationships?.length
      ? Object.fromEntries(input.relationships.map((t) => [t, { orientation: undirected ? "UNDIRECTED" : "NATURAL" }]))
      : { ALL: { type: "*", orientation: undirected ? "UNDIRECTED" : "NATURAL" } };
    try {
      await g.run("CALL gds.graph.project($name, $labels, $rels) YIELD graphName RETURN graphName", { name, labels: input.labels, rels });
      const call = {
        pagerank: "gds.pageRank.stream($name) YIELD nodeId, score AS value",
        communities: "gds.louvain.stream($name) YIELD nodeId, communityId AS value",
        components: "gds.wcc.stream($name) YIELD nodeId, componentId AS value",
        betweenness: "gds.betweenness.stream($name) YIELD nodeId, score AS value",
      }[input.algorithm];
      const r = await g.run(`CALL ${call} RETURN elementId(gds.util.asNode(nodeId)) AS id, value`, { name });
      const at = new Map(ids.map((id, i) => [id, i]));
      const out = new Float64Array(ids.length);
      for (const rec of r.records) {
        const i = at.get(String(rec.get("id")));
        if (i !== undefined) out[i] = Number(rec.get("value"));
      }
      return out;
    } finally {
      await g.run("CALL gds.graph.drop($name, false) YIELD graphName RETURN graphName", { name }).catch(() => undefined);
    }
  }

  private async writeBack(ids: string[], values: ArrayLike<number>, property: string): Promise<void> {
    if (!NAME.test(property)) throw new Error(`bad property ${property}`);
    const g = this.g();
    for (let i = 0; i < ids.length; i += 2000) {
      const rows = [];
      for (let j = i; j < Math.min(ids.length, i + 2000); j++) rows.push({ id: ids[j], v: values[j] });
      await g.run(`UNWIND $rows AS row MATCH (n) WHERE elementId(n) = row.id SET n.${property} = row.v`, { rows });
    }
  }

  private async summarize(input: AnalyzeInput, ids: string[], values: ArrayLike<number>) {
    const top = Math.max(1, Math.min(input.top ?? 10, 100));
    const name = async (pick: string[]) => {
      if (!pick.length) return new Map<string, { name: string; labels: string[] }>();
      const r = await this.g().run(
        `UNWIND $ids AS id MATCH (n) WHERE elementId(n) = id
         RETURN id, labels(n) AS labels, coalesce(n.name, n.title, n.subject, n.label, n.id, '') AS name`,
        { ids: pick },
      );
      return new Map(r.records.map((x) => [String(x.get("id")), { name: String(x.get("name") ?? ""), labels: x.get("labels") as string[] }]));
    };
    if (input.algorithm === "pagerank" || input.algorithm === "betweenness") {
      const order = [...ids.keys()].sort((a, b) => values[b] - values[a]).slice(0, top);
      const names = await name(order.map((i) => ids[i]));
      return { top: order.map((i) => ({ ...names.get(ids[i]), score: Math.round(values[i] * 1e6) / 1e6 })) };
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < ids.length; i++) groups.set(values[i], [...(groups.get(values[i]) ?? []), i]);
    const biggest = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, top);
    const names = await name(biggest.flatMap(([, m]) => m.slice(0, 5).map((i) => ids[i])));
    return {
      groups: groups.size,
      largest: biggest.map(([id, m]) => ({ id, size: m.length, sample: m.slice(0, 5).map((i) => names.get(ids[i])?.name ?? "") })),
    };
  }
}

export function runLocal(input: AnalyzeInput, proj: Projection): ArrayLike<number> {
  switch (input.algorithm) {
    case "pagerank":
      return pageRank(proj);
    case "components":
      return components(proj);
    case "communities":
      return louvain(proj);
    case "betweenness":
      return betweenness(proj, { samples: input.samples ?? Math.min(proj.n, 500) });
  }
}

