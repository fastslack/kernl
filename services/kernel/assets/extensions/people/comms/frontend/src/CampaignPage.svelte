<script lang="ts">
  // /comms/campaign/:id — migrated from
  // services/dashboard/src/routes/comms/campaign/[id]/+page.svelte (Fase 2b).
  // The id comes from the Root sub-router (pathname), not $page.params.
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import Badge from '$shared/components/Badge.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import { fmtTime } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;
  export let id: string;

  const goto = (path: string) => ctx.navigate(path);

  $: campaignId = id;

  let campaign: any = null;
  let messages: any[] = [];
  let loading = true;
  let error = '';

  $: if (campaignId) loadCampaign();

  async function loadCampaign() {
    loading = true; error = '';
    try {
      const data = await ctx.rpc('comms.campaign', { id: campaignId }, async () => {
        const r = await ctx.fetchRaw('/api/dashboard/comms/campaign?id=' + encodeURIComponent(campaignId));
        if (!r.ok) throw new Error('Not found');
        return r.json();
      }) as any;
      campaign = data.campaign;
      messages = data.messages ?? [];
    } catch (e: any) { error = e.message; }
    finally { loading = false; }
  }
</script>

<ViewHeader title="Campaign" sub={campaign?.name ?? campaignId}>
  <button class="header-btn" on:click={() => goto('/comms')}>← Back</button>
</ViewHeader>

{#if loading}
  <div class="loading-view">Loading campaign...</div>
{:else if error}
  <Panel cls="anim"><div class="empty">Error: {error}</div></Panel>
{:else}
  {#if campaign}
    <div class="kpi-row anim">
      <div class="kpi"><div class="kpi-label">Total</div><div class="kpi-value">{messages.length}</div></div>
      <div class="kpi"><div class="kpi-label">Sent</div><div class="kpi-value" style="color:var(--green)">{messages.filter(m => m.status === 'sent').length}</div></div>
      <div class="kpi"><div class="kpi-label">Failed</div><div class="kpi-value" style="color:var(--red)">{messages.filter(m => m.status === 'failed').length}</div></div>
      <div class="kpi"><div class="kpi-label">Draft</div><div class="kpi-value" style="color:var(--gold)">{messages.filter(m => m.status === 'draft').length}</div></div>
    </div>
  {/if}

  {#if !messages.length}
    <Panel cls="anim"><Empty message="No messages in campaign" /></Panel>
  {:else}
    {#each messages as m}
      <div class="panel anim" style="margin-bottom:8px;cursor:pointer" on:click={() => goto('/comms/edit/' + m.id)} role="button" tabindex="0" on:keypress={() => {}}>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500">{m.subject || '(no subject)'}</div>
            <div style="font-size:11px;color:var(--text-3)">{m.recipients_to}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <Badge text={m.status} />
            <span style="font-size:11px;color:var(--text-3)">{fmtTime(m.updated_at)}</span>
          </div>
        </div>
      </div>
    {/each}
  {/if}
{/if}
