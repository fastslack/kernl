<script lang="ts">
  import { data, issues, planner } from '$lib/stores.js';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import QuickAction from '$lib/components/QuickAction.svelte';
  import OverviewCard from '$lib/components/OverviewCard.svelte';
  import BarChart from '$lib/components/BarChart.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Empty from '$lib/components/Empty.svelte';
  import { fmtTime } from '$lib/utils.js';

  // Data from stores
  $: d = ($data as any);
  $: iss = ($issues as any);
  $: pl = ($planner as any);

  // Tasks breakdown
  $: tasks = d?.tasks ?? {};
  $: taskTodo = tasks.byStatus?.todo ?? 0;
  $: taskInProgress = tasks.byStatus?.in_progress ?? 0;
  $: taskDone = tasks.byStatus?.done ?? 0;
  $: taskBlocked = tasks.byStatus?.blocked ?? 0;
  $: taskOverdue = (tasks.overdue ?? []) as any[];
  $: taskDueSoon = (tasks.dueSoon ?? []) as any[];
  $: taskDoneToday = d?.tasks?.doneToday ?? 0;
  $: tasksByContext = tasks.byContext ?? {};

  // Reminders breakdown
  $: reminders = d?.reminders ?? {};
  $: remActive = reminders.active ?? 0;
  $: remOverdue = (reminders.overdue ?? []) as any[];
  $: remUpcoming = (reminders.upcoming24h ?? []) as any[];

  // Issues breakdown
  $: issuesAvailable = iss?.available ?? false;
  $: issuesOpen = iss?.open ?? 0;
  $: issuesClosed = iss?.closed ?? 0;

  // Color map for priorities
  const COL: Record<string, string> = {
    todo: 'var(--blue)',
    in_progress: 'var(--gold)',
    done: 'var(--green)',
    blocked: 'var(--red)',
    urgent: 'var(--red)',
    high: 'var(--orange)',
    medium: 'var(--blue)',
    low: 'var(--text-3)'
  };

  // Urgent tasks = overdue + high/urgent priority tasks
  $: urgentTasks = [...taskOverdue, ...taskDueSoon.filter((t: any) => t.priority === 'urgent' || t.priority === 'high')].slice(0, 5);

  // Task status bars
  $: statusBars = [
    { label: 'Todo', value: taskTodo, color: COL.todo },
    { label: 'In Progress', value: taskInProgress, color: COL.in_progress },
    { label: 'Done', value: taskDone, color: COL.done },
    { label: 'Blocked', value: taskBlocked, color: COL.blocked }
  ];

  // Context entries sorted by count
  $: contextEntries = Object.entries(tasksByContext)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 5);

  // SVG paths
  const ICONS = {
    newTask: 'M12 4v16m8-8H4',
    reminder: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 00-5-5.917V4a1 1 0 10-2 0v1.083A6 6 0 006 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    planner: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    issues: 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    urgent: 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    context: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z',
    status: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4'
  };
</script>

{#if !d}
  <div class="loading-view">Loading work overview...</div>
{:else}
  <ViewHeader title="Work" sub="Your productivity command center" />

  <!-- Quick Actions -->
  <div class="quick-actions">
    <QuickAction label="New Task" icon={ICONS.newTask} variant="primary" href="/tasks" />
    <QuickAction label="Add Reminder" icon={ICONS.reminder} variant="purple" href="/reminders" />
    <QuickAction label="View Planner" icon={ICONS.planner} variant="blue" href="/planner" />
    <QuickAction label="Open Issues" icon={ICONS.issues} variant="orange" href="/issues" />
  </div>

  <!-- KPI Row -->
  <div class="kpi-row anim">
    <KpiCard label="Open Tasks" value={taskTodo} sub="{taskInProgress} in progress" accent="--blue" color="var(--blue)" />
    <KpiCard label="Done Today" value={taskDoneToday} sub="tasks completed" accent="--teal" color="var(--teal)" />
    <KpiCard label="Overdue" value={taskOverdue.length} sub="need attention" accent="--red" color={taskOverdue.length > 0 ? 'var(--red)' : 'var(--text-3)'} />
    <KpiCard label="Reminders" value={remActive} sub="active" accent="--purple" color="var(--purple)" />
    {#if issuesAvailable}
      <KpiCard label="Issues" value={issuesOpen} sub="{issuesClosed} closed" accent="--orange" color="var(--orange)" />
    {/if}
  </div>

  <!-- Overview Grid -->
  <div class="overview-grid">
    <!-- Urgent Tasks -->
    <OverviewCard title="Urgent Tasks" icon={ICONS.urgent} iconColor="var(--red)" actions={[{ label: 'View All Tasks', href: '/tasks' }]}>
      {#if urgentTasks.length > 0}
        <ul class="card-list">
          {#each urgentTasks as t}
            <li>
              <span class="card-list-title">{t.title}</span>
              <Badge text={t.priority} variant={t.priority} />
            </li>
          {/each}
        </ul>
      {:else}
        <Empty message="No urgent tasks!" />
      {/if}
    </OverviewCard>

    <!-- Upcoming Reminders -->
    <OverviewCard title="Upcoming Reminders" icon={ICONS.reminder} iconColor="var(--purple)" actions={[{ label: 'View Alerts', href: '/reminders' }]}>
      {#if remUpcoming.length > 0}
        <ul class="card-list">
          {#each remUpcoming.slice(0, 5) as r}
            <li>
              <span class="card-list-title">{r.title}</span>
              <span class="card-list-meta">{fmtTime(r.trigger_at)}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <Empty message="No upcoming reminders." />
      {/if}
    </OverviewCard>

    <!-- By Context -->
    <OverviewCard title="By Context" icon={ICONS.context} iconColor="var(--gold)">
      {#if contextEntries.length > 0}
        <ul class="card-list">
          {#each contextEntries as [ctx, count]}
            <li>
              <span class="card-list-title">{ctx}</span>
              <span class="card-list-value">{count}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <Empty message="No contexts defined." />
      {/if}
    </OverviewCard>

    <!-- Task Status -->
    <OverviewCard title="Task Status" icon={ICONS.status} iconColor="var(--blue)">
      <BarChart bars={statusBars} />
    </OverviewCard>
  </div>
{/if}

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
    gap: 8px;
    padding: 8px 10px;
    margin: 0 -6px;
    border-radius: 8px;
    border-bottom: 1px solid var(--border);
    transition: background .14s ease, transform .14s ease;
  }
  .card-list li:hover {
    background: var(--surface-2);
    transform: translateX(2px);
    border-bottom-color: transparent;
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
    font-family: var(--font-mono);
  }
  .card-list-value {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    color: var(--gold);
    background: rgba(212, 168, 75, .1);
    border-radius: 999px;
    padding: 2px 9px;
    min-width: 24px;
    text-align: center;
  }
</style>
