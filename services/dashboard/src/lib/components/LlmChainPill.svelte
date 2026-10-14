<script lang="ts">
  import { onMount } from 'svelte';
  import { wsConnected } from '$lib/stores.js';
  import { t } from '$lib/i18n';
  import { rpcPost } from '$lib/api';
  import { fmtSince, fmtCountdown, type ChainData, type ChainLink } from '$lib/llm-chain.js';
  import { modelColor, scoreBand, shortModel } from '$lib/components/bench/model.js';

  // ── LIVE pill: the stream status, and the models Kernl is running on ─────
  // The pill carries one dot per model of the chain, in the color the bench
  // gives that provider. The popover lists them with their health (fetched on
  // every open, so a 403 between yesterday and now shows up) and the score
  // each one got in the latest bench run.
  let liveOpen = false;
  let chainData: ChainData | null = null;
  let chainErr = '';
  let chainLoading = false;
  /** Latest bench total per "<slug>/<model>", and per slug for a link with no explicit model. */
  let scores: Record<string, number> = {};

  async function loadChain() {
    chainLoading = true; chainErr = '';
    try {
      const r = await fetch('/api/llm/chain');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      chainData = await r.json();
    } catch (err) {
      chainErr = err instanceof Error ? err.message : String(err);
      chainData = null;
    } finally { chainLoading = false; }
  }
  async function loadScores() {
    try {
      const ov = await rpcPost('bench.overview');
      const next: Record<string, number> = {};
      for (const m of ov?.latest?.models ?? []) {
        if (typeof m.total !== 'number') continue;
        next[`${m.slug}/${m.model}`] = m.total;
        next[m.slug] ??= m.total;
      }
      scores = next;
    } catch { /* no bench yet, or the kernel predates it: no scores */ }
  }
  function toggleLive() {
    liveOpen = !liveOpen;
    if (liveOpen) { loadChain(); loadScores(); }
  }
  onMount(loadChain);

  // Svelte action — closes the popover when the user clicks anywhere
  // outside its wrapper. Inlined here because it's the only consumer.
  function clickOutside(node: HTMLElement, onOutside: () => void) {
    function handle(ev: MouseEvent) {
      if (node && !node.contains(ev.target as Node)) onOutside();
    }
    document.addEventListener('mousedown', handle, true);
    return { destroy() { document.removeEventListener('mousedown', handle, true); } };
  }

  $: links = chainData ? [chainData.primary, ...chainData.fallbacks] : [];
  const scoreOf = (l: ChainLink) => scores[`${l.slug}/${l.model}`] ?? scores[l.slug];
  const STATUS_TONE: Record<ChainLink['status'], string> = {
    active: '#34D399', standby: '#94A3B8', 'no-key': '#64748B', quota: '#FBBF24', 'rate-limit': '#FBBF24', auth: '#F43F5E', degraded: '#FB923C',
  };
</script>

