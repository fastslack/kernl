<!--
  CrtBootLines — typing-in animation for a list of strings.

  Renders each line with a stagger so it reads like a boot sequence.
  Use after a CrtTopbar to fill the page during initial load.
-->
<script lang="ts">
  /** Lines to display, in order. */
  export let lines: string[] = [];
  /** Per-line delay in milliseconds. */
  export let stagger = 90;
</script>

<div class="crt-boot">
  {#each lines as line, i}
    <div class="line" style="animation-delay: {i * stagger}ms">{line}</div>
  {/each}
</div>

<style>
  .crt-boot {
    font-size: 11px;
    color: var(--text-2);
    font-family: var(--font-mono);
    padding: 6px 12px;
  }
  .line {
    animation: crt-type-in 0.18s ease-out both;
  }
</style>
