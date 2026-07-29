<!--
  CrtTopbar — single-line ASCII bracket header.

  Renders `┌─[ {path} ]── {counts}` left-justified, with a slot on the
  right for user/identity/actions. Lives at the top of a CrtShell, above
  the column grid.

  Counts: pass an array of { label, value } pairs and they render as
  `· 4 threads · 12 items · 3 files` after the bracket.
-->
<script lang="ts">
  /** Path text rendered inside the brackets (e.g. "mtw://social/home"). */
  export let path = '';
  /** Optional summary chips after the bracket. */
  export let counts: Array<{ label: string; value: number | string }> = [];
</script>

<header class="crt-topbar">
  <div class="ascii">
    <span class="hl">┌─[</span>
    <span class="path">{path}</span>
    <span class="hl">]──</span>
    {#each counts as c}
      <span class="dim">· {c.value} {c.label}</span>
    {/each}
  </div>
  <div class="right">
    <slot name="right" />
  </div>
</header>

<style>
  .crt-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 12px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 60%, transparent), transparent);
    gap: 14px;
    flex-shrink: 0;
    font-family: var(--font-display);
    font-size: 14px;
    line-height: 1;
  }
  .ascii {
    color: var(--text-1);
    letter-spacing: 0.04em;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hl {
    color: var(--gold);
  }
  .path {
    color: var(--text-1);
  }
  .dim {
    color: var(--text-2);
    font-size: 12px;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
</style>
