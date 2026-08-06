<script lang="ts">
  import { systemAgenda } from '$lib/stores.js';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import BarChart from '$lib/components/BarChart.svelte';
  import Empty from '$lib/components/Empty.svelte';
  import { fmtMs, fmtTimeShort } from '$lib/utils.js';

  $: sd = ($systemAgenda as any);
  $: st = sd?.stats ?? {};
  $: procs = (sd?.processes ?? []) as any[];

  $: intervals = procs.filter((p: any) => p.type === 'interval');
  $: listeners = procs.filter((p: any) => p.type === 'event-listener');
  $: caches = procs.filter((p: any) => p.type === 'cache');
  $: watchers = procs.filter((p: any) => p.type === 'watcher');

  $: moduleEntries = st.byModule
    ? (Object.keys(st.byModule) as string[])
        .map(k => ({ label: k, value: st.byModule[k], color: 'var(--blue)' }))
        .sort((a, b) => b.value - a.value)
    : [];

  function dotColor(status: string) {
    if (status === 'running') return 'var(--green)';
    if (status === 'idle') return 'var(--text-3)';
    if (status === 'error') return 'var(--red)';
    return 'var(--text-3)';
  }
</script>

<!-- Internal sub-nav: system pages removed from the group tab bar -->
<nav class="sys-subnav" aria-label="System pages">
  <a class="sub-tab active" href="/system" aria-current="page">Status</a>
  <a class="sub-tab" href="/sysoverview">Overview</a>
  <a class="sub-tab" href="/architecture">Arch 3D</a>
  <a class="sub-tab" href="/friends">Friends</a>
</nav>

<ViewHeader title="System Agenda" sub="{procs.length} processes registered" />

{#if !sd || !sd.available}
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
  </div>

  {#if intervals.length}
    <Panel title="Active Intervals" dotColor="var(--teal)" cls="anim d1 full-width">
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
    <Panel title="Event Listeners" dotColor="var(--blue)" cls="anim d2 full-width">
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
    <Panel title="Caches" dotColor="var(--gold)" cls="anim d3 full-width">
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
    <Panel title="Watchers" dotColor="var(--purple)" cls="anim d4 full-width">
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
    <Panel title="By Module" dotColor="var(--text-2)" cls="anim d5 full-width">
      <BarChart entries={moduleEntries} />
    </Panel>
  {/if}
{/if}

<style>
  /* Same visual language as the group tab bar (.sub-tabs / .sub-tab in
     app.css) but rendered inside the page, so no negative bleed margins. */
  .sys-subnav {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin: 0 0 20px;
    overflow-x: auto;
  }
  .sys-subnav a {
    text-decoration: none;
    display: inline-flex;
    align-items: center;
  }
</style>
