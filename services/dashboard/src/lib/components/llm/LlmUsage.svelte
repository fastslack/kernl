<script lang="ts">
  /**
   * Settings → AI → Token usage, on one screen: totals, tokens per day, and
   * one dense row per model (or caller, or day). Clicking a model drills into
   * who spends it. Data: GET /api/llm/usage, the kernel's daily rollup.
   */
  import { onMount } from 'svelte';
  import { t, locale } from '$lib/i18n/index.js';
  import {
    fetchUsage, fillDays, rangeBounds, sumRows, totalTokens, fmtTokens, fmtInt, fmtCost,
    type UsageGroup, type UsageRange, type UsageRow, type UsageFilter,
  } from '$lib/llm-usage.js';

  const RANGES: UsageRange[] = ['today', '7d', '30d', 'all'];
  const GROUPS: UsageGroup[] = ['model', 'caller', 'day'];

  let range: UsageRange = '30d';
  let group: UsageGroup = 'model';
  let filter: UsageFilter = {};
  let rows: UsageRow[] = [];
  let days: UsageRow[] = [];
  let loading = false;
  let error = '';
  let seq = 0;

  async function load(): Promise<void> {
    const mine = ++seq;
    loading = true;
    try {
      const [r, d] = await Promise.all([
        fetchUsage(group, range, filter),
        group === 'day' ? Promise.resolve(null) : fetchUsage('day', range, filter),
      ]);
      if (mine !== seq) return;
      rows = r;
      const b = rangeBounds(range);
      days = fillDays(d ?? r, b.from, b.to);
      error = '';
    } catch (e) {
      if (mine === seq) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === seq) loading = false;
    }
  }

  onMount(load);

  function setRange(r: UsageRange) { range = r; void load(); }
  function setGroup(g: UsageGroup) { group = g; void load(); }
  function drill(r: UsageRow) {
    if (group !== 'model') return;
    filter = { slug: r.slug, model: r.key };
    group = 'caller';
    void load();
  }
  function clearFilter() { filter = {}; group = 'model'; void load(); }

  $: lc = $locale;
  $: total = sumRows(rows);
  $: maxTokens = Math.max(1, ...rows.map(totalTokens));
  $: maxDay = Math.max(1, ...days.map(totalTokens));
  $: label = (r: UsageRow) => (group === 'caller' && !r.key ? $t('llm.usage.untagged') : r.key);
</script>

