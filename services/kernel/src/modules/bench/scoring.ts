/**
 * From attempts to the numbers on the screen. Pure: the service feeds it the
 * rows of one run, the screen shows what comes out.
 *
 * - Task = mean of its scored attempts (provider errors left out); stdev kept.
 * - Category = mean of its tasks that ran. Total = weighted mean over the
 *   categories that ran, so a provider that cannot run tool tasks is compared
 *   on what it did run — and its coverage says how much that is.
 * - Ranking uses total × coverage, so a high score on half the suite does not
 *   outrank a slightly lower one on all of it.
 */

import { CATEGORIES, CATEGORY_WEIGHTS, type BenchTask, type Category } from "./types.js";

export interface ResultRow {
  slug: string;
  model: string;
  taskId: string;
  category: Category;
  status: "ok" | "provider_error" | "na";
  score: number;
  invalid: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface TaskScore { mean: number | null; stdev: number; n: number; status: "ok" | "na" | "provider_error" }

export interface ModelSummary {
  key: string;
  slug: string;
  model: string;
  /** 0..100, over the categories that ran; null when nothing was scored. */
  total: number | null;
  /** Share of the suite's weight that ran (0..1). */
  coverage: number;
  /** total × coverage — the ranking order. */
  rankScore: number;
  categories: Record<Category, number | null>;
  tasks: Record<string, TaskScore>;
  attempts: number;
  p50: number | null;
  p95: number | null;
  avgInputTokens: number;
  avgOutputTokens: number;
  /** Mean USD per scored attempt; null when no cost is known. */
  costPerTask: number | null;
  invalidRate: number;
  providerErrorRate: number;
}

export interface Highlights { winner: string | null; bestValue: string | null; fastest: string | null; mostReliable: string | null }

export const modelKey = (slug: string, model: string) => `${slug}/${model}`;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Nearest-rank percentile. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export function summarize(rows: ResultRow[], suite: readonly BenchTask[]): ModelSummary[] {
  const byModel = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const k = modelKey(r.slug, r.model);
    if (!byModel.has(k)) byModel.set(k, []);
    byModel.get(k)!.push(r);
  }
  const perCategory = new Map<Category, number>();
  for (const t of suite) perCategory.set(t.category, (perCategory.get(t.category) ?? 0) + 1);
  // Coverage is relative to the suite's own weight (all seven categories in the real one).
  const suiteWeight = [...perCategory.keys()].reduce((w, c) => w + CATEGORY_WEIGHTS[c], 0);

  const out: ModelSummary[] = [];
  for (const [key, rs] of byModel) {
    const tasks: Record<string, TaskScore> = {};
    for (const t of suite) {
      const mine = rs.filter((r) => r.taskId === t.id);
      if (!mine.length) continue;
      const scored = mine.filter((r) => r.status === "ok").map((r) => r.score);
      const status = scored.length ? "ok" : mine.some((r) => r.status === "na") ? "na" : "provider_error";
      const m = scored.length ? mean(scored) : null;
      const sd = scored.length > 1 ? Math.sqrt(mean(scored.map((x) => (x - m!) ** 2))) : 0;
      tasks[t.id] = { mean: m, stdev: sd, n: scored.length, status };
    }
    const categories = {} as Record<Category, number | null>;
    let weighted = 0, weightRan = 0, coverage = 0;
    for (const c of CATEGORIES) {
      const ran = suite.filter((t) => t.category === c && tasks[t.id]?.status === "ok").map((t) => tasks[t.id].mean!);
      categories[c] = ran.length ? round1(mean(ran) * 100) : null;
      if (ran.length) {
        weighted += CATEGORY_WEIGHTS[c] * mean(ran);
        weightRan += CATEGORY_WEIGHTS[c];
        coverage += CATEGORY_WEIGHTS[c] * (ran.length / (perCategory.get(c) ?? ran.length));
      }
    }
    const total = weightRan ? round1((weighted / weightRan) * 100) : null;
    coverage = suiteWeight ? coverage / suiteWeight : 0;
    const ok = rs.filter((r) => r.status === "ok");
    const live = rs.filter((r) => r.status !== "na");
    const costs = ok.map((r) => r.costUsd).filter((c): c is number => typeof c === "number");
    out.push({
      key, slug: rs[0].slug, model: rs[0].model,
      total, coverage: Math.round(coverage * 1000) / 1000,
      rankScore: total === null ? 0 : round1(total * coverage),
      categories, tasks,
      attempts: live.length,
      p50: percentile(ok.map((r) => r.latencyMs), 50),
      p95: percentile(ok.map((r) => r.latencyMs), 95),
      avgInputTokens: Math.round(mean(ok.map((r) => r.inputTokens))),
      avgOutputTokens: Math.round(mean(ok.map((r) => r.outputTokens))),
      costPerTask: costs.length && costs.length === ok.length ? mean(costs) : null,
      invalidRate: ok.length ? ok.filter((r) => r.invalid).length / ok.length : 0,
      providerErrorRate: live.length ? live.filter((r) => r.status === "provider_error").length / live.length : 0,
    });
  }
  return out.sort((a, b) => b.rankScore - a.rankScore);
}

/**
 * The four cards. Best value: the cheapest model within 15 % of the best
 * total (a free model that scores far lower is not "value"). Most reliable:
 * fewest invalid outputs and provider errors.
 */
export function highlights(models: ModelSummary[]): Highlights {
  const scored = models.filter((m) => m.total !== null);
  if (!scored.length) return { winner: null, bestValue: null, fastest: null, mostReliable: null };
  const winner = scored[0].key;
  const best = Math.max(...scored.map((m) => m.total!));
  const close = scored.filter((m) => m.total! >= best * 0.85 && m.costPerTask !== null);
  const bestValue = close.sort((a, b) => a.costPerTask! - b.costPerTask! || b.total! - a.total!)[0]?.key ?? null;
  const fastest = [...scored].filter((m) => m.p50 !== null).sort((a, b) => a.p50! - b.p50!)[0]?.key ?? null;
  const failRate = (m: ModelSummary) => m.invalidRate * (1 - m.providerErrorRate) + m.providerErrorRate;
  const mostReliable = [...scored].sort((a, b) => failRate(a) - failRate(b) || b.total! - a.total!)[0]?.key ?? null;
  return { winner, bestValue, fastest, mostReliable };
}
