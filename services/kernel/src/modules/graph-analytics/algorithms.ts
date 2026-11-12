/**
 * Graph algorithms in plain TypeScript, for when no Graph Data Science is at
 * hand. Nodes are 0..n-1; edges are pairs of indices (directed as given).
 * Deterministic: the same graph gives the same numbers, run after run.
 */

export interface Projection {
  n: number;
  src: Int32Array;
  dst: Int32Array;
}

/** PageRank by power iteration; dangling nodes spread their rank evenly. Sums to 1. */
export function pageRank(g: Projection, opts: { damping?: number; iterations?: number; tolerance?: number } = {}): Float64Array {
  const { n, src, dst } = g;
  const d = opts.damping ?? 0.85;
  const out = new Int32Array(n);
  for (let i = 0; i < src.length; i++) out[src[i]]++;
  let rank = new Float64Array(n).fill(n ? 1 / n : 0);
  let next = new Float64Array(n);
  for (let it = 0; it < (opts.iterations ?? 40); it++) {
    let dangling = 0;
    for (let v = 0; v < n; v++) if (out[v] === 0) dangling += rank[v];
    next.fill((1 - d) / n + (d * dangling) / n);
    for (let i = 0; i < src.length; i++) next[dst[i]] += (d * rank[src[i]]) / out[src[i]];
    let delta = 0;
    for (let v = 0; v < n; v++) delta += Math.abs(next[v] - rank[v]);
    [rank, next] = [next, rank];
    if (delta < (opts.tolerance ?? 1e-9)) break;
  }
  return rank;
}

/** Weakly connected components: the component id is its smallest node index. */
export function components(g: Projection): Int32Array {
  const parent = new Int32Array(g.n);
  for (let i = 0; i < g.n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let i = 0; i < g.src.length; i++) {
    const a = find(g.src[i]);
    const b = find(g.dst[i]);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const out = new Int32Array(g.n);
  for (let i = 0; i < g.n; i++) out[i] = find(i);
  return out;
}

/** Undirected adjacency with summed weights; self-loops kept once. */
function undirected(n: number, src: Int32Array | number[], dst: Int32Array | number[], w?: Float64Array | number[]) {
  const adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    const b = dst[i];
    const x = w ? w[i] : 1;
    adj[a].set(b, (adj[a].get(b) ?? 0) + x);
    if (a !== b) adj[b].set(a, (adj[b].get(a) ?? 0) + x);
  }
  return adj;
}

/**
 * Louvain communities (undirected, modularity). Local moves until no node
 * gains, then the communities become nodes and it repeats. Community ids are
 * renumbered 0..k-1 by first appearance, so they are stable across runs.
 */
export function louvain(g: Projection, opts: { maxLevels?: number; maxPasses?: number } = {}): Int32Array {
  let adj = undirected(g.n, g.src, g.dst);
  let membership = Int32Array.from({ length: g.n }, (_, i) => i);
  for (let level = 0; level < (opts.maxLevels ?? 10); level++) {
    const n = adj.length;
    const degree = new Float64Array(n);
    let m2 = 0;
    for (let v = 0; v < n; v++) {
      for (const [u, w] of adj[v]) {
        degree[v] += u === v ? 2 * w : w;
      }
      m2 += degree[v];
    }
    if (m2 === 0) break;
    const comm = Int32Array.from({ length: n }, (_, i) => i);
    const tot = Float64Array.from(degree);
    let moved = false;
    for (let pass = 0; pass < (opts.maxPasses ?? 20); pass++) {
      let changes = 0;
      for (let v = 0; v < n; v++) {
        const cv = comm[v];
        const links = new Map<number, number>();
        for (const [u, w] of adj[v]) if (u !== v) links.set(comm[u], (links.get(comm[u]) ?? 0) + w);
        tot[cv] -= degree[v];
        let best = cv;
        let bestGain = (links.get(cv) ?? 0) - (tot[cv] * degree[v]) / m2;
        for (const [c, kin] of links) {
          const gain = kin - (tot[c] * degree[v]) / m2;
          if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best)) {
            bestGain = gain;
            best = c;
          }
        }
        tot[best] += degree[v];
        if (best !== cv) {
          comm[v] = best;
          changes++;
        }
      }
      if (!changes) break;
      moved = true;
    }
    if (!moved) break;
    // Renumber and fold the graph.
    const ids = new Map<number, number>();
    for (let v = 0; v < n; v++) if (!ids.has(comm[v])) ids.set(comm[v], ids.size);
    for (let i = 0; i < membership.length; i++) membership[i] = ids.get(comm[membership[i]])!;
    const folded: Array<Map<number, number>> = Array.from({ length: ids.size }, () => new Map());
    const add = (a: number, b: number, w: number) => folded[a].set(b, (folded[a].get(b) ?? 0) + w);
    for (let v = 0; v < n; v++) {
      const a = ids.get(comm[v])!;
      for (const [u, w] of adj[v]) {
        const b = ids.get(comm[u])!;
        if (u === v) add(a, a, w); // a self-loop, stored once
        else if (a === b) add(a, a, w / 2); // an inner edge, seen from both ends
        else add(a, b, w); // the other direction is added from u's side
      }
    }
    adj = folded;
  }
  const ids = new Map<number, number>();
  return membership.map((c) => {
    if (!ids.has(c)) ids.set(c, ids.size);
    return ids.get(c)!;
  });
}

/**
 * Betweenness centrality (Brandes), undirected and unweighted. With `samples`
 * below n it starts from that many evenly spread sources and scales up — an
 * estimate that keeps big graphs affordable.
 */
export function betweenness(g: Projection, opts: { samples?: number } = {}): Float64Array {
  const n = g.n;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < g.src.length; i++) {
    if (g.src[i] === g.dst[i]) continue;
    adj[g.src[i]].push(g.dst[i]);
    adj[g.dst[i]].push(g.src[i]);
  }
  const k = Math.min(n, opts.samples ?? n);
  const step = k ? n / k : 1;
  const cb = new Float64Array(n);
  const sigma = new Float64Array(n);
  const dist = new Int32Array(n);
  const delta = new Float64Array(n);
  const preds: number[][] = Array.from({ length: n }, () => []);
  const stack: number[] = [];
  const queue = new Int32Array(n);
  for (let si = 0; si < k; si++) {
    const s = Math.floor(si * step);
    sigma.fill(0);
    dist.fill(-1);
    delta.fill(0);
    for (const p of preds) p.length = 0;
    stack.length = 0;
    sigma[s] = 1;
    dist[s] = 0;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    while (head < tail) {
      const v = queue[head++];
      stack.push(v);
      for (const w of adj[v]) {
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue[tail++] = w;
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          preds[w].push(v);
        }
      }
    }
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of preds[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== s) cb[w] += delta[w];
    }
  }
  // Undirected: each pair counted from both ends.
  const scale = (k < n ? n / k : 1) / 2;
  for (let v = 0; v < n; v++) cb[v] *= scale;
  return cb;
}
