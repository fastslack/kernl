<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { wsConnected } from '$lib/stores.js';
  import { t } from '$lib/i18n';
  import { rpcPost } from '$lib/api';
  import {
    fmtSince, fmtCountdown, fmtElapsed, oldestInFlight, inFlightTotal, chainPollMs,
    callsForLink, usageForLink, utcDay, fmtTokens, fmtCost,
    type ChainData, type ChainLink, type LlmCall, type UsageRow, type LinkUsage,
  } from '$lib/llm-chain.js';
  import { modelColor, scoreBand, shortModel } from '$lib/components/bench/model.js';

  // ── LIVE pill: the stream status, and the models Kernl is running on ─────
  // The pill carries one dot per model of the chain, in the color the bench
  // gives that provider. The popover lists them with their health, the calls
  // running on each right now and the score each one got in the latest bench
  // run; a row opens in place onto everything the kernel knows about that link.
  let liveOpen = false;
  let chainData: ChainData | null = null;
  let chainErr = '';
  let chainLoading = false;
  /** Latest bench total per "<slug>/<model>", and per slug for a link with no explicit model. */
  let scores: Record<string, number> = {};

  /** The open row, by chain position; one at a time. */
  let openIdx: number | null = null;
  let detail: { key: string; calls: LlmCall[]; usage: LinkUsage | null; err: string; loading: boolean } | null = null;
  /** Ticks once a second while the popover shows something running. */
  let now = Date.now();

  const linkKey = (l: ChainLink, i: number) => `${i}:${l.slug}:${l.model}`;

  /** `quiet`: a background poll keeps the last good chain on a hiccup instead of blanking the list. */
  async function loadChain(quiet = false) {
    if (!quiet) { chainLoading = true; chainErr = ''; }
    try {
      const r = await fetch('/api/llm/chain');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      chainData = await r.json();
      chainErr = '';
    } catch (err) {
      if (!quiet || !chainData) {
        chainErr = err instanceof Error ? err.message : String(err);
        chainData = null;
      }
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

  async function getJson<T>(url: string): Promise<T> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  /**
   * The call log and the usage rollup of one link. The driver files a call
   * under the link's own slug and the adapters under the catalog slug, so a
   * link whose two differ ("claude_code" / "claude-code") reads both.
   */
  async function loadDetail(link: ChainLink, i: number) {
    const key = linkKey(link, i);
    if (detail?.key !== key) detail = { key, calls: [], usage: null, err: '', loading: true };
    const slugs = [...new Set([link.logSlug ?? link.slug, link.slug])];
    const day = utcDay();
    try {
      const [calls, usage] = await Promise.all([
        Promise.all(slugs.map((s) => getJson<{ calls: LlmCall[] }>(`/api/llm/calls?slug=${encodeURIComponent(s)}&limit=60`))),
        Promise.all(slugs.map((s) => getJson<{ rows: UsageRow[] }>(`/api/llm/usage?slug=${encodeURIComponent(s)}&from=${day}&to=${day}&group=model`))),
      ]);
      if (detail?.key !== key) return; // another row opened meanwhile
      detail = {
        key, err: '', loading: false,
        calls: callsForLink(calls.flatMap((c) => c.calls ?? []), link, 8),
        usage: usageForLink(usage.flatMap((u) => u.rows ?? []), link),
      };
    } catch (err) {
      if (detail?.key !== key) return;
      detail = { ...detail, err: err instanceof Error ? err.message : String(err), loading: false };
    }
  }

  function toggleRow(link: ChainLink, i: number) {
    if (openIdx === i) { openIdx = null; detail = null; return; }
    openIdx = i;
    loadDetail(link, i);
  }

  // One poll at a time: each run schedules the next when it settles, faster
  // while the popover is open on something running.
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let destroyed = false;
  async function poll(quiet = true) {
    if (polling) return;
    polling = true;
    clearTimeout(pollTimer);
    try {
      await loadChain(quiet);
      const link = openIdx !== null ? links[openIdx] : undefined;
      if (liveOpen && link) await loadDetail(link, openIdx as number);
    } finally {
      polling = false;
      if (!destroyed) pollTimer = setTimeout(() => poll(), chainPollMs(liveOpen, running));
    }
  }

  function toggleLive() {
    liveOpen = !liveOpen;
    if (liveOpen) { now = Date.now(); poll(false); loadScores(); }
    else { openIdx = null; detail = null; }
  }
  function refresh() { poll(false); loadScores(); }

  onMount(() => { poll(false); });
  onDestroy(() => { destroyed = true; clearTimeout(pollTimer); clearInterval(clock); });

  // Svelte action — closes the popover when the user clicks anywhere
  // outside its wrapper. Inlined here because it's the only consumer.
  function clickOutside(node: HTMLElement, onOutside: () => void) {
    function handle(ev: MouseEvent) {
      if (node && !node.contains(ev.target as Node)) onOutside();
    }
    document.addEventListener('mousedown', handle, true);
    return { destroy() { document.removeEventListener('mousedown', handle, true); } };
  }
  function close() { liveOpen = false; openIdx = null; detail = null; }
  function onKey(ev: KeyboardEvent) { if (liveOpen && ev.key === 'Escape') close(); }

  $: links = chainData ? [chainData.primary, ...chainData.fallbacks] : [];
  $: limitedLinks = links.filter((link) => !['active', 'standby'].includes(link.status));
  $: running = inFlightTotal(links);
  // A chain that changed shape under an open row closes it rather than show another link's data.
  $: if (openIdx !== null && detail && links[openIdx] && linkKey(links[openIdx], openIdx) !== detail.key) { openIdx = null; detail = null; }

  // The clock only runs while there is a timer on screen to move.
  let clock: ReturnType<typeof setInterval> | undefined;
  $: ticking = liveOpen && running > 0;
  $: if (ticking && !clock) { now = Date.now(); clock = setInterval(() => (now = Date.now()), 1000); }
  $: if (!ticking && clock) { clearInterval(clock); clock = undefined; }

  const scoreOf = (l: ChainLink) => scores[`${l.slug}/${l.model}`] ?? scores[l.slug];
  const STATUS_TONE: Record<ChainLink['status'], string> = {
    active: '#34D399', standby: '#94A3B8', 'no-key': '#64748B', quota: '#FBBF24', 'rate-limit': '#FBBF24', auth: '#F43F5E', degraded: '#FB923C',
  };
  const isClaudeCode = (l: ChainLink) => /^claude[-_]code$/.test(l.logSlug ?? l.slug);
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
</script>

<svelte:window on:keydown={onKey} />

<div class="live-pill-wrap" use:clickOutside={() => { if (liveOpen) close(); }}>
  <button
    type="button"
    class="ws-pill ws-pill-btn"
    class:connected={$wsConnected}
    class:open={liveOpen}
    class:busy={running > 0}
    on:click={toggleLive}
    aria-expanded={liveOpen}
    title={running > 0 ? `${$t('live.pillTitle')} · ${$t('live.pillRunning', { n: running })}` : $t('live.pillTitle')}
  >
    <span class="ws-dot"></span>
    <span class="ws-label">{$wsConnected ? 'LIVE' : 'POLL'}</span>
    {#if limitedLinks.length}<span class="lc-alert" title={limitedLinks.map((l) => `${l.model || l.slug}: ${l.reason || l.status}`).join(' · ')}>⚠ {limitedLinks.length}</span>{/if}
    {#if links.length}
      <span class="lc-dots" aria-hidden="true">
        {#each links.slice(0, 4) as l, i (l.slug + i)}<i style="background:{modelColor(l.slug)};color:{modelColor(l.slug)}" class:dim={l.status !== 'active' && l.status !== 'standby'} class:hot={(l.inFlight?.length ?? 0) > 0}></i>{/each}
      </span>
    {/if}
    {#if running > 0}<span class="lc-pill-count" aria-hidden="true">{running}</span>{/if}
  </button>
  {#if liveOpen}
    <div class="lc-pop" role="dialog" aria-label={$t('live.title')}>
      <header class="lc-head">
        <div>
          <div class="lc-title">{$t('live.title')}</div>
          <div class="lc-sub">
            {$t('live.sub')}
            {#if running > 0}<span class="lc-sub-run" aria-live="polite"><i></i>{$t('live.running', { n: running })}</span>{/if}
          </div>
        </div>
        <button type="button" class="lc-refresh" on:click={refresh} title={$t('live.refresh')} aria-label={$t('live.refresh')} disabled={chainLoading}>
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
          {#each links as link, i (link.slug + ':' + link.model + ':' + i)}
            {@const c = modelColor(link.slug)}
            {@const sc = scoreOf(link)}
            {@const busy = (link.inFlight?.length ?? 0) > 0}
            {@const oldest = oldestInFlight(link)}
            {@const isOpen = openIdx === i}
            <li class="lc-row" class:busy class:open={isOpen} style="--c:{c};--tone:{STATUS_TONE[link.status]}">
              <div class="lc-line">
                <button
                  type="button"
                  class="lc-toggle"
                  aria-expanded={isOpen}
                  aria-controls="lc-detail-{i}"
                  title={$t('live.expand')}
                  on:click={() => toggleRow(link, i)}
                >
                  <span class="lc-rank" title={i === 0 ? $t('live.primary') : $t('live.fallback', { n: i })}>{i === 0 ? '★' : i}</span>
                  <span class="lc-dot"></span>
                  <span class="lc-main">
                    <span class="lc-model" title={link.model}>{link.model ? shortModel(link.model) : $t('live.defaultModel')}</span>
                    <span class="lc-meta">
                      <span class="lc-prov">{link.slug}</span>
                      {#if link.latencyMs !== undefined}<span>{Math.round(link.latencyMs)} ms</span>{/if}
                      {#if link.lastSuccessAt}<span title={$t('live.lastOk')}>✓ {fmtSince(link.lastSuccessAt, now)}</span>{/if}
                      {#if link.blockedForMs && link.blockedForMs > 0}<span class="lc-warn">{$t('live.retryIn', { t: fmtCountdown(link.blockedForMs) })}</span>{/if}
                    </span>
                    {#if link.reason && !isOpen}<span class="lc-reason" title={link.reason}>⚠ {link.reason}</span>{/if}
                  </span>
                  {#if busy}
                    <span class="lc-run" title={(link.inFlight ?? []).map((f) => f.caller || $t('live.d.noCaller')).join(' · ')}>
                      <b>{$t('live.running', { n: link.inFlight?.length ?? 0 })}</b>
                      {#if oldest}<span class="lc-clock">{fmtElapsed(now - oldest)}</span>{/if}
                    </span>
                  {/if}
                  <span class="lc-status">{$t(`live.status.${link.status}`)}</span>
                  <svg class="lc-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                </button>
                {#if sc !== undefined}
                  <a class="lc-score" href="/bench" on:click={close} title={$t('live.benchScore')} style="--band:{scoreBand(sc)}">{Math.round(sc)}</a>
                {:else}
                  <span class="lc-score none" title={$t('live.noScore')}>—</span>
                {/if}
              </div>
              {#if isClaudeCode(link) && link.status === 'auth'}
                <a class="lc-reconnect" href="/settings?section=ai&card=providers&connect=claude-code" on:click={close}>{$t('agent.failure.reconnect_claude')} →</a>
              {/if}
              {#if link.resetsAt && !isOpen}<div class="lc-reason lc-pad">{$t('live.resetsAt', { t: new Date(link.resetsAt).toLocaleString() })}</div>{/if}

              {#if isOpen}
                <div class="lc-detail" id="lc-detail-{i}">
                  <dl class="lc-kv">
                    <div class="wide"><dt>{$t('live.d.model')}</dt><dd class="mono">{link.model || $t('live.defaultModel')}</dd></div>
                    <div><dt>{$t('live.d.provider')}</dt><dd>{link.provider}{#if (link.logSlug ?? link.slug) !== link.provider} · {link.logSlug ?? link.slug}{/if}</dd></div>
                    <div><dt>{$t('live.d.position')}</dt><dd>{i === 0 ? $t('live.primary') : $t('live.fallback', { n: i })}</dd></div>
                    <div><dt>{$t('live.d.status')}</dt><dd style="color:var(--tone)">{$t(`live.status.${link.status}`)}</dd></div>
                    <div><dt>{$t('live.d.failures')}</dt><dd class:warn={link.failures > 0}>{link.failures}</dd></div>
                    <div><dt>{$t('live.d.latency')}</dt><dd>{link.latencyMs !== undefined ? `${Math.round(link.latencyMs)} ms` : '—'}</dd></div>
                    <div><dt>{$t('live.d.lastOk')}</dt><dd title={link.lastSuccessAt ? new Date(link.lastSuccessAt).toLocaleString() : ''}>{fmtSince(link.lastSuccessAt, now)}</dd></div>
                    {#if link.blockedForMs && link.blockedForMs > 0}<div><dt>{$t('live.d.retry')}</dt><dd class="warn">{fmtCountdown(link.blockedForMs)}</dd></div>{/if}
                    {#if link.resetsAt}<div class="wide"><dt>{$t('live.d.resets')}</dt><dd>{new Date(link.resetsAt).toLocaleString()}</dd></div>{/if}
                    {#if link.reason}<div class="wide"><dt>{$t('live.d.reason')}</dt><dd class="warn">{link.reason}</dd></div>{/if}
                  </dl>

                  {#if busy}
                    <section class="lc-sec">
                      <h4><i class="lc-live-dot"></i>{$t('live.d.inFlight')}</h4>
                      <ul class="lc-flight">
                        <!-- Unkeyed: two parallel calls can share a start and a caller. -->
                        {#each link.inFlight ?? [] as f}
                          <li><span class="lc-caller">{f.caller || $t('live.d.noCaller')}</span><span class="lc-clock">{fmtElapsed(now - f.startedAt)}</span></li>
                        {/each}
                      </ul>
                    </section>
                  {/if}

                  {#if detail?.err}
                    <div class="lc-derr">{$t('live.d.error', { err: detail.err })}</div>
                  {:else if detail?.loading}
                    <div class="lc-dload">{$t('live.d.loading')}</div>
                  {:else if detail}
                    {#if detail.usage}
                      <section class="lc-sec">
                        <h4>{$t('live.d.today')}</h4>
                        <div class="lc-tiles">
                          <div class="tile" style="--h:#22D3EE"><b>{detail.usage.calls}</b><span>{$t('live.d.calls')}</span></div>
                          <div class="tile" style="--h:{detail.usage.fails ? '#F43F5E' : '#34D399'}"><b>{detail.usage.fails}</b><span>{$t('live.d.fails')}</span></div>
                          <div class="tile" style="--h:#A78BFA"><b>{fmtTokens(detail.usage.inputTokens)}</b><span>{$t('live.d.tokensIn')}</span></div>
                          <div class="tile" style="--h:#F472B6"><b>{fmtTokens(detail.usage.outputTokens)}</b><span>{$t('live.d.tokensOut')}</span></div>
                          <div class="tile" style="--h:#FBBF24"><b>{detail.usage.priced ? fmtCost(detail.usage.costUsd) : '—'}</b><span>{detail.usage.priced ? $t('live.d.cost') : $t('live.d.noCost')}</span></div>
                        </div>
                      </section>
                    {/if}
                    <section class="lc-sec">
                      <h4>{$t('live.d.recent')}</h4>
                      {#if !detail.calls.length}
                        <div class="lc-dload">{$t('live.d.noCalls')}</div>
                      {:else}
                        <ul class="lc-calls">
                          {#each detail.calls as call}
                            <li class:fail={!call.ok}>
                              <span class="ok" aria-label={call.ok ? 'ok' : 'error'}>{call.ok ? '✓' : '✕'}</span>
                              <span class="lc-caller" title={`${call.caller || $t('live.d.noCaller')} · ${call.model}`}>{call.caller || $t('live.d.noCaller')}</span>
                              <span class="num">{call.latencyMs >= 1000 ? `${(call.latencyMs / 1000).toFixed(1)}s` : `${call.latencyMs}ms`}</span>
                              <span class="num tok" title="{call.inputTokens ?? '—'} → {call.outputTokens ?? '—'}">{call.inputTokens !== undefined ? fmtTokens(call.inputTokens) : '—'}→{call.outputTokens !== undefined ? fmtTokens(call.outputTokens) : '—'}</span>
                              <span class="num ago" title={new Date(call.startedAt).toLocaleString()}>{fmtSince(call.startedAt, now)}</span>
                              {#if !call.ok && (call.errorKind || call.errorMsg)}
                                <span class="err" title={call.errorMsg ?? call.errorKind}>{call.errorKind ? `${call.errorKind}: ` : ''}{clip(call.errorMsg ?? '', 90)}</span>
                              {/if}
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </section>
                  {/if}

                  <div class="lc-dfoot">
                    {#if sc !== undefined}
                      <a href="/bench" on:click={close}>{$t('live.d.bench')} <b style="color:{scoreBand(sc)}">{Math.round(sc)}</b> →</a>
                    {:else}
                      <a href="/bench" on:click={close}>{$t('live.toBench')} →</a>
                    {/if}
                  </div>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
        <footer class="lc-foot">
          <a href="/bench" on:click={close}>{$t('live.toBench')} →</a>
          <!-- /models is a redirect stub onto the AI section of Settings; link the real destination. -->
          <a href="/settings?section=ai" on:click={close}>{$t('live.configure')} →</a>
        </footer>
      {/if}
    </div>
  {/if}
</div>

<style>
  .lc-alert { color: #fbbf24; font-size: 11px; margin-left: 5px; }

  .lc-dots { display: inline-flex; gap: 3px; margin-left: 6px; }
  .lc-dots i { width: 6px; height: 6px; border-radius: 50%; box-shadow: 0 0 6px currentColor; }
  .lc-dots i.dim { opacity: .35; box-shadow: none; }
  /* Something is running: every dot breathes, the ones doing the work hardest. */
  .busy .lc-dots i { animation: breathe 1.8s ease-in-out infinite; }
  .busy .lc-dots i.hot { animation-duration: .9s; }
  .lc-dots i:nth-child(2) { animation-delay: .15s; }
  .lc-dots i:nth-child(3) { animation-delay: .3s; }
  .lc-dots i:nth-child(4) { animation-delay: .45s; }
  .lc-pill-count {
    margin-left: 5px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px; display: inline-grid; place-items: center;
    font-size: 9.5px; font-weight: 800; color: #0b1220; background: #22D3EE; box-shadow: 0 0 8px #22D3EE; font-variant-numeric: tabular-nums;
  }
  @keyframes breathe {
    0%, 100% { transform: scale(1); box-shadow: 0 0 4px currentColor; }
    50% { transform: scale(1.35); box-shadow: 0 0 10px currentColor; }
  }

  .lc-pop {
    position: absolute; right: 0; top: calc(100% + 8px); z-index: var(--z-modal, 40); width: 460px; max-width: calc(100vw - 24px);
    max-height: calc(100vh - var(--header-h, 60px) - 24px); display: flex; flex-direction: column;
    border-radius: 14px; overflow: hidden; color: var(--text-1);
    background:
      radial-gradient(360px 120px at 0% 0%, color-mix(in srgb, #22D3EE 12%, transparent), transparent 70%),
      radial-gradient(320px 140px at 100% 100%, color-mix(in srgb, #A78BFA 12%, transparent), transparent 70%),
      linear-gradient(160deg, color-mix(in srgb, #A78BFA 10%, var(--surface-1)), var(--surface-1) 45%);
    border: 1px solid color-mix(in srgb, #22D3EE 30%, var(--border));
    box-shadow: 0 18px 40px -12px rgba(0, 0, 0, .6), 0 0 0 1px rgba(255, 255, 255, .02);
  }
  .lc-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px 10px; border-bottom: 1px solid var(--border); flex: none; }
  .lc-title {
    font-size: 14px; font-weight: 800; letter-spacing: -.01em;
    background: linear-gradient(90deg, #22D3EE, #A78BFA 60%, #F472B6); -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .lc-sub { font-size: 11px; color: var(--text-3); margin-top: 1px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .lc-sub-run {
    display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border-radius: 999px; font-weight: 700; color: #22D3EE;
    border: 1px solid color-mix(in srgb, #22D3EE 45%, transparent); background: color-mix(in srgb, #22D3EE 12%, transparent);
  }
  .lc-sub-run i, .lc-live-dot { width: 6px; height: 6px; border-radius: 50%; background: #22D3EE; box-shadow: 0 0 6px #22D3EE; animation: blink 1.2s ease-in-out infinite; display: inline-block; }
  @keyframes blink { 50% { opacity: .35; } }
  .lc-refresh { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); cursor: pointer; }
  .lc-refresh svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .lc-refresh:hover:not(:disabled) { color: #22D3EE; border-color: #22D3EE; }
  .lc-refresh:disabled svg { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .lc-empty { padding: 18px; text-align: center; font-size: 12px; color: var(--text-3); }
  .lc-err { color: #F43F5E; }
  .lc-list { list-style: none; margin: 0; padding: 6px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; min-height: 0; flex: 1 1 auto; }

  .lc-row {
    position: relative; overflow: hidden; border-radius: 10px;
    background: linear-gradient(150deg, color-mix(in srgb, var(--c) 10%, transparent), color-mix(in srgb, var(--c) 4%, transparent) 70%);
    border: 1px solid color-mix(in srgb, var(--c) 22%, transparent); transition: background .15s, border-color .2s, box-shadow .2s;
    flex: none;
  }
  .lc-row:hover { background: color-mix(in srgb, var(--c) 13%, transparent); }
  .lc-row.open { border-color: color-mix(in srgb, var(--c) 55%, transparent); box-shadow: 0 10px 24px -18px var(--c); }
  .lc-row.busy { border-color: color-mix(in srgb, var(--c) 50%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--c) 18%, transparent), 0 8px 22px -14px var(--c); }
  /* The work sweep: a light bar running along the top edge while a call is out. */
  .lc-row.busy::before {
    content: ''; position: absolute; left: 0; top: 0; height: 2px; width: 40%; pointer-events: none;
    background: linear-gradient(90deg, transparent, var(--c), transparent); box-shadow: 0 0 8px var(--c);
    animation: sweep 1.6s cubic-bezier(.4, 0, .2, 1) infinite;
  }
  @keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(250%); } }

  .lc-line { display: flex; align-items: center; gap: 6px; padding-right: 8px; }
  .lc-toggle {
    flex: 1; min-width: 0; display: grid; grid-template-columns: 14px 10px minmax(0, 1fr) auto auto 12px; align-items: center; gap: 8px;
    padding: 8px 4px 8px 10px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 10px;
  }
  .lc-rank { font-size: 11px; font-weight: 800; color: var(--text-3); text-align: center; }
  .lc-row:first-child .lc-rank { color: #FBBF24; }
  .lc-dot { position: relative; width: 10px; height: 10px; border-radius: 50%; background: var(--c); box-shadow: 0 0 10px var(--c); }
  .busy .lc-dot { animation: breathe 1.4s ease-in-out infinite; color: var(--c); }
  .busy .lc-dot::after {
    content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--c); opacity: 0;
    animation: ring 1.4s ease-out infinite;
  }
  @keyframes ring { 0% { transform: scale(.6); opacity: .8; } 100% { transform: scale(1.7); opacity: 0; } }
  .lc-main { min-width: 0; display: flex; flex-direction: column; }
  .lc-model { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lc-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 10.5px; color: var(--text-3); margin-top: 2px; font-variant-numeric: tabular-nums; }
  .lc-prov { font-weight: 700; color: var(--c); }
  .lc-warn { color: #FBBF24; }
  .lc-reason { font-size: 10.5px; color: #fbbf24; font-style: italic; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lc-pad { padding: 0 12px 8px 42px; margin-top: -4px; }
  .lc-reconnect { display: inline-block; margin: -2px 0 8px 42px; font-size: 11px; font-weight: 600; color: #F43F5E; text-decoration: none; }
  .lc-reconnect:hover { text-decoration: underline; }
  .lc-run {
    display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 999px; white-space: nowrap; font-size: 10px;
    color: var(--c); border: 1px solid color-mix(in srgb, var(--c) 55%, transparent); background: color-mix(in srgb, var(--c) 16%, transparent);
    box-shadow: 0 0 10px -2px color-mix(in srgb, var(--c) 70%, transparent);
  }
  .lc-run b { font-weight: 800; }
  .lc-clock { font-variant-numeric: tabular-nums; font-weight: 700; color: var(--text-1); }
  .lc-status {
    font-size: 9.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; padding: 3px 7px; border-radius: 999px; white-space: nowrap;
    color: var(--tone); background: color-mix(in srgb, var(--tone) 15%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 40%, transparent);
  }
  .lc-chev { width: 12px; height: 12px; fill: none; stroke: var(--text-3); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; transition: transform .2s ease-out; }
  .open .lc-chev { transform: rotate(180deg); stroke: var(--c); }
  .lc-score {
    flex: none; min-width: 34px; text-align: center; padding: 4px 6px; border-radius: 8px; font-size: 12.5px; font-weight: 800; color: #fff; text-decoration: none;
    background: color-mix(in srgb, var(--band) 45%, transparent); box-shadow: inset 0 -2px 0 var(--band); font-variant-numeric: tabular-nums;
  }
  .lc-score:hover { filter: brightness(1.15); }
  .lc-score.none { color: var(--text-3); background: var(--surface-2); box-shadow: none; font-weight: 500; }

  .lc-detail { padding: 2px 10px 10px; border-top: 1px dashed color-mix(in srgb, var(--c) 30%, transparent); animation: open .18s ease-out; }
  @keyframes open { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
  .lc-kv { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; margin: 8px 0 0; }
  .lc-kv > div { min-width: 0; padding: 4px 7px; border-radius: 7px; background: color-mix(in srgb, var(--surface-2) 70%, transparent); border: 1px solid var(--border); }
  .lc-kv > div.wide { grid-column: 1 / -1; }
  .lc-kv dt { font-size: 9px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--text-3); }
  .lc-kv dd { margin: 1px 0 0; font-size: 11.5px; font-weight: 600; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .lc-kv dd.mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
  .lc-kv dd.warn, .warn { color: #FBBF24; }
  .lc-sec { margin-top: 8px; }
  .lc-sec h4 { display: flex; align-items: center; gap: 6px; margin: 0 0 4px; font-size: 9.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); }
  .lc-sec h4::before { content: ''; width: 3px; height: 10px; border-radius: 2px; background: linear-gradient(#22D3EE, #A78BFA); }
  .lc-flight, .lc-calls { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .lc-flight li {
    display: flex; justify-content: space-between; gap: 8px; padding: 4px 8px; border-radius: 7px; font-size: 11.5px;
    background: color-mix(in srgb, var(--c) 12%, transparent); border: 1px solid color-mix(in srgb, var(--c) 35%, transparent);
  }
  .lc-caller { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .lc-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; }
  .tile {
    display: flex; flex-direction: column; align-items: center; padding: 5px 2px; border-radius: 8px; min-width: 0;
    background: linear-gradient(160deg, color-mix(in srgb, var(--h) 18%, var(--surface-1)), var(--surface-1) 75%);
    border: 1px solid color-mix(in srgb, var(--h) 35%, var(--border)); box-shadow: 0 6px 14px -12px var(--h);
  }
  .tile b { font-size: 13px; font-weight: 800; color: var(--h); font-variant-numeric: tabular-nums; }
  .tile span { font-size: 9px; color: var(--text-3); text-transform: uppercase; letter-spacing: .04em; }
  .lc-calls { max-height: 190px; overflow-y: auto; }
  .lc-calls li {
    display: grid; grid-template-columns: 12px minmax(0, 1fr) auto auto auto; gap: 7px; align-items: center;
    padding: 3px 6px; border-radius: 6px; font-size: 11px; background: color-mix(in srgb, var(--surface-2) 55%, transparent);
  }
  .lc-calls li.fail { background: color-mix(in srgb, #F43F5E 10%, transparent); }
  .lc-calls .ok { font-weight: 800; color: #34D399; }
  .lc-calls li.fail .ok { color: #F43F5E; }
  .lc-calls .num { font-variant-numeric: tabular-nums; color: var(--text-2); white-space: nowrap; }
  .lc-calls .tok { color: var(--text-3); }
  .lc-calls .ago { color: var(--text-3); }
  .lc-calls .err { grid-column: 2 / -1; font-size: 10.5px; color: #F87171; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lc-dload, .lc-derr { font-size: 11px; color: var(--text-3); padding: 6px 2px; }
  .lc-derr { color: #F43F5E; }
  .lc-dfoot { display: flex; justify-content: flex-end; margin-top: 8px; }
  .lc-dfoot a { font-size: 11px; font-weight: 700; color: #22D3EE; text-decoration: none; }
  .lc-dfoot a:hover { text-decoration: underline; }

  .lc-foot { display: flex; justify-content: space-between; padding: 9px 14px 11px; border-top: 1px solid var(--border); flex: none; }
  .lc-foot a { font-size: 11.5px; font-weight: 700; color: #22D3EE; text-decoration: none; }
  .lc-foot a:last-child { color: var(--text-2); font-weight: 600; }
  .lc-foot a:hover { text-decoration: underline; }
  .lc-refresh:focus-visible, .lc-foot a:focus-visible, .lc-score:focus-visible, .lc-toggle:focus-visible, .lc-dfoot a:focus-visible, .lc-reconnect:focus-visible {
    outline: 2px solid #22D3EE; outline-offset: 2px;
  }

  /* No motion: the live state stays readable — solid ring, steady glow, the count and the clock. */
  @media (prefers-reduced-motion: reduce) {
    .lc-refresh:disabled svg, .busy .lc-dots i, .busy .lc-dot, .lc-sub-run i, .lc-live-dot, .lc-detail { animation: none; }
    .lc-row, .lc-chev { transition: none; }
    .lc-row.busy::before { animation: none; width: 100%; transform: none; opacity: .8; }
    .busy .lc-dot::after { animation: none; opacity: .7; transform: scale(1.3); }
  }
</style>
