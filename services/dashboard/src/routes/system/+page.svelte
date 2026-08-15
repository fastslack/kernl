<script lang="ts">
  /*
    Página de Sistema. Reúne lo que estaba repartido en tres rutas leyendo el
    mismo store `systemAgenda`: los KPI y las tarjetas de resumen que eran
    /sysoverview, las tablas de procesos que ya vivían acá, y el calendario de
    jobs que era /automations, ahora detrás del card-tab "Automation".
  */
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { systemAgenda, aiConfig } from '$lib/stores.js';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import OverviewCard from '$lib/components/OverviewCard.svelte';
  import BarChart from '$lib/components/BarChart.svelte';
  import Empty from '$lib/components/Empty.svelte';
  import AutomationsPanel from '$lib/components/system/AutomationsPanel.svelte';
  import { fmtMs, fmtTimeShort } from '$lib/utils.js';

  $: sd = ($systemAgenda as any);
  $: ai = ($aiConfig as any);
  $: st = sd?.stats ?? {};
  $: procs = (sd?.processes ?? []) as any[];

  // Deep-linkable como las secciones de Settings: /automations redirige a
  // ?tab=automation, así que un bookmark viejo sigue aterrizando en su vista.
  $: activeTab = $page.url.searchParams.get('tab') === 'automation' ? 'automation' : 'processes';
  function gotoTab(id: string) {
    goto(id === 'processes' ? '/system' : `/system?tab=${id}`, { noScroll: true, keepFocus: true });
  }

  $: providers = ai?.providers ?? {};
  $: configuredProviders = Object.values(providers).filter((p: any) => p.configured).length;

  $: intervals = procs.filter((p: any) => p.type === 'interval');
  $: listeners = procs.filter((p: any) => p.type === 'event-listener');
  $: caches = procs.filter((p: any) => p.type === 'cache');
  $: watchers = procs.filter((p: any) => p.type === 'watcher');

  $: moduleEntries = st.byModule
    ? (Object.keys(st.byModule) as string[])
        .map(k => ({ label: k, value: st.byModule[k], color: 'var(--blue)' }))
        .sort((a, b) => b.value - a.value)
    : [];

  const ICONS = {
    processes: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
    providers: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z'
  };

  function dotColor(status: string) {
    if (status === 'running') return 'var(--green)';
    if (status === 'idle') return 'var(--text-3)';
    if (status === 'error') return 'var(--red)';
    return 'var(--text-3)';
  }

  function statusColor(status: string): string {
    return status === 'running' ? 'var(--teal)' : 'var(--text-3)';
  }
</script>

<ViewHeader title="System" sub="{procs.length} processes registered" />

<div class="card-tabs" role="tablist">
  <button
    type="button"
    role="tab"
    class="card-tab"
    class:active={activeTab === 'processes'}
    aria-selected={activeTab === 'processes'}
    on:click={() => gotoTab('processes')}
  >Processes</button>
  <button
    type="button"
    role="tab"
    class="card-tab"
    class:active={activeTab === 'automation'}
    aria-selected={activeTab === 'automation'}
    on:click={() => gotoTab('automation')}
  >Automation</button>
</div>

