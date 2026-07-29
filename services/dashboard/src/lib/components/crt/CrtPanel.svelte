<!--
  CrtPanel — a column with title + cursor + content + optional footer.

  Stacks vertically inside a CrtShell-grid. The title is in the display
  font with a phosphor glow (inherited from theme) and a blinking cursor.
  Pass content via the default slot; pass a stuck-to-bottom help/legend
  block via slot="foot".
-->
<script lang="ts">
  export let title = '';
  /** Show the blinking cursor next to the title (default true). */
  export let cursor = true;
  /** Optional left/right padding override. */
  export let padding = '8px 10px';
</script>

<aside class="crt-panel" style="padding: {padding}">
  {#if title}
    <div class="head">
      {title}
      {#if cursor}<span class="crt-cursor">█</span>{/if}
    </div>
  {/if}
  <div class="body">
    <slot />
  </div>
  {#if $$slots.foot}
    <div class="foot">
      <slot name="foot" />
    </div>
  {/if}
</aside>

<style>
  .crt-panel {
    background: var(--bg);
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .head {
    font-family: var(--font-display);
    font-size: 18px;
    color: var(--gold);
    border-bottom: 1px dashed var(--border-h);
    padding-bottom: 4px;
    margin-bottom: 6px;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }
  .body {
    flex: 1;
    min-height: 0;
  }
  .foot {
    margin-top: auto;
    padding-top: 6px;
    border-top: 1px dashed var(--border);
    font-size: 10px;
    color: var(--text-2);
    line-height: 1.4;
    flex-shrink: 0;
  }
</style>
