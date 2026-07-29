<script lang="ts">
  // /comms — migrated from services/dashboard/src/routes/comms/+page.svelte
  // (Fase 2b). The shell keeps hydrating the comms store (comms WS channel)
  // for this path; sub-pages are reached via ctx.navigate (Root re-routes).
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import Badge from '$shared/components/Badge.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import { fmtTime } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const comms = ctx.getStore('comms') as any;

  const searchCommsInbox = (query: string) =>
    ctx.rpc('comms.search', { q: query }, () => ctx.fetchJson('/api/dashboard/comms/search?q=' + encodeURIComponent(query)));

  $: cm = ($comms as any);
  $: kpis = cm?.kpis ?? {};
  // API shape: { pendingDrafts:[], recentSent:[], kpis:{total,drafts,sent,failed,...} }
  $: drafts = (cm?.pendingDrafts ?? []) as any[];
  $: sent = (cm?.recentSent ?? []) as any[];
  $: accounts = (cm?.accounts ?? []) as any[];

  let tab = 'drafts';
  let searchQuery = '';
  let searchResults: any[] = [];
  let searching = false;

  async function doSearch() {
    if (!searchQuery.trim()) { searchResults = []; return; }
    searching = true;
    try { searchResults = await searchCommsInbox(searchQuery); }
    finally { searching = false; }
  }

  function openEditor(id: string) { ctx.navigate('/comms/edit/' + id); }
  function openThread(threadId: string) { ctx.navigate('/comms/thread/' + threadId); }
  function openCompose() { ctx.navigate('/comms/compose'); }
</script>

<ViewHeader title="Comms" sub="Multi-channel communications">
  <button class="search-btn" on:click={openCompose}>+ Compose</button>
</ViewHeader>

{#if !cm}
  <div class="loading-view">Loading comms...</div>
{:else}
  <div class="kpi-row anim">
    <KpiCard label="Drafts" value={kpis.drafts ?? 0} accent="--gold" color="var(--gold)" />
    <KpiCard label="Sent (30d)" value={kpis.sent ?? 0} accent="--green" color="var(--green)" />
    <KpiCard label="Archived" value={kpis.archived ?? 0} accent="--teal" color="var(--teal)" />
    <KpiCard label="Failed" value={kpis.failed ?? 0} accent="--red" color={(kpis.failed ?? 0) > 0 ? 'var(--red)' : 'var(--text-1)'} />
  </div>

  <!-- Tabs -->
  <div style="display:flex;gap:6px;margin-bottom:16px">
    {#each ['drafts','sent','search','accounts'] as t}
      <button class="badge badge-{tab === t ? 'teal' : 'low'}" style="cursor:pointer;border:none;font-size:12px;padding:6px 12px" on:click={() => tab = t}>
        {t.charAt(0).toUpperCase() + t.slice(1)}
      </button>
    {/each}
  </div>

  {#if tab === 'drafts'}
    {#if !drafts.length}
      <Panel cls="anim"><Empty message="No drafts" /></Panel>
    {:else}
      {#each drafts as c}
        <div class="panel anim" style="cursor:pointer" on:click={() => openEditor(c.id)} role="button" tabindex="0" on:keypress={() => openEditor(c.id)}>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500;margin-bottom:2px">{c.subject || '(no subject)'}</div>
              <div style="font-size:11px;color:var(--text-3)">{c.recipients_to || 'No recipient'}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <Badge text={c.status} variant={c.status} />
              <Badge text={c.channel} />
              <span style="font-size:11px;color:var(--text-3);white-space:nowrap">{fmtTime(c.updated_at)}</span>
            </div>
          </div>
        </div>
      {/each}
    {/if}

  {:else if tab === 'sent'}
    {#if !sent.length}
      <Panel cls="anim"><Empty message="No sent messages" /></Panel>
    {:else}
      {#each sent as c}
        <div class="panel anim" style="cursor:pointer" on:click={() => c.thread_id ? openThread(c.thread_id) : openEditor(c.id)} role="button" tabindex="0" on:keypress={() => {}}>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500;margin-bottom:2px">{c.subject || '(no subject)'}</div>
              <div style="font-size:11px;color:var(--text-3)">To: {c.recipients_to}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <Badge text={c.channel} />
              <span style="font-size:11px;color:var(--text-3);white-space:nowrap">{fmtTime(c.sent_at)}</span>
            </div>
          </div>
        </div>
      {/each}
    {/if}

  {:else if tab === 'search'}
    <Panel cls="anim">
      <div class="search-input-row">
        <input class="search-input" bind:value={searchQuery} placeholder="Search Gmail inbox..." on:keypress={e => e.key === 'Enter' && doSearch()} />
        <button class="search-btn" on:click={doSearch} disabled={searching}>{searching ? '...' : 'Search'}</button>
      </div>
      {#if searchResults.length}
        {#each searchResults as r}
          <div class="agenda-item">
            <div class="agenda-content">
              <div style="font-size:13px;font-weight:500">{r.subject}</div>
              <div style="font-size:11px;color:var(--text-3)">{r.from} · {fmtTime(r.date)}</div>
            </div>
          </div>
        {/each}
      {:else if !searching}
        <Empty message="Search your Gmail inbox" />
      {/if}
    </Panel>

  {:else if tab === 'accounts'}
    {#if !accounts.length}
      <Panel cls="anim"><Empty message="No accounts configured" /></Panel>
    {:else}
      {#each accounts as acc}
        <Panel cls="anim">
          <div style="display:flex;align-items:center;gap:10px">
            <Badge text={acc.channel} />
            <div style="flex:1">
              <div style="font-size:13px;font-weight:500">{acc.label || acc.address}</div>
              {#if acc.address}<div style="font-size:11px;color:var(--text-3)">{acc.address}</div>{/if}
            </div>
            <span class="badge badge-{acc.connected ? 'done' : 'blocked'}">{acc.connected ? 'connected' : 'not connected'}</span>
          </div>
        </Panel>
      {/each}
    {/if}
  {/if}
{/if}
