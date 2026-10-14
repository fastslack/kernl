<script lang="ts">
  /** Each model's total across the finished runs of the current suite, oldest to newest. */
  import { t, locale } from '$lib/i18n';
  import type { Overview } from './model.js';

  export let history: Overview['history'];
  export let colors: Record<string, string>;
  export let labels: Record<string, string>;

  const W = 640, H = 92, L = 26, R = 8, T = 8, B = 16;
  $: keys = [...new Set(history.flatMap((h) => Object.keys(h.totals)))];
  $: n = history.length;
  const x = (i: number, len: number) => (len <= 1 ? (L + W - R) / 2 : L + (i / (len - 1)) * (W - L - R));
  const y = (v: number) => T + (1 - v / 100) * (H - T - B);
  const day = (iso: string, loc: string) => new Date(iso).toLocaleDateString(loc, { day: '2-digit', month: '2-digit' });
  function path(k: string): string {
    return history.map((h, i) => [h.totals[k], i] as const).filter(([v]) => typeof v === 'number')
      .map(([v, i], j) => `${j ? 'L' : 'M'}${x(i, n).toFixed(1)},${y(v as number).toFixed(1)}`).join(' ');
  }
</script>

{#if n === 0}
  <p class="empty">{$t('bench.history.empty')}</p>
{:else}
  <svg viewBox="0 0 {W} {H}" role="img" aria-label={$t('bench.history.aria')} preserveAspectRatio="none">
    {#each [50, 100] as g (g)}
      <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} class="grid" /><text x={L - 4} y={y(g) + 3} class="ax" text-anchor="end">{g}</text>
    {/each}
    {#each history as h, i (h.id)}<text x={x(i, n)} y={H - 3} class="ax" text-anchor="middle">{day(h.started_at, $locale)}</text>{/each}
    {#each keys as k (k)}
      <path d={path(k)} fill="none" stroke={colors[k] ?? 'var(--text-3)'} stroke-width="2" />
      {#each history as h, i (h.id)}
        {#if typeof h.totals[k] === 'number'}
          <circle cx={x(i, n)} cy={y(h.totals[k] ?? 0)} r="2.5" fill={colors[k] ?? 'var(--text-3)'}><title>{labels[k] ?? k}: {h.totals[k]}</title></circle>
        {/if}
      {/each}
    {/each}
  </svg>
{/if}

<style>
  svg { width: 100%; height: 92px; display: block; }
  .grid { stroke: var(--border); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .ax { font-size: 9px; fill: var(--text-3); }
  .empty { margin: 0; font-size: 12px; color: var(--text-3); }
</style>
