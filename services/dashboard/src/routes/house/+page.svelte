<script lang="ts">
  import { house } from '$lib/stores.js';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Empty from '$lib/components/Empty.svelte';
  import { fmtTime, formatCents } from '$lib/utils.js';

  $: hd = ($house as any);
  // API shape: { available, overdueMaintenance:[], upcomingMaintenance:[], activeProjects:[],
  //              openIncidents:[], expiringWarranties:[], ytdSpendCents, applianceCount, vendorCount }
  $: maintenance = (hd?.overdueMaintenance ?? []) as any[];
  $: projects = (hd?.activeProjects ?? []) as any[];
  $: incidents = (hd?.openIncidents ?? []) as any[];
  $: warranties = (hd?.expiringWarranties ?? []) as any[];
  $: hasAny = maintenance.length || incidents.length || projects.length || warranties.length
    || (hd?.applianceCount ?? 0) > 0;
</script>

<ViewHeader title="House" sub="Home management" />

<div class="kpi-row anim">
    <KpiCard label="Overdue Maintenance" value={maintenance.length} accent="--red" color={maintenance.length > 0 ? 'var(--red)' : 'var(--text-1)'} />
    <KpiCard label="Active Projects" value={projects.length} accent="--blue" color="var(--blue)" />
    <KpiCard label="Open Incidents" value={incidents.length} accent="--orange" color={incidents.length > 0 ? 'var(--orange)' : 'var(--text-1)'} />
    <KpiCard label="Expiring Warranties" value={warranties.length} accent="--gold" color={warranties.length > 0 ? 'var(--gold)' : 'var(--text-1)'} />
    <KpiCard label="YTD Spend" value={formatCents(hd?.ytdSpendCents ?? 0)} accent="--purple" color="var(--purple)" />
    <KpiCard label="Appliances" value={hd?.applianceCount ?? 0} sub="{hd?.vendorCount ?? 0} vendors" accent="--teal" color="var(--teal)" />
  </div>

  {#if maintenance.length}
    <Panel title="Overdue Maintenance" dotColor="var(--red)" cls="anim d2" style="border-color:var(--red)">
      {#each maintenance as m}
        <div class="agenda-item">
          <div class="agenda-content">
            <div style="font-size:13px;font-weight:500">{m.name}</div>
            <div style="display:flex;gap:6px;margin-top:2px;flex-wrap:wrap">
              <Badge text={m.priority ?? 'medium'} variant={m.priority ?? 'medium'} />
              {#if m.next_due}<span style="font-size:11px;color:var(--red)">Due: {fmtTime(m.next_due)}</span>{/if}
              {#if m.estimated_cost_cents}<span style="font-size:11px;color:var(--text-3)">{formatCents(m.estimated_cost_cents)}</span>{/if}
            </div>
          </div>
        </div>
      {/each}
    </Panel>
  {/if}

  {#if incidents.length}
    <Panel title="Open Incidents" dotColor="var(--orange)" cls="anim d3">
      {#each incidents as inc}
        <div class="agenda-item">
          <div class="agenda-content">
            <div style="font-size:13px;font-weight:500">{inc.title}</div>
            <div style="display:flex;gap:6px;margin-top:2px;flex-wrap:wrap">
              <Badge text={inc.severity} variant={inc.severity === 'emergency' ? 'overdue' : inc.severity === 'urgent' ? 'high' : 'medium'} />
              <Badge text={inc.status} />
              {#if inc.date_reported}<span style="font-size:11px;color:var(--text-3)">{fmtTime(inc.date_reported)}</span>{/if}
            </div>
          </div>
        </div>
      {/each}
    </Panel>
  {/if}

  {#if projects.length}
    <Panel title="Active Projects" dotColor="var(--blue)" cls="anim d4">
      {#each projects as p}
        <div class="agenda-item">
          <div class="agenda-content">
            <div style="font-size:13px;font-weight:500">{p.title}</div>
            <div style="display:flex;gap:6px;margin-top:2px;flex-wrap:wrap">
              <Badge text={p.status} />
              {#if p.budget_cents}<span style="font-size:11px;color:var(--text-3)">Budget: {formatCents(p.budget_cents)}</span>{/if}
              {#if p.actual_cents}<span style="font-size:11px;color:var(--gold)">Actual: {formatCents(p.actual_cents)}</span>{/if}
            </div>
          </div>
        </div>
      {/each}
    </Panel>
  {/if}

  {#if warranties.length}
    <Panel title="Expiring Warranties (90d)" dotColor="var(--gold)" cls="anim d5">
      {#each warranties as w}
        <div class="agenda-item">
          <div class="agenda-content">
            <div style="font-size:13px;font-weight:500">{w.name}</div>
            <div style="font-size:11px;color:var(--gold);margin-top:2px">Expires: {fmtTime(w.warranty_expiry)}</div>
          </div>
        </div>
      {/each}
    </Panel>
  {/if}

{#if !hasAny}
  <Panel cls="anim d2">
    <Empty
      icon="🏠"
      title="Your home, organized"
      hint="Track appliances, maintenance schedules, warranties and repair projects in one place. Ask your assistant to log an appliance or a repair to get started."
    />
  </Panel>
{/if}