{#if activeTab === 'automation'}
  <AutomationsPanel />
{:else if !sd || !sd.available}
  <Panel cls="anim"><Empty message="System registry not available." /></Panel>
{:else}
  <div class="kpi-row anim">
    <KpiCard label="Processes" value={st.total ?? 0} sub="registered" accent="--teal" color="var(--teal)" />
    <KpiCard label="Running" value={st.running ?? 0} sub="active" accent="--green" color="var(--green)" />
    <KpiCard label="Listeners" value={st.byType?.['event-listener'] ?? 0} sub="events" accent="--blue" color="var(--blue)" />
    <KpiCard label="Caches" value={st.byType?.['cache'] ?? 0} sub="entries" accent="--gold" color="var(--gold)" />
    {#if sd.uptimeFormatted}
      <KpiCard label="Uptime" value={sd.uptimeFormatted} sub="" accent="--purple" color="var(--purple)" />
    {/if}
    {#if ai?.providers}
      <KpiCard label="AI Providers" value={configuredProviders} sub="configured" accent="--purple" color="var(--purple)" />
    {/if}
  </div>

  <div class="overview-grid anim d1">
    <OverviewCard title="Running Processes" icon={ICONS.processes} iconColor="var(--teal)">
      {#if procs.length > 0}
        <ul class="card-list">
          {#each procs.slice(0, 5) as p}
            <li>
              <span class="card-list-title">{p.name}</span>
              <span class="card-list-status" style="color: {statusColor(p.status)}">{p.status}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <Empty message="No processes running." />
      {/if}
    </OverviewCard>

    <OverviewCard title="AI Providers" icon={ICONS.providers} iconColor="var(--purple)" actions={[{ label: 'Configure', href: '/settings?section=ai' }]}>
      {#if ai?.providers}
        <ul class="card-list">
          {#each Object.entries(providers) as [name, prov]}
            <li>
              <span class="card-list-title">{name.charAt(0).toUpperCase() + name.slice(1)}</span>
              <span class="card-list-status" style="color: {prov?.configured ? 'var(--teal)' : 'var(--red)'}">
                {prov?.configured ? 'Configured' : 'Not set'}
              </span>
            </li>
          {/each}
        </ul>
      {:else}
        <Empty message="No provider info." />
      {/if}
    </OverviewCard>
  </div>

  {#if intervals.length}
    <Panel title="Active Intervals" dotColor="var(--teal)" cls="anim d2 full-width">
      <table class="sys-table">
        <tr>
          <th>Name</th><th>Module</th><th>Interval</th><th>Last Run</th><th>Next Run</th><th>Runs</th><th>Status</th>
        </tr>
        {#each intervals as p}
          <tr>
            <td>{p.name ?? ''}</td>
            <td><span class="badge">{p.module ?? ''}</span></td>
            <td>{fmtMs(p.intervalMs)}</td>
            <td>{p.lastRunAt ? fmtTimeShort(p.lastRunAt) : '—'}</td>
            <td>{p.nextRunAt ? fmtTimeShort(p.nextRunAt) : '—'}</td>
            <td>{p.runCount ?? 0}</td>
            <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{dotColor(p.status)};margin-right:4px"></span>{p.status ?? ''}</td>
          </tr>
        {/each}
      </table>
    </Panel>
  {/if}

  {#if listeners.length}
    <Panel title="Event Listeners" dotColor="var(--blue)" cls="anim d3 full-width">
      <table class="sys-table">
        <tr><th>Event</th><th>Module</th><th>Description</th><th>Fires</th><th>Status</th></tr>
        {#each listeners as p}
          <tr>
            <td><code>{p.event ?? '—'}</code></td>
            <td><span class="badge">{p.module ?? ''}</span></td>
            <td>{p.description ?? ''}</td>
            <td>{p.runCount ?? 0}</td>
            <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{dotColor(p.status)};margin-right:4px"></span>{p.status ?? ''}</td>
          </tr>
        {/each}
      </table>
    </Panel>
  {/if}

  {#if caches.length}
    <Panel title="Caches" dotColor="var(--gold)" cls="anim d4 full-width">
      <table class="sys-table">
        <tr><th>Name</th><th>TTL</th><th>Last Refresh</th><th>Expires</th><th>Hits</th></tr>
        {#each caches as p}
          <tr>
            <td>{p.name ?? ''}</td>
            <td>{fmtMs(p.ttlMs)}</td>
            <td>{p.lastRunAt ? fmtTimeShort(p.lastRunAt) : '—'}</td>
            <td>{p.nextRunAt ? fmtTimeShort(p.nextRunAt) : '—'}</td>
            <td>{p.runCount ?? 0}</td>
          </tr>
        {/each}
      </table>
    </Panel>
  {/if}

  {#if watchers.length}
    <Panel title="Watchers" dotColor="var(--purple)" cls="anim d5 full-width">
      <ul class="items">
        {#each watchers as p}
          <li>
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{dotColor(p.status)};margin-right:6px"></span>
            {p.name ?? ''} — {p.description ?? ''}
          </li>
        {/each}
      </ul>
    </Panel>
  {/if}

  {#if moduleEntries.length}
    <Panel title="By Module" dotColor="var(--text-2)" cls="anim d6 full-width">
      <BarChart entries={moduleEntries} />
    </Panel>
  {/if}
{/if}

<style>
  /* Card tabs: una sección, una pantalla. Mismo lenguaje visual que el strip
     de Settings (`.card-tab` en settings/+page.svelte). */
  .card-tabs {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin: 0 0 16px;
  }
  .card-tab {
    padding: 7px 14px; border-radius: 8px; cursor: pointer;
    background: rgba(120, 130, 160, .05);
    border: 1px solid rgba(120, 130, 160, .16);
    color: var(--text-2);
    font: 600 12px var(--font-sans, inherit);
    text-transform: uppercase; letter-spacing: .6px;
    transition: background .15s, border-color .15s, color .15s;
  }
  .card-tab:hover { background: rgba(120, 130, 160, .12); color: var(--text-1); }
  .card-tab.active {
    background: rgba(120, 130, 160, .18);
    border-color: rgba(120, 130, 160, .5);
    color: var(--text-1);
  }
  .card-tab:focus-visible { outline: 2px solid #4ade80; outline-offset: 2px; }

  /* Heredado de /sysoverview, que se fusionó acá. */
  .overview-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }
  .card-list { list-style: none; margin: 0; padding: 0; }
  .card-list li {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0; border-bottom: 1px solid var(--border);
  }
  .card-list li:last-child { border-bottom: none; }
  .card-list-title {
    font-size: 12px; color: var(--text-1); flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px;
  }
  .card-list-status { font-size: 10px; font-weight: 600; }
</style>
