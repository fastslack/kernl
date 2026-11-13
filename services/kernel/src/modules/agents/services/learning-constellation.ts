/**
 * A3 · The constellation: every lesson the agents keep as a star in a dome
 * over the office, placed by meaning — lessons that say the same thing sit
 * together — and grouped into named constellations.
 *
 *   similarity   Relate compares every pair of lessons by their embeddings
 *                (vector.similarity.cosine, one statement); each star keeps
 *                its three closest neighbours above a floor
 *   position     the embeddings' first two principal components (power
 *                iteration over the vectors SQLite keeps), so near = alike
 *   groups       label propagation over the neighbour links; each group is
 *                named by the words that set it apart from the rest
 */

import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { GraphDriver } from "../../../core/db-drivers/graph-driver.js";
import { blobToVector } from "../../../core/ranking/relevance.js";

export const CONSTELLATION_CYPHER = `
MATCH (a:AgentLearning) WHERE a.embedding IS NOT NULL AND a.agent_id IS NOT NULL
WITH a ORDER BY a.confidence DESC LIMIT $max
WITH collect(a) AS ls
UNWIND ls AS a
UNWIND ls AS b
WITH a, b WHERE a.id < b.id
WITH a, b, vector.similarity.cosine(a.embedding, b.embedding) AS s
WHERE s >= $floor
RETURN a.id AS a, b.id AS b, s`;

export interface Star {
  id: string; agent_id: string; agent_name: string; type: string; content: string;
  confidence: number; active: boolean; uses: number; x: number; y: number; group: number;
}
export interface Constellation {
  stars: Star[];
  links: Array<{ a: string; b: string; s: number }>;
  groups: Array<{ id: number; name: string; size: number; x: number; y: number }>;
  query_ms: number | null;
  pairs: number;
  cypher: string;
}

const STOP = new Set(("a an the and or of to in on for with without by from at as is are be been was were it its this that these those " +
  "when then than not no never do does did done before after first new any all each every more most less one two your their them they " +
  "if so but into over under about via auto use used using can should must will would just only also there here what which who how").split(" "));

const words = (t: string) => t.toLowerCase().replace(/^\[auto\]\s*/, "").match(/[a-záéíóúñü]{3,}/g)?.filter((w) => !STOP.has(w)) ?? [];

/** The first two principal components of `vecs` (rows), by power iteration with deflation; coordinates scaled to [-1, 1]. */
export function project2d(vecs: number[][]): Array<[number, number]> {
  const n = vecs.length;
  if (n === 0) return [];
  if (n === 1) return [[0, 0]];
  const dim = vecs[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) mean[i] += v[i] / n;
  const X = vecs.map((v) => v.map((x, i) => x - mean[i]));
  const comps: number[][] = [];
  for (let c = 0; c < 2; c++) {
    // Deterministic start, so the same library draws the same sky.
    let w = Array.from({ length: dim }, (_, i) => Math.sin(i * 12.9898 + c * 78.233));
    for (let it = 0; it < 60; it++) {
      const proj = X.map((r) => r.reduce((s, x, i) => s + x * w[i], 0));
      const next = new Array(dim).fill(0);
      X.forEach((r, k) => { for (let i = 0; i < dim; i++) next[i] += r[i] * proj[k]; });
      for (const p of comps) {
        const d = next.reduce((s, x, i) => s + x * p[i], 0);
        for (let i = 0; i < dim; i++) next[i] -= d * p[i];
      }
      const norm = Math.hypot(...next) || 1;
      w = next.map((x) => x / norm);
    }
    comps.push(w);
  }
  const pts = X.map((r) => comps.map((p) => r.reduce((s, x, i) => s + x * p[i], 0)) as [number, number]);
  const span = Math.max(1e-9, ...pts.flat().map(Math.abs));
  return pts.map(([x, y]) => [x / span, y / span]);
}

