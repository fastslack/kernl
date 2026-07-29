<script lang="ts">
  // /comms/thread/:id — migrated from
  // services/dashboard/src/routes/comms/thread/[id]/+page.svelte (Fase 2b).
  // The id comes from the Root sub-router (pathname), not $page.params.
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import Badge from '$shared/components/Badge.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import { fmtTime } from '$shared/utils';
  import { sanitizeHtml } from '$shared/sanitize';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;
  export let id: string;

  const goto = (path: string) => ctx.navigate(path);

  const getCommThread = (threadId: string) =>
    ctx.rpc('comms.thread', { id: threadId }, () => ctx.fetchJson('/api/dashboard/comms/thread?id=' + encodeURIComponent(threadId)));

  $: threadId = id;

  let thread: any[] = [];
  let loading = true;
  let error = '';

  // Reactive on the id prop (runs on init and on same-view navigation).
  $: if (threadId) loadThread();

  async function loadThread() {
    loading = true; error = '';
    try { thread = await getCommThread(threadId); }
    catch (e: any) { error = e.message; }
    finally { loading = false; }
  }
</script>

<ViewHeader title="Thread" sub="{thread.length} messages">
  <button class="header-btn" on:click={() => goto('/comms')}>← Back</button>
</ViewHeader>

{#if loading}
  <div class="loading-view">Loading thread...</div>
{:else if error}
  <Panel cls="anim"><div class="empty">Error: {error}</div></Panel>
{:else if !thread.length}
  <Panel cls="anim"><Empty message="Thread not found" /></Panel>
{:else}
  {#each thread as msg}
    <div class="panel anim" style="margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="display:flex;gap:6px;align-items:center">
          <Badge text={msg.direction} variant={msg.direction === 'inbound' ? 'teal' : 'blue'} />
          <Badge text={msg.status} />
          <span style="font-size:12px;font-weight:600">{msg.subject || '(no subject)'}</span>
        </div>
        <span style="font-size:11px;color:var(--text-3)">{fmtTime(msg.sent_at || msg.created_at)}</span>
      </div>
      {#if msg.direction === 'inbound'}
        <div style="font-size:11px;color:var(--text-3);margin-bottom:6px">From: {msg.recipients_to || 'unknown'}</div>
      {:else}
        <div style="font-size:11px;color:var(--text-3);margin-bottom:6px">To: {msg.recipients_to}</div>
      {/if}
      {#if msg.body_html}
        <div class="html-preview" style="padding:12px;background:var(--surface-2);border-radius:var(--radius-sm)">
          {@html sanitizeHtml(msg.body_html)}
        </div>
      {:else if msg.body}
        <div style="font-size:13px;color:var(--text-1);line-height:1.6;white-space:pre-wrap">{msg.body}</div>
      {/if}
    </div>
  {/each}
{/if}
