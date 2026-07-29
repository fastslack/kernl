<script lang="ts">
  // /reminders — migrated from services/dashboard/src/routes/reminders/+page.svelte
  // (Fase 2b). Read-only view over the shell "data" store (dashboard channel);
  // the shell keeps hydrating it for this path.
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import Badge from '$shared/components/Badge.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import { fmtTime } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const data = ctx.getStore('data') as any;

  $: d = ($data as any);
  $: reminders = d?.reminders ?? {};
  // API shape: { overdue:[], upcoming24h:[], byStatus:{active,snoozed,...}, firedToday, recurringCount }
  $: overdue = (reminders.overdue ?? []) as any[];
  $: upcoming = (reminders.upcoming24h ?? []) as any[];
  $: activeCount = (reminders.byStatus as Record<string, number>)?.active ?? 0;
  // Combine for "all" display
  $: all = (() => {
    const seen = new Set<string>();
    const result: any[] = [];
    for (const r of [...overdue, ...upcoming]) {
      if (!seen.has(r.id)) { seen.add(r.id); result.push(r); }
    }
    return result;
  })();
</script>

<ViewHeader title="Reminders" sub="{activeCount} active" />

{#if !d}
  <div class="loading-view">Loading reminders...</div>
{:else}
  <div class="kpi-row anim">
    <KpiCard label="Active" value={activeCount} accent="--teal" color="var(--teal)" />
    <KpiCard label="Overdue" value={overdue.length} accent="--red" color={overdue.length > 0 ? 'var(--red)' : 'var(--text-1)'} />
    <KpiCard label="Upcoming 24h" value={upcoming.length} accent="--gold" color="var(--gold)" />
    <KpiCard label="Fired Today" value={reminders.firedToday ?? 0} accent="--blue" />
  </div>

  {#if overdue.length}
    <Panel title="Overdue ({overdue.length})" dotColor="var(--red)" cls="anim d1" style="border-color:var(--red)">
      {#each overdue as r}
        <div class="agenda-item">
          <span class="agenda-time" style="color:var(--red)">{fmtTime(r.trigger_at)}</span>
          <div class="agenda-content">
            <div class="agenda-title">{r.title}</div>
            {#if r.body}<div style="font-size:11px;color:var(--text-2);margin-top:2px">{r.body}</div>{/if}
            <div class="agenda-meta">
              <Badge text="overdue" variant="overdue" />
              {#if r.repeat !== 'none'}<Badge text={r.repeat} variant="teal" />{/if}
            </div>
          </div>
        </div>
      {/each}
    </Panel>
  {/if}

  {#if upcoming.length}
    <Panel title="Upcoming (next 24h)" dotColor="var(--gold)" cls="anim d2">
      {#each upcoming as r}
        <div class="agenda-item">
          <span class="agenda-time">{fmtTime(r.trigger_at)}</span>
          <div class="agenda-content">
            <div class="agenda-title">{r.title}</div>
            {#if r.body}<div style="font-size:11px;color:var(--text-2);margin-top:2px">{r.body}</div>{/if}
            <div class="agenda-meta">
              <Badge text="upcoming" variant="low" />
              {#if r.repeat !== 'none'}<Badge text={r.repeat} variant="teal" />{/if}
            </div>
          </div>
        </div>
      {/each}
    </Panel>
  {/if}

  <Panel title="All Reminders" dotColor="var(--text-2)" cls="anim d3">
    {#if !all.length}
      <Empty message="No reminders" />
    {:else}
      {#each all as r}
        <div class="agenda-item">
          <span class="agenda-time" style={r.status === 'fired' && new Date(r.trigger_at) < new Date() ? 'color:var(--red)' : ''}>{fmtTime(r.trigger_at)}</span>
          <div class="agenda-content">
            <div class="agenda-title">{r.title}</div>
            <div class="agenda-meta">
              <Badge text={r.status} variant={r.status} />
              {#if r.repeat !== 'none'}<Badge text={r.repeat} variant="teal" />{/if}
            </div>
          </div>
        </div>
      {/each}
    {/if}
  </Panel>
{/if}
