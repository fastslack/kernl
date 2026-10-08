/**
 * How much each model has been used, from GET /api/llm/usage?group=model (the
 * kernel's daily rollup, all time). The model pickers order by it: the models
 * the user actually runs float to the top of their provider, and the
 * providers they run most come first.
 *
 * Loaded once per page and shared like the prices; a picker asks for a fresh
 * copy when it opens, throttled, so a model picked a minute ago moves up.
 */
import { writable, type Readable } from 'svelte/store';
import { priceKey } from './model-prices.js';

export type ModelUsage = {
  /** calls per `priceKey(slug, model)` */
  byModel: Map<string, number>;
  /** calls per provider slug */
  bySlug: Map<string, number>;
};

const EMPTY: ModelUsage = { byModel: new Map(), bySlug: new Map() };
const store = writable<ModelUsage>(EMPTY);
let lastFetch = 0;
let inFlight = false;
const STALE_MS = 60_000;

type UsageRow = { key: string; slug?: string; calls: number };

export function foldUsage(rows: UsageRow[] | undefined): ModelUsage {
  const byModel = new Map<string, number>();
  const bySlug = new Map<string, number>();
  for (const r of rows ?? []) {
    if (!r.slug || !r.key) continue;
    const calls = Number(r.calls) || 0;
    const k = priceKey(r.slug, r.key);
    byModel.set(k, (byModel.get(k) ?? 0) + calls);
    bySlug.set(r.slug, (bySlug.get(r.slug) ?? 0) + calls);
  }
  return { byModel, bySlug };
}

/** Fetch again unless a copy younger than a minute is already here. */
export function refreshUsage(): void {
  if (inFlight || typeof fetch === 'undefined' || Date.now() - lastFetch < STALE_MS) return;
  inFlight = true;
  fetch('/api/llm/usage?group=model')
    .then((r) => (r.ok ? r.json() : null))
    .then((b: { rows?: UsageRow[] } | null) => {
      if (b) { store.set(foldUsage(b.rows)); lastFetch = Date.now(); }
    })
    .catch(() => {})
    .finally(() => { inFlight = false; });
}

/** The shared usage map; the first subscriber triggers the fetch. */
export function modelUsage(): Readable<ModelUsage> {
  refreshUsage();
  return store;
}

/**
 * Most used first. Stable: models nobody has used keep the order they came
 * in (the catalogue's own), so an account with no history looks as before.
 */
export function byUsage<T>(items: T[], callsOf: (it: T) => number): T[] {
  return items
    .map((it, i) => ({ it, i, n: callsOf(it) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.it);
}

/** "2,7k" — short enough to sit next to a model id. */
export function fmtUses(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '').replace('.', ',')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')}M`;
}
