/**
 * Cosine similarity over two equal-length numeric vectors.
 * Returns 0 on length mismatch or zero-magnitude input (never NaN).
 * Single source of truth — tool-memory and the RankingService both consume this.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0 || !Number.isFinite(denom) || !Number.isFinite(dot)) return 0;
  return dot / denom;
}
