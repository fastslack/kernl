/**
 * Pure helpers for the Storage tab (System › Storage): byte formatting, the
 * 30-day sparkline and the order/colour of the data kinds. Kept out of the
 * component so they can be tested without a DOM.
 */

export type StorageKind = "operational" | "cache" | "reference" | "personal" | "unclassified";

/** Largest first is how the weight bar reads best; personal last among policies. */
export const KIND_ORDER: StorageKind[] = ["reference", "operational", "cache", "personal", "unclassified"];

export const KIND_COLOR: Record<StorageKind, string> = {
  reference: "var(--blue)",
  operational: "var(--teal)",
  cache: "var(--gold)",
  personal: "var(--purple)",
  unclassified: "var(--text-3)",
};

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "—";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString();
}

/**
 * SVG polyline points for a sparkline of `values` inside a w×h box. A flat
 * series sits in the middle; fewer than two points draws nothing.
 */
export function sparkPoints(values: number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = w / (values.length - 1);
  return values
    .map((v, i) => {
      const y = span === 0 ? h / 2 : h - ((v - min) / span) * h;
      return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Share of each kind in the total, for the stacked bar. Zero-weight kinds are dropped. */
export function kindShares(byKind: Partial<Record<StorageKind, number>>): Array<{ kind: StorageKind; bytes: number; pct: number }> {
  const total = KIND_ORDER.reduce((s, k) => s + (byKind[k] ?? 0), 0);
  if (total <= 0) return [];
  return KIND_ORDER.filter((k) => (byKind[k] ?? 0) > 0).map((k) => ({
    kind: k,
    bytes: byKind[k] ?? 0,
    pct: ((byKind[k] ?? 0) / total) * 100,
  }));
}
