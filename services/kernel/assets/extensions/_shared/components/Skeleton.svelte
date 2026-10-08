<!-- services/kernel/assets/extensions/_shared/components/Skeleton.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  export let variant: 'rows' | 'cards' | 'text' = 'rows';
  export let rows = 5;
  /** Wait before showing, so fast loads don't flash. */
  export let delay = 300;
  let visible = delay === 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onMount(() => { if (!visible) timer = setTimeout(() => (visible = true), delay); });
  onDestroy(() => clearTimeout(timer));
</script>

{#if visible}
  <div class="sk sk-{variant}" aria-busy="true" aria-live="polite">
    {#each Array(rows) as _, i}
      <div class="sk-item" style="--w:{variant === 'text' ? 60 + ((i * 37) % 40) : 100}%"></div>
    {/each}
  </div>
{/if}

<style>
  .sk { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
  .sk-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .sk-item { height: 44px; width: var(--w); border-radius: 8px; background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%); background-size: 200% 100%; animation: sk 1.4s ease-in-out infinite; }
  .sk-cards .sk-item { height: 110px; }
  .sk-text .sk-item { height: 12px; }
  @keyframes sk { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .sk-item { animation: none; } }
</style>
