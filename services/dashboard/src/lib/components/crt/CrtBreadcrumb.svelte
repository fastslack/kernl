<!--
  CrtBreadcrumb — `> cd /path // label` style header strip.

  Sits above a feed/content area inside a CrtPanel body. Slot on the
  right for badges (thread counts, status pills, etc.).
-->
<script lang="ts">
  /** The verb after the prompt — "cd", "ls", "open", etc. */
  export let prompt = 'cd';
  /** The path/identifier rendered after the prompt. */
  export let path = '';
  /** Optional descriptive label after the `//` separator. */
  export let label = '';
</script>

<div class="crt-breadcrumb">
  <span class="cmd">&gt;</span>
  <span class="dim">{prompt}</span>
  <span class="path">{path}</span>
  {#if label}
    <span class="dim">// {label}</span>
  {/if}
  <span class="spacer" />
  <slot name="right" />
</div>

<style>
  .crt-breadcrumb {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    margin-bottom: 8px;
    font-size: 12px;
    font-family: var(--font-mono);
  }
  .cmd { color: var(--gold); font-weight: 700; }
  .dim { color: var(--text-2); }
  .path { color: var(--text-1); }
  .spacer { flex: 1; }
</style>
