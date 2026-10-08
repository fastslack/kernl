<script lang="ts">
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
  let query = '';
  const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  $: matches = model.offices.filter(o => fold(o.name + ' ' + o.agents.map(a => a.name).join(' ')).includes(fold(query.trim())));
  function status(office: RailOffice) {
    if (office.paused) return 'off';
    if (office.agents.some(a => a.state === 'error')) return 'review';
    if (office.working) return 'working';
    if (office.agents.length && office.agents.every(a => a.state === 'paused')) return 'paused';
    return 'idle';
  }
</script>

<section class="directory" aria-label={$t('office.directory.title')}>
  <div class="directory-intro">
    <div><p class="eyebrow">{$t('office.directory.eyebrow')}</p><h2>{$t('office.directory.title')}</h2><p class="intro-copy">{$t('office.directory.description')}</p></div>
    {#if model.headquarters}
      <button class="chief" on:click={() => dispatch('headquarters')}>
        <span class="chief-mark" aria-hidden="true">◆</span>
        <span><strong>{$t('office.rail.headquarters')}</strong><small>{$t(inbox ? 'office.directory.pending' : 'office.directory.chief', { n: inbox })}</small></span>
        <span aria-hidden="true">→</span>
      </button>
    {/if}
  </div>
  <div class="directory-tools">
    <label class="search"><span aria-hidden="true">⌕</span><input type="search" bind:value={query} aria-label={$t('office.rail.search')} placeholder={$t('office.rail.search')} /></label>
    <span class="result-count">{$t('office.directory.count', { n: matches.length })}</span>
  </div>
  {#if error}
    <div class="empty" role="alert"><p>{$t('office.directory.error')}</p><button class="k-btn" on:click={() => dispatch('retry')}>{$t('office.directory.retry')}</button></div>
  {:else if loading}
    <div role="status" aria-label={$t('office.directory.loading')}><Skeleton variant="cards" rows={6} /></div>
  {:else}
    <div class="office-grid">
      {#each matches as office (office.id)}
        {@const state = status(office)}
        <div class="card-wrap" class:off={office.paused}>
        <button class="office-card" style:--office-color={office.color} on:click={() => dispatch('select', { id: office.id })}>
          <span class="card-top"><span class="office-mark" aria-hidden="true">{office.name.slice(0, 2).toUpperCase()}</span><span class="status" class:working={state === 'working'} class:review={state === 'review'}><span aria-hidden="true">●</span> {$t('office.directory.' + state)}</span></span>
          <strong class="office-name">{office.name}</strong>
          <span class="members">{$t('office.directory.agents', { n: office.agents.length })}{#if office.working} · {$t('office.directory.running', { n: office.working })}{/if}</span>
          <span class="agent-names">{office.agents.slice(0, 3).map(a => a.name).join(' · ')}{office.agents.length > 3 ? ' …' : ''}</span>
          <span class="card-bottom">{$t('office.directory.open')} <span aria-hidden="true">↗</span></span>
        </button>
        <!-- Sibling of the card, not inside it: a button can't nest another. -->
        <button class="power" class:on={!office.paused} type="button" aria-pressed={!office.paused}
          disabled={powerBusy === office.id}
          title={$t(office.paused ? 'office.power.turn_on' : 'office.power.turn_off')}
          aria-label={$t(office.paused ? 'office.power.turn_on_named' : 'office.power.turn_off_named', { name: office.name })}
          on:click={() => dispatch('power', { id: office.id, paused: !office.paused })}>⏻</button>
        </div>
      {/each}
    </div>
    {#if !matches.length}<p class="empty">{$t(query ? 'office.rail.no_match' : 'office.rail.empty', { q: query })}</p>{/if}
    {#if model.unassigned.length}
      <section class="unassigned"><h3>{$t('office.rail.unassigned')}</h3><div>{#each model.unassigned as agent (agent.id)}<button class="k-btn" on:click={() => dispatch('agent', { id: agent.id })}>{agent.name} ↗</button>{/each}</div></section>
    {/if}
  {/if}
</section>

<style>
  .directory { position: absolute; inset: 0; z-index: 2; overflow: auto; padding: clamp(20px, 3vw, 48px); background: var(--bg); color: var(--text-1); }
  .directory-intro { display: flex; justify-content: space-between; gap: 24px; align-items: center; margin-bottom: 30px; }
  .eyebrow { color: var(--gold); font: 600 11px/1.4 var(--font-body); letter-spacing: .12em; text-transform: uppercase; margin: 0 0 10px; }
  h2 { font: 600 clamp(26px, 3vw, 38px)/1.15 var(--font-display); letter-spacing: -.035em; margin: 0 0 12px; }
  .intro-copy { margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.6; max-width: 560px; }
  .chief { display: flex; align-items: center; gap: 16px; text-align: left; padding: 18px 22px; background: color-mix(in srgb, var(--gold) 7%, var(--surface-1)); border: 1px solid color-mix(in srgb, var(--gold) 30%, var(--border)); border-radius: 14px; color: var(--text-1); cursor: pointer; }
  .chief strong, .chief small { display: block; } .chief strong { font-size: 15px; } .chief small { color: var(--text-2); margin-top: 5px; font-size: 12px; } .chief-mark { color: var(--gold); font-size: 26px; }
  .directory-tools { display: flex; align-items: center; gap: 20px; margin-bottom: 22px; }
  .search { display: flex; align-items: center; gap: 12px; padding: 0 16px; width: min(460px, 100%); height: 46px; border: 1px solid var(--border-h); border-radius: 10px; background: var(--surface-1); }
  .search:focus-within { border-color: var(--gold); } .search span { font-size: 26px; color: var(--text-2); }
  input { width: 100%; min-width: 0; border: 0; background: transparent; color: var(--text-1); font: inherit; font-size: 14px; } input::placeholder { color: var(--text-3); }
  .result-count { color: var(--text-2); font-size: 13px; white-space: nowrap; }
  .office-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr)); gap: 16px; }
  .office-card { display: flex; flex-direction: column; min-width: 0; text-align: left; padding: 22px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 14px; color: var(--text-1); cursor: pointer; transition: background .15s, border-color .15s; }
  .office-card:hover { background: var(--surface-2); border-color: var(--office-color); }
  .card-wrap { position: relative; display: flex; min-width: 0; } .card-wrap .office-card { flex: 1; }
  .card-wrap .card-top { padding-right: 44px; }
  .card-wrap.off .office-card { opacity: .55; filter: grayscale(.8); }
  .power { position: absolute; top: 22px; right: 22px; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--border-h); background: var(--surface-2); color: var(--text-3); font-size: 15px; cursor: pointer; }
  .power.on { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, var(--border)); }
  .power:hover:not(:disabled) { border-color: var(--text-2); } .power:disabled { opacity: .5; cursor: wait; }
  .power:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .card-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
  .office-mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 12px; font: 700 14px var(--font-display); background: color-mix(in srgb, var(--office-color) 18%, var(--surface-2)); color: var(--text-1); border-left: 3px solid var(--office-color); }
  .status { color: var(--text-2); font-size: 12px; } .status span { font-size: 8px; margin-right: 4px; } .working { color: var(--green); } .review { color: var(--gold); }
  .office-name { font: 600 19px/1.3 var(--font-display); overflow-wrap: anywhere; margin-bottom: 8px; }
  .members { color: var(--text-2); font-size: 13px; } .agent-names { color: var(--text-3); font-size: 12px; line-height: 1.5; margin: 12px 0 20px; overflow-wrap: anywhere; }
  .card-bottom { display: flex; justify-content: space-between; margin-top: auto; padding-top: 14px; border-top: 1px solid var(--border); color: var(--text-2); font-size: 12px; } .card-bottom span { color: var(--gold); font-size: 17px; }
  .empty { padding: 32px; color: var(--text-2); text-align: center; }
  .unassigned { margin-top: 28px; } h3 { color: var(--text-2); font-size: 14px; } .unassigned div { display: flex; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 700px) { .directory-intro { align-items: stretch; flex-direction: column; } .chief { justify-content: space-between; } .directory-tools { align-items: stretch; flex-direction: column; gap: 10px; } .search { width: auto; } }
  @media (prefers-reduced-motion: reduce) { .office-card { transition: none; } }
</style>
