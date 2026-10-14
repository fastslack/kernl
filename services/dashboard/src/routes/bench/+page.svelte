<script lang="ts">
  /*
    Model Bench — compares every configured model on Kernl's own kinds of work.
    One screen: the four answers ("which do I use?"), the ranking with its side
    metrics, the category heatmap, quality against cost, every task with its
    attempts, and the history across runs. While a run is going, the button
    turns into its progress and the screen fills in as results arrive.
  */
  import { onDestroy, onMount } from 'svelte';
  import { t, locale } from '$lib/i18n';
  import { rpcPost } from '$lib/api';
  import Heatmap from '$lib/components/bench/Heatmap.svelte';
  import Scatter from '$lib/components/bench/Scatter.svelte';
  import History from '$lib/components/bench/History.svelte';
  import TaskTable from '$lib/components/bench/TaskTable.svelte';
  import { CATEGORIES, ICON, modelColor, pct0, secs, shortModel, usd, type ModelRow, type Overview, type Report, type Run } from '$lib/components/bench/model.js';

  let ov: Overview | null = null;
  let report: Report | null = null;
  let active: Run | null = null;
  let error = '';
  let busy = false;
  let menuOpen = false;
  let viewing = ''; // a past run picked from the ⋯ menu; '' = the latest
  let poll: ReturnType<typeof setInterval> | null = null;
  let tick = 0;

  async function load() {
    try {
      ov = (await rpcPost('bench.overview')) as Overview;
      active = ov.active;
      if (!viewing) report = active ? ((await rpcPost('bench.run', { id: active.id })) as Report) : ov.latest;
      error = '';
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    syncPoll();
  }

  function syncPoll() {
    if (active && !poll) poll = setInterval(refresh, 2500);
    if (!active && poll) { clearInterval(poll); poll = null; }
  }

  /** While running: progress every tick, the partial report every other one. */
  async function refresh() {
    try {
      const s = (await rpcPost('bench.status')) as { active: Run | null };
      if (!s.active) { active = null; await load(); return; }
      active = s.active;
      if (!viewing && tick++ % 2 === 0) report = (await rpcPost('bench.run', { id: s.active.id })) as Report;
    } catch { /* the next tick retries */ }
  }

  async function start() {
    busy = true; menuOpen = false; viewing = '';
    try {
      active = (await rpcPost('bench.start')) as Run;
      report = (await rpcPost('bench.run', { id: active.id })) as Report;
      error = '';
      syncPoll();
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    busy = false;
  }

  async function cancel() {
    menuOpen = false;
    try { await rpcPost('bench.cancel'); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }

  async function show(id: string) {
    menuOpen = false;
    viewing = ov?.latest?.run.id === id ? '' : id;
    try { report = (await rpcPost('bench.run', { id })) as Report; } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }

  async function removeRun(id: string) {
    menuOpen = false;
    try { await rpcPost('bench.delete', { id }); viewing = ''; await load(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }

  function exportCsv() {
    menuOpen = false;
    if (!report || !ov) return;
    const head = ['provider', 'model', 'total', 'coverage', ...CATEGORIES, 'p50_ms', 'p95_ms', 'cost_per_task_usd', 'invalid_rate', 'provider_error_rate', ...ov.tasks.map((x) => x.id)];
    const rows = report.models.map((m) => [m.slug, m.model, m.total ?? '', m.coverage, ...CATEGORIES.map((c) => m.categories[c] ?? ''), m.p50 ?? '', m.p95 ?? '',
      m.costPerTask ?? '', m.invalidRate, m.providerErrorRate, ...ov!.tasks.map((x) => { const s = m.tasks[x.id]; return s?.mean === null || !s ? s?.status ?? '' : Math.round(s.mean * 100); })]);
    const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `kernl-bench-${report.run.started_at.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  onMount(load);
  onDestroy(() => { if (poll) clearInterval(poll); });

  $: scored = report?.models ?? [];
  /** Every model of the run, scored or not yet: a run shows all its contenders from the first second. */
  $: models = (report?.run.targets ?? []).map((tg): ModelRow => scored.find((m) => m.key === `${tg.slug}/${tg.model}`) ?? {
    key: `${tg.slug}/${tg.model}`, slug: tg.slug, model: tg.model, name: tg.name, supportsTools: tg.supportsTools,
    total: null, coverage: 0, rankScore: -1, categories: Object.fromEntries(CATEGORIES.map((c) => [c, null])) as ModelRow['categories'],
    tasks: {}, attempts: 0, p50: null, p95: null, avgInputTokens: 0, avgOutputTokens: 0, costPerTask: null, invalidRate: 0, providerErrorRate: 0,
  }).sort((a, b) => b.rankScore - a.rankScore);
  $: running = !!active && report?.run.id === active.id;
  /** "nvidia/nvidia/nemotron… · tools/x" → "nemotron… · tools/x". */
  $: currentLabel = (active?.current ?? '').replace(/^[^·]*?([^/·\s]+)\s·/, '$1 ·');
  // One color per provider, the same one the LIVE popover uses; history keys from older runs included.
  $: colors = Object.fromEntries([
    ...(ov?.history ?? []).flatMap((h) => Object.keys(h.totals)),
    ...(report?.run.targets ?? []).map((tg) => `${tg.slug}/${tg.model}`),
  ].map((k) => [k, modelColor(k.split('/')[0])]));
  $: labels = Object.fromEntries((ov?.history ?? []).flatMap((h) => Object.keys(h.totals)).map((k) => [k, k.split('/').slice(1).join('/')]));
  $: byKey = Object.fromEntries(scored.map((m) => [m.key, m]));
  $: hl = report?.highlights;
  $: when = (iso: string) => new Date(iso).toLocaleString($locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  $: mins = (r: Run) => (r.finished_at ? Math.max(1, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60000)) : null);
  $: progress = active ? Math.round((active.done / Math.max(1, active.planned)) * 100) : 0;
  $: oldSuite = !!report && !!ov && report.run.suite_version !== ov.suiteVersion;

  const cards = [
    { id: 'winner', icon: ICON.trophy, hue: 'var(--b-gold)' },
    { id: 'bestValue', icon: ICON.coins, hue: 'var(--b-emerald)' },
    { id: 'fastest', icon: ICON.zap, hue: 'var(--b-cyan)' },
    { id: 'mostReliable', icon: ICON.shield, hue: 'var(--b-violet)' },
  ] as const;
  const MEDAL = ['var(--b-gold)', 'var(--b-silver)', 'var(--b-bronze)'];
</script>

<svelte:window on:click={() => (menuOpen = false)} />

<div class="bench">
  <header class="top">
    <div class="ttl">
      <h1>{$t('bench.title')}</h1>
      {#if running}<span class="live"><span class="pulse"></span>{$t('bench.status.running')}</span>{/if}
      <span class="meta">
        {#if report}
          {$t('bench.meta', { v: report.run.suite_version, when: when(report.run.started_at), n: report.run.targets.length })}{#if mins(report.run)} · {mins(report.run)} min{/if}
          {#if report.run.status !== 'done' && report.run.status !== 'running'} · <span class="warn">{$t(`bench.status.${report.run.status}`)}</span>{/if}
          {#if viewing} · <button type="button" class="link" on:click={() => { viewing = ''; load(); }}>{$t('bench.backLatest')}</button>{/if}
        {:else if ov}
          {$t('bench.metaEmpty', { tasks: ov.tasks.length, n: ov.targets.length })}
        {/if}
      </span>
    </div>
    <div class="actions">
      {#if active}
        <div class="prog" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={$t('bench.running')}>
          <div class="bar" style="width:{progress}%"></div>
          <span><b>{progress} %</b> · {active.done}/{active.planned}{#if currentLabel} · {currentLabel}{/if}</span>
        </div>
      {:else}
        <button type="button" class="btn primary" disabled={busy || !ov?.targets.length} on:click={start}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICON.play} /></svg>{busy ? '…' : $t('bench.run')}
        </button>
      {/if}
      <div class="menu-wrap">
        <button type="button" class="btn icon" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={$t('bench.more')} on:click|stopPropagation={() => (menuOpen = !menuOpen)}>⋯</button>
        {#if menuOpen}
          <div class="menu" role="menu" on:click|stopPropagation on:keydown|stopPropagation tabindex="-1">
            {#if active}<button type="button" role="menuitem" on:click={cancel}>{$t('bench.cancel')}</button>{/if}
            <button type="button" role="menuitem" disabled={!report} on:click={exportCsv}>{$t('bench.export')}</button>
            {#if ov?.runs.length}
              <div class="msep">{$t('bench.pastRuns')}</div>
              {#each ov.runs as r (r.id)}
                <div class="mrun">
                  <button type="button" role="menuitem" class:cur={report?.run.id === r.id} on:click={() => show(r.id)}>{when(r.started_at)} · {$t(`bench.status.${r.status}`)}</button>
                  {#if r.status !== 'running'}<button type="button" class="del" aria-label={$t('bench.delete')} title={$t('bench.delete')} on:click={() => removeRun(r.id)}>✕</button>{/if}
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </header>

  {#if error}<div class="banner" role="alert">{error}</div>{/if}
  {#if oldSuite}<div class="banner">{$t('bench.oldSuite')}</div>{/if}

  {#if !ov}
    <div class="empty">…</div>
  {:else if !report}
    <div class="empty">
      <p>{$t('bench.emptyTitle')}</p>
      <p class="muted">{$t('bench.emptyBody', { tasks: ov.tasks.length, attempts: ov.attemptsPerTask })}</p>
      <ul class="tg">{#each ov.targets as tg (tg.slug)}<li>{tg.name} · <b>{tg.model}</b>{#if !tg.supportsTools} <span class="muted">({$t('bench.noTools')})</span>{/if}</li>{/each}</ul>
      {#if !ov.targets.length}<p class="warn">{$t('bench.noTargets')}</p>{/if}
    </div>
  {:else}
    <section class="cards">
      {#each cards as c (c.id)}
        {@const m = hl?.[c.id] ? byKey[hl[c.id] ?? ''] : null}
        <div class="card" style="--hue:{c.hue}">
          <span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={c.icon} /></svg></span>
          <div class="cbody">
            <span class="ck">{$t(`bench.card.${c.id}`)}{#if running}<span class="prov">{$t('bench.provisional')}</span>{/if}</span>
            {#if m}
              <span class="cv" title="{m.name} · {m.model}">{shortModel(m.model)}</span>
              <span class="cs num">
                {#if c.id === 'winner'}<b>{m.total}</b> / 100{#if m.coverage < 1} · {$t('bench.covers', { pct: pct0(m.coverage) })}{/if}
                {:else if c.id === 'bestValue'}<b>{m.total}</b> · {usd(m.costPerTask)}{$t('bench.perTask')}
                {:else if c.id === 'fastest'}p50 <b>{secs(m.p50)}</b>
                {:else}<b>{pct0(m.invalidRate)}</b> {$t('bench.invalidShort')} · {pct0(m.providerErrorRate)} {$t('bench.errShort')}{/if}
              </span>
            {:else}<span class="cv muted">{running ? $t('bench.waiting') : '—'}</span>{/if}
          </div>
        </div>
      {/each}
    </section>

    <section class="mid">
      <div class="panel rank">
        <h2>{$t('bench.ranking')}</h2>
        <!-- Wider than its panel on most screens: it scrolls sideways, model column pinned.
             Focusable so the keyboard can scroll it too (WCAG 2.1.1). -->
        <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
        <div class="rank-scroll" tabindex="0" role="region" aria-label={$t('bench.ranking')}>
        <table>
          <thead><tr>
            <th>#</th><th class="tl">{$t('bench.col.model')}</th><th title={$t('bench.col.totalHint')}>{$t('bench.col.total')}</th>
            <th title={$t('bench.col.coverageHint')}>{$t('bench.col.coverage')}</th><th>p50</th><th>p95</th>
            <th>{$t('bench.col.cost')}</th><th title={$t('bench.col.invalidHint')}>{$t('bench.col.invalid')}</th><th title={$t('bench.col.errorsHint')}>{$t('bench.col.errors')}</th>
          </tr></thead>
          <tbody>
            {#each models as m, i (m.key)}
              <tr class:pending={m.total === null}>
                <td><span class="medal" style="--medal:{m.total !== null && i < 3 ? MEDAL[i] : 'var(--surface-3)'}">{i + 1}</span></td>
                <td class="tl"><span class="mn" title="{m.name} · {m.model}"><i style="background:{colors[m.key]};color:{colors[m.key]}"></i><b>{shortModel(m.model)}</b><span class="prov-chip">{m.name}</span></span></td>
                <td class="score">
                  {#if m.total === null}<span class="muted">{running ? '…' : '—'}</span>
                  {:else}<span class="sbar"><span style="width:{m.total}%;background:{colors[m.key]}"></span></span><b class="num">{m.total}</b>{/if}
                </td>
                <td class="num" class:warn={m.total !== null && m.coverage < 1}>{m.total === null ? '—' : pct0(m.coverage)}</td>
                <td class="num">{secs(m.p50)}</td><td class="num">{secs(m.p95)}</td>
                <td class="num">{usd(m.costPerTask)}</td>
                <td class="num" class:bad={m.invalidRate > 0.05}>{m.total === null ? '—' : pct0(m.invalidRate)}</td>
                <td class="num" class:bad={m.providerErrorRate > 0.05}>{m.total === null ? '—' : pct0(m.providerErrorRate)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        </div>
      </div>
      <div class="panel">
        <h2>{$t('bench.byCategory')}</h2>
        <Heatmap {models} {colors} />
      </div>
      <div class="panel">
        <h2>{$t('bench.qualityCost')}</h2>
        <Scatter models={scored} {colors} />
      </div>
    </section>

    <section class="low">
      <div class="panel tasks">
        <h2>{$t('bench.tasksTitle', { n: ov.tasks.length, a: ov.attemptsPerTask })}</h2>
        <TaskTable tasks={ov.tasks} {models} runId={report.run.id} {colors} />
      </div>
      <div class="panel hist">
        <h2>{$t('bench.history')}</h2>
        <History history={ov.history} {colors} {labels} />
        <p class="note">{$t('bench.note')}</p>
      </div>
    </section>
  {/if}
</div>

<style>
  /* The bench's own palette: vivid on the dark surfaces, and immune to a user
     theme repainting the global accents (one turned this screen grey). */
  .bench {
    --b-cyan: #22D3EE; --b-violet: #A78BFA; --b-pink: #F472B6; --b-gold: #FBBF24; --b-emerald: #34D399; --b-sky: #60A5FA; --b-orange: #FB923C;
    --b-silver: #CBD5E1; --b-bronze: #F59E6B;
    --b-bad: #F43F5E;
    --b-accent: var(--b-cyan);
    display: flex; flex-direction: column; gap: 12px; padding: 14px 20px 16px; flex: 1; min-height: 0; height: 100%; overflow-y: auto; box-sizing: border-box;
    background:
      radial-gradient(900px 300px at 0% -10%, color-mix(in srgb, var(--b-violet) 10%, transparent), transparent 70%),
      radial-gradient(700px 260px at 100% -10%, color-mix(in srgb, var(--b-cyan) 9%, transparent), transparent 70%);
  }
  .top { display: flex; align-items: center; gap: 12px; }
  .ttl { display: flex; align-items: baseline; gap: 12px; min-width: 0; flex: 1; flex-wrap: wrap; }
  h1 {
    margin: 0; font-size: 21px; font-weight: 800; letter-spacing: -.01em; font-family: var(--font-display);
    background: linear-gradient(90deg, var(--b-cyan), var(--b-violet) 55%, var(--b-pink)); -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .meta { font-size: 12px; color: var(--text-2); }
  .live { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
    color: var(--b-emerald); padding: 2px 9px; border-radius: 999px; background: color-mix(in srgb, var(--b-emerald) 14%, transparent); align-self: center; }
  .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--b-emerald); box-shadow: 0 0 0 0 color-mix(in srgb, var(--b-emerald) 70%, transparent); animation: pulse 1.6s infinite; }
  @keyframes pulse { 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  .actions { display: flex; align-items: center; gap: 8px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 38px; padding: 6px 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1); font-size: 13.5px; font-weight: 700; cursor: pointer; transition: transform .15s ease-out, box-shadow .2s, filter .2s; }
  .btn svg { width: 15px; height: 15px; fill: currentColor; }
  .btn.primary { border: none; color: #07131a; background: linear-gradient(135deg, var(--b-cyan), var(--b-emerald)); box-shadow: 0 6px 20px -6px color-mix(in srgb, var(--b-cyan) 70%, transparent); }
  .btn.primary:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.08); box-shadow: 0 10px 26px -8px color-mix(in srgb, var(--b-cyan) 80%, transparent); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.icon { width: 38px; padding: 0; justify-content: center; font-size: 17px; }
  .btn:focus-visible, .link:focus-visible, .menu button:focus-visible { outline: 2px solid var(--b-cyan); outline-offset: 2px; }
  .link { all: unset; color: var(--b-cyan); cursor: pointer; font-weight: 600; }
  .prog { position: relative; width: 360px; height: 38px; border-radius: 10px; background: var(--surface-2); border: 1px solid color-mix(in srgb, var(--b-cyan) 35%, var(--border)); overflow: hidden; }
  .prog .bar { position: absolute; inset: 0 auto 0 0; transition: width .5s ease-out;
    background: linear-gradient(90deg, color-mix(in srgb, var(--b-violet) 55%, transparent), color-mix(in srgb, var(--b-cyan) 55%, transparent)); }
  .prog .bar::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,.18), transparent); animation: shine 1.8s infinite; }
  @keyframes shine { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
  .prog span { position: relative; display: block; padding: 0 12px; line-height: 36px; font-size: 12px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .prog b { color: #fff; }
  .menu-wrap { position: relative; }
  .menu { position: absolute; right: 0; top: 42px; z-index: 20; min-width: 240px; max-height: 380px; overflow: auto; background: var(--surface-1); border: 1px solid var(--border-h); border-radius: 10px; padding: 5px; box-shadow: 0 14px 34px rgba(0,0,0,.45); display: flex; flex-direction: column; }
  .menu button { all: unset; padding: 8px 10px; font-size: 12.5px; color: var(--text-1); cursor: pointer; border-radius: 6px; }
  .menu button:hover:not(:disabled) { background: color-mix(in srgb, var(--b-cyan) 14%, transparent); }
  .menu button:disabled { opacity: .4; }
  .msep { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-3); padding: 9px 10px 3px; }
  .mrun { display: flex; align-items: center; }
  .mrun > button:first-child { flex: 1; }
  .mrun .cur { color: var(--b-cyan); font-weight: 700; }
  .menu .del { color: var(--text-3); padding: 8px; }
  .menu .del:hover { color: var(--b-bad); }
  .banner { font-size: 12.5px; padding: 8px 12px; border-radius: 8px; background: color-mix(in srgb, var(--b-orange) 14%, transparent); border: 1px solid color-mix(in srgb, var(--b-orange) 45%, transparent); color: var(--text-1); }
  .empty { margin: auto; max-width: 540px; text-align: center; color: var(--text-1); font-size: 15px; }
  .tg { list-style: none; padding: 0; font-size: 13px; color: var(--text-2); line-height: 1.8; }

  .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .card { position: relative; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; min-width: 0; overflow: hidden;
    background: linear-gradient(135deg, color-mix(in srgb, var(--hue) 16%, var(--surface-1)), var(--surface-1) 65%);
    border: 1px solid color-mix(in srgb, var(--hue) 38%, var(--border)); transition: transform .2s ease-out, box-shadow .2s; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 12px 28px -14px color-mix(in srgb, var(--hue) 70%, transparent); }
  .ic { flex: none; width: 40px; height: 40px; border-radius: 11px; display: grid; place-items: center; background: color-mix(in srgb, var(--hue) 22%, transparent); }
  .ic svg { width: 21px; height: 21px; fill: none; stroke: var(--hue); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .cbody { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .ck { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--hue); font-weight: 800; display: flex; align-items: center; gap: 6px; }
  .prov { font-size: 9px; letter-spacing: .03em; color: var(--text-2); background: var(--surface-3); padding: 1px 6px; border-radius: 6px; font-weight: 700; }
  .cv { font-size: 16px; font-weight: 800; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cs { font-size: 12px; color: var(--text-2); }
  .cs b { color: var(--text-1); }

  .mid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.15fr) minmax(0, 0.9fr); gap: 12px; }
  .low { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(0, 1fr); gap: 12px; flex: 1; min-height: 0; }
  .panel { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .tasks { min-height: 0; }
  h2 { margin: 0; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--text-2); display: flex; align-items: center; gap: 8px; }
  h2::before { content: ''; width: 3px; height: 12px; border-radius: 2px; background: linear-gradient(var(--b-cyan), var(--b-violet)); }
  .rank-scroll { overflow-x: auto; overflow-y: hidden; margin: 0 -4px; padding: 0 4px 6px; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--b-cyan) 45%, transparent) transparent; }
  .rank-scroll::-webkit-scrollbar { height: 6px; }
  .rank-scroll::-webkit-scrollbar-thumb { border-radius: 3px; background: color-mix(in srgb, var(--b-cyan) 45%, transparent); }
  .rank-scroll:focus-visible { outline: 2px solid var(--b-cyan); outline-offset: 2px; border-radius: 6px; }
  .rank table { width: 100%; min-width: 640px; border-collapse: separate; border-spacing: 0; font-size: 12.5px; }
  /* Rank and model stay put while the metrics scroll under them. */
  .rank th:nth-child(-n+2), .rank td:nth-child(-n+2) { position: sticky; z-index: 1; background: var(--surface-1); }
  .rank th:nth-child(1), .rank td:nth-child(1) { left: 0; width: 34px; min-width: 34px; box-sizing: border-box; }
  .rank th:nth-child(2), .rank td:nth-child(2) { left: 34px; box-shadow: 6px 0 8px -6px rgba(0, 0, 0, .55); }
  .rank th { font-size: 10.5px; font-weight: 700; color: var(--text-3); text-align: right; padding: 3px 6px; white-space: nowrap; }
  .rank td { padding: 6px; text-align: right; border-top: 1px solid var(--border); color: var(--text-1); white-space: nowrap; }
  .rank tr.pending td { color: var(--text-3); }
  .rank .tl { text-align: left; }
  .medal { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; font-size: 11px; font-weight: 800; color: #111; background: var(--medal); }
  .mn { display: inline-flex; align-items: center; gap: 7px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
  .mn i { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 8px currentColor; }
  .prov-chip { font-size: 10px; font-weight: 700; color: var(--text-2); background: var(--surface-3); padding: 1px 6px; border-radius: 6px; }
  .score { min-width: 110px; }
  .sbar { display: inline-block; vertical-align: middle; width: 64px; height: 6px; border-radius: 3px; background: var(--surface-3); margin-right: 8px; overflow: hidden; }
  .sbar span { display: block; height: 100%; border-radius: 3px; }
  .score b { font-size: 14px; }
  .num { font-variant-numeric: tabular-nums; }
  .muted { color: var(--text-3); }
  .warn { color: var(--b-gold); }
  .bad { color: var(--b-bad); font-weight: 700; }
  .note { margin: 0; font-size: 11px; color: var(--text-3); line-height: 1.45; }
  @media (prefers-reduced-motion: reduce) {
    .pulse, .prog .bar::after { animation: none; }
    .btn, .card, .prog .bar { transition: none; }
    .card:hover, .btn.primary:hover:not(:disabled) { transform: none; }
  }
  @media (max-width: 1100px) {
    .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .mid, .low { grid-template-columns: minmax(0, 1fr); }
    .tasks { min-height: 420px; }
    .prog { width: 230px; }
  }
</style>
