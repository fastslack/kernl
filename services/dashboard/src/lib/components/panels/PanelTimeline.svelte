<!-- src/lib/components/panels/PanelTimeline.svelte -->
<script lang="ts">
  export let items: Array<{ at: string; text: string }> = [];
  $: sorted = [...items].sort((a, b) => (a.at < b.at ? 1 : -1));
  const fmt = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
</script>

<ol class="ptl">
  {#each sorted as it, i (it.at + i)}
    <li><time datetime={it.at}>{fmt(it.at)}</time><span>{it.text}</span></li>
  {:else}
    <li class="ptl-empty">—</li>
  {/each}
</ol>

<style>
  .ptl { list-style: none; margin: 0; padding: 0; max-height: 62vh; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .ptl li { display: grid; grid-template-columns: 130px 1fr; gap: 8px; padding: 5px 4px; border-bottom: 1px solid var(--border); font: 500 11.5px 'Manrope', sans-serif; color: var(--text-1); }
  .ptl time { color: var(--text-3); font: 500 10.5px 'JetBrains Mono', monospace; }
  .ptl-empty { color: var(--text-3); }
</style>
