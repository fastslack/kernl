<script lang="ts">
  // /comms/edit/:id — migrated from
  // services/dashboard/src/routes/comms/edit/[id]/+page.svelte (Fase 2b).
  // The id comes from the Root sub-router (pathname), not $page.params.
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import KpiCard from '$shared/components/KpiCard.svelte';
  import Badge from '$shared/components/Badge.svelte';
  import { fmtTime, formatFileSize } from '$shared/utils';
  import { COMM_STATUS_COL, CHAN_COL } from './constants';
  import { sanitizeHtml, escapeHtml } from '$shared/sanitize';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;
  export let id: string;

  const goto = (path: string) => ctx.navigate(path);

  const postJson = (url: string, payload: unknown, method = 'POST') =>
    ctx.fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

  const getCommDetail = (commId: string) =>
    ctx.rpc('comms.detail', { id: commId }, () => ctx.fetchJson('/api/dashboard/comms/detail?id=' + encodeURIComponent(commId)));
  const updateComm = (payload: Record<string, unknown>) =>
    ctx.rpc('comms.update', payload, () => postJson('/api/dashboard/comms/update', payload, 'PUT'));
  const sendComm = (commId: string) =>
    ctx.rpc('comms.send', { id: commId }, () => postJson('/api/dashboard/comms/send', { id: commId }));

  let commData: any = null;
  let loading = true;
  let error = '';

  let subject = '';
  let body = '';
  let recipientsTo = '';
  let recipientsCc = '';
  let recipientsBcc = '';
  let saveStatus = '';
  let saving = false;
  let sending = false;

  let previewMode = false;

  // Reactive on the id prop (runs on init and on same-view navigation).
  $: if (id) loadComm();

  async function loadComm() {
    loading = true; error = '';
    try {
      commData = await getCommDetail(id);
      const c = commData.comm;
      subject = c.subject ?? '';
      body = c.body ?? '';
      recipientsTo = c.recipients_to ?? '';
      recipientsCc = c.recipients_cc ?? '';
      recipientsBcc = c.recipients_bcc ?? '';
    } catch (e: any) {
      error = e.message;
    } finally { loading = false; }
  }

  $: comm = commData?.comm;
  $: attachments = commData?.attachments ?? [];
  $: contact = commData?.contact;
  $: task = commData?.task;
  $: editable = comm?.status === 'draft' || comm?.status === 'failed';

  async function doSave() {
    saving = true; saveStatus = 'Saving...';
    try {
      await updateComm({ id, subject, body, recipients_to: recipientsTo, recipients_cc: recipientsCc, recipients_bcc: recipientsBcc });
      saveStatus = 'Saved';
      setTimeout(() => { saveStatus = ''; }, 3000);
    } catch (e: any) {
      saveStatus = 'Error: ' + e.message;
    } finally { saving = false; }
  }

  async function doSetStatus(newStatus: string) {
    saveStatus = 'Updating...';
    try {
      await updateComm({ id, status: newStatus });
      await loadComm();
      saveStatus = 'Updated to ' + newStatus;
    } catch (e: any) { saveStatus = 'Error: ' + e.message; }
  }

  async function doSend() {
    sending = true; saveStatus = 'Sending...';
    try {
      await sendComm(id);
      saveStatus = 'Sent!';
      setTimeout(() => goto('/comms'), 1000);
    } catch (e: any) {
      saveStatus = 'Error: ' + e.message;
      sending = false;
    }
  }
</script>

<ViewHeader title="Edit Draft" />