/** Label propagation over weighted links: each star takes the group its neighbours weigh most. */
export function groupsOf(ids: string[], links: Array<{ a: string; b: string; s: number }>): Map<string, number> {
  const label = new Map(ids.map((id, i) => [id, i]));
  const nbr = new Map<string, Array<[string, number]>>(ids.map((id) => [id, []]));
  for (const l of links) { nbr.get(l.a)?.push([l.b, l.s]); nbr.get(l.b)?.push([l.a, l.s]); }
  for (let round = 0; round < 12; round++) {
    let changed = false;
    for (const id of ids) {
      const w = new Map<number, number>();
      for (const [o, s] of nbr.get(id) ?? []) w.set(label.get(o)!, (w.get(label.get(o)!) ?? 0) + s);
      if (w.size === 0) continue;
      const best = [...w.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
      if (best !== label.get(id)) { label.set(id, best); changed = true; }
    }
    if (!changed) break;
  }
  // Renumber 0..k by size.
  const sizes = new Map<number, number>();
  for (const g of label.values()) sizes.set(g, (sizes.get(g) ?? 0) + 1);
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const renum = new Map(order.map((g, i) => [g, i]));
  return new Map([...label.entries()].map(([id, g]) => [id, renum.get(g)!]));
}

/** A group's name: its two words most over-represented against every lesson. */
export function nameGroup(texts: string[], all: Map<string, number>, total: number): string {
  const tf = new Map<string, number>();
  for (const t of texts) for (const w of new Set(words(t))) tf.set(w, (tf.get(w) ?? 0) + 1);
  const scored = [...tf.entries()]
    .filter(([, c]) => c >= Math.min(2, texts.length))
    .map(([w, c]) => [w, (c / texts.length) * Math.log(1 + total / (all.get(w) ?? 1))] as const)
    .sort((a, b) => b[1] - a[1]);
  return scored.slice(0, 2).map(([w]) => w).join(" · ") || (texts[0] ? words(texts[0]).slice(0, 2).join(" ") : "");
}

export async function buildConstellation(db: SqliteDb, g: GraphDriver, max = 600, floor = 0.45): Promise<Constellation> {
  const r = await g.run(CONSTELLATION_CYPHER, { max, floor });
  const pairs = r.records.map((x) => ({ a: String(x.get("a")), b: String(x.get("b")), s: Number(x.get("s")) }));
  // Each star keeps its three closest neighbours.
  const best = new Map<string, Array<{ a: string; b: string; s: number }>>();
  for (const p of pairs) for (const id of [p.a, p.b]) best.set(id, [...(best.get(id) ?? []), p]);
  const keep = new Set<string>();
  for (const list of best.values()) for (const p of list.sort((x, y) => y.s - x.s).slice(0, 3)) keep.add(`${p.a}|${p.b}`);
  const links = pairs.filter((p) => keep.has(`${p.a}|${p.b}`));

  const rows = db.prepare(
    `SELECT l.id, l.agent_id, COALESCE(a.name, '') AS agent_name, l.type, l.content, l.confidence, l.active, l.embedding,
            (SELECT COUNT(*) FROM agent_run_learnings rl WHERE rl.learning_id = l.id) AS uses
       FROM agent_learnings l LEFT JOIN agents a ON a.id = l.agent_id
      WHERE l.embedding IS NOT NULL ORDER BY l.confidence DESC LIMIT ?`,
  ).all(max) as Array<{ id: string; agent_id: string; agent_name: string; type: string; content: string; confidence: number; active: number; embedding: Buffer; uses: number }>;
  const withVec = rows.map((x) => ({ ...x, vec: blobToVector(x.embedding) })).filter((x) => x.vec && x.vec.length > 0);
  const pts = project2d(withVec.map((x) => x.vec!));
  const group = groupsOf(withVec.map((x) => x.id), links);

  const df = new Map<string, number>();
  for (const x of withVec) for (const w of new Set(words(x.content))) df.set(w, (df.get(w) ?? 0) + 1);
  const stars: Star[] = withVec.map((x, i) => ({
    id: x.id, agent_id: x.agent_id, agent_name: x.agent_name, type: x.type, content: x.content.replace(/^\[auto\]\s*/, "").slice(0, 160),
    confidence: x.confidence, active: x.active === 1, uses: x.uses, x: pts[i][0], y: pts[i][1], group: group.get(x.id) ?? 0,
  }));
  const byGroup = new Map<number, Star[]>();
  for (const s of stars) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
  const groups = [...byGroup.entries()].filter(([, ss]) => ss.length >= 2).map(([id, ss]) => ({
    id, size: ss.length,
    name: nameGroup(ss.map((s) => s.content), df, stars.length),
    x: ss.reduce((a, s) => a + s.x, 0) / ss.length, y: ss.reduce((a, s) => a + s.y, 0) / ss.length,
  }));
  return { stars, links, groups, query_ms: r.summary?.resultAvailableAfterMs ?? null, pairs: pairs.length, cypher: CONSTELLATION_CYPHER.trim() };
}
