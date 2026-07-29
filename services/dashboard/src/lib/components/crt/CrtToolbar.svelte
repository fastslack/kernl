<!--
  CrtToolbar — horizontal strip of glyph buttons, used above compose
  boxes. Pass items via the default slot using regular <button> elements
  or CrtTBButton (which scopes the styling).
-->
<script lang="ts">
  /** Optional aria label for the toolbar region. */
  export let label = 'toolbar';
</script>

<div class="crt-toolbar" role="toolbar" aria-label={label}>
  <slot />
</div>

<style>
  .crt-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 6px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    border-radius: 2px;
  }
  /* Style any direct <button> inside the toolbar so callers can pass
     plain buttons without wrapping every glyph. */
  :global(.crt-toolbar > button) {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-1);
    width: 24px;
    height: 24px;
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    line-height: 1;
    border-radius: 2px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  :global(.crt-toolbar > button:hover) {
    background: var(--surface-2);
    border-color: var(--border-h);
    color: var(--gold);
  }
</style>
