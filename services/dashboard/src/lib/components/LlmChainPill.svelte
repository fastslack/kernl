<script lang="ts">
  import { wsConnected } from '$lib/stores.js';
  import { statusLabel, fmtSince, fmtCountdown, type ChainData } from '$lib/llm-chain.js';

  // ── LIVE pill popover: the configured LLM chain, with status ─────
  // Hits /api/llm/chain on open. Re-fetches on every open so the user
  // sees the current health (a 403 on Grok between yesterday and now
  // would otherwise be invisible until they opened Settings → AI).
  let liveOpen = false;
  let chainData: ChainData | null = null;
  let chainErr = '';
  let chainLoading = false;
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
  function toggleLive() {
    liveOpen = !liveOpen;
    if (liveOpen) loadChain();
  }
  // Svelte action — closes the popover when the user clicks anywhere
  // outside its wrapper. Inlined here because it's the only consumer.
  function clickOutside(node: HTMLElement, onOutside: () => void) {
    function handle(ev: MouseEvent) {
      if (node && !node.contains(ev.target as Node)) onOutside();
    }
    document.addEventListener('mousedown', handle, true);
    return { destroy() { document.removeEventListener('mousedown', handle, true); } };
  }
</script>

<div class="live-pill-wrap" use:clickOutside={() => { liveOpen = false; }}>
  <button
    type="button"
    class="ws-pill ws-pill-btn"
    class:connected={$wsConnected}
    class:open={liveOpen}
    on:click={toggleLive}
    title="Realtime stream + LLM chain status — click to inspect"
  >
    <span class="ws-dot"></span>
    <span class="ws-label">{$wsConnected ? 'LIVE' : 'POLL'}</span>
  </button>
  {#if liveOpen}
    <div class="live-popover" role="dialog" aria-label="LLM chain status">
      <header class="lp-head">
        <span class="lp-title">LLM chain · Settings → AI</span>
        <button type="button" class="lp-refresh" on:click={loadChain} title="Re-check provider health" disabled={chainLoading}>
          ↻
        </button>
      </header>
      {#if chainLoading && !chainData}
        <div class="lp-empty">loading…</div>
      {:else if chainErr}
        <div class="lp-empty lp-err">error: {chainErr}</div>
      {:else if !chainData}
        <div class="lp-empty">no chain configured</div>
      {:else}
        <ul class="lp-list">
          {#each [chainData.primary, ...chainData.fallbacks] as link, i (link.slug + ':' + i)}
            <li class="lp-row" data-status={link.status}>
              <span class="lp-rank">{i === 0 ? 'P' : i}</span>
              <span class="lp-slug">{link.slug}</span>
              <span class="lp-model" title={link.model}>{link.model || '—'}</span>
              <span class="lp-status" data-status={link.status}>{statusLabel(link.status)}</span>
              <span class="lp-meta">
                {#if link.latencyMs !== undefined}
                  <span class="lp-meta-item">{Math.round(link.latencyMs)}ms</span>
                {/if}
                {#if link.lastSuccessAt}
                  <span class="lp-meta-item" title="Last successful call">✓ {fmtSince(link.lastSuccessAt)}</span>
                {/if}
                {#if link.blockedForMs && link.blockedForMs > 0}
                  <span class="lp-meta-item lp-meta-warn" title="Blocked — backoff window">retry in {fmtCountdown(link.blockedForMs)}</span>
                {/if}
              </span>
              {#if link.reason}
                <span class="lp-reason">{link.reason}</span>
              {/if}
            </li>
          {/each}
        </ul>
        <footer class="lp-foot">
          <!-- /models is a redirect stub onto the AI section of
               Settings; link the real destination. -->
          <a href="/settings?section=ai" on:click={() => liveOpen = false}>configure in Settings →</a>
        </footer>
      {/if}
    </div>
  {/if}
</div>
