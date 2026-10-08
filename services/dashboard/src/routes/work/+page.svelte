<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { data, planner } from '$lib/stores.js';
  import { apiFetchRaw } from '$lib/api.js';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import QuickAction from '$shared/components/QuickAction.svelte';
  import OverviewCard from '$shared/components/OverviewCard.svelte';
  import BarChart from '$shared/components/BarChart.svelte';
  import Badge from '$shared/components/Badge.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import Skeleton from '$shared/components/Skeleton.svelte';
  import ErrorState from '$shared/components/ErrorState.svelte';
  import { HttpFailure } from '$shared/feedback';
  import { fmtTime } from '$shared/utils';

  // Data from stores
  $: d = ($data as any);
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

  // Approvals: drafts the agents are waiting on you to approve (/outbox).
  // Null until loaded, and stays null on a kernel without the projects module,
  // so the card and the KPI only show where approvals exist.
  interface Approval { id: string; channel: string; created_at: string; preview?: { title?: string; body?: string } }
  let approvals: Approval[] | null = null;
  let approvalsPending = 0;
  // A failed load (anything but a kernel without the module) keeps the error
  // here instead of hiding the card. It stays set while a retry is in flight so
  // ErrorState remains mounted and its 60 s auto-retry cap is not reset.
  let approvalsError: unknown = null;

  async function loadApprovals() {
    try {
      const [list, count] = await Promise.all([
        apiFetchRaw('/api/outbox?status=draft&limit=5'),
        apiFetchRaw('/api/outbox/count'),
      ]);
      // 404: a kernel without the projects module — keep the section hidden.
      if (list.status === 404 || count.status === 404) { approvalsError = null; return; }
      for (const r of [list, count]) {
        if (!r.ok) throw new HttpFailure(r.status, r.headers.get('content-type') ?? '', await r.text());
      }
      const items = (((await list.json()) as { items?: Approval[] }).items ?? []);
      approvalsPending = ((await count.json()) as { pending?: number }).pending ?? items.length;
      approvals = items;
      approvalsError = null;
    } catch (e) { approvalsError = e; }
  }

  const approvalTitle = (a: Approval) =>
    (a.preview?.title || a.preview?.body || a.channel || '').split('\n')[0].slice(0, 90);

  onMount(loadApprovals);

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
    approvals: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    urgent: 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    context: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z',
    status: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4'
  };
</script>

{#if !d}
  <Skeleton variant="cards" rows={6} />
{:else}
  <ViewHeader title="Work" sub="Your productivity command center" />

  <!-- Quick Actions -->
  <div class="quick-actions">
    <QuickAction label="New Task" icon={ICONS.newTask} variant="primary" navigate={goto} href="/tasks" />
    <QuickAction label="Add Reminder" icon={ICONS.reminder} variant="purple" navigate={goto} href="/reminders" />
    <QuickAction label="View Planner" icon={ICONS.planner} variant="blue" navigate={goto} href="/planner" />
    <QuickAction label="Review Approvals" icon={ICONS.approvals} variant="orange" navigate={goto} href="/outbox" />
  </div>

  <!-- KPI Row -->
  <div class="kpi-row anim">
    <KpiCard label="Open Tasks" value={taskTodo} sub="{taskInProgress} in progress" accent="--blue" color="var(--blue)" />
    <KpiCard label="Done Today" value={taskDoneToday} sub="tasks completed" accent="--teal" color="var(--teal)" />
    <KpiCard label="Overdue" value={taskOverdue.length} sub="need attention" accent="--red" color={taskOverdue.length > 0 ? 'var(--red)' : 'var(--text-3)'} />
    <KpiCard label="Reminders" value={remActive} sub="active" accent="--purple" color="var(--purple)" />
    {#if approvals}
      <KpiCard label="Approvals" value={approvalsPending} sub="waiting for you" accent="--orange" color={approvalsPending > 0 ? 'var(--orange)' : 'var(--text-3)'} />
    {/if}
  </div>

  <!-- Overview Grid -->
  <div class="overview-grid">
    <!-- Urgent Tasks -->
    <OverviewCard title="Urgent Tasks" icon={ICONS.urgent} iconColor="var(--red)" navigate={goto} actions={[{ label: 'View All Tasks', href: '/tasks' }]}>
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

    <!-- Pending Approvals -->
    {#if approvals || approvalsError}
      <OverviewCard title="Pending Approvals" icon={ICONS.approvals} iconColor="var(--orange)" navigate={goto} actions={[{ label: 'Review All', href: '/outbox' }]}>
        {#if approvalsError}
          <ErrorState error={approvalsError} on:retry={loadApprovals} />
        {:else if approvals && approvals.length > 0}
          <ul class="card-list">
            {#each approvals as a (a.id)}
              <li>
                <span class="card-list-title">{approvalTitle(a)}</span>
                <span class="card-list-meta">{a.channel}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <Empty message="Nothing waiting for approval." />
        {/if}
      </OverviewCard>
    {/if}

    <!-- Upcoming Reminders -->
    <OverviewCard title="Upcoming Reminders" icon={ICONS.reminder} iconColor="var(--purple)" navigate={goto} actions={[{ label: 'View Alerts', href: '/reminders' }]}>
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
