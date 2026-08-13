<script lang="ts">
  import { systemAgenda, aiConfig } from '$lib/stores.js';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import QuickAction from '$lib/components/QuickAction.svelte';
  import OverviewCard from '$lib/components/OverviewCard.svelte';
  import Empty from '$lib/components/Empty.svelte';

  // Data from stores
  $: sys = ($systemAgenda as any);
  $: ai = ($aiConfig as any);

  // System breakdown
  $: sysAvailable = sys?.available ?? false;
  $: processes = (sys?.processes ?? []) as any[];
  $: uptimeFormatted = sys?.uptimeFormatted ?? 'N/A';

  // AI Config breakdown
  $: providers = ai?.providers ?? {};
  $: configuredProviders = Object.values(providers).filter((p: any) => p.configured).length;

  // SVG paths
  const ICONS = {
    viewProcesses: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    aiProviders: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    processes: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
    providers: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z'
  };

  // Status colors
  function getStatusColor(status: string): string {
    return status === 'running' ? 'var(--teal)' : 'var(--text-3)';
  }
</script>

<!-- Internal sub-nav: system pages removed from the group tab bar -->
<nav class="sys-subnav" aria-label="System pages">
  <a class="sub-tab" href="/system">Status</a>
  <a class="sub-tab active" href="/sysoverview" aria-current="page">Overview</a>
  <a class="sub-tab" href="/automations">Automation</a>
  <a class="sub-tab" href="/architecture">Arch 3D</a>
  <a class="sub-tab" href="/friends">Friends</a>
</nav>

<ViewHeader title="System" sub="Processes, providers, and configuration" />

<!-- Quick Actions -->
<div class="quick-actions">
  <QuickAction label="View Processes" icon={ICONS.viewProcesses} variant="primary" href="/system" />
  <QuickAction label="AI Providers" icon={ICONS.aiProviders} variant="purple" href="/providers" />
</div>

<!-- KPI Row -->
<div class="kpi-row anim">
  {#if sysAvailable}
    <KpiCard label="Processes" value={processes.length} sub="running" accent="--teal" color="var(--teal)" />
    <KpiCard label="Uptime" value={uptimeFormatted} sub="" accent="--blue" color="var(--blue)" />
  {/if}
  {#if ai?.providers}
    <KpiCard label="AI Providers" value={configuredProviders} sub="configured" accent="--purple" color="var(--purple)" />
  {/if}
</div>

<!-- Overview Grid -->
<div class="overview-grid">
  <!-- Running Processes -->
  <OverviewCard title="Running Processes" icon={ICONS.processes} iconColor="var(--teal)" actions={[{ label: 'View All', href: '/system' }]}>
    {#if sysAvailable && processes.length > 0}
      <ul class="card-list">
        {#each processes.slice(0, 5) as p}
          <li>
            <span class="card-list-title">{p.name}</span>
            <span class="card-list-status" style="color: {getStatusColor(p.status)}">{p.status}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <Empty message="No processes running." />
    {/if}
  </OverviewCard>

  <!-- AI Providers -->
  <OverviewCard title="AI Providers" icon={ICONS.providers} iconColor="var(--purple)" actions={[{ label: 'Configure', href: '/providers' }]}>
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
  .quick-actions {
    display: flex;
    gap: 12px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  .overview-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
  }
  .card-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .card-list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .card-list li:last-child {
    border-bottom: none;
  }
  .card-list-title {
    font-size: 12px;
    color: var(--text-1);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-right: 8px;
  }
  .card-list-status {
    font-size: 10px;
    font-weight: 600;
  }
</style>
