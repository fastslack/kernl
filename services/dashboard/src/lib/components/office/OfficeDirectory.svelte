<script lang="ts">
  /*
    The office directory, on one screen: a strip with the question, four KPI
    tiles that double as filters (all, working now, to review, turned off), the
    search and the way to Dirección; under it every office as a dense tile that
    shares the height left. A tile says what matters at a glance — who is
    working (bar + glowing dot), the state, the first agents — and its power
    switch sits beside it. Only the grid scrolls, and only when the window is
    too small for every office.
  */
  import { createEventDispatcher } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import type { RailModel, RailOffice } from '$lib/office/rail-model.js';
  import Skeleton from '$shared/components/Skeleton.svelte';
  export let model: RailModel;
  export let loading = false;
  export let error = false;
  export let inbox = 0;
  /** Office whose on/off switch is waiting on the kernel. */
  export let powerBusy: string | null = null;
  const dispatch = createEventDispatcher<{ select: { id: string }; headquarters: void; retry: void; agent: { id: string }; power: { id: string; paused: boolean } }>();

  type State = 'working' | 'review' | 'paused' | 'idle' | 'off' | 'draining';
  let query = '';
  let filter: '' | 'working' | 'review' | 'off' = '';
  const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  function status(office: RailOffice): State {
    if (office.paused) return office.working ? 'draining' : 'off';
    if (office.agents.some(a => a.state === 'error')) return 'review';
    if (office.working) return 'working';
    if (office.agents.length && office.agents.every(a => a.state === 'paused')) return 'paused';
    return 'idle';
  }
  $: states = new Map(model.offices.map(o => [o.id, status(o)]));
  $: kpi = {
    offices: model.offices.length,
    agents: model.offices.reduce((s, o) => s + o.agents.length, 0),
    working: model.offices.reduce((s, o) => s + o.working, 0),
    workingOffices: model.offices.filter(o => o.working > 0 && !o.paused).length,
    review: model.offices.filter(o => states.get(o.id) === 'review').length,
    off: model.offices.filter(o => o.paused).length,
  };
  const inFilter = (o: RailOffice) => {
    const s = states.get(o.id);
    return !filter || (filter === 'working' ? s === 'working' || s === 'draining' : filter === 'review' ? s === 'review' : o.paused);
  };
  $: matches = model.offices
    .filter(inFilter)
    .filter(o => fold(o.name + ' ' + o.agents.map(a => a.name).join(' ')).includes(fold(query.trim())));
  function toggle(f: typeof filter) { filter = filter === f ? '' : f; }
  /** Leads first, then the ones at work: the names that tell what the office is doing. */
  const names = (o: RailOffice) => [...o.agents].sort((a, b) => Number(b.lead) - Number(a.lead) || Number(b.state === 'working') - Number(a.state === 'working')).slice(0, 4);
  const COLOR: Record<State, string> = { working: '#34D399', draining: '#FBBF24', review: '#FB923C', paused: '#60A5FA', idle: '#94A3B8', off: '#64748B' };
</script>