<div class="us">
  <div class="us-bar">
    <div class="us-seg" role="radiogroup" aria-label={$t('llm.usage.tab')}>
      {#each RANGES as r (r)}
        <button type="button" role="radio" aria-checked={range === r} class:on={range === r} on:click={() => setRange(r)}>
          {$t(`llm.usage.range.${r}`)}
        </button>
      {/each}
    </div>
    <div class="us-seg" role="radiogroup" aria-label={$t('llm.usage.group.model')}>
      {#each GROUPS as g (g)}
        <button type="button" role="radio" aria-checked={group === g} class:on={group === g} on:click={() => setGroup(g)}>
          {$t(`llm.usage.group.${g}`)}
        </button>
      {/each}
    </div>
    {#if filter.model}
      <span class="us-chip">
        {$t('llm.usage.filtered', { model: filter.model })}
        <button type="button" aria-label={$t('llm.usage.clear_filter')} title={$t('llm.usage.clear_filter')} on:click={clearFilter}>✕</button>
      </span>
    {/if}
    <button type="button" class="us-btn" disabled={loading} on:click={load}>{$t('llm.usage.refresh')}</button>
  </div>

  {#if error}
    <p class="us-error" role="alert">{error}</p>
  {/if}

  <div class="us-tiles">
    <div class="us-tile">
      <span class="us-k">{$t('llm.usage.calls')}</span>
      <span class="us-v">{fmtInt(total.calls, lc)}</span>
      {#if total.fails}<span class="us-sub warn">{$t('llm.usage.fails_n', { n: fmtInt(total.fails, lc) })}</span>{/if}
    </div>
    <div class="us-tile">
      <span class="us-k"><i class="sw in"></i>{$t('llm.usage.input')}</span>
      <span class="us-v" title={fmtInt(total.inputTokens, lc)}>{fmtTokens(total.inputTokens, lc)}</span>
    </div>
    <div class="us-tile">
      <span class="us-k"><i class="sw out"></i>{$t('llm.usage.output')}</span>
      <span class="us-v" title={fmtInt(total.outputTokens, lc)}>{fmtTokens(total.outputTokens, lc)}</span>
    </div>
    <div class="us-tile">
      <span class="us-k"><i class="sw cache"></i>{$t('llm.usage.cache')}</span>
      <span class="us-v" title={fmtInt(total.cacheReadTokens, lc)}>{fmtTokens(total.cacheReadTokens, lc)}</span>
      <span class="us-sub">{$t('llm.usage.cache_write')}: {fmtTokens(total.cacheWriteTokens, lc)}</span>
    </div>
    <div class="us-tile">
      <span class="us-k">{$t('llm.usage.cost')}</span>
      <span class="us-v">{fmtCost(total.costUsd, total.costKind, lc)}</span>
    </div>
  </div>

  {#if days.length > 1}
    <div class="us-chart" role="img" aria-label={$t('llm.usage.chart_label')}>
      {#each days as d (d.key)}
        {@const tot = totalTokens(d)}
        <div
          class="us-col"
          title={`${d.key} · ${$t('llm.usage.input')} ${fmtInt(d.inputTokens, lc)} · ${$t('llm.usage.output')} ${fmtInt(d.outputTokens, lc)} · ${$t('llm.usage.cache')} ${fmtInt(d.cacheReadTokens + d.cacheWriteTokens, lc)}`}
        >
          <div class="us-stack" style="height:{(tot / maxDay) * 100}%">
            <span class="cache" style="flex-grow:{d.cacheReadTokens + d.cacheWriteTokens}"></span>
            <span class="out" style="flex-grow:{d.outputTokens}"></span>
            <span class="in" style="flex-grow:{d.inputTokens}"></span>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="us-table" role="table" aria-busy={loading}>
    <div class="us-row head" role="row">
      <span role="columnheader">{$t(`llm.usage.group.${group}`)}</span>
      <span role="columnheader" class="n">{$t('llm.usage.calls')}</span>
      <span role="columnheader" class="n">{$t('llm.usage.fails')}</span>
      <span role="columnheader" class="n">{$t('llm.usage.input')}</span>
      <span role="columnheader" class="n">{$t('llm.usage.output')}</span>
      <span role="columnheader" class="n" title={$t('llm.usage.cache_read')}>{$t('llm.usage.cache_read_short')}</span>
      <span role="columnheader" class="n" title={$t('llm.usage.cache_write')}>{$t('llm.usage.cache_write_short')}</span>
      <span role="columnheader" class="n">{$t('llm.usage.cost')}</span>
      <span role="columnheader">{$t('llm.usage.share')}</span>
    </div>
    <div class="us-body">
      {#each rows as r (`${r.slug ?? ''}\u0000${r.key}`)}
        <div
          class="us-row"
          class:click={group === 'model'}
          role="row"
          tabindex={group === 'model' ? 0 : -1}
          title={group === 'model' ? $t('llm.usage.drill', { model: r.key }) : undefined}
          on:click={() => drill(r)}
          on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), drill(r))}
        >
          <span role="cell" class="name">
            {#if r.slug}<span class="slug">{r.slug}</span>{/if}
            <span class="key" title={label(r)}>{label(r)}</span>
          </span>
          <span role="cell" class="n">{fmtInt(r.calls, lc)}</span>
          <span role="cell" class="n" class:warn={r.fails > 0}>{r.fails ? fmtInt(r.fails, lc) : '—'}</span>
          <span role="cell" class="n" title={fmtInt(r.inputTokens, lc)}>{fmtTokens(r.inputTokens, lc)}</span>
          <span role="cell" class="n" title={fmtInt(r.outputTokens, lc)}>{fmtTokens(r.outputTokens, lc)}</span>
          <span role="cell" class="n" title={fmtInt(r.cacheReadTokens, lc)}>{fmtTokens(r.cacheReadTokens, lc)}</span>
          <span role="cell" class="n" title={fmtInt(r.cacheWriteTokens, lc)}>{fmtTokens(r.cacheWriteTokens, lc)}</span>
          <span role="cell" class="n">{fmtCost(r.costUsd, r.costKind, lc)}</span>
          <span role="cell" class="share"><i style="width:{(totalTokens(r) / maxTokens) * 100}%"></i></span>
        </div>
      {:else}
        {#if !loading}<p class="us-empty">{$t('llm.usage.empty')}</p>{/if}
      {/each}
    </div>
  </div>

  <p class="us-note">{$t('llm.usage.note')}</p>
</div>

<style>
  .us { display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-height: 0; }
  /* Settings marks every child of a filling pane as non-shrinking; this one is the filler. */
  :global(.st-content.fill) > .us { flex-shrink: 1; }
  .us-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .us-seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .us-seg button {
    min-height: 32px; padding: 4px 12px; border: 0; border-right: 1px solid var(--border); background: transparent;
    color: var(--text-2); font-size: 13px; cursor: pointer; transition: background 150ms ease-out, color 150ms ease-out;
  }
  .us-seg button:last-child { border-right: 0; }
  .us-seg button:hover { color: var(--text-1); }
  .us-seg button.on { background: var(--surface-3); color: var(--text-1); font-weight: 600; }
  .us-seg button:focus-visible, .us-btn:focus-visible, .us-row.click:focus-visible, .us-chip button:focus-visible {
    outline: 2px solid var(--teal); outline-offset: -2px;
  }
  .us-chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 10px; border-radius: 999px;
    background: var(--surface-3); font-size: 12px; color: var(--text-1); font-family: var(--font-mono);
  }
  .us-chip button { min-width: 24px; min-height: 24px; border: 0; border-radius: 999px; background: transparent; color: var(--text-2); cursor: pointer; }
  .us-btn {
    margin-left: auto; min-height: 32px; padding: 4px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: transparent; color: var(--text-1); font-size: 13px; cursor: pointer;
  }
  .us-btn:disabled { opacity: 0.45; cursor: progress; }
  .us-error { margin: 0; color: var(--red); font-size: 13px; }

  .us-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
  .us-tile {
    display: flex; flex-direction: column; gap: 2px; padding: 8px 12px;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2);
  }
  .us-k { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
  .us-v { font-size: 20px; font-weight: 600; color: var(--text-1); font-variant-numeric: tabular-nums; }
  .us-sub { font-size: 12px; color: var(--text-2); }
  .warn { color: var(--orange); }
  .sw { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .sw.in, .us-stack .in { background: var(--blue); }
  .sw.out, .us-stack .out { background: var(--teal); }
  .sw.cache, .us-stack .cache { background: var(--purple); }

  .us-chart {
    display: flex; align-items: flex-end; gap: 2px; height: 72px; padding: 6px 8px;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2);
  }
  .us-col { flex: 1 1 0; height: 100%; display: flex; align-items: flex-end; min-width: 2px; }
  .us-stack { width: 100%; min-height: 1px; display: flex; flex-direction: column; border-radius: 2px 2px 0 0; overflow: hidden; }
  .us-stack span { flex-basis: 0; min-height: 0; }

  .us-table {
    flex: 1 1 auto; min-height: 120px; display: flex; flex-direction: column;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); overflow: hidden;
  }
  .us-body { overflow-y: auto; min-height: 0; flex: 1 1 auto; }
  .us-row {
    display: grid;
    grid-template-columns: minmax(160px, 1.8fr) repeat(6, minmax(74px, 0.7fr)) minmax(104px, 0.9fr) minmax(60px, 0.6fr);
    align-items: center; gap: 10px; min-height: 36px; padding: 2px 14px; border-bottom: 1px solid var(--border);
    font-size: 13px; color: var(--text-1);
  }
  .us-row.head { min-height: 32px; font-size: 12px; color: var(--text-2); font-weight: 600; background: var(--surface-1); }
  .us-row.click { cursor: pointer; }
  .us-row.click:hover { background: var(--surface-3); }
  .us-body .us-row:last-child { border-bottom: 0; }
  .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .us-row.head > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .slug { flex: none; padding: 1px 6px; border-radius: 4px; background: var(--surface-3); font-size: 11px; color: var(--text-2); }
  .key { font-family: var(--font-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .share { height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; }
  .share i { display: block; height: 100%; background: var(--teal); }
  .us-empty { margin: 0; padding: 20px 14px; color: var(--text-2); font-size: 13px; }
  .us-note { margin: 0; font-size: 12px; color: var(--text-2); }

  @media (max-width: 900px) {
    .us-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .us-row { grid-template-columns: minmax(140px, 1fr) repeat(3, 64px) 80px; }
    .us-row > :nth-child(3), .us-row > :nth-child(6), .us-row > :nth-child(7), .us-row > :nth-child(9) { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .us-seg button { transition: none; }
  }
</style>
