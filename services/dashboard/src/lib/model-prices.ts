/**
 * What each external model costs, from GET /api/llm/prices (the kernel prices
 * them from LiteLLM's public table). USD per million tokens, input and output.
 * Local runtimes and the Claude Code subscription are never priced.
 *
 * Loaded once per page and shared: every model picker on screen reads the
 * same map instead of each asking the kernel.
 */
import { writable, type Readable } from 'svelte/store';

export type ModelPrice = { inputPerMTok: number; outputPerMTok: number };

const map = writable<Map<string, ModelPrice>>(new Map());
let started = false;

type PriceRow = { provider: string; model: string } & ModelPrice;
function load(rows: PriceRow[] | undefined): number {
  const m = new Map<string, ModelPrice>();
  for (const p of rows ?? []) m.set(priceKey(p.provider, p.model), { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok });
  map.set(m);
  return m.size;
}

/**
 * Re-download the prices now (POST /api/llm/prices/refresh) and update every
 * picker on screen. Resolves to how many models are priced.
 */
export async function refreshPrices(): Promise<number> {
  const r = await fetch('/api/llm/prices/refresh', { method: 'POST' });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
  started = true;
  return load(b.prices);
}

export const priceKey = (provider: string, model: string) => `${provider}\u0000${model}`;

/** The shared price map; the first subscriber triggers the one fetch. */
export function modelPrices(): Readable<Map<string, ModelPrice>> {
  if (!started && typeof fetch !== 'undefined') {
    started = true;
    fetch('/api/llm/prices')
      .then((r) => (r.ok ? r.json() : { prices: [] }))
      .then((b: { prices?: PriceRow[] }) => { load(b.prices); })
      .catch(() => { started = false; });
  }
  return map;
}

/** "$0.15 / $0.60" — two decimals, more only when the price needs them; "free" at zero. */
export function fmtPrice(p: ModelPrice): string {
  if (p.inputPerMTok === 0 && p.outputPerMTok === 0) return 'free';
  const one = (n: number) => {
    if (n === 0) return '$0';
    const digits = n >= 1 ? 2 : 4;
    return `$${n.toFixed(digits).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')}`;
  };
  return `${one(p.inputPerMTok)} / ${one(p.outputPerMTok)}`;
}
