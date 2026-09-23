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
  import { jsonApi } from '$shared/api';

  export let ctx: ExtPageContext;
  export let id: string;

  const goto = (path: string) => ctx.navigate(path);
  const api = jsonApi((p, i) => ctx.fetchRaw(p, i), { statusMessage: () => 'Not found', bodyError: false });

  $: campaignId = id;

  let campaign: any = null;
  let recipients: any[] = [];
  let loading = true;
  let error = '';

  $: if (campaignId) loadCampaign();

  async function loadCampaign() {
    loading = true; error = '';
    try {
      const data = await ctx.rpc('comms.campaign', { id: campaignId }, () =>
        api.getJson('/api/dashboard/comms/campaign?id=' + encodeURIComponent(campaignId))) as any;
      // The operation answers { ...campaign, campaign, recipients } — one row
      // per campaign_recipients entry, each linked to the message it produced
      // (comm_id) once sent.
      campaign = data.campaign;
      recipients = data.recipients ?? [];
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
      <div class="kpi"><div class="kpi-label">Total</div><div class="kpi-value">{recipients.length}</div></div>
      <div class="kpi"><div class="kpi-label">Sent</div><div class="kpi-value" style="color:var(--green)">{recipients.filter(r => r.status === 'sent').length}</div></div>
      <div class="kpi"><div class="kpi-label">Failed</div><div class="kpi-value" style="color:var(--red)">{recipients.filter(r => r.status === 'failed').length}</div></div>
      <div class="kpi"><div class="kpi-label">Pending</div><div class="kpi-value" style="color:var(--gold)">{recipients.filter(r => r.status === 'pending').length}</div></div>
    </div>
  {/if}

  {#if !recipients.length}
    <Panel cls="anim"><Empty message="No recipients in campaign" /></Panel>
  {:else}
    {#each recipients as r}
      <!-- A recipient opens the message it produced, once there is one. -->
      <div class="panel anim" style="margin-bottom:8px;cursor:{r.comm_id ? 'pointer' : 'default'}" on:click={() => r.comm_id && goto('/comms/edit/' + r.comm_id)} role="button" tabindex="0" on:keypress={() => {}}>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500">{r.name || r.email}</div>
            <div style="font-size:11px;color:var(--text-3)">{r.name ? r.email : ''}{r.error_message ? (r.name ? ' · ' : '') + r.error_message : ''}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <Badge text={r.status} />
            <span style="font-size:11px;color:var(--text-3)">{fmtTime(r.sent_at ?? r.created_at)}</span>
          </div>
        </div>
      </div>
    {/each}
  {/if}
{/if}
