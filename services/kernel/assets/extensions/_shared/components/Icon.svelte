<script lang="ts">
  /**
   * Inline SVG icon set for extension pages.
   *
   * Replaces the emoji that were doing icon duty across these pages (📁 💬 🎬
   * 🔎 ⧉ ▶ ✦ ⊘ ⚙ ★). Emoji were the wrong tool for three reasons that all
   * showed up on screen: they render from a different font on every platform
   * so a row of them has no shared weight or optical size; they carry their own
   * colour and therefore ignore the design tokens, which is why a "dim" chip
   * still had a full-saturation 📁 in it; and colour emoji sitting next to
   * monochrome dingbats (⧉ ✦ ⊘) in the same row read as two icon sets.
   *
   * These are one family: 24px grid, 1.6 stroke, round caps and joins, drawn
   * in `currentColor` so they inherit whatever the chip or button is doing —
   * including its hover, active and disabled states.
   *
   * Sizes come from the caller in px. Stroke width is scaled against the
   * nominal 16px so a 20px icon does not read heavier than a 14px one.
   */

  /** Icon name. Unknown names render nothing rather than a broken glyph. */
  export let name: string;
  /** Rendered edge length in px. */
  export let size: number = 16;
  /** Stroke width at the nominal 16px size; scaled for other sizes. */
  export let stroke: number = 1.6;
  /**
   * Accessible name. Leave empty for decorative icons sitting beside a text
   * label — the default — so screen readers do not announce the label twice.
   */
  export let label: string = '';

  const paths: Record<string, string> = {
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-4-4',
    star: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z',
    cpu: 'M9 9h6v6H9zM4.5 4.5h15v15h-15zM9 2v2.5M15 2v2.5M9 19.5V22M15 19.5V22M2 9h2.5M2 15h2.5M19.5 9H22M19.5 15H22',
    folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M8 14.5v5',
    x: 'M6 6l12 12M18 6L6 18',
    chevronDown: 'M6 9.5l6 6 6-6',
    chevronRight: 'M9.5 6l6 6-6 6',
    layers: 'M12 3.5l8.5 4.2-8.5 4.3-8.5-4.3zM3.5 12.2l8.5 4.3 8.5-4.3M3.5 16.4l8.5 4.3 8.5-4.3',
    play: 'M8 5.5l10 6.5-10 6.5z',
    captions: 'M3.5 5.5h17v13h-17zM8.5 10.5a2.2 2.2 0 1 0 0 3M15.5 10.5a2.2 2.2 0 1 0 0 3',
    verified: 'M12 2.8l2.3 1.7 2.8-.2.9 2.7 2.3 1.6-1 2.7 1 2.7-2.3 1.6-.9 2.7-2.8-.2L12 21.2l-2.3-1.7-2.8.2-.9-2.7-2.3-1.6 1-2.7-1-2.7 2.3-1.6.9-2.7 2.8.2zM8.8 12l2.2 2.2 4.2-4.4',
    sparkles: 'M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7zM18.5 15l.8 2.1 2.2.8-2.2.8-.8 2.1-.8-2.1-2.2-.8 2.2-.8zM5 14l.6 1.6 1.6.6-1.6.6L5 18.4l-.6-1.6-1.6-.6 1.6-.6z',
    tag: 'M11.6 3.5H20v8.4l-8.7 8.7a1.6 1.6 0 0 1-2.3 0l-6.1-6.1a1.6 1.6 0 0 1 0-2.3zM16.3 7.7h.01',
    eraser: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M5.6 5.6l12.8 12.8',
    check: 'M4.5 12.5l5 5 10-11',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3.2 9.8h17.6M3.2 14.2h17.6M12 3c-2.4 2.5-3.6 5.5-3.6 9s1.2 6.5 3.6 9c2.4-2.5 3.6-5.5 3.6-9S14.4 5.5 12 3',
    clock: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M12 7.2V12l3.4 2',
    film: 'M3.5 4.5h17v15h-17zM8 4.5v15M16 4.5v15M3.5 9.5h4.5M3.5 14.5h4.5M16 9.5h4.5M16 14.5h4.5',
    calendar: 'M4 6.5h16v14H4zM4 10.5h16M8.5 3.5V7M15.5 3.5V7',
    sort: 'M7 20V5M7 5L3.5 8.5M7 5l3.5 3.5M17 4v15M17 19l3.5-3.5M17 19l-3.5-3.5',
    corner: 'M9 5.5l-4.5 4.5L9 14.5M4.5 10h10a4.5 4.5 0 0 1 4.5 4.5v4',
  };

  // Icons whose shapes read as solid areas rather than outlines. Stroking a
  // triangle-shaped play head leaves a hollow arrow that disappears at 14px.
  const filled = new Set(['play', 'star']);

  $: d = paths[name] ?? '';
  $: sw = (stroke * 16) / size;
</script>

{#if d}
  <svg
    class="ext-icon"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={filled.has(name) ? 'currentColor' : 'none'}
    stroke="currentColor"
    stroke-width={sw}
    stroke-linecap="round"
    stroke-linejoin="round"
    role={label ? 'img' : 'presentation'}
    aria-label={label || undefined}
    aria-hidden={label ? undefined : 'true'}
    focusable="false"
  >
    <path {d} />
  </svg>
{/if}

<style>
  .ext-icon {
    display: block;
    flex: 0 0 auto;
    /* Glyph-like vertical rhythm: without this the icon sits on the text
       baseline box and lifts the whole flex row by a pixel or two. */
    vertical-align: middle;
  }
</style>
