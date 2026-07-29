<script lang="ts">
  // /health — migrated from services/dashboard/src/routes/health/+page.svelte
  // (Fase 3). Data still flows through the shell: the layout subscribes the
  // "health" WS channel for this path and hydrates the healthData store.
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const healthData = ctx.getStore('healthData');

  $: hd = ($healthData as any);
  $: k = hd?.kpis ?? {};
  $: latestMetrics = hd?.latestMetrics ?? {};
  $: latestMetricEntries = Object.entries(latestMetrics) as [string, any][];
  $: upcomingAppointments = (hd?.upcomingAppointments ?? []) as any[];
  $: activeMedications = (hd?.activeMedications ?? []) as any[];
  $: recentMetrics = (hd?.recentMetrics ?? []) as any[];

  function wt(lm: any) {
    return lm && lm.weight ? lm.weight : null;
  }
</script>

<ViewHeader title="Health" sub="Vitals & tracking" />

{#if !hd || !hd.available}
  <Panel cls="anim"><Empty message="Health module not available. Use MCP tools to log metrics and medications." /></Panel>
{:else}
  {@const weight = wt(latestMetrics)}
  <div class="kpi-row anim">
    <KpiCard label="Active Meds" value={k.activeMedications ?? 0} sub="medications" accent="--purple" color="var(--purple)" />
    <KpiCard label="Appointments" value={k.upcomingAppointments ?? 0} sub="upcoming" accent="--teal" color="var(--teal)" />
    <KpiCard label="Metrics (30d)" value={k.metricsLast30d ?? 0} sub="logged" accent="--gold" color="var(--gold)" />
    <KpiCard label="Weight" value={weight ? weight.value + ' ' + weight.unit : '—'} sub={weight ? weight.date : 'no data'} accent="--teal" color={weight ? 'var(--teal)' : 'var(--text-2)'} />
  </div>

  {#if latestMetricEntries.length}
    <Panel title="Latest Metrics" dotColor="var(--teal)" cls="anim d1">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-top:10px">
        {#each latestMetricEntries as [key, val]}
          <div style="padding:12px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border)">
            <div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px">{key.replace(/_/g,' ')}</div>
            <div style="font-size:20px;font-weight:700;color:var(--teal);margin-top:4px">{val.value} {val.unit}</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:2px">{val.date ?? ''}</div>
          </div>
        {/each}
      </div>
    </Panel>
  {/if}

  {#if upcomingAppointments.length}
    <Panel title="Upcoming Appointments" dotColor="var(--blue)" cls="anim d2">
      {#each upcomingAppointments as a}
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-weight:600">{a.title}</div>
            <div style="font-size:12px;color:var(--text-2)">{a.provider ?? ''}</div>
          </div>
          <div style="text-align:right;font-size:12px;color:var(--text-2)">{a.date ? String(a.date).slice(0,10) : ''}</div>
        </div>
      {/each}
    </Panel>
  {/if}

  {#if activeMedications.length}
    <Panel title="Active Medications" dotColor="var(--purple)" cls="anim d3">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-top:10px">
        {#each activeMedications as m}
          <div style="padding:10px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border)">
            <div style="font-weight:600">{m.name}</div>
            <div style="font-size:12px;color:var(--text-2);margin-top:2px">{m.dosage}{m.frequency ? ' — ' + String(m.frequency).replace(/_/g,' ') : ''}</div>
          </div>
        {/each}
      </div>
    </Panel>
  {/if}

  {#if recentMetrics.length}
    <Panel title="Recent Metrics Log" dotColor="var(--gold)" cls="anim d4">
      <table class="data-table" style="width:100%;font-size:12px">
        <tr><th>Date</th><th>Type</th><th>Value</th></tr>
        {#each recentMetrics as m}
          <tr>
            <td style="color:var(--text-2)">{m.date ? String(m.date).slice(0,10) : ''}</td>
            <td>{String(m.type ?? '').replace(/_/g,' ')}</td>
            <td style="font-weight:600">{m.value} {m.unit ?? ''}</td>
          </tr>
        {/each}
      </table>
    </Panel>
  {/if}
{/if}
