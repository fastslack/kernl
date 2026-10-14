<script lang="ts">
  /**
   * Ranked horizontal bars, every one direct-labeled with its name and value
   * (so identity never rests on color alone). Length is the value against the
   * longest bar; each row carries its own color when the rows are entities
   * (models, providers) and one shared color when they are not.
   */
  export let items: Array<{ label: string; value: number; color: string; display: string; sub?: string; title?: string }>;
  export let empty = '—';
  $: max = Math.max(1, ...items.map((i) => i.value));
</script>

{#if !items.length}
  <p class="empty">{empty}</p>
{:else}
  <ul class="hb">
    {#each items as it (it.label)}
      <li title={it.title ?? `${it.label}: ${it.display}`}>
        <div class="row">
          <span class="lb">{it.label}</span>
          <span class="val">{it.display}{#if it.sub}<small> · {it.sub}</small>{/if}</span>
        </div>
        <div class="track"><span style="width:{Math.max(2, (it.value / max) * 100)}%;background:{it.color}"></span></div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .hb { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
  .row { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; }
  .lb { color: var(--text-1); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .val { color: var(--text-1); font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 700; }
  .val small { color: var(--text-3); font-weight: 500; }
  .track { height: 7px; margin-top: 4px; border-radius: 4px; background: color-mix(in srgb, var(--text-3) 14%, transparent); overflow: hidden; }
  .track span { display: block; height: 100%; border-radius: 4px; }
  .empty { margin: 0; font-size: 12px; color: var(--text-3); }
</style>
