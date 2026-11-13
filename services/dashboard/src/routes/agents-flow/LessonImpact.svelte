<script lang="ts">
  /**
   * C6 · Did it help? One lesson: the runs that carried it against the runs the
   * same agents made without it since it exists (one traversal on the agents'
   * experience graph), who used it, and how its confidence moved run by run.
   */
  import { onMount } from 'svelte';
  import { apiFetch } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';

  export let id: string;

  type Impact = {
    owner: { id: string; name: string };
    type: string; content: string; confidence: number; active: boolean;
    with: { runs: number; ok: number };
    without: { runs: number; ok: number };
    agents: Array<{ id: string; name: string; runs: number; ok: number; shared: boolean }>;
    query_ms: number | null;
    cypher: string;
  };
  type Point = { at: string; after: number; delta: number; agent_name: string; cause: string };

  let impact: Impact | null = null;
  let history: Point[] = [];
  let loading = true;
  let failed = false;
  let showQuery = false;

  onMount(async () => {
    try {
      const r = (await apiFetch(`/api/agents/learnings/${encodeURIComponent(id)}/impact`)) as { impact: Impact | null; history: Point[] };
      impact = r.impact;
      history = r.history ?? [];
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  });

  const rate = (s: { runs: number; ok: number }) => (s.runs ? s.ok / s.runs : 0);
  $: enough = !!impact && impact.with.runs >= 2 && impact.without.runs >= 2;
  $: lift = impact ? Math.round((rate(impact.with) - rate(impact.without)) * 100) : 0;

  // Confidence sparkline: one point per change, 0..1 on a 120×28 box.
  const W = 120, H = 28;
  $: pts = history.map((h, i) => {
    const x = history.length > 1 ? (i / (history.length - 1)) * W : W / 2;
    return `${x.toFixed(1)},${(H - 2 - h.after * (H - 4)).toFixed(1)}`;
  }).join(' ');
  $: first = history[0]?.after;
  $: last = history.at(-1)?.after;
  const pct = (v: number | undefined) => (v === undefined ? '' : `${Math.round(v * 100)}%`);
</script>

{#if loading}
  <div class="li li-loading">{$t('li.loading')}</div>
{:else if !failed && (impact || history.length)}
  <section class="li" aria-label={$t('li.title')}>
    <header class="li-head">
      <span class="li-title">{$t('li.title')}</span>
      {#if impact?.owner?.name}<span class="li-owner">{$t('li.from', { who: impact.owner.name })}</span>{/if}
      {#if impact && !impact.active}<span class="li-retired">{$t('li.retired')}</span>{/if}
    </header>
    {#if impact?.content}<p class="li-content">{impact.content.replace(/^\[auto\]\s*/, '')}</p>{/if}

    {#if impact}
      <div class="li-bars">
        {#each [{ k: 'li.with', s: impact.with, cls: 'with' }, { k: 'li.without', s: impact.without, cls: 'without' }] as row (row.k)}
          <div class="li-row">
            <span class="li-row-label">{$t(row.k)}</span>
            <span class="li-track"><span class="li-fill li-{row.cls}" style="width:{Math.round(rate(row.s) * 100)}%"></span></span>
            <span class="li-num">{row.s.runs ? `${Math.round(rate(row.s) * 100)}%` : '—'}</span>
            <span class="li-sub">{$t('li.ok', { ok: row.s.ok, n: row.s.runs })}</span>
          </div>
        {/each}
      </div>
      <p class="li-verdict" class:up={enough && lift > 0} class:down={enough && lift < 0}>
        {#if !enough}{$t('li.few')}
        {:else if lift > 0}{$t('li.lift.up', { pts: lift })}
        {:else if lift < 0}{$t('li.lift.down', { pts: -lift })}
        {:else}{$t('li.lift.flat')}{/if}
      </p>
      {#if impact.agents.length}
        <div class="li-agents">
          <span class="li-row-label">{$t('li.usedBy')}</span>
          {#each impact.agents.slice(0, 6) as a (a.id)}
            <span class="li-chip" class:shared={a.shared}>{a.name || a.id.slice(0, 8)} <b>{a.ok}/{a.runs}</b></span>
          {/each}
        </div>
      {/if}
    {:else}
      <p class="li-note">{$t('li.noGraph')}</p>
    {/if}

    {#if history.length}
      <div class="li-conf">
        <span class="li-row-label">{$t('li.confidence')}</span>
        <svg viewBox="0 0 {W} {H}" width={W} height={H} aria-hidden="true">
          <line x1="0" x2={W} y1={H - 2 - 0.15 * (H - 4)} y2={H - 2 - 0.15 * (H - 4)} class="li-floor" />
          <polyline points={pts} class="li-line" />
        </svg>
        <span class="li-num">{pct(first)} → {pct(last)}</span>
        <span class="li-sub">{history.length} ×</span>
      </div>
    {/if}

    {#if impact}
      <footer class="li-foot">
        {#if impact.query_ms != null}<span>{$t('li.engine', { ms: impact.query_ms.toFixed(2) })}</span>{/if}
        <button type="button" class="li-q" on:click={() => (showQuery = !showQuery)} aria-expanded={showQuery}>{$t('li.query')}</button>
      </footer>
      {#if showQuery}<pre class="li-cypher">{impact.cypher}</pre>{/if}
    {/if}
  </section>
{/if}

<style>
  .li{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:7px;
    background:linear-gradient(180deg,rgba(166,107,255,.08),rgba(166,107,255,.03));
    border:1px solid rgba(166,107,255,.28)}
  .li-loading{font:500 11px 'Manrope',sans-serif;color:#8a8fa8}
  .li-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  .li-title{font:700 10px 'Syne',sans-serif;letter-spacing:1.1px;text-transform:uppercase;color:#c9a8ff}
  .li-owner{font:500 11px 'Manrope',sans-serif;color:#a0a5b8}
  .li-retired{font:600 9px 'JetBrains Mono',monospace;padding:1px 5px;border-radius:3px;background:rgba(239,93,110,.15);color:#f3a0aa}
  .li-content{margin:0;font:400 12px/1.5 'Manrope',sans-serif;color:#dfe3ee}
  .li-bars{display:flex;flex-direction:column;gap:5px}
  .li-row,.li-conf,.li-agents{display:grid;grid-template-columns:150px 1fr auto auto;align-items:center;gap:8px}
  .li-agents{display:flex;flex-wrap:wrap}
  .li-row-label{font:600 10px 'Manrope',sans-serif;color:#8a8fa8}
  .li-track{height:8px;border-radius:4px;background:rgba(120,130,160,.15);overflow:hidden;min-width:60px}
  .li-fill{display:block;height:100%;border-radius:4px;transition:width .5s ease-out}
  .li-with{background:#a66bff}
  .li-without{background:#6c7393}
  .li-num{font:600 12px 'JetBrains Mono',monospace;color:#e0e3ee;font-variant-numeric:tabular-nums}
  .li-sub{font:400 10px 'JetBrains Mono',monospace;color:#8a8fa8}
  .li-verdict{margin:0;font:700 12px 'Manrope',sans-serif;color:#a0a5b8}
  .li-verdict.up{color:#5fdba0}
  .li-verdict.down{color:#ef5d6e}
  .li-chip{font:500 10px 'Manrope',sans-serif;padding:2px 7px;border-radius:10px;background:rgba(120,130,160,.15);color:#c8ccda}
  .li-chip.shared{background:rgba(166,107,255,.18);color:#e2d2ff}
  .li-chip b{font:600 10px 'JetBrains Mono',monospace}
  .li-conf svg{overflow:visible}
  .li-line{fill:none;stroke:#c9a8ff;stroke-width:1.6;stroke-linejoin:round}
  .li-floor{stroke:rgba(239,93,110,.45);stroke-dasharray:2 3;stroke-width:1}
  .li-note{margin:0;font:400 11px 'Manrope',sans-serif;color:#8a8fa8}
  .li-foot{display:flex;justify-content:space-between;align-items:center;font:500 10px 'JetBrains Mono',monospace;color:#8a8fa8}
  .li-q{background:none;border:1px solid rgba(166,107,255,.35);color:#c9a8ff;border-radius:4px;padding:1px 7px;font:600 10px 'JetBrains Mono',monospace;cursor:pointer}
  .li-q:focus-visible{outline:2px solid #c9a8ff;outline-offset:2px}
  .li-cypher{margin:0;padding:8px;border-radius:5px;background:rgba(0,0,0,.35);font:400 10px/1.5 'JetBrains Mono',monospace;color:#cfd3e2;white-space:pre-wrap;overflow-x:auto}
  @media (max-width:520px){ .li-row,.li-conf{grid-template-columns:1fr auto} .li-track{grid-column:1 / -1} }
</style>
