<script lang="ts">
  /*
    Header button for /outbox: how many drafts the agents are waiting on you
    to approve. Polls the count every minute and when the window regains focus.
  */
  import { onMount, onDestroy } from 'svelte';
  import { apiFetchRaw } from '$lib/api.js';

  export let onOpen: () => void;

  let pending = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    try {
      const r = await apiFetchRaw('/api/outbox/count');
      if (r.ok) pending = ((await r.json()) as { pending?: number }).pending ?? 0;
    } catch { /* kernel without the projects module, or offline: keep the last count */ }
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
</script>

<button class="header-icon-btn" on:click={onOpen} title="Aprobaciones{pending > 0 ? ` — ${pending} pendiente${pending === 1 ? '' : 's'}` : ''}" aria-label="Aprobaciones pendientes: {pending}">
  📤
  {#if pending > 0}
    <span class="header-icon-badge hb-visible hb-gold">{pending}</span>
  {/if}
</button>
