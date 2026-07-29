<script lang="ts">
  // /people — migrated from services/dashboard/src/routes/people/+page.svelte
  // (Fase 2b). Read-only over the shell "data" + "analytics" stores.
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import BarChart from '$shared/components/BarChart.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import Badge from '$shared/components/Badge.svelte';
  import { fmtTime } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const data = ctx.getStore('data') as any;
  const analytics = ctx.getStore('analytics') as any;

  // Chart color cycle — local copy of CC from services/dashboard/src/lib/constants.ts
  const CC: string[] = [
    'var(--teal)', 'var(--blue)', 'var(--purple)', 'var(--gold)',
    'var(--green)', 'var(--orange)', 'var(--red)'
  ];

  $: d = ($data as any);
  $: crm = d?.crm ?? {};
  $: a = ($analytics as any);
  $: ci = a?.contactInsights ?? {};
  // API returns topDomains/topCompanies as flat arrays, not nested objects
  $: topDomains = (a?.topDomains ?? []) as any[];
  $: topCompanies = (a?.topCompanies ?? []) as any[];
  $: stale = (crm.staleContacts ?? []) as any[];
  $: recentInteractions = (crm.recentInteractions ?? []) as any[];

  $: domainBars = topDomains.slice(0, 15).map((d: any, i: number) => ({
    label: d.domain, value: d.count, color: CC[i % CC.length]
  }));

  $: companyBars = topCompanies.slice(0, 10).map((c: any, i: number) => ({
    label: c.company, value: c.count, color: CC[i % CC.length]
  }));

  // byRelationship is a Record<string,number> object, not an array
  $: relBars = Object.entries(ci.byRelationship ?? {}).map(([label, value], i) => ({
    label, value: value as number, color: CC[i % CC.length]
  }));

  // Contact search — searches over stale contacts (full list not available in API)
  let search = '';
  $: filtered = stale.filter((c: any) =>
    !search || c.name?.toLowerCase().includes(search.toLowerCase()) || c.company?.toLowerCase().includes(search.toLowerCase())
  );
</script>

<ViewHeader title="People" sub="{crm.total ?? 0} contacts" />

{#if !d}
  <div class="loading-view">Loading contacts...</div>
{:else}
  <!-- KPIs -->
  <div class="kpi-row anim">
    <KpiCard label="Total Contacts" value={crm.total ?? 0} accent="--teal" color="var(--teal)" />
    <KpiCard label="With Email" value={ci.withEmail ?? 0} sub="{ci.emailPct ?? 0}%" accent="--blue" color="var(--blue)" />
    <KpiCard label="With Phone" value={ci.withPhone ?? 0} sub="{ci.phonePct ?? 0}%" accent="--green" color="var(--green)" />
    <KpiCard label="Stale (30d+)" value={stale.length} accent="--orange" color={stale.length > 0 ? 'var(--orange)' : 'var(--text-1)'} />
  </div>

  <div class="grid-2 anim d1">
    <!-- By Relationship -->
    {#if relBars.length}
      <Panel title="By Relationship" dotColor="var(--teal)">
        <BarChart entries={relBars} />
      </Panel>
    {/if}

    <!-- Recent Interactions -->
    <Panel title="Recent Interactions" dotColor="var(--gold)">
      {#if !recentInteractions.length}
        <Empty message="No recent interactions" />
      {:else}
        {#each recentInteractions.slice(0, 6) as ix}
          <div class="agenda-item">
            <span class="agenda-time">{fmtTime(ix.date)}</span>
            <div class="agenda-content">
              <div class="agenda-title">{ix.contact_name}</div>
              <div class="agenda-meta"><Badge text={ix.type} /></div>
            </div>
          </div>
        {/each}
      {/if}
    </Panel>
  </div>

  <!-- Domains + Companies -->
  {#if domainBars.length || companyBars.length}
    <div class="grid-2 anim d2">
      {#if domainBars.length}
        <Panel title="Top Email Domains" dotColor="var(--blue)">
          <BarChart entries={domainBars} />
        </Panel>
      {/if}
      {#if companyBars.length}
        <Panel title="Top Companies" dotColor="var(--purple)">
          <BarChart entries={companyBars} />
        </Panel>
      {/if}
    </div>
  {/if}

  <!-- Stale contacts -->
  {#if stale.length}
    <Panel title="Stale Contacts (30d+)" dotColor="var(--orange)" cls="anim d3">
      {#each stale.slice(0, 10) as c}
        <div class="agenda-item">
          <div class="agenda-content">
            <div class="agenda-title">{c.name}</div>
            <div class="agenda-meta">
              {#if c.company}<span style="font-size:11px;color:var(--text-3)">{c.company}</span>{/if}
              <span style="font-size:11px;color:var(--text-3)">Last: {fmtTime(c.last_interaction)}</span>
            </div>
          </div>
        </div>
      {/each}
    </Panel>
  {/if}

  <!-- Stale contact search -->
  {#if stale.length}
    <Panel title="Search Stale Contacts" dotColor="var(--text-2)" cls="anim d4">
      <input class="search-input" bind:value={search} placeholder="Filter by name or company..." style="margin-bottom:12px" />
      {#if search && filtered.length === 0}
        <Empty message="No stale contacts match '{search}'" />
      {:else}
        {#each filtered.slice(0, 20) as c}
          <div class="agenda-item">
            <div class="agenda-content">
              <div style="font-size:13px;font-weight:500">{c.name}</div>
              <div style="font-size:11px;color:var(--text-3)">
                {#if c.company}{c.company} · {/if}Last: {c.last_interaction ?? 'never'}
              </div>
            </div>
            <Badge text={c.relationship ?? 'acquaintance'} />
          </div>
        {/each}
      {/if}
    </Panel>
  {/if}
{/if}
