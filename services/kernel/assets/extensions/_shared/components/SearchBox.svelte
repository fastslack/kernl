<script lang="ts">
  /** The Oficinas search field: ⌕, a borderless input, gold when focused. */
  export let value = '';
  export let placeholder = '';
  export let width = '420px';
</script>

<label class="sb" style="--sb-w: {width}">
  <span aria-hidden="true">⌕</span>
  <input type="search" bind:value {placeholder} aria-label={placeholder} on:input on:keydown />
</label>

<style>
  .sb { display: flex; align-items: center; gap: 10px; padding: 0 12px; width: min(var(--sb-w), 100%); height: 36px; box-sizing: border-box;
    border: 1px solid var(--border-h, var(--border)); border-radius: 10px; background: var(--surface-1); }
  .sb:focus-within { border-color: var(--gold); }
  span { font-size: 20px; color: var(--text-2); }
  input { width: 100%; min-width: 0; border: 0; background: transparent; color: var(--text-1); font: inherit; font-size: 13px; }
  input::placeholder { color: var(--text-3); }
  input:focus { outline: none; }
  @media (max-height: 820px) { .sb { height: 32px; } }
  @media (max-width: 700px) { .sb { width: 100%; } }
</style>
