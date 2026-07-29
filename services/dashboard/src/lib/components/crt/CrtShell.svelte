<!--
  CrtShell — full-bleed page wrapper.

  Use when a page wants the social-style edge-to-edge layout: one flex
  column, no outer padding, internal scrolling. Pair with CrtTopbar +
  CrtPanel children. The layout puts the route under .main-content which
  in full-bleed mode flexes to fill the slot, so the shell just needs to
  consume that vertical space cleanly.

  Slot: default = page content (usually a CrtTopbar + a flex grid of
  CrtPanels).
-->
<script lang="ts">
  /** Optional CSS grid template for direct children (passes through
   *  inline). Common: "220px 1fr 380px" for a three-column layout. */
  export let columns: string | undefined = undefined;
  /** Optional gap between columns (uses border-color so the grid lines
   *  read as separators). */
  export let gap = '1px';
</script>

<div class="crt-shell">
  {#if columns}
    <div class="crt-shell-grid" style="grid-template-columns: {columns}; gap: {gap}">
      <slot />
    </div>
  {:else}
    <slot />
  {/if}
</div>

<style>
  .crt-shell {
    /* Fill whatever slot the layout gives us (full-bleed mode = .main-inner
       is flex with min-height: 0). */
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    height: 100%;
    background: var(--bg);
    color: var(--text-1);
    overflow: hidden;
    position: relative;
  }

  .crt-shell-grid {
    display: grid;
    background: var(--border);
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* Each direct grid child gets the bg back so the gap reads as a 1px
     separator line. */
  :global(.crt-shell-grid > *) {
    background: var(--bg);
    min-height: 0;
    overflow: auto;
  }
</style>
