<!--
  Kernl's base page: the office look (dashboard/src/lib/styles/office-look.css)
  as a component, so dashboard routes and extension pages build the same page
  without copying its markup.

  One screen tall: the strip (optional gold eyebrow, gradient title, one-line
  summary; KPI tiles in the middle; actions on the right) and a body that
  fills the rest. Only the lists inside the cards scroll; below 1100px wide
  the page flows and scrolls as a whole.

  Slots: `tiles` (StatTile…), `actions` (Btn…), default (the body).
  `cols` / `rows` set the body grid — e.g. "minmax(0,1.3fr) minmax(0,1fr)"
  for a list + detail page. `flow` is for pages taller than a screen: they
  scroll as a whole instead of inside their cards.

  The styles are the global `ol-*` classes; this file only lays out the body.
  Pages that already write `ol-*` markup by hand look the same.
-->
<script lang="ts">
  export let title: string;
  export let sub: string = '';
  export let eyebrow: string = '';
  export let cols: string = 'minmax(0, 1fr)';
  export let rows: string = 'minmax(0, 1fr)';
  export let flow = false;
  export let cls: string = '';
</script>

<div class="ol-page ks-page {cls}" class:fill={!flow} class:flow>
  <header class="ol-strip" class:no-cta={!$$slots.actions}>
    <div class="ol-ttl">
      {#if eyebrow}<p class="ol-eyebrow">{eyebrow}</p>{/if}
      <h1 class="ol-title">{title}</h1>
      {#if sub}<p class="ol-sub">{sub}</p>{/if}
    </div>
    {#if $$slots.tiles}<div class="ol-kpis ks-tiles"><slot name="tiles" /></div>{:else}<span></span>{/if}
    {#if $$slots.actions}<div class="ks-act"><slot name="actions" /></div>{/if}
  </header>
  <div class="ks-body" style="grid-template-columns: {cols}; grid-template-rows: {rows};">
    <slot />
  </div>
</div>

<style>
  .ks-page { box-sizing: border-box; }
  .ks-page.fill { min-height: 0; }
  /* A page taller than the screen scrolls itself: on a full-bleed view the
     shell around it does not scroll. */
  .ks-page.flow { height: 100%; min-height: 0; overflow-y: auto; }
  .ol-strip { flex: none; }
  .ol-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* As many equal columns as tiles, in one row: a page shows 4 to 7. */
  .ks-tiles { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 8px; }
  .ks-act { display: flex; gap: 6px; align-items: center; }
  .ks-body { flex: 1; min-height: 0; display: grid; gap: 12px; }
  .ks-page.flow .ks-body { flex: none; }

  @media (max-height: 760px) { .ks-tiles :global(.ol-kpi b) { font-size: 17px; } }
  @media (max-width: 1100px) {
    .ks-page.fill { overflow-y: auto; }
    .ks-body { flex: none; }
    .ks-tiles { grid-auto-flow: row; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .ks-body { grid-template-columns: minmax(0, 1fr) !important; grid-template-rows: none !important; }
  }
  @media (max-width: 700px) { .ks-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
