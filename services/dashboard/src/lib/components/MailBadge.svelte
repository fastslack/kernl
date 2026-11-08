<script lang="ts">
  /*
    Header button for the mail: how many emails are waiting for an answer
    (the triage's "attention" folder, not the raw unread count, which counts
    every newsletter). Opens /mail straight on that folder when there is
    something in it, on the inbox otherwise. The count spans every account, so
    the page opens on all of them, each message tagged with its mailbox.
    Polls every minute and on focus.
  */
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { apiFetchRaw } from '$lib/api.js';
  import HeaderIcon, { badgeText } from './HeaderIcon.svelte';

  let attention = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    try {
      const r = await apiFetchRaw('/api/emails/counts');
      if (r.ok) attention = ((await r.json()) as { attention?: number }).attention ?? 0;
    } catch { /* no mail module or offline: keep the last count */ }
  }

  onMount(() => {
    void refresh();
    timer = setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
    if (typeof window !== 'undefined') window.removeEventListener('focus', refresh);
  });

  $: label = attention > 0 ? `Correo — ${attention} ${attention === 1 ? 'email pide' : 'emails piden'} respuesta (todas las cuentas)` : 'Correo';
</script>

<button class="header-icon-btn" on:click={() => goto(attention > 0 ? '/mail?folder=attention&account=all' : '/mail?account=all')} title={label} aria-label={label}>
  <HeaderIcon name="mail" />
  {#if attention > 0}
    <span class="header-icon-badge hb-visible hb-gold">{badgeText(attention)}</span>
  {/if}
</button>
