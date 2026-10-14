<script lang="ts">
  /** One whole split into parts on a single bar (2px gaps between segments), named in a legend with values. */
  export let parts: Array<{ label: string; value: number; color: string; display: string }>;
  $: total = parts.reduce((a, p) => a + p.value, 0);
</script>

<div class="sb" role="img" aria-label={parts.map((p) => `${p.label} ${p.display}`).join(', ')}>
  {#each parts.filter((p) => p.value > 0) as p (p.label)}
    <span style="flex:{p.value / Math.max(1, total)};background:{p.color}" title="{p.label}: {p.display}"></span>
  {/each}
</div>
<ul class="lg">
  {#each parts as p (p.label)}
    <li><i style="background:{p.color}"></i><span class="l">{p.label}</span><span class="v">{p.display}</span></li>
  {/each}
</ul>

<style>
  .sb { display: flex; gap: 2px; height: 14px; border-radius: 7px; overflow: hidden; background: color-mix(in srgb, var(--text-3) 14%, transparent); }
  .sb span { display: block; min-width: 3px; }
  .lg { list-style: none; margin: 10px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 14px; }
  .lg li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 7px; align-items: center; font-size: 12px; }
  .lg i { width: 10px; height: 10px; border-radius: 3px; }
  .l { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .v { color: var(--text-1); font-weight: 700; font-variant-numeric: tabular-nums; }
</style>
