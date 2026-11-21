<script lang="ts">
  /**
   * Where a user's roles apply: everything, some projects (and so only what
   * belongs to them), or some offices and single agents. Edits `value` in
   * place; the parent saves it.
   */
  import { t } from '$lib/i18n/index.js';
  import type { Agent, Office, Project, Scope, ScopeKind } from './types.js';
  import { officesOfProject, scopeKind } from './types.js';

  export let value: Scope;
  export let projects: Project[] = [];
  export let offices: Office[] = [];
  export let agents: Agent[] = [];

  $: kind = scopeKind(value);

  // What each mode had picked, so flipping between them loses nothing.
  let keptProjects: string[] = [];
  let keptOffices: string[] = [];
  let keptAgents: string[] = [];

  function setKind(next: ScopeKind) {
    if (next === kind) return;
    if (value.projects.length) keptProjects = value.projects;
    if (value.offices.length) keptOffices = value.offices;
    if (value.agents.length) keptAgents = value.agents;
    if (next === 'all') value = { ...value, mode: 'all' };
    else if (next === 'projects') {
      value = { mode: 'restricted', projects: keptProjects, offices: [], agents: [] };
    } else value = { mode: 'restricted', projects: [], offices: keptOffices, agents: keptAgents };
  }

  function toggle(list: 'projects' | 'offices' | 'agents', id: string) {
    const cur = value[list];
    value = { ...value, [list]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
  }

  const MODES: Array<{ id: ScopeKind; icon: string }> = [
    { id: 'all', icon: '◎' },
    { id: 'projects', icon: '◆' },
    { id: 'offices', icon: '▦' },
  ];

  $: officeById = new Map(offices.map((o) => [o.id, o]));
  $: reached = [...new Set(projects.filter((p) => value.projects.includes(p.id)).flatMap(officesOfProject))]
    .map((id) => officeById.get(id))
    .filter((o): o is Office => !!o);
  $: agentsOf = (officeId: string) => agents.filter((a) => a.flow_id === officeId);
  $: loose = agents.filter((a) => !a.flow_id || !officeById.has(a.flow_id));
  let openOffice = '';
</script>

<div class="se">
  <div class="se-modes" role="radiogroup">
    {#each MODES as m (m.id)}
      <button
        type="button" role="radio" aria-checked={kind === m.id}
        class="se-mode" class:on={kind === m.id} on:click={() => setKind(m.id)}
      >
        <span class="se-mode-ic">{m.icon}</span>
        <span class="se-mode-tx">
          <strong>{$t(`access.scope.mode.${m.id}`)}</strong>
          <small>{$t(`access.scope.mode.${m.id}_hint`)}</small>
        </span>
      </button>
    {/each}
  </div>

  {#if kind === 'projects'}
    <div class="se-grid">
      {#each projects as p (p.id)}
        {@const on = value.projects.includes(p.id)}
        {@const n = officesOfProject(p).length}
        <button type="button" class="se-tile" class:on aria-pressed={on} on:click={() => toggle('projects', p.id)}>
          <span class="se-check">{on ? '✓' : ''}</span>
          <span class="se-tile-name">{p.name}</span>
          <span class="se-tile-sub">{$t('access.scope.offices_n', { n })}{#if p.status && p.status !== 'active'} · {p.status}{/if}</span>
        </button>
      {/each}
    </div>
    {#if value.projects.length === 0}
      <p class="acx-warn">{$t('access.scope.none_projects')}</p>
    {:else}
      <div class="se-reach">
        <span class="acx-label">{$t('access.scope.reaches')}</span>
        {#if reached.length}
          <div class="se-chips">
            {#each reached as o (o.id)}<span class="acx-chip static">{o.name}</span>{/each}
          </div>
        {:else}
          <span class="acx-hint">{$t('access.scope.no_offices')}</span>
        {/if}
      </div>
      <p class="acx-note">{$t('access.scope.projects_note')}</p>
    {/if}
  {:else if kind === 'offices'}
    <div class="se-offices">
      {#each offices as o (o.id)}
        {@const on = value.offices.includes(o.id)}
        {@const own = agentsOf(o.id)}
        {@const picked = own.filter((a) => value.agents.includes(a.id)).length}
        <div class="se-office" class:on>
          <button type="button" class="se-office-hd" aria-pressed={on} on:click={() => toggle('offices', o.id)}>
            <span class="se-check">{on ? '✓' : ''}</span>
            <span class="se-tile-name">{o.name}</span>
            {#if !on && picked}<span class="acx-pill teal">{picked}</span>{/if}
          </button>
          {#if !on && own.length}
            <button type="button" class="se-more" on:click={() => (openOffice = openOffice === o.id ? '' : o.id)}>
              {$t('access.scope.agents_n', { n: own.length })} {openOffice === o.id ? '▴' : '▾'}
            </button>
          {/if}
          {#if !on && openOffice === o.id}
            <div class="se-chips sub">
              {#each own as a (a.id)}
                <button type="button" class="acx-chip" class:on={value.agents.includes(a.id)} on:click={() => toggle('agents', a.id)}>{a.name}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
    {#if loose.length}
      <div class="se-reach">
        <span class="acx-label">{$t('access.scope.agents')}</span>
        <div class="se-chips">
          {#each loose as a (a.id)}
            <button type="button" class="acx-chip" class:on={value.agents.includes(a.id)} on:click={() => toggle('agents', a.id)}>{a.name}</button>
          {/each}
        </div>
      </div>
    {/if}
    {#if value.offices.length === 0 && value.agents.length === 0}
      <p class="acx-warn">{$t('access.scope.none_offices')}</p>
    {:else}
      <p class="acx-note">{$t('access.scope.agents_hint')}</p>
    {/if}
  {/if}

  {#if kind !== 'all'}<p class="acx-hint mcp">⌁ {$t('access.scope.mcp_note')}</p>{/if}
</div>

<style>
  .se { display: flex; flex-direction: column; gap: 12px; }
  .se-modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  @media (max-width: 900px) { .se-modes { grid-template-columns: 1fr; } }
  .se-mode {
    display: flex; align-items: flex-start; gap: 10px; text-align: left; cursor: pointer;
    padding: 11px 12px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text-2); font: inherit; transition: border-color 0.15s, background 0.15s;
  }
  .se-mode:hover { border-color: color-mix(in srgb, var(--teal) 35%, var(--border)); }
  .se-mode.on {
    border-color: var(--teal); background: color-mix(in srgb, var(--teal) 9%, var(--surface-2));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--teal) 10%, transparent);
  }
  .se-mode-ic {
    width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; flex-shrink: 0;
    background: var(--surface-3); color: var(--text-3); font-size: 13px;
  }
  .se-mode.on .se-mode-ic { background: var(--teal); color: var(--bg); }
  .se-mode-tx { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .se-mode-tx strong { font-size: 12.5px; color: var(--text-1); font-weight: 650; }
  .se-mode-tx small { font-size: 10.5px; color: var(--text-3); line-height: 1.35; }

  .se-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
  .se-tile, .se-office-hd {
    position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
    padding: 11px 12px 11px 36px; border-radius: 9px; border: 1px solid var(--border);
    background: var(--surface-2); color: var(--text-1); font: inherit; text-align: left; cursor: pointer;
    transition: border-color 0.15s, background 0.15s; width: 100%;
  }
  .se-tile:hover, .se-office-hd:hover { border-color: color-mix(in srgb, var(--teal) 35%, var(--border)); }
  .se-tile.on, .se-office.on .se-office-hd {
    border-color: color-mix(in srgb, var(--teal) 70%, transparent);
    background: color-mix(in srgb, var(--teal) 8%, var(--surface-2));
  }
  .se-check {
    position: absolute; left: 11px; top: 11px; width: 16px; height: 16px; border-radius: 5px;
    border: 1px solid var(--border); background: var(--surface-1); display: grid; place-items: center;
    font-size: 10px; font-weight: 800; color: var(--bg);
  }
  .se-tile.on .se-check, .se-office.on .se-check { background: var(--teal); border-color: var(--teal); }
  .se-tile-name { font-size: 12.5px; font-weight: 650; }
  .se-tile-sub { font: 500 10px var(--font-mono); color: var(--text-3); letter-spacing: 0.2px; }

  .se-offices { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; align-items: start; }
  .se-office { display: flex; flex-direction: column; gap: 6px; }
  .se-office-hd { flex-direction: row; align-items: center; gap: 8px; }
  .se-office-hd .acx-pill { margin-left: auto; }
  .se-more {
    align-self: flex-start; margin-left: 36px; border: none; background: none; padding: 0;
    font: 500 10px var(--font-mono); color: var(--text-3); cursor: pointer;
  }
  .se-more:hover { color: var(--teal); }

  .se-reach { display: flex; flex-direction: column; gap: 7px; }
  .se-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .se-chips.sub { margin-left: 36px; }
  .mcp { margin: 0; }
</style>
