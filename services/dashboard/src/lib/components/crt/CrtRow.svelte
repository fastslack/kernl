<!--
  CrtRow — clickable row used by sidebars, lists, tree views, etc.

  Layout: [glyph] [label] [count]. Active state draws a `>` prefix and
  applies the phosphor highlight. Pass `depth` for tree-style indent;
  optionally a hover-revealed `+` action via the right-action slot.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let active = false;
  export let glyph = '▸';
  export let label = '';
  export let count: number | string | null = null;
  /** Tree depth — adds proportional left padding. */
  export let depth = 0;
  /** Visual variant. `new` is dashed (for "new item" rows). */
  export let variant: 'default' | 'new' = 'default';

  const dispatch = createEventDispatcher<{ click: void }>();
</script>

<button
  type="button"
  class="crt-row"
  class:active
  class:variant-new={variant === 'new'}
  style="padding-left: {6 + depth * 14}px"
  on:click={() => dispatch('click')}
>
  <span class="glyph">{glyph}</span>
  <span class="label">{label}</span>
  {#if count !== null && count !== undefined}
    <span class="count crt-tnum">{count}</span>
  {:else}
    <span class="count" />
  {/if}
  <span class="action">
    <slot name="action" />
  </span>
</button>

<style>
  .crt-row {
    display: grid;
    grid-template-columns: 22px 1fr auto 16px;
    align-items: center;
    gap: 5px;
    width: 100%;
    background: none;
    border: 1px solid transparent;
    color: var(--text-1);
    padding: 2px 6px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    text-align: left;
    border-radius: 2px;
    line-height: 1.3;
    position: relative;
  }
  .crt-row:hover {
    background: var(--surface-2);
    border-color: var(--border-h);
  }
  .crt-row.active {
    background: var(--surface-3);
    border-color: var(--text-2);
    color: var(--text-1);
  }
  .crt-row.active::before {
    content: '>';
    position: absolute;
    left: -10px;
    color: var(--gold);
  }
  .crt-row.variant-new {
    color: var(--text-2);
    border-style: dashed;
    border-color: var(--border);
    margin-top: 4px;
  }
  .crt-row.variant-new:hover {
    color: var(--gold);
    border-color: var(--gold);
  }

  .glyph { color: var(--gold); width: 16px; text-align: center; }
  .label { font-weight: 500; }
  .count { color: var(--text-2); font-size: 11px; min-width: 8px; text-align: right; }
  .action { opacity: 0; }
  .crt-row:hover .action { opacity: 1; }
</style>
