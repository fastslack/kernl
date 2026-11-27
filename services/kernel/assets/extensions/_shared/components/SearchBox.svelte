<script lang="ts">
  /** The Oficinas search field (the office look's `ol-search`): ⌕, a borderless input, gold when focused. */
  export let value = '';
  export let placeholder = '';
  export let width = '420px';
</script>

<label class="ol-search sb" style="width: min({width}, 100%)">
  <span aria-hidden="true">⌕</span>
  <input type="search" bind:value {placeholder} aria-label={placeholder} on:input on:keydown />
</label>

<style>
  .sb { box-sizing: border-box; }
  @media (max-height: 820px) { .sb { height: 32px; } }
  @media (max-width: 700px) { .sb { width: 100% !important; } }
</style>
