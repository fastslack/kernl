<script lang="ts">
  /**
   * B1 + B2 + A2 · The experience library.
   *
   * Every lesson each agent keeps, as books on its bookcase — here as a list,
   * and in the office as a pavilion on a free lot (office3d/library.ts). The
   * slider walks the weeks: books appear when learned, grow or shrink with
   * their confidence, fall when retired. Pick a book: its lineage — the agents
   * it reached, how their runs went, the lessons it gave rise to — comes from
   * one quantified-path query and is drawn as threads between their desks.
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { apiFetch } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';
  import {
    bookAt, libraryWeeks, librarySummary, lineageHops, lineageReach,
    type Library, type LibraryBook, type LineageNode,
  } from '$lib/learning-library.js';
  import LessonImpact from './LessonImpact.svelte';

  export let world: any = null;
  export let flows: Array<{ id: string; name: string }> = [];
  /** Open on one lesson (a book picked elsewhere). */
  export let learningId = '';

  const dispatch = createEventDispatcher<{ close: void }>();

  let flow = '';
  let lib: Library | null = null;
  let loading = true;
  let error = '';
  let weeks: number[] = [];
  let idx = 0;
  let playing = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let selected: LibraryBook | null = null;
  type Lineage = { nodes: LineageNode[]; query_ms: number | null; cypher: string };
  let lineage: Lineage | null = null;
  let lineageLoading = false;
  let showLibQuery = false;
  let showLinQuery = false;

  $: at = weeks[idx] ?? Date.now();
  $: summary = lib ? librarySummary(lib, at) : null;
  $: if (lib && world) world.libraryAt?.(at);
  $: reach = lineage ? lineageReach(lineage.nodes) : null;

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      const r = (await apiFetch(`/api/agents/learnings/library${flow ? `?flow=${encodeURIComponent(flow)}` : ''}`)) as Library;
      if (!r.graph) { error = $t('lib.noGraph'); lib = null; return; }
      lib = r;
      weeks = libraryWeeks(r, Date.now());
      idx = weeks.length - 1;
      // A book named in the URL opens once the library stands in the office
      // (its lineage is drawn between desks the scene must have built).
      const preset = learningId ? r.agents.flatMap((a) => a.books).find((x) => x.id === learningId) : undefined;
      placeInOffice(r, preset ? () => setTimeout(() => void pick(preset), 1500) : undefined);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // The scene may still be building when the data arrives: try until it stands.
  let placeTimer: ReturnType<typeof setInterval> | null = null;
  function placeInOffice(r: Library, then?: () => void): void {
    if (placeTimer) clearInterval(placeTimer);
    const tryOnce = () => {
      if (lib !== r) return true;
      if (!world?.libraryShow?.(r, at)) return false;
      world.libraryFocus?.();
      then?.();
      return true;
    };
    if (tryOnce()) return;
    let tries = 0;
    placeTimer = setInterval(() => {
      if (tryOnce() || ++tries > 60) { if (placeTimer) clearInterval(placeTimer); placeTimer = null; }
    }, 1000);
  }

  async function pick(b: LibraryBook): Promise<void> {
    if (selected?.id === b.id) { unpick(); return; }
    selected = b;
    lineage = null;
    lineageLoading = true;
    try {
      const r = (await apiFetch(`/api/agents/learnings/${encodeURIComponent(b.id)}/lineage`)) as { lineage: Lineage | null };
      if (selected?.id !== b.id) return;
      const found = r.lineage;
      lineage = found;
      if (found) {
        world?.libraryHighlight?.(new Set(found.nodes.map((n) => n.id)));
        const origin = found.nodes.find((n) => n.depth === 0)?.owner.id ?? '';
        world?.lineageShow?.(lineageHops(found.nodes), origin);
        // The threads run between desks: frame the office where it was learned.
        const office = lib?.agents.find((a) => a.id === origin)?.flow_id;
        if (office) world?.focusOfficeById?.(office);
      }
    } catch {
      lineage = null;
    } finally {
      lineageLoading = false;
    }
  }

  function unpick(): void {
    selected = null;
    lineage = null;
    world?.libraryHighlight?.(null);
    world?.lineageClear?.();
  }

  function toggle(): void {
    if (playing) { stop(); return; }
    if (idx >= weeks.length - 1) idx = 0;
    playing = true;
    timer = setInterval(() => {
      if (idx >= weeks.length - 1) { stop(); return; }
      idx += 1;
    }, 900);
  }
  function stop(): void {
    playing = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function close(): void {
    stop();
    world?.libraryClose?.();
    dispatch('close');
  }

  onMount(load);
  onDestroy(() => { stop(); if (placeTimer) clearInterval(placeTimer); world?.libraryClose?.(); });

  const KIND: Record<string, string> = { avoid: '#ff5a5a', prefer: '#45e08a', insight: '#ffc94d', pattern: '#6aa8ff' };
  // Weeks start Monday 00:00 UTC: shown in UTC, or a western clock reads Sunday.
  const dateOf = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const clean = (s: string) => s.replace(/^\[auto\]\s*/, '');
  const nameOf = (id: string) => lib?.agents.find((a) => a.id === id)?.name ?? '';
</script>

<aside class="lib" aria-label={$t('lib.title')}>
  <header class="lib-head">
    <span class="lib-title"><span aria-hidden="true">📚</span> {$t('lib.title')}</span>
    <select bind:value={flow} on:change={() => { unpick(); world?.libraryClose?.(); void load(); }} aria-label={$t('lib.all')}>
      <option value="">{$t('lib.all')}</option>
      {#each flows as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
    </select>
    <button class="lib-x" on:click={() => world?.libraryFocus?.()} aria-label={$t('lib.toLibrary')} title={$t('lib.toLibrary')}>🏛</button>
    <button class="lib-x" on:click={close} aria-label={$t('lib.close')} title={$t('lib.close')}>✕</button>
  </header>

  {#if loading}
    <p class="lib-msg">{$t('lib.loading')}</p>
  {:else if error}
    <p class="lib-msg err">{error}</p>
  {:else if lib && lib.agents.length === 0}
    <p class="lib-msg">{$t('lib.empty')}</p>
  {:else if lib}
    <div class="lib-time">
      <button class="lib-play" on:click={toggle} aria-label={playing ? $t('lib.pause') : $t('lib.play')} title={playing ? $t('lib.pause') : $t('lib.play')}>{playing ? '❚❚' : '▶'}</button>
      <input type="range" min="0" max={Math.max(0, weeks.length - 1)} bind:value={idx} on:input={stop} aria-label={$t('lib.play')} />
      <span class="lib-date">{idx === weeks.length - 1 ? $t('lib.now') : $t('lib.week', { date: dateOf(at) })}</span>
    </div>
    {#if summary}
      <div class="lib-stats">
        <span><b>{summary.held}</b> {$t('lib.held')}</span>
        <span><b>{summary.retired}</b> {$t('lib.retired')}</span>
        <span><b>{Math.round(summary.avgConfidence * 100)}%</b> {$t('lib.avg')}</span>
        <span><b>{summary.shared}</b> {$t('lib.shared')}</span>
      </div>
    {/if}

    <div class="lib-shelves">
      {#each lib.agents as a (a.id)}
        <div class="shelf">
          <span class="shelf-name" title={a.name}>{a.name}</span>
          <div class="shelf-books">
            {#each a.books as b (b.id)}
              {@const s = bookAt(b, lib.timelines[b.id], at)}
              {#if s.present}
                <button
                  class="book" class:retired={s.retired} class:on={selected?.id === b.id}
                  style="--h:{Math.round(22 + 58 * s.confidence)}%;--c:{KIND[b.type] ?? KIND.insight};--dust:{s.retired ? 0.8 : s.dust * 0.7}"
                  title={`${clean(b.content)}\n${Math.round(s.confidence * 100)}% · ${$t('lib.uses', { n: b.uses, s: b.shared_uses })}`}
                  aria-label={clean(b.content)} aria-pressed={selected?.id === b.id}
                  on:click={() => pick(b)}
                ></button>
              {/if}
            {/each}
          </div>
        </div>
      {/each}
    </div>
    <footer class="lib-foot">
      {#if lib.query_ms != null}<span>{$t('lib.engine', { what: $t('lib.libQuery'), ms: lib.query_ms.toFixed(2) })}</span>{/if}
      <button class="lib-q" on:click={() => (showLibQuery = !showLibQuery)} aria-expanded={showLibQuery}>{$t('lib.query')}</button>
    </footer>
    {#if showLibQuery}<pre class="lib-cypher">{lib.cypher}</pre>{/if}

    {#if !selected}
      <p class="lib-msg">{$t('lib.pick')}</p>
    {:else}
      <section class="lin">
        <h4>{$t('lib.lineage')}</h4>
        {#if lineageLoading}
          <p class="lib-msg">{$t('lib.loading')}</p>
        {:else if lineage}
          {#if reach}<p class="lin-reach">{$t('lib.reach', { agents: reach.agents, ok: reach.ok, runs: reach.runs, d: reach.descendants })}</p>{/if}
          <ol class="lin-tree">
            {#each lineage.nodes as n (n.id)}
              <li style="--d:{n.depth}">
                <div class="lin-node">
                  <span class="dot" style="background:{KIND[n.type] ?? KIND.insight}"></span>
                  <span class="lin-text">{clean(n.content)}</span>
                  <span class="lin-meta">{$t('lib.learnedBy', { who: n.owner.name || nameOf(n.owner.id) })} · {Math.round(n.confidence * 100)}%</span>
                </div>
                {#if n.uses.length}
                  <ul class="lin-uses">
                    {#each n.uses as u (u.run)}
                      <li class:ok={u.status === 'completed'} class:bad={u.status !== 'completed'}>
                        {u.status === 'completed' ? '✓' : '✗'} {$t('lib.carried', { who: u.name || nameOf(u.agent) })}{#if u.child}{' '}<b>{$t('lib.gaveRise')}</b>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ol>
          <footer class="lib-foot">
            {#if lineage.query_ms != null}<span>{$t('lib.engine', { what: $t('lib.linQuery'), ms: lineage.query_ms.toFixed(2) })}</span>{/if}
            <button class="lib-q" on:click={() => (showLinQuery = !showLinQuery)} aria-expanded={showLinQuery}>{$t('lib.query')}</button>
          </footer>
          {#if showLinQuery}<pre class="lib-cypher">{lineage.cypher}</pre>{/if}
        {/if}
        {#key selected.id}<LessonImpact id={selected.id} />{/key}
      </section>
    {/if}
  {/if}
</aside>

<style>
  .lib {
    position: absolute; top: 12px; right: 12px; bottom: 12px; z-index: 41;
    width: min(400px, calc(100% - 24px)); overflow-y: auto; scrollbar-width: thin;
    display: flex; flex-direction: column; gap: 10px;
    background: rgba(10, 8, 20, 0.88); backdrop-filter: blur(10px);
    border: 1px solid rgba(166, 107, 255, 0.3); border-radius: 14px;
    color: #e6e2f2; padding: 12px 14px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45); font-size: 13px;
  }
  .lib-head { display: flex; align-items: center; gap: 8px; }
  .lib-title { font-weight: 700; color: #c9a8ff; white-space: nowrap; }
  select { flex: 1; min-width: 0; background: rgba(255,255,255,.06); color: inherit; border: 1px solid rgba(255,255,255,.14); border-radius: 7px; padding: 4px 6px; font: inherit; }
  button { cursor: pointer; font: inherit; color: inherit; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #c9a8ff; outline-offset: 2px; }
  .lib-x { background: none; border: none; font-size: 15px; }
  .lib-msg { margin: 0; color: #a49cbc; }
  .lib-msg.err { color: #ff8a8a; }
  .lib-time { display: flex; align-items: center; gap: 8px; }
  .lib-play { width: 34px; height: 28px; border-radius: 8px; border: 1px solid rgba(166,107,255,.4); background: rgba(166,107,255,.22); }
  .lib-time input { flex: 1; accent-color: #a66bff; }
  .lib-date { font: 600 11px 'JetBrains Mono', monospace; color: #d9c2ff; white-space: nowrap; min-width: 116px; text-align: right; }
  .lib-stats { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: #a49cbc; }
  .lib-stats b { color: #fff; font: 700 13px 'JetBrains Mono', monospace; }
  .lib-shelves { display: flex; flex-direction: column; gap: 6px; }
  .shelf { display: grid; grid-template-columns: 96px 1fr; gap: 8px; align-items: end; }
  .shelf-name { font-size: 11px; color: #c8c2da; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shelf-books {
    display: flex; align-items: flex-end; gap: 2px; height: 38px; padding: 0 4px 3px;
    border-bottom: 3px solid #4a3324; background: linear-gradient(180deg, transparent, rgba(74,51,36,.25)); overflow: hidden;
  }
  .book {
    width: 7px; height: var(--h); flex: none; padding: 0; border: none; border-radius: 1px 1px 0 0;
    background: color-mix(in srgb, var(--c) calc(100% - var(--dust) * 100%), #6f6a62);
    transition: height .5s ease-out, background .5s, transform .5s;
  }
  .book:hover { filter: brightness(1.35); }
  .book.on { box-shadow: 0 0 0 2px #fff, 0 0 10px var(--c); }
  .book.retired { height: 5px; width: 12px; transform: translateY(2px) rotate(-6deg); }
  .lib-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; font: 500 10px 'JetBrains Mono', monospace; color: #8f88a8; }
  .lib-q { background: none; border: 1px solid rgba(166,107,255,.35); color: #c9a8ff; border-radius: 4px; padding: 1px 7px; font: 600 10px 'JetBrains Mono', monospace; }
  .lib-cypher { margin: 0; padding: 8px; border-radius: 5px; background: rgba(0,0,0,.35); font: 400 10px/1.5 'JetBrains Mono', monospace; color: #cfd3e2; white-space: pre-wrap; }
  .lin { display: flex; flex-direction: column; gap: 8px; }
  .lin h4 { margin: 0; font: 700 10px 'Syne', sans-serif; letter-spacing: 1.1px; text-transform: uppercase; color: #c9a8ff; }
  .lin-reach { margin: 0; font-weight: 600; color: #d9c2ff; font-size: 12px; }
  .lin-tree { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .lin-tree > li { margin-left: calc(var(--d) * 14px); padding-left: 8px; border-left: 2px solid rgba(166,107,255,.35); }
  .lin-node { display: flex; flex-direction: column; gap: 2px; }
  .lin-node .dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .lin-text { font-size: 12px; line-height: 1.45; color: #e8e4f4; }
  .lin-meta { font: 500 10px 'JetBrains Mono', monospace; color: #8f88a8; }
  .lin-uses { margin: 4px 0 0; padding: 0; list-style: none; font-size: 11px; display: flex; flex-direction: column; gap: 2px; }
  .lin-uses li.ok { color: #7fe3aa; }
  .lin-uses li.bad { color: #ff9a9a; }
  .lin-uses b { color: #d9c2ff; font-weight: 600; }
  @media (prefers-reduced-motion: reduce) { .book { transition: none; } }
</style>
