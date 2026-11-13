<script lang="ts">
  /**
   * A4 + C4 + C5 · Relate's engine room, beside the 3D pavilion
   * (office3d/engine-room.ts).
   *
   * Polls /api/graph/engine for the statements the kernel ran since the last
   * look: each becomes a pulse on the rack, reads and writes on their lanes.
   * Lists what the planner warns about — a missing index, with the CREATE
   * INDEX it proposes, applied on a click — and the costliest statements; a
   * read picked here is PROFILEd again and its plan drawn on the wall. The
   * graph's blueprint hangs on the other wall, and a question ("how do Bruno
   * and Delta Norte connect?") is answered with SHORTEST paths over the rack.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { apiFetch, apiFetchRaw } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';

  export let world: any = null;

  const dispatch = createEventDispatcher<{ close: void }>();

  type Lane = { count: number; perSec: number; p50: number | null; p95: number | null; failed: number };
  type Statement = { key: string; label: string; write: boolean; count: number; avgMs: number; maxMs: number; failures: number; cypher: string; profileable: boolean };
  type Warning = { title: string; description: string; remedy: string; code: string; statement: string; seen: number };
  type PlanNode = { operator: string; details: string; rows: number; dbHits: number; ms: number; start: string | null; children: PlanNode[] };
  type Snapshot = {
    engine: string; embedded: boolean; lastSeq: number;
    items: Array<{ seq: number; write: boolean; ms: number | null; failed: boolean; label: string }>;
    stats: { reads: Lane; writes: Lane };
    top: Statement[]; warnings: Warning[];
  };
  type Blueprint = {
    labels: Array<{ label: string; count: number; indexes: Array<{ type: string; properties: string[] }> }>;
    relationships: Array<{ type: string; from: string; to: string; count: number }>; ms: number;
  };
  type PathRes = {
    from: { name: string; label: string } | null; to: { name: string; label: string } | null;
    paths: Array<{ nodes: Array<{ id: string; label: string; name: string }>; rels: Array<{ type: string }> }>;
    ms: number | null; cypher: string;
  };

  let snap: Snapshot | null = null;
  let error = '';
  let since = 0;
  let recent: Array<{ write: boolean; ms: number | null; failed: boolean }> = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let placeTimer: ReturnType<typeof setInterval> | null = null;
  let picked: Statement | null = null;
  let plan: { ms: number | null; rows: number; dbHits: number; tree: PlanNode | null } | null = null;
  let planError = '';
  let applying = '';
  let appliedMsg = '';
  let bp: Blueprint | null = null;
  let from = '';
  let to = '';
  let path: PathRes | null = null;
  let pathBusy = false;
  let showPathQuery = false;

  /** A remedy the kernel will apply on a click: the CREATE INDEX shape Relate proposes. Anything else is advice. */
  const INDEX_REMEDY = /^CREATE INDEX [A-Za-z_]\w* FOR \(n:[A-Za-z_]\w*\) ON \(n\.[A-Za-z_]\w*(?:, n\.[A-Za-z_]\w*)*\)$/;
  const fmt = (v: number | null | undefined) => (v == null ? '—' : v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v).toString());

  async function poll(): Promise<void> {
    try {
      const s = (await apiFetch(`/api/graph/engine?since=${since}`)) as Snapshot;
      error = '';
      snap = s;
      if (s.items.length) {
        since = s.items[s.items.length - 1].seq;
        recent = [...recent, ...s.items].slice(-48);
        world?.enginePulse?.(s.items.map((i) => ({ write: i.write, ms: i.ms, failed: i.failed })));
      } else if (since === 0) {
        since = s.lastSeq;
      }
      world?.engineStats?.({
        reads: `${$t('eng.reads')} ${s.stats.reads.perSec.toFixed(1)}/s · p50 ${fmt(s.stats.reads.p50)} ms`,
        writes: `${$t('eng.writes')} ${s.stats.writes.perSec.toFixed(1)}/s · p50 ${fmt(s.stats.writes.p50)} ms`,
      });
      world?.engineWarning?.(s.warnings.length > 0);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function loadBlueprint(): Promise<void> {
    try {
      bp = (await apiFetch('/api/graph/blueprint')) as Blueprint;
      world?.engineBlueprint?.(bp);
    } catch { bp = null; }
  }

  async function pick(s: Statement): Promise<void> {
    if (!s.profileable) return;
    picked = s;
    plan = null;
    planError = '';
    try {
      const r = (await apiFetch(`/api/graph/engine/profile?key=${encodeURIComponent(s.key)}`)) as { ms: number | null; rows: number; dbHits: number; tree: PlanNode | null };
      if (picked?.key !== s.key) return;
      plan = r;
      world?.enginePlan?.(s.label, r.tree, $t('eng.planFoot', { ms: fmt(r.ms), rows: r.rows, hits: r.dbHits }));
      world?.engineFocus?.();
    } catch (e) {
      planError = e instanceof Error ? e.message : String(e);
    }
  }

  async function apply(w: Warning): Promise<void> {
    applying = w.remedy;
    appliedMsg = '';
    try {
      const r = await apiFetchRaw('/api/graph/engine/index', { method: 'POST', body: JSON.stringify({ remedy: w.remedy }) });
      const body = (await r.json()) as { ms?: number | null; error?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      appliedMsg = $t('eng.applied', { ms: fmt(body.ms ?? null) });
      await poll();
      void loadBlueprint();
    } catch (e) {
      appliedMsg = e instanceof Error ? e.message : String(e);
    } finally {
      applying = '';
    }
  }

  async function ask(): Promise<void> {
    const a = from.trim(), b = to.trim();
    if (!a || !b) return;
    pathBusy = true;
    try {
      path = (await apiFetch(`/api/graph/path?from=${encodeURIComponent(a)}&to=${encodeURIComponent(b)}`)) as PathRes;
      const first = path.paths[0];
      world?.enginePath?.(first ? { nodes: first.nodes.map((n) => ({ label: n.label, name: n.name })), rels: first.rels } : null);
      if (first) world?.engineFocus?.();
    } catch (e) {
      path = null;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      pathBusy = false;
    }
  }

  function close(): void {
    world?.engineClose?.();
    dispatch('close');
  }

  onMount(() => {
    // The scene may still be building: place the room as soon as it stands.
    const place = () => {
      if (!world?.engineShow?.()) return false;
      world.engineFocus?.();
      return true;
    };
    if (!place()) {
      let tries = 0;
      placeTimer = setInterval(() => { if (place() || ++tries > 60) { if (placeTimer) clearInterval(placeTimer); placeTimer = null; } }, 1000);
    }
    void poll();
    void loadBlueprint();
    timer = setInterval(poll, 1500);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
    if (placeTimer) clearInterval(placeTimer);
    world?.engineClose?.();
  });

  const lines = (n: PlanNode, d = 0): Array<{ n: PlanNode; d: number }> => [{ n, d }, ...n.children.flatMap((c) => lines(c, d + 1))];
</script>

<aside class="eng" aria-label={$t('eng.title')}>
  <header class="eng-head">
    <span class="eng-title"><span aria-hidden="true">⚙</span> {$t('eng.title')}</span>
    <button class="eng-icon" on:click={() => world?.engineFocus?.()} aria-label={$t('eng.toRoom')} title={$t('eng.toRoom')}>🏭</button>
    <button class="eng-icon" on:click={close} aria-label={$t('eng.close')} title={$t('eng.close')}>✕</button>
  </header>

  {#if error && !snap}
    <p class="eng-msg err">{error}</p>
  {:else if snap}
    <section class="lanes" aria-label={$t('eng.lastMin')}>
      {#each [{ k: 'eng.reads', s: snap.stats.reads, cls: 'r' }, { k: 'eng.writes', s: snap.stats.writes, cls: 'w' }] as lane (lane.k)}
        <div class="lane lane-{lane.cls}">
          <span class="lane-name">{$t(lane.k)}</span>
          <b>{$t('eng.perSec', { n: lane.s.perSec.toFixed(1) })}</b>
          <span class="lane-p">{$t('eng.p', { p50: fmt(lane.s.p50), p95: fmt(lane.s.p95) })}</span>
        </div>
      {/each}
      <div class="strip" aria-hidden="true">
        {#each recent as q, i (i)}
          <span class="tick" class:w={q.write} class:slow={q.failed || (q.ms ?? 0) > 50}
            style="height:{Math.max(12, Math.min(100, 30 + 25 * Math.log10(Math.max(0.01, q.ms ?? 1))))}%"></span>
        {/each}
      </div>
      <p class="hint">{$t('eng.lastMin')} · {snap.engine}{snap.embedded ? ' · in-process' : ''}</p>
    </section>

    {#if snap.warnings.length}
      <section class="sec warn">
        <h4>⚠ {$t('eng.warnings')}</h4>
        {#each snap.warnings as w (w.remedy)}
          <div class="wcard">
            <p class="w-desc">{w.description}</p>
            {#if INDEX_REMEDY.test(w.remedy)}<code>{w.remedy}</code>{:else}<p class="w-advice">{w.remedy}</p>{/if}
            <p class="w-meta">{$t('eng.seenBy', { stmt: w.statement, n: w.seen })}</p>
            {#if INDEX_REMEDY.test(w.remedy)}
              <button class="apply" on:click={() => apply(w)} disabled={!!applying}>{applying === w.remedy ? '…' : $t('eng.apply')}</button>
            {/if}
          </div>
        {/each}
      </section>
    {/if}
    {#if appliedMsg}<p class="eng-msg ok">{appliedMsg}</p>{/if}

    <section class="sec">
      <h4>{$t('eng.top')} <span class="sub">· {$t('eng.topHint')}</span></h4>
      <ol class="top">
        {#each snap.top as s (s.key)}
          <li>
            <button class="stmt" class:on={picked?.key === s.key} class:w={s.write} disabled={!s.profileable} on:click={() => pick(s)} title={s.cypher}>
              <span class="stmt-k">{s.write ? 'W' : 'R'}</span>
              <span class="stmt-l">{s.label}</span>
              <span class="stmt-n">{$t('eng.calls', { n: s.count, avg: fmt(s.avgMs), max: fmt(s.maxMs) })}</span>
            </button>
          </li>
        {/each}
      </ol>
    </section>

    {#if picked}
      <section class="sec">
        <h4>{$t('eng.plan')} · <span class="sub">{picked.label}</span></h4>
        {#if planError}<p class="eng-msg err">{planError}</p>
        {:else if plan?.tree}
          <ul class="plan">
            {#each lines(plan.tree) as { n, d }, i (i)}
              <li style="--d:{d}"><b>{n.operator}</b> <span>{n.rows} · {n.dbHits}{n.start ? ` · ${n.start}` : ''}</span>{#if n.details}<em>{n.details}</em>{/if}</li>
            {/each}
          </ul>
          <p class="foot">{$t('eng.planFoot', { ms: fmt(plan.ms), rows: plan.rows, hits: plan.dbHits })}</p>
          <pre class="cy">{picked.cypher}</pre>
        {/if}
      </section>
    {/if}

    <section class="sec">
      <h4>{$t('eng.ask')}</h4>
      <form class="ask" on:submit|preventDefault={ask}>
        <input bind:value={from} placeholder={$t('eng.from')} aria-label="from" />
        <span aria-hidden="true">↔</span>
        <input bind:value={to} placeholder={$t('eng.to')} aria-label="to" />
        <button type="submit" disabled={pathBusy}>{pathBusy ? '…' : $t('eng.find')}</button>
      </form>
      {#if path}
        {#if !path.from}<p class="eng-msg">{$t('eng.notFound', { q: from })}</p>
        {:else if !path.to}<p class="eng-msg">{$t('eng.notFound', { q: to })}</p>
        {:else if path.paths.length === 0}<p class="eng-msg">{$t('eng.noPath')}</p>
        {:else}
          {#each path.paths as p, pi (pi)}
            <p class="chain" class:alt={pi > 0}>
              {#each p.nodes as n, i (n.id)}
                <span class="node"><b>{n.name}</b><em>:{n.label}</em></span>{#if i < p.rels.length}<span class="rel">—{p.rels[i].type}—</span>{/if}
              {/each}
            </p>
          {/each}
          <p class="foot">{$t('eng.pathFoot', { n: path.paths.length, ms: fmt(path.ms) })}
            <button class="q" on:click={() => (showPathQuery = !showPathQuery)} aria-expanded={showPathQuery}>{$t('eng.query')}</button></p>
          {#if showPathQuery}<pre class="cy">{path.cypher}</pre>{/if}
        {/if}
      {/if}
    </section>

    {#if bp}
      <section class="sec">
        <h4>{$t('eng.blueprint')}</h4>
        <div class="labels">
          {#each bp.labels.slice(0, 18) as l (l.label)}
            <span class="lab" class:idx={l.indexes.some((i) => i.type !== 'LOOKUP')}>{l.label} <b>{l.count.toLocaleString()}</b></span>
          {/each}
        </div>
        <p class="foot">{$t('eng.blueprintFoot', { labels: bp.labels.length, rels: new Set(bp.relationships.map((r) => r.type)).size, ms: fmt(bp.ms) })}</p>
      </section>
    {/if}
  {:else}
    <p class="eng-msg">…</p>
  {/if}
</aside>

<style>
  .eng {
    position: absolute; top: 12px; right: 12px; bottom: 12px; z-index: 41;
    width: min(410px, calc(100% - 24px)); overflow-y: auto; scrollbar-width: thin;
    display: flex; flex-direction: column; gap: 12px;
    background: rgba(6, 10, 20, 0.9); backdrop-filter: blur(10px);
    border: 1px solid rgba(124, 200, 255, 0.3); border-radius: 14px;
    color: #e3ebf5; padding: 12px 14px; box-shadow: 0 10px 40px rgba(0,0,0,.45); font-size: 13px;
  }
  .eng-head { display: flex; align-items: center; gap: 6px; }
  .eng-title { font-weight: 700; color: #7cc8ff; flex: 1; }
  button { cursor: pointer; font: inherit; color: inherit; }
  button:focus-visible, input:focus-visible { outline: 2px solid #7cc8ff; outline-offset: 2px; }
  .eng-icon { background: none; border: none; font-size: 15px; }
  .eng-msg { margin: 0; color: #9fb4c8; }
  .eng-msg.err { color: #ff8a8a; }
  .eng-msg.ok { color: #3dd68c; }
  .lanes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .lane { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; background: rgba(255,255,255,.04); }
  .lane-r { border-left: 3px solid #4fb3ff; }
  .lane-w { border-left: 3px solid #ffb020; }
  .lane-name { font: 600 10px 'Syne', sans-serif; letter-spacing: 1px; text-transform: uppercase; color: #8aa0b8; }
  .lane b { font: 700 18px 'JetBrains Mono', monospace; }
  .lane-p { font: 500 11px 'JetBrains Mono', monospace; color: #9fb4c8; }
  .strip { grid-column: 1 / -1; display: flex; align-items: flex-end; justify-content: flex-end; gap: 2px; height: 34px; }
  .tick { flex: none; width: 5px; background: #4fb3ff; border-radius: 1px; opacity: .85; }
  .tick.w { background: #ffb020; }
  .tick.slow { background: #ff4d4d; }
  .hint { grid-column: 1 / -1; margin: 0; font: 500 10px 'JetBrains Mono', monospace; color: #6f8399; }
  .sec { display: flex; flex-direction: column; gap: 6px; }
  .sec h4 { margin: 0; font: 700 10px 'Syne', sans-serif; letter-spacing: 1.1px; text-transform: uppercase; color: #7cc8ff; }
  .sub { text-transform: none; letter-spacing: 0; font: 500 11px 'Manrope', sans-serif; color: #8aa0b8; }
  .warn h4 { color: #ffb020; }
  .wcard { padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,176,32,.35); background: rgba(255,176,32,.07); display: flex; flex-direction: column; gap: 4px; }
  .w-desc { margin: 0; font-size: 12px; }
  .w-advice { margin: 0; font: 500 11px 'Manrope', sans-serif; color: #ffd37a; }
  .wcard code { font: 500 11px 'JetBrains Mono', monospace; color: #ffd37a; word-break: break-all; }
  .w-meta { margin: 0; font-size: 10px; color: #9fb4c8; }
  .apply { align-self: flex-start; background: rgba(255,176,32,.2); border: 1px solid rgba(255,176,32,.5); border-radius: 6px; padding: 3px 10px; }
  .apply:disabled { opacity: .5; cursor: default; }
  .top { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
  .stmt { width: 100%; display: grid; grid-template-columns: 18px 1fr; gap: 0 6px; text-align: left; background: rgba(255,255,255,.03); border: 1px solid transparent; border-radius: 6px; padding: 4px 6px; }
  .stmt:hover:not(:disabled) { border-color: rgba(124,200,255,.35); }
  .stmt.on { border-color: #7cc8ff; background: rgba(124,200,255,.1); }
  .stmt:disabled { cursor: default; opacity: .75; }
  .stmt-k { grid-row: span 2; font: 700 11px 'JetBrains Mono', monospace; color: #4fb3ff; align-self: center; }
  .stmt.w .stmt-k { color: #ffb020; }
  .stmt-l { font: 500 11px 'JetBrains Mono', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stmt-n { font: 500 10px 'JetBrains Mono', monospace; color: #8aa0b8; }
  .plan { margin: 0; padding: 0; list-style: none; font: 500 11px 'JetBrains Mono', monospace; display: flex; flex-direction: column; gap: 2px; }
  .plan li { padding-left: calc(var(--d) * 14px); }
  .plan b { color: #7cc8ff; }
  .plan span { color: #9fb4c8; }
  .plan em { display: block; font-style: normal; color: #6f8399; padding-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot { margin: 0; font: 600 10px 'JetBrains Mono', monospace; color: #3dd68c; display: flex; justify-content: space-between; align-items: center; }
  .cy { margin: 0; padding: 8px; border-radius: 5px; background: rgba(0,0,0,.35); font: 400 10px/1.5 'JetBrains Mono', monospace; color: #cfd8e6; white-space: pre-wrap; max-height: 160px; overflow: auto; }
  .q { background: none; border: 1px solid rgba(124,200,255,.35); color: #7cc8ff; border-radius: 4px; padding: 0 6px; font: 600 10px 'JetBrains Mono', monospace; }
  .ask { display: flex; align-items: center; gap: 6px; }
  .ask input { flex: 1; min-width: 0; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); border-radius: 7px; padding: 4px 8px; color: inherit; font: inherit; }
  .ask button { background: rgba(61,214,140,.18); border: 1px solid rgba(61,214,140,.45); border-radius: 7px; padding: 4px 10px; white-space: nowrap; }
  .chain { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 12px; }
  .chain.alt { opacity: .6; font-size: 11px; }
  .node { display: inline-flex; flex-direction: column; padding: 2px 7px; border-radius: 6px; background: rgba(124,200,255,.1); border: 1px solid rgba(124,200,255,.3); }
  .node em { font-style: normal; font-size: 10px; color: #8aa0b8; }
  .rel { font: 600 10px 'JetBrains Mono', monospace; color: #3dd68c; }
  .labels { display: flex; flex-wrap: wrap; gap: 4px; }
  .lab { font: 500 11px 'Manrope', sans-serif; padding: 2px 7px; border-radius: 10px; background: rgba(166,107,255,.14); color: #d9c2ff; }
  .lab.idx { box-shadow: inset 0 0 0 1px #3dd68c; }
  .lab b { font: 600 10px 'JetBrains Mono', monospace; }
</style>