<section class="directory" aria-label={$t('office.directory.title')}>
  <header class="strip">
    <div class="ttl">
      <p class="eyebrow">{$t('office.directory.eyebrow')}</p>
      <h2>{$t('office.directory.title')}</h2>
    </div>
    <div class="kpis">
      <button class="kpi" class:on={filter === ''} style="--c: #22D3EE" on:click={() => (filter = '')} aria-pressed={filter === ''}>
        <b>{kpi.offices}</b><small>{$t('office.directory.k_offices')} · {$t('office.directory.k_agents', { n: kpi.agents })}</small>
      </button>
      <button class="kpi" class:on={filter === 'working'} class:live={kpi.working > 0} style="--c: #34D399" on:click={() => toggle('working')} aria-pressed={filter === 'working'}>
        <b>{kpi.working}</b><small>{$t('office.directory.k_working')}</small>
      </button>
      <button class="kpi" class:on={filter === 'review'} style="--c: {kpi.review ? '#FB923C' : '#A78BFA'}" on:click={() => toggle('review')} aria-pressed={filter === 'review'}>
        <b>{kpi.review}</b><small>{$t('office.directory.k_review')}</small>
      </button>
      <button class="kpi" class:on={filter === 'off'} style="--c: #94A3B8" on:click={() => toggle('off')} aria-pressed={filter === 'off'}>
        <b>{kpi.off}</b><small>{$t('office.directory.k_off')}</small>
      </button>
    </div>
    {#if model.headquarters}
      <button class="chief" class:pending={inbox > 0} on:click={() => dispatch('headquarters')}>
        <span class="chief-mark" aria-hidden="true">◆</span>
        <span class="chief-txt"><strong>{$t('office.rail.headquarters')}</strong><small>{$t(inbox ? 'office.directory.pending' : 'office.directory.chief', { n: inbox })}</small></span>
        <span aria-hidden="true">→</span>
      </button>
    {/if}
  </header>

  <div class="tools">
    <label class="search"><span aria-hidden="true">⌕</span><input type="search" bind:value={query} aria-label={$t('office.rail.search')} placeholder={$t('office.rail.search')} /></label>
    <span class="result-count">{$t('office.directory.count', { n: matches.length })}</span>
    {#if filter || query}<button class="clear" on:click={() => { filter = ''; query = ''; }}>{$t('office.directory.show_all')}</button>{/if}
  </div>

  {#if error}
    <div class="empty" role="alert"><p>{$t('office.directory.error')}</p><button class="k-btn" on:click={() => dispatch('retry')}>{$t('office.directory.retry')}</button></div>
  {:else if loading}
    <div role="status" aria-label={$t('office.directory.loading')}><Skeleton variant="cards" rows={6} /></div>
  {:else}
    <div class="grid" style="--n: {matches.length}">
      {#each matches as office (office.id)}
        {@const state = states.get(office.id) ?? 'idle'}
        {@const share = office.agents.length ? office.working / office.agents.length : 0}
        <div class="tile-wrap" class:off={office.paused} style:--oc={office.color} style:--sc={COLOR[state]}>
          <button class="tile" on:click={() => dispatch('select', { id: office.id })} title={office.agents.map(a => a.name).join(' · ')}>
            <span class="row1">
              <span class="mark" aria-hidden="true">{office.name.slice(0, 2).toUpperCase()}</span>
              <span class="name">{office.name}</span>
            </span>
            <span class="row2">
              <span class="st" class:live={state === 'working'}><i aria-hidden="true"></i>{$t('office.directory.' + state)}</span>
              <span class="cnt">{#if office.working}<b>{office.working}</b>/{/if}{office.agents.length}</span>
            </span>
            <span class="meter" aria-hidden="true"><i style="width: {office.working ? Math.max(8, share * 100) : 0}%"></i></span>
            <span class="who">{names(office).map(a => a.name).join(' · ')}{office.agents.length > 4 ? ' …' : ''}</span>
          </button>
          <!-- Sibling of the tile, not inside it: a button can't nest another. -->
          <button class="power" class:on={!office.paused} type="button" aria-pressed={!office.paused}
            disabled={powerBusy === office.id}
            title={$t(office.paused ? 'office.power.turn_on' : 'office.power.turn_off')}
            aria-label={$t(office.paused ? 'office.power.turn_on_named' : 'office.power.turn_off_named', { name: office.name })}
            on:click={() => dispatch('power', { id: office.id, paused: !office.paused })}>⏻</button>
        </div>
      {/each}
      {#if !matches.length}<p class="empty">{$t(query ? 'office.rail.no_match' : 'office.rail.empty', { q: query })}</p>{/if}
    </div>
    {#if model.unassigned.length}
      <section class="unassigned"><h3>{$t('office.rail.unassigned')}</h3><div>{#each model.unassigned as agent (agent.id)}<button class="k-btn" on:click={() => dispatch('agent', { id: agent.id })}>{agent.name} ↗</button>{/each}</div></section>
    {/if}
  {/if}
</section>

<style>
  /* One screen: strip, tools and a grid that shares what is left; the grid scrolls only when it must. */
  .directory { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; gap: 10px; overflow: hidden; padding: 14px 20px 16px; background: var(--bg); color: var(--text-1); }

  .strip { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px; align-items: center; }
  .eyebrow { margin: 0; color: var(--gold); font: 700 10px/1.4 var(--font-body); letter-spacing: .14em; text-transform: uppercase; }
  h2 { margin: 2px 0 0; font: 700 22px/1.15 var(--font-display); letter-spacing: -.02em;
    background: linear-gradient(90deg, #FBBF24, #F472B6 50%, #A78BFA); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .kpi { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; padding: 7px 12px; border-radius: 12px; cursor: pointer; font: inherit; color: inherit; text-align: left;
    background: linear-gradient(160deg, color-mix(in srgb, var(--c) 18%, var(--surface-1)), var(--surface-1) 72%); border: 1px solid color-mix(in srgb, var(--c) 32%, var(--border));
    transition: transform .15s, box-shadow .15s, border-color .15s; }
  .kpi:hover { transform: translateY(-1px); box-shadow: 0 10px 22px -16px var(--c); }
  .kpi.on { border-color: var(--c); box-shadow: 0 0 0 1px var(--c) inset, 0 10px 24px -16px var(--c); }
  .kpi b { font-size: 21px; font-weight: 800; line-height: 1.1; color: color-mix(in srgb, var(--c) 75%, white); font-variant-numeric: tabular-nums; text-shadow: 0 0 14px color-mix(in srgb, var(--c) 45%, transparent); }
  .kpi small { font-size: 10.5px; color: color-mix(in srgb, var(--c) 45%, var(--text-2)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .kpi.live b::after { content: ''; display: inline-block; width: 7px; height: 7px; margin-left: 7px; vertical-align: middle; border-radius: 50%; background: var(--c); box-shadow: 0 0 10px var(--c); animation: blink 1.4s ease-in-out infinite; }

  .chief { display: flex; align-items: center; gap: 12px; text-align: left; padding: 9px 14px; border-radius: 12px; cursor: pointer; color: var(--text-1);
    background: linear-gradient(160deg, color-mix(in srgb, var(--gold) 16%, var(--surface-1)), var(--surface-1) 75%); border: 1px solid color-mix(in srgb, var(--gold) 35%, var(--border)); transition: transform .15s, box-shadow .15s; }
  .chief:hover { transform: translateY(-1px); box-shadow: 0 10px 22px -16px var(--gold); }
  .chief.pending { animation: ring 2.4s ease-in-out infinite; }
  @keyframes ring { 50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--gold) 20%, transparent); } }
  .chief-txt { display: flex; flex-direction: column; } .chief strong { font-size: 13.5px; } .chief small { color: var(--text-2); font-size: 11px; }
  .chief-mark { color: var(--gold); font-size: 20px; text-shadow: 0 0 12px var(--gold); }

  .tools { display: flex; align-items: center; gap: 14px; }
  .search { display: flex; align-items: center; gap: 10px; padding: 0 12px; width: min(420px, 100%); height: 36px; border: 1px solid var(--border-h); border-radius: 10px; background: var(--surface-1); }
  .search:focus-within { border-color: var(--gold); } .search span { font-size: 20px; color: var(--text-2); }
  input { width: 100%; min-width: 0; border: 0; background: transparent; color: var(--text-1); font: inherit; font-size: 13px; } input::placeholder { color: var(--text-3); }
  input:focus { outline: none; }
  .result-count { color: var(--text-2); font-size: 12.5px; white-space: nowrap; }
  .clear { background: none; border: 0; color: #93c5fd; font-size: 12px; cursor: pointer; text-decoration: underline; }

  /* the tiles share the height: as many rows as needed, each at least 92px */
  .grid { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(212px, 1fr)); grid-auto-rows: minmax(92px, 1fr); gap: 8px; align-content: stretch; }
  .tile-wrap { position: relative; display: flex; min-width: 0; min-height: 0; }
  .tile { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border-radius: 12px; text-align: left; color: var(--text-1); cursor: pointer; overflow: hidden;
    background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--oc) 16%, transparent), transparent 60%), linear-gradient(160deg, color-mix(in srgb, var(--oc) 8%, var(--surface-1)), var(--surface-1) 70%);
    border: 1px solid color-mix(in srgb, var(--oc) 26%, var(--border)); transition: transform .15s, border-color .15s, box-shadow .15s; }
  .tile:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--oc) 65%, transparent); box-shadow: 0 12px 26px -18px var(--oc); }
  .tile:focus-visible, .power:focus-visible, .kpi:focus-visible, .chief:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .row1 { display: flex; align-items: center; gap: 9px; padding-right: 30px; min-width: 0; }
  .mark { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; font: 800 11px var(--font-display);
    color: color-mix(in srgb, var(--oc) 60%, white); background: color-mix(in srgb, var(--oc) 22%, var(--surface-2)); box-shadow: 0 0 14px -4px var(--oc), inset 0 0 0 1px color-mix(in srgb, var(--oc) 40%, transparent); }
  .name { font: 700 14px/1.2 var(--font-display); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row2 { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .st { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: color-mix(in srgb, var(--sc) 75%, white); }
  .st i { width: 7px; height: 7px; border-radius: 50%; background: var(--sc); box-shadow: 0 0 8px var(--sc); }
  .st.live i { animation: blink 1.3s ease-in-out infinite; }
  @keyframes blink { 50% { opacity: .35; } }
  .cnt { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; } .cnt b { color: #6ee7b7; font-weight: 800; }
  .meter { height: 4px; border-radius: 3px; background: color-mix(in srgb, var(--oc) 12%, var(--surface-2)); overflow: hidden; }
  .meter i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #34D399, #22D3EE); box-shadow: 0 0 8px #34D399; transition: width .4s ease; }
  .who { font-size: 11px; line-height: 1.4; color: var(--text-3); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .tile-wrap.off .tile { opacity: .5; filter: grayscale(.8); }
  .power { position: absolute; top: 9px; right: 9px; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--border-h); background: var(--surface-2); color: var(--text-3); font-size: 12px; cursor: pointer; }
  .power.on { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, var(--border)); box-shadow: 0 0 10px -3px var(--green); }
  .power:hover:not(:disabled) { border-color: var(--text-2); } .power:disabled { opacity: .5; cursor: wait; }

  .empty { grid-column: 1 / -1; padding: 32px; color: var(--text-2); text-align: center; }
  .unassigned { flex: none; } h3 { margin: 0 0 6px; color: var(--text-2); font-size: 12.5px; } .unassigned div { display: flex; flex-wrap: wrap; gap: 6px; }

  /* Short windows: more columns, one-line tiles, so every office still fits. */
  @media (max-height: 820px) {
    .directory { gap: 8px; padding: 10px 16px 12px; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); grid-auto-rows: minmax(50px, 1fr); gap: 6px; }
    .tile { gap: 3px; padding: 6px 9px; }
    .who { display: none; }
    .mark { width: 24px; height: 24px; font-size: 9.5px; border-radius: 7px; }
    .name { font-size: 12.5px; }
    .power { top: 6px; right: 6px; width: 22px; height: 22px; font-size: 10px; }
    .kpi { padding: 5px 10px; } .kpi b { font-size: 18px; }
    .chief { padding: 6px 12px; }
    h2 { font-size: 19px; }
    .search { height: 32px; }
    .unassigned .k-btn { padding: 2px 8px; font-size: 11px; }
  }
  @media (max-width: 1100px) { .strip { grid-template-columns: 1fr auto; } .kpis { grid-column: 1 / -1; grid-row: 2; } }
  @media (max-width: 700px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .tools { flex-wrap: wrap; } .search { width: 100%; } }
  @media (prefers-reduced-motion: reduce) { .tile, .kpi, .chief { transition: none; } .st.live i, .kpi.live b::after, .chief.pending { animation: none; } }
</style>