{#if loading}
  <div class="loading-view">Loading draft...</div>
{:else if error}
  <div class="panel anim"><div class="empty">Error: {error}</div></div>
{:else if comm}
  <div class="panel anim full-width">
    <button class="editor-back" on:click={() => goto('/comms')}>← Back to Comms</button>

    <!-- Status bar -->
    <div class="kpi-row" style="margin-bottom:20px">
      <KpiCard label="Status" value={comm.status} color={COMM_STATUS_COL[comm.status] ?? 'var(--text-2)'} accent="--gold" />
      <KpiCard label="Channel" value={comm.channel} color={CHAN_COL[comm.channel] ?? 'var(--blue)'} accent="--blue" />
      {#if contact}<KpiCard label="Contact" value={contact.name} color="var(--teal)" accent="--teal" />{/if}
      {#if task}<KpiCard label="Task" value={task.title.slice(0, 20) + (task.title.length > 20 ? '...' : '')} color="var(--purple)" accent="--purple" />{/if}
    </div>

    <!-- Subject -->
    <div class="editor-field">
      <label class="editor-label">Subject</label>
      <input class="editor-input" bind:value={subject} disabled={!editable} />
    </div>

    <!-- To -->
    <div class="editor-field">
      <label class="editor-label">To</label>
      <input class="editor-input" bind:value={recipientsTo} disabled={!editable} />
    </div>

    <!-- CC / BCC -->
    <div class="grid-2" style="gap:12px;margin-bottom:14px">
      <div class="editor-field" style="margin-bottom:0">
        <label class="editor-label">CC</label>
        <input class="editor-input" bind:value={recipientsCc} disabled={!editable} />
      </div>
      <div class="editor-field" style="margin-bottom:0">
        <label class="editor-label">BCC</label>
        <input class="editor-input" bind:value={recipientsBcc} disabled={!editable} />
      </div>
    </div>

    <!-- Body with Edit/Preview tabs -->
    <div class="editor-field">
      <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
        <label class="editor-label" style="flex:1;margin-bottom:0">Body</label>
        <button class="editor-status-btn {!previewMode ? 'ready' : ''}" style="font-size:10px;padding:4px 10px" on:click={() => previewMode = false}>Edit</button>
        <button class="editor-status-btn {previewMode ? 'ready' : ''}" style="font-size:10px;padding:4px 10px" on:click={() => previewMode = true}>Preview</button>
      </div>
      {#if previewMode}
        <div class="html-preview" style="min-height:200px;padding:12px;background:var(--surface-2);border-radius:var(--radius-sm)">
          {@html comm.body_html ? sanitizeHtml(comm.body_html) : escapeHtml(body).replace(/\n/g, '<br>')}
        </div>
      {:else}
        <textarea class="editor-textarea" bind:value={body} disabled={!editable}></textarea>
      {/if}
    </div>

    <!-- Thread link -->
    {#if comm.thread_id && comm.thread_id !== comm.id}
      <div style="margin-bottom:12px">
        <a href="/comms/thread/{comm.thread_id}" style="font-size:11px;color:var(--teal);text-decoration:underline">View thread →</a>
      </div>
    {/if}

    <!-- Actions -->
    {#if editable}
      <div class="editor-actions">
        <button class="editor-save-btn" on:click={doSave} disabled={saving}>Save Draft</button>
        {#if comm.status === 'draft'}
          <button class="editor-status-btn ready" on:click={() => doSetStatus('ready')}>Mark Ready</button>
        {:else if comm.status === 'ready' || comm.status === 'failed'}
          <button class="editor-status-btn" on:click={() => doSetStatus('draft')}>Back to Draft</button>
        {/if}
        {#if comm.status === 'ready'}
          <button class="compose-btn-send" style="padding:8px 16px" on:click={doSend} disabled={sending}>Send</button>
        {/if}
        {#if saveStatus}<span class="save-status" class:ok={saveStatus === 'Saved' || saveStatus === 'Sent!'} class:err={saveStatus.startsWith('Error')}>{saveStatus}</span>{/if}
      </div>
    {/if}

    <!-- Attachments -->
    {#if attachments.length}
      <div class="editor-attachments" style="margin-top:16px">
        <label class="editor-label">Attachments ({attachments.length})</label>
        {#each attachments as att}
          <div class="editor-att-item">
            <a href="/api/attachments?id={att.id}" target="_blank" class="editor-att-name">{att.filename}</a>
            <span class="editor-att-size">{formatFileSize(att.size_bytes)}</span>
            <span class="editor-att-type">{att.mime_type}</span>
          </div>
          {#if att.mime_type?.startsWith('image/')}
            <img src="/api/attachments?id={att.id}" alt="" style="max-width:100%;border-radius:8px;margin:8px 0" loading="lazy" />
          {/if}
        {/each}
      </div>
    {/if}

    <!-- Timestamps -->
    <div style="margin-top:20px;font-size:11px;color:var(--text-3)">
      Created: {fmtTime(comm.created_at)} · Updated: {fmtTime(comm.updated_at)}
    </div>
  </div>
{/if}
