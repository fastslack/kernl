<script lang="ts">
  /** Página /automations legacy — es el card-tab "Automation" de /system. */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(() => {
    goto('/system?tab=automation', { replaceState: true });
  });
</script>

<div class="redir">
  <p>Esta vista ahora es una pestaña dentro de Sistema.</p>
  <a href="/system?tab=automation">Ir a Automatización</a>
</div>

<style>
  .redir {
    padding: 48px 24px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
    color: var(--text-2); font-size: 13px;
  }
  .redir a { color: var(--teal); font-weight: 600; text-decoration: none; }
  .redir a:hover { text-decoration: underline; }
</style>
