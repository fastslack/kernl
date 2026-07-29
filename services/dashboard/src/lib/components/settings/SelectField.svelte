<script lang="ts">
  /** Compact select. Keeps the current value visible even if it's not in the options list. */
  export let value = '';
  export let options: Array<{ value: string; label: string }> = [];
  export let disabled = false;
  export let id = '';
</script>

<select {id} bind:value {disabled} on:change>
  {#if value && !options.some((o) => o.value === value)}
    <option value={value}>{value}</option>
  {/if}
  {#each options as o (o.value)}
    <option value={o.value}>{o.label}</option>
  {/each}
</select>

<style>
  select {
    width: 100%; padding: 6px 10px; border-radius: 6px; font-size: 12px;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-body); outline: none; box-sizing: border-box; cursor: pointer;
  }
  select:focus { border-color: var(--teal); }
  select:disabled { opacity: 0.5; cursor: default; }
</style>
