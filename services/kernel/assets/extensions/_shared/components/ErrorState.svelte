<!-- services/kernel/assets/extensions/_shared/components/ErrorState.svelte -->
<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { feedbackLabels, isKernelRestarting, describeError } from '../feedback';
  export let error: unknown;
  export let title = '';
  const dispatch = createEventDispatcher<{ retry: void }>();
  const L = feedbackLabels();
  let open = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = 0;

  $: restarting = isKernelRestarting(error);
  $: d = describeError(error);
  $: if (restarting && !timer) {
    started = Date.now();
    timer = setInterval(() => {
      if (Date.now() - started > 60_000) { clearInterval(timer); timer = undefined; restarting = false; return; }
      dispatch('retry');
    }, 3000);
  }
  $: if (!restarting && timer) { clearInterval(timer); timer = undefined; }
  onDestroy(() => clearInterval(timer));
</script>

<div class="es" role="alert">
  {#if restarting}
    <p class="es-title">{L.restarting}</p>
  {:else}
    <p class="es-title">{title || d.title}</p>
    {#if d.detail && d.detail !== (title || d.title)}
      <button class="es-link" on:click={() => (open = !open)}>{open ? L.hideDetail : L.showDetail}</button>
      {#if open}<pre class="es-detail">{d.detail}</pre>{/if}
    {/if}
    <button class="es-btn" on:click={() => dispatch('retry')}>{L.retry}</button>
  {/if}
</div>

<style>
  .es { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 32px 20px; text-align: center; }
  .es-title { margin: 0; font-size: 14px; color: var(--text-1); }
  .es-link { background: none; border: 0; color: var(--text-3); font-size: 12px; cursor: pointer; text-decoration: underline; }
  .es-detail { max-width: 100%; overflow: auto; font-size: 11.5px; color: var(--text-2); background: var(--surface-2); padding: 8px 10px; border-radius: 6px; text-align: left; }
  .es-btn { background: var(--teal); color: var(--bg); border: 0; border-radius: 6px; padding: 7px 16px; font-weight: 700; cursor: pointer; }
</style>
