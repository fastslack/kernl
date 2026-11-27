<!--
  A card of the page body (the office look's `ol-card` with its `ol-h`
  heading): the accent bar and title, an optional count on the right, and a
  body that scrolls inside the card. `color` tints the card's glow.

  Slots: `head` (extra controls in the heading row, before the count),
  `top` (fixed content under the heading — filters, chips), default (the
  scrolling body). `scroll={false}` lets the body size itself instead.
-->
<script lang="ts">
  export let title: string = '';
  export let count: string | number = '';
  export let color: string = '';
  export let scroll = true;
  export let cls: string = '';
  export let style: string = '';
</script>

<section class="ol-card ks-card {cls}" style="{color ? `--oc: ${color};` : ''}{style}">
  {#if title || $$slots.head || count !== ''}
    <div class="ks-ch">
      {#if title}<h2 class="ol-h">{title}</h2>{/if}
      <slot name="head" />
      {#if count !== ''}<em>{count}</em>{/if}
    </div>
  {/if}
  <slot name="top" />
  <div class="ks-cb" class:scroll><slot /></div>
</section>

<style>
  .ks-card { min-height: 0; gap: 7px; padding: 11px 13px; overflow: hidden; box-sizing: border-box; }
  .ks-ch { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; flex: none; min-width: 0; }
  .ks-ch h2 { flex: none; white-space: nowrap; }
  .ks-ch em { margin-left: auto; font-style: normal; font-size: 12px; font-weight: 800; color: var(--text-1); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ks-cb { min-height: 0; display: flex; flex-direction: column; gap: 3px; }
  .ks-cb.scroll { flex: 1; overflow: auto; scrollbar-width: thin; }
  @media (max-width: 1100px) { .ks-card { max-height: 75vh; } }
</style>
