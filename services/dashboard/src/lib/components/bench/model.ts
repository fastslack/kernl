/** Shapes the /bench screen reads from the bench.* RPC, and the formatters it shares. */

export type Category = 'tools' | 'agent' | 'json' | 'numbers' | 'language' | 'context' | 'safety';
export const CATEGORIES: Category[] = ['tools', 'agent', 'json', 'numbers', 'language', 'context', 'safety'];

export interface TaskScore { mean: number | null; stdev: number; n: number; status: 'ok' | 'na' | 'provider_error' }

export interface ModelRow {
  key: string; slug: string; model: string; name: string; supportsTools: boolean;
  total: number | null; coverage: number; rankScore: number;
  categories: Record<Category, number | null>;
  tasks: Record<string, TaskScore>;
  attempts: number; p50: number | null; p95: number | null;
  avgInputTokens: number; avgOutputTokens: number;
  costPerTask: number | null; invalidRate: number; providerErrorRate: number;
}

export interface Run {
  id: string; suite_version: number; status: 'running' | 'done' | 'cancelled' | 'interrupted' | 'failed';
  targets: Array<{ slug: string; name: string; model: string; supportsTools: boolean }>;
  planned: number; done: number; current: string; error: string; started_at: string; finished_at: string | null;
}

export interface Report {
  run: Run;
  models: ModelRow[];
  highlights: { winner: string | null; bestValue: string | null; fastest: string | null; mostReliable: string | null };
}

export interface Overview {
  suiteVersion: number;
  attemptsPerTask: number;
  categories: Array<{ id: Category; weight: number; tasks: number }>;
  tasks: Array<{ id: string; category: Category; title: string; needsTools: boolean }>;
  targets: Array<{ slug: string; name: string; model: string; supportsTools: boolean }>;
  active: Run | null;
  latest: Report | null;
  runs: Run[];
  history: Array<{ id: string; started_at: string; status: string; totals: Record<string, number | null> }>;
}

export interface Attempt {
  attempt: number; status: string; score: number; detail: string; invalid: string;
  latency_ms: number; input_tokens: number; output_tokens: number; cost_usd: number | null;
  iterations: number; output: string; calls: Array<{ name: string; input: Record<string, unknown> }>; error: string;
}

/**
 * The model palette: vivid on the dark surfaces, and set as plain colors
 * rather than the global accent tokens, because a user theme may repaint
 * those (one turned the whole bench grey). Each provider keeps its color
 * everywhere — the bench, the LIVE popover — so a model is recognisable at
 * a glance wherever it shows up.
 */
export const PALETTE = {
  cyan: '#22D3EE', violet: '#A78BFA', pink: '#F472B6', gold: '#FBBF24', emerald: '#34D399', sky: '#60A5FA', orange: '#FB923C', lime: '#A3E635',
};
const BY_PROVIDER: Record<string, string> = {
  nvidia: PALETTE.cyan, openai: PALETTE.violet, minimax: PALETTE.pink, 'claude-code': PALETTE.gold, claude_code: PALETTE.gold,
  claude: PALETTE.orange, anthropic: PALETTE.orange, gemini: PALETTE.sky, google: PALETTE.sky, groq: PALETTE.emerald,
  deepseek: PALETTE.sky, mistral: PALETTE.orange, openrouter: PALETTE.lime, ollama: PALETTE.emerald, lmstudio: PALETTE.lime,
};
const CYCLE = Object.values(PALETTE);

/** A provider's color: fixed for the known ones, stable by name for the rest. */
export function modelColor(slug: string): string {
  if (BY_PROVIDER[slug]) return BY_PROVIDER[slug];
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CYCLE[h % CYCLE.length];
}

/**
 * Chart marks (bars, slices, segments) take the same hues one step deeper:
 * the bright UI accents above sit outside the lightness band a data mark needs
 * on a dark surface. This set was run through the dataviz palette validator
 * (dark, surface #17181B): band, chroma, CVD and contrast all pass; the
 * emerald/amber pair is in the 6–8 CVD floor, so every mark that uses it is
 * direct-labeled.
 */
const DEEP: Record<string, string> = {
  [PALETTE.cyan]: '#0891B2', [PALETTE.violet]: '#8B5CF6', [PALETTE.pink]: '#EC4899', [PALETTE.gold]: '#D97706',
  [PALETTE.emerald]: '#059669', [PALETTE.sky]: '#3B82F6', [PALETTE.orange]: '#EA580C', [PALETTE.lime]: '#65A30D',
};
/** Categorical order for charts whose series are not providers (storage kinds, triggers…). */
export const CHART_SERIES = ['#0891B2', '#8B5CF6', '#EC4899', '#D97706', '#059669', '#3B82F6'];
/** A provider's color as a chart mark. */
export const chartColor = (slug: string): string => DEEP[modelColor(slug)] ?? modelColor(slug);
/** Reserved for state — never a series color; always shown with its label. */
export const STATUS_COLORS = { good: '#16A34A', running: '#6366F1', critical: '#DC2626', neutral: '#6B7280' };

/** Score bands 0..100: coral → amber → yellow → green → emerald. */
export const SCORE_COLORS = ['#F43F5E', '#FB923C', '#FACC15', '#4ADE80', '#10B981'];

/** Score 0..100 → its band color. */
export function scoreBand(v: number | null): string {
  if (v === null) return 'transparent';
  return SCORE_COLORS[v >= 90 ? 4 : v >= 75 ? 3 : v >= 60 ? 2 : v >= 40 ? 1 : 0];
}

/** A score cell's fill: its band, strong enough to read as color, light enough for white text. */
export function scoreTint(v: number | null): string {
  return v === null ? 'transparent' : `color-mix(in srgb, ${scoreBand(v)} 42%, transparent)`;
}

/** "nvidia/nemotron-3-super-120b-a12b" → "nemotron-3-super-120b-a12b"; the provider is shown next to it anyway. */
export const shortModel = (model: string) => model.split('/').pop() || model;

export const secs = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
export const pct0 = (x: number) => `${Math.round(x * 100)} %`;
export function usd(x: number | null): string {
  if (x === null) return '—';
  if (x === 0) return 'US$ 0';
  return x < 0.01 ? `US$ ${x.toFixed(4)}` : `US$ ${x.toFixed(3)}`;
}

/** Inline SVG paths (Lucide, 24×24, stroke) — the cards' icons, no emoji. */
export const ICON = {
  trophy: 'M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z',
  coins: 'M8 8a6 6 0 1 0 0 12A6 6 0 1 0 8 8zM18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1zM9 12l2 2 4-4',
  play: 'M6 3l14 9-14 9V3z',
  gauge: 'M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0',
};
