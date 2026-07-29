<script lang="ts">
  import { agents, skills, automations } from '$lib/stores.js';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import QuickAction from '$lib/components/QuickAction.svelte';
  import OverviewCard from '$lib/components/OverviewCard.svelte';
  import Empty from '$lib/components/Empty.svelte';

  // Data from stores
  $: ag = ($agents as any);
  $: sk = ($skills as any);
  $: auto = ($automations as any);

  // Agents breakdown
  $: agentsAvailable = ag?.available ?? false;
  $: totalAgents = ag?.total ?? 0;
  $: runningAgents = ag?.running ?? 0;
  $: agentsList = (ag?.agents ?? []) as any[];

  // Skills breakdown
  $: skillsList = (Array.isArray(sk) ? sk : sk?.skills ?? []) as any[];
  $: totalSkills = skillsList.length;

  // Automations breakdown
  $: automationsList = (Array.isArray(auto) ? auto : []) as any[];
  $: totalAutomations = automationsList.length;

  // SVG paths
  const ICONS = {
    newAgent: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    browseSkills: 'M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z',
    skillStore: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z',
    research: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7',
    agents: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    skills: 'M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z',
    automations: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15'
  };

  // Status colors
  function getStatusColor(status: string): string {
    switch (status) {
      case 'running': return 'var(--teal)';
      case 'idle': return 'var(--text-3)';
      default: return 'var(--orange)';
    }
  }
</script>

<ViewHeader title="AI" sub="Agents, skills, and automations" />

<!-- Quick Actions -->
<div class="quick-actions">
  <QuickAction label="New Agent" icon={ICONS.newAgent} variant="primary" href="/agents" />
  <QuickAction label="Browse Skills" icon={ICONS.browseSkills} variant="purple" href="/skills" />
  <QuickAction label="Skill Store" icon={ICONS.skillStore} variant="teal" href="/marketplace" />
</div>

<!-- KPI Row -->
<div class="kpi-row anim">
  {#if agentsAvailable}
    <KpiCard label="Agents" value={totalAgents} sub="configured" accent="--purple" color="var(--purple)" />
    <KpiCard label="Running" value={runningAgents} sub="active now" accent="--teal" color={runningAgents > 0 ? 'var(--teal)' : 'var(--text-3)'} />
  {/if}
  <KpiCard label="Skills" value={totalSkills} sub="installed" accent="--blue" color="var(--blue)" />
  <KpiCard label="Automations" value={totalAutomations} sub="configured" accent="--gold" color="var(--gold)" />
</div>

<!-- Overview Grid -->
<div class="overview-grid">
  <!-- Agents Card -->
  <OverviewCard title="Agents" icon={ICONS.agents} iconColor="var(--purple)" actions={[{ label: 'Manage Agents', href: '/agents' }]}>
    {#if agentsAvailable && agentsList.length > 0}
      <ul class="card-list">
        {#each agentsList.slice(0, 4) as agent}
          <li>
            <span class="card-list-title">{agent.name}</span>
            <span class="card-list-status" style="color: {getStatusColor(agent.status)}">{agent.status}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <Empty message="No agents configured." />
    {/if}
  </OverviewCard>

  <!-- Skills Card -->
  <OverviewCard title="Installed Skills" icon={ICONS.skills} iconColor="var(--blue)" actions={[{ label: 'View Skills', href: '/skills' }, { label: 'Browse Store', href: '/marketplace' }]}>
    {#if skillsList.length > 0}
      <ul class="card-list">
        {#each skillsList.slice(0, 4) as skill}
          <li>
            <span class="card-list-title">{skill.name || skill.id}</span>
            <span class="card-list-meta">{skill.category || ''}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <Empty message="No skills installed." />
    {/if}
  </OverviewCard>

  <!-- Automations Card -->
  <OverviewCard title="Automations" icon={ICONS.automations} iconColor="var(--gold)" actions={[{ label: 'View Automations', href: '/automations' }]}>
    {#if automationsList.length > 0}
      <ul class="card-list">
        {#each automationsList.slice(0, 4) as auto}
          <li>
            <span class="card-list-title">{auto.name || 'Automation'}</span>
            <span class="card-list-meta">{auto.status || ''}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <Empty message="No automations configured." />
    {/if}
  </OverviewCard>
</div>

<style>
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
  .card-list-meta {
    font-size: 10px;
    color: var(--text-3);
  }
  .card-list-status {
    font-size: 10px;
    font-weight: 600;
  }
</style>
