<script lang="ts">
  export let entries: { label: string; value: number; color: string }[] = [];

  $: max = Math.max(1, ...entries.map(e => e.value));
</script>

<div class="bars">
  {#each entries as e}
    <div class="bar-r">
      <span class="bar-l" title={e.label}>{e.label}</span>
      <div class="bar-t">
        <div class="bar-f" style="width:{Math.max(1,Math.round(e.value/max*100))}%;background:{e.color}"></div>
      </div>
      <span class="bar-v">{e.value}</span>
    </div>
  {/each}
</div>
