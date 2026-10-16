<script lang="ts">
  // panels.v1 `kpis` view: one card per row — value, change against the
  // previous period, sparkline, and the missing-data note when value is null.
  import { locale } from '$lib/i18n/index.js';
  export let rows: Array<Record<string, unknown>> = [];
  $: en = $locale.startsWith('en');
  const nf = (v: unknown, unit: unknown, en: boolean) => {
    if (typeof v !== 'number') return '—';
    const loc = en ? 'en-US' : 'es-AR';
    if (unit === 'money') return `US$ ${(v / 100).toLocaleString(loc, { maximumFractionDigits: 2 })}`;
    if (unit === 'pct') return `${v.toLocaleString(loc, { maximumFractionDigits: 1 })}%`;
    return v.toLocaleString(loc);
  };
  const path = (s: unknown) => {
    const a = Array.isArray(s) ? (s as unknown[]).filter((x): x is number => typeof x === 'number') : [];
    if (a.length < 2) return '';
    const max = Math.max(...a), min = Math.min(...a), span = max - min || 1;
    return a.map((y, i) => `${(i / (a.length - 1)) * 100},${28 - ((y - min) / span) * 26}`).join(' ');
  };
</script>

<div class="kpis">
  {#each rows as r (r.key)}
    <div class="kpi">
      <div class="label">{r.label ?? r.key}</div>
      {#if typeof r.value !== 'number'}
        <div class="value muted">—</div>
        <div class="missing">{r.missing ?? (en ? 'No data yet' : 'Sin datos todavía')}</div>
      {:else}
        <div class="row">
          <span class="value">{nf(r.value, r.unit, en)}</span>
          {#if typeof r.delta_pct === 'number'}
            <span class="delta" class:down={r.delta_pct < 0}>{r.delta_pct >= 0 ? '↑' : '↓'} {Math.abs(r.delta_pct).toFixed(0)}%</span>
          {/if}
        </div>
        {#if path(r.series)}
          <svg viewBox="0 0 100 30" preserveAspectRatio="none" class="spark" aria-hidden="true"><polyline points={path(r.series)} /></svg>
        {/if}
      {/if}
    </div>
  {/each}
</div>

<style>
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .kpi { background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; padding: 8px 10px; min-width: 0; }
  .label { font-size: 11px; opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row { display: flex; align-items: baseline; gap: 6px; }
  .value { font-size: 20px; font-weight: 700; }
  .value.muted { opacity: 0.4; }
  .missing { font-size: 11px; opacity: 0.6; }
  .delta { font-size: 12px; color: #34d399; }
  .delta.down { color: #f87171; }
  .spark { width: 100%; height: 22px; }
  .spark polyline { fill: none; stroke: #22d3ee; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
</style>
