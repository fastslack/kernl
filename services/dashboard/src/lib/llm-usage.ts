/**
 * Token usage per model, caller or day — GET /api/llm/usage, read from the
 * kernel's daily rollup of every LLM call. Days are UTC, as the kernel
 * buckets them.
 */

export type UsageGroup = 'model' | 'caller' | 'day';
export type UsageRange = 'today' | '7d' | '30d' | 'all';
export type CostKind = 'reported' | 'estimated' | 'mixed' | 'none';

export interface UsageRow {
  key: string;
  slug?: string;
  calls: number;
  fails: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costKind: CostKind;
}

export interface UsageFilter {
  slug?: string;
  model?: string;
}

const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Inclusive UTC day bounds for a range chip; `all` has none. */
export function rangeBounds(range: UsageRange, now = Date.now()): { from?: string; to?: string } {
  if (range === 'all') return {};
  const back = range === 'today' ? 0 : range === '7d' ? 6 : 29;
  return { from: utcDay(now - back * DAY_MS), to: utcDay(now) };
}

export function usageUrl(group: UsageGroup, range: UsageRange, filter: UsageFilter = {}, now = Date.now()): string {
  const q = new URLSearchParams({ group, ...rangeBounds(range, now) });
  if (filter.slug) q.set('slug', filter.slug);
  if (filter.model) q.set('model', filter.model);
  return `/api/llm/usage?${q}`;
}

export async function fetchUsage(group: UsageGroup, range: UsageRange, filter: UsageFilter = {}): Promise<UsageRow[]> {
  const r = await fetch(usageUrl(group, range, filter));
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
  return (b.rows ?? []) as UsageRow[];
}

/**
 * Day rows with the missing days filled in as zeros, so a bar chart's x axis
 * is time and a quiet week reads as a gap, not as nothing.
 */
export function fillDays(rows: UsageRow[], from?: string, to?: string): UsageRow[] {
  const sorted = [...rows].sort((a, b) => a.key.localeCompare(b.key));
  const first = from ?? sorted[0]?.key;
  const last = to ?? sorted[sorted.length - 1]?.key;
  if (!first || !last) return sorted;
  const byDay = new Map(sorted.map((r) => [r.key, r]));
  const out: UsageRow[] = [];
  for (let ms = Date.parse(`${first}T00:00:00Z`); ms <= Date.parse(`${last}T00:00:00Z`); ms += DAY_MS) {
    const day = utcDay(ms);
    out.push(byDay.get(day) ?? {
      key: day, calls: 0, fails: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costKind: 'none',
    });
  }
  return out;
}

export const totalTokens = (r: UsageRow) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;

/** Column totals for the summary tiles. */
export function sumRows(rows: UsageRow[]): UsageRow {
  const kinds = new Set(rows.filter((r) => totalTokens(r) > 0 || r.costUsd > 0).map((r) => r.costKind));
  const priced = [...kinds].filter((k) => k !== 'none');
  const costKind: CostKind = priced.length === 0 ? 'none'
    : priced.length === 1 && !kinds.has('none') && priced[0] !== 'mixed' ? priced[0] : 'mixed';
  return rows.reduce<UsageRow>((a, r) => ({
    ...a,
    calls: a.calls + r.calls,
    fails: a.fails + r.fails,
    inputTokens: a.inputTokens + r.inputTokens,
    outputTokens: a.outputTokens + r.outputTokens,
    cacheReadTokens: a.cacheReadTokens + r.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + r.cacheWriteTokens,
    costUsd: a.costUsd + r.costUsd,
  }), {
    key: '', calls: 0, fails: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costKind,
  });
}

/** "1,8 M" / "262 k" — compact, in the UI's locale. */
export function fmtTokens(n: number, locale: string): string {
  if (n === 0) return '0';
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: n < 1e4 ? 0 : 1 }).format(n);
}

export function fmtInt(n: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

/** "$12.40", "≈ $0.03", "—"; cents below one cent show as "< $0.01". */
export function fmtCost(usd: number, kind: CostKind, locale: string): string {
  if (kind === 'none' && usd === 0) return '—';
  const money = usd > 0 && usd < 0.01
    ? `< ${new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(0.01)}`
    : new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(usd);
  return kind === 'reported' ? money : `≈ ${money}`;
}
