<script lang="ts">
  // /comms/compose — migrated from
  // services/dashboard/src/routes/comms/compose/+page.svelte (Fase 2b).
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const goto = (path: string) => ctx.navigate(path);
  const createComm = (payload: Record<string, unknown>) =>
    ctx.rpc('comms.create', payload, () =>
      ctx.fetchJson('/api/dashboard/comms/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));

  let channel = 'email';
  let subject = '';
  let recipientsTo = '';
  let recipientsCc = '';
  let body = '';
  let sending = false;
  let error = '';

  async function doCreate() {
    if (!body.trim()) { error = 'Body is required'; return; }
    sending = true; error = '';
    try {
      await createComm({ channel, subject, body, recipients_to: recipientsTo, recipients_cc: recipientsCc });
      goto('/comms');
    } catch (e: any) {
      error = e.message;
    } finally { sending = false; }
  }
</script>

<ViewHeader title="Compose" sub="New communication" />

<div class="panel anim full-width">
  <button class="editor-back" on:click={() => goto('/comms')}>← Back to Comms</button>

  <div class="compose-row">
    <label>Channel</label>
    <select class="search-input" bind:value={channel}>
      {#each ['email','whatsapp','mattermost','x','instagram','linkedin'] as ch}
        <option value={ch}>{ch}</option>
      {/each}
    </select>
  </div>

  <div class="compose-row">
    <label>To</label>
    <input class="editor-input" bind:value={recipientsTo} placeholder="recipient@example.com" />
  </div>

  <div class="grid-2" style="gap:12px;margin-bottom:14px">
    <div class="compose-row" style="margin-bottom:0">
      <label>CC</label>
      <input class="editor-input" bind:value={recipientsCc} placeholder="cc@example.com" />
    </div>
    <div class="compose-row" style="margin-bottom:0">
      <label>Subject</label>
      <input class="editor-input" bind:value={subject} placeholder="Subject" />
    </div>
  </div>

  <div class="compose-row">
    <label>Body</label>
    <textarea class="editor-textarea" bind:value={body} placeholder="Write your message..."></textarea>
  </div>

  {#if error}<div style="color:var(--red);font-size:12px;margin-bottom:10px">{error}</div>{/if}

  <div class="editor-actions">
    <button class="editor-save-btn" on:click={doCreate} disabled={sending}>
      {sending ? 'Creating...' : 'Save as Draft'}
    </button>
    <button class="compose-btn-cancel" on:click={() => goto('/comms')}>Cancel</button>
  </div>
</div>