<div class="live-pill-wrap" use:clickOutside={() => { liveOpen = false; }}>
  <button
    type="button"
    class="ws-pill ws-pill-btn"
    class:connected={$wsConnected}
    class:open={liveOpen}
    on:click={toggleLive}
    aria-expanded={liveOpen}
    title={$t('live.pillTitle')}
  >
    <span class="ws-dot"></span>
    <span class="ws-label">{$wsConnected ? 'LIVE' : 'POLL'}</span>
    {#if links.length}
      <span class="lc-dots" aria-hidden="true">
        {#each links.slice(0, 4) as l, i (l.slug + i)}<i style="background:{modelColor(l.slug)};color:{modelColor(l.slug)}" class:dim={l.status !== 'active' && l.status !== 'standby'}></i>{/each}
      </span>
    {/if}
  </button>
  {#if liveOpen}
    <div class="lc-pop" role="dialog" aria-label={$t('live.title')}>
      <header class="lc-head">
        <div>
          <div class="lc-title">{$t('live.title')}</div>
          <div class="lc-sub">{$t('live.sub')}</div>
        </div>
        <button type="button" class="lc-refresh" on:click={() => { loadChain(); loadScores(); }} title={$t('live.refresh')} aria-label={$t('live.refresh')} disabled={chainLoading}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" /></svg>
        </button>
      </header>
      {#if chainLoading && !chainData}
        <div class="lc-empty">{$t('live.loading')}</div>
      {:else if chainErr}
        <div class="lc-empty lc-err">{$t('live.error', { err: chainErr })}</div>
      {:else if !links.length}
        <div class="lc-empty">{$t('live.empty')}</div>
      {:else}
        <ul class="lc-list">
          {#each links as link, i (link.slug + ':' + i)}
            {@const c = modelColor(link.slug)}
            {@const sc = scoreOf(link)}
            <li class="lc-row" style="--c:{c};--tone:{STATUS_TONE[link.status]}">
              <span class="lc-rank" title={i === 0 ? $t('live.primary') : $t('live.fallback', { n: i })}>{i === 0 ? '★' : i}</span>
              <span class="lc-dot"></span>
              <div class="lc-main">
                <div class="lc-model" title={link.model}>{link.model ? shortModel(link.model) : $t('live.defaultModel')}</div>
                <div class="lc-meta">
                  <span class="lc-prov">{link.slug}</span>
                  {#if link.latencyMs !== undefined}<span>{Math.round(link.latencyMs)} ms</span>{/if}
                  {#if link.lastSuccessAt}<span title={$t('live.lastOk')}>✓ {fmtSince(link.lastSuccessAt)}</span>{/if}
                  {#if link.blockedForMs && link.blockedForMs > 0}<span class="lc-warn">{$t('live.retryIn', { t: fmtCountdown(link.blockedForMs) })}</span>{/if}
                </div>
                {#if link.reason}<div class="lc-reason">{link.reason}</div>{/if}
              </div>
              <span class="lc-status">{$t(`live.status.${link.status}`)}</span>
              {#if sc !== undefined}
                <a class="lc-score" href="/bench" on:click={() => (liveOpen = false)} title={$t('live.benchScore')} style="--band:{scoreBand(sc)}">{Math.round(sc)}</a>
              {:else}
                <span class="lc-score none" title={$t('live.noScore')}>—</span>
              {/if}
            </li>
          {/each}
        </ul>
        <footer class="lc-foot">
          <a href="/bench" on:click={() => (liveOpen = false)}>{$t('live.toBench')} →</a>
          <!-- /models is a redirect stub onto the AI section of Settings; link the real destination. -->
          <a href="/settings?section=ai" on:click={() => (liveOpen = false)}>{$t('live.configure')} →</a>
        </footer>
      {/if}
    </div>
  {/if}
</div>

<style>
  .lc-dots { display: inline-flex; gap: 3px; margin-left: 6px; }
  .lc-dots i { width: 6px; height: 6px; border-radius: 50%; box-shadow: 0 0 6px currentColor; }
  .lc-dots i.dim { opacity: .35; box-shadow: none; }

  .lc-pop {
    position: absolute; right: 0; top: calc(100% + 8px); z-index: var(--z-modal, 40); width: 400px; max-width: calc(100vw - 24px);
    border-radius: 14px; overflow: hidden; color: var(--text-1);
    background: linear-gradient(160deg, color-mix(in srgb, #A78BFA 10%, var(--surface-1)), var(--surface-1) 45%);
    border: 1px solid color-mix(in srgb, #22D3EE 30%, var(--border));
    box-shadow: 0 18px 40px -12px rgba(0, 0, 0, .6), 0 0 0 1px rgba(255, 255, 255, .02);
  }
  .lc-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px 10px; border-bottom: 1px solid var(--border); }
  .lc-title {
    font-size: 14px; font-weight: 800; letter-spacing: -.01em;
    background: linear-gradient(90deg, #22D3EE, #A78BFA 60%, #F472B6); -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .lc-sub { font-size: 11px; color: var(--text-3); margin-top: 1px; }
  .lc-refresh { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); cursor: pointer; }
  .lc-refresh svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .lc-refresh:hover:not(:disabled) { color: #22D3EE; border-color: #22D3EE; }
  .lc-refresh:disabled svg { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .lc-empty { padding: 18px; text-align: center; font-size: 12px; color: var(--text-3); }
  .lc-err { color: #F43F5E; }
  .lc-list { list-style: none; margin: 0; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
  .lc-row {
    display: grid; grid-template-columns: 16px 10px minmax(0, 1fr) auto auto; align-items: center; gap: 9px;
    padding: 9px 10px; border-radius: 10px; background: color-mix(in srgb, var(--c) 7%, transparent);
    border: 1px solid color-mix(in srgb, var(--c) 22%, transparent); transition: background .15s;
  }
  .lc-row:hover { background: color-mix(in srgb, var(--c) 13%, transparent); }
  .lc-rank { font-size: 11px; font-weight: 800; color: var(--text-3); text-align: center; }
  .lc-row:first-child .lc-rank { color: #FBBF24; }
  .lc-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--c); box-shadow: 0 0 10px var(--c); }
  .lc-main { min-width: 0; }
  .lc-model { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lc-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 10.5px; color: var(--text-3); margin-top: 2px; font-variant-numeric: tabular-nums; }
  .lc-prov { font-weight: 700; color: var(--c); }
  .lc-warn { color: #FBBF24; }
  .lc-reason { font-size: 10.5px; color: var(--text-3); font-style: italic; margin-top: 2px; }
  .lc-status {
    font-size: 9.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; padding: 3px 7px; border-radius: 999px; white-space: nowrap;
    color: var(--tone); background: color-mix(in srgb, var(--tone) 15%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 40%, transparent);
  }
  .lc-score {
    min-width: 34px; text-align: center; padding: 4px 6px; border-radius: 8px; font-size: 12.5px; font-weight: 800; color: #fff; text-decoration: none;
    background: color-mix(in srgb, var(--band) 45%, transparent); box-shadow: inset 0 -2px 0 var(--band); font-variant-numeric: tabular-nums;
  }
  .lc-score:hover { filter: brightness(1.15); }
  .lc-score.none { color: var(--text-3); background: var(--surface-2); box-shadow: none; font-weight: 500; }
  .lc-foot { display: flex; justify-content: space-between; padding: 9px 14px 11px; border-top: 1px solid var(--border); }
  .lc-foot a { font-size: 11.5px; font-weight: 700; color: #22D3EE; text-decoration: none; }
  .lc-foot a:last-child { color: var(--text-2); font-weight: 600; }
  .lc-foot a:hover { text-decoration: underline; }
  .lc-refresh:focus-visible, .lc-foot a:focus-visible, .lc-score:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .lc-refresh:disabled svg { animation: none; } .lc-row { transition: none; } }
</style>
