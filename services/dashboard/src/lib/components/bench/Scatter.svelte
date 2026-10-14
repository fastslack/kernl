<script lang="ts">
  /**
   * Quality (total) against cost per task. The dot's size is the p50 latency:
   * bigger is slower. A model with an unknown cost sits on the right edge, hollow.
   */
  import { t } from '$lib/i18n';
  import { secs, shortModel, usd, type ModelRow } from './model.js';

  export let models: ModelRow[];
  export let colors: Record<string, string>;

  const W = 320, H = 170, L = 30, R = 12, T = 10, B = 24;
  $: pts = models.filter((m) => m.total !== null);
  $: maxCost = Math.max(0.000001, ...pts.map((m) => m.costPerTask ?? 0));
  $: maxP50 = Math.max(1, ...pts.map((m) => m.p50 ?? 0));
  const x = (c: number | null, max: number) => (c === null ? W - R : L + (c / max) * (W - L - R) * 0.92);
  const y = (v: number) => T + (1 - v / 100) * (H - T - B);
  const r = (p50: number | null, max: number) => 4 + 8 * Math.sqrt((p50 ?? 0) / max);
</script>

<svg viewBox="0 0 {W} {H}" role="img" aria-label={$t('bench.scatter.aria')}>
  {#each [0, 25, 50, 75, 100] as g (g)}
    <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} class="grid" />
    <text x={L - 5} y={y(g) + 3} class="ax" text-anchor="end">{g}</text>
  {/each}
  <text x={L} y={H - 6} class="ax">US$ 0</text>
  <text x={W - R} y={H - 6} class="ax" text-anchor="end">{usd(maxCost)}{$t('bench.perTask')}</text>
  {#each pts as m (m.key)}
    <g>
      <title>{m.name} · {m.model} — {m.total} · {usd(m.costPerTask)} · p50 {secs(m.p50)}</title>
      <circle cx={x(m.costPerTask, maxCost)} cy={y(m.total ?? 0)} r={r(m.p50, maxP50)}
        fill={m.costPerTask === null ? 'none' : colors[m.key]} stroke={colors[m.key]} stroke-width="2" fill-opacity="0.85" class="dot" style="color:{colors[m.key]}" />
      <text x={x(m.costPerTask, maxCost) + r(m.p50, maxP50) + 3} y={y(m.total ?? 0) + 3} class="lb"
        text-anchor={x(m.costPerTask, maxCost) > W * 0.7 ? 'end' : 'start'}
        dx={x(m.costPerTask, maxCost) > W * 0.7 ? -2 * r(m.p50, maxP50) - 6 : 0}>{shortModel(m.model)}</text>
    </g>
  {/each}
</svg>

<style>
  svg { width: 100%; height: auto; display: block; }
  .grid { stroke: var(--border); stroke-width: 1; }
  .ax { font-size: 9px; fill: var(--text-3); font-variant-numeric: tabular-nums; }
  .lb { font-size: 10.5px; font-weight: 600; fill: var(--text-1); }
  .dot { filter: drop-shadow(0 0 6px currentColor); }
</style>
