<script lang="ts">
  /**
   * The four capability tags the kernel already works out for every model in
   * `model-traits.ts`. They were being computed, sent over the wire, and
   * dropped on the floor — so a picker with 67 rows offered nothing to choose
   * on but the name.
   *
   * Glyphs, not emoji: emoji render differently per platform and can't take a
   * colour from the theme. Each carries a title, and the pair is announced to
   * screen readers as one label rather than four mystery characters.
   */
  export let traits: { vision?: boolean; reasoning?: boolean; fast?: boolean; longContext?: boolean; tools?: boolean } | undefined = undefined;
  /** The run behind this picker is a tool loop: flag models nobody has seen call a tool. */
  export let needsTools = false;

  const ALL = [
    { key: 'vision', glyph: '◎', label: 'accepts images' },
    { key: 'reasoning', glyph: '❯', label: 'reasoning mode' },
    { key: 'fast', glyph: '⚡', label: 'fast tier' },
    { key: 'longContext', glyph: '≣', label: 'long context' },
  ] as const;

  $: unverified = needsTools && traits?.tools === undefined;
  $: shown = [
    ...ALL.filter((t) => traits?.[t.key]),
    ...(unverified ? [{ key: 'tools', glyph: '?', label: 'tool use not verified yet' }] : []),
  ];
</script>

{#if shown.length}
  <span class="tb" aria-label={shown.map((t) => t.label).join(', ')}>
    {#each shown as t (t.key)}
      <span class="tb-i" title={t.label} aria-hidden="true">{t.glyph}</span>
    {/each}
  </span>
{/if}

<style>
  .tb { display: inline-flex; gap: 3px; flex-shrink: 0; }
  .tb-i {
    font-size: 9px;
    line-height: 1;
    padding: 2px 3px;
    border-radius: 3px;
    color: color-mix(in srgb, var(--row-c, var(--gold, #D4A84B)) 80%, var(--text-3));
    background: color-mix(in srgb, var(--row-c, var(--gold, #D4A84B)) 12%, transparent);
    cursor: help;
  }
</style>
