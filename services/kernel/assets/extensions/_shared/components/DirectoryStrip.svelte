<script lang="ts" context="module">
  /** One number in the strip. `key` is what `pick` reports; `on` marks the active filter. */
  export interface StripKpi {
    key: string;
    n: string | number;
    label: string;
    /** CSS colour for the tile (hex or var()). */
    color: string;
    /** A glowing dot after the number: something is happening now. */
    live?: boolean;
    on?: boolean;
    title?: string;
  }
</script>

<script lang="ts">
  /*
    The header the Oficinas directory uses, for a page that lays out its own
    body: an eyebrow and a gradient title on the left, coloured KPI tiles that
    double as filters or links in the middle, and an optional action on the
    right (slot "aside"). Slot "tools" sits under it: search, counts, a clear
    button. It is the strip of page/PageShell.svelte with the KPIs given as
    data; both draw the global `ol-*` classes (office-look.css).
  */
  import { createEventDispatcher } from 'svelte';
  import StatTile from './page/StatTile.svelte';
  export let eyebrow = '';
  export let title: string;
  export let sub = '';
  export let kpis: StripKpi[] = [];
  /** A KPI is a button only when the page listens for picks. */
  export let interactive = true;
  const dispatch = createEventDispatcher<{ pick: { key: string } }>();
</script>

<header class="ol-strip ds-strip" class:no-cta={!$$slots.aside}>
  <div class="ol-ttl">
    {#if eyebrow}<p class="ol-eyebrow">{eyebrow}</p>{/if}
    <h1 class="ol-title">{title}</h1>
    {#if sub}<p class="ol-sub">{sub}</p>{/if}
  </div>
  {#if kpis.length}
    <div class="ol-kpis ds-kpis" style="--ds-n: {kpis.length}">
      {#each kpis as k (k.key)}
        <StatTile clickable={interactive} on={k.on ?? false} live={k.live ?? false} color={k.color} value={k.n} label={k.label}
          title={k.title ?? ''} on:click={() => dispatch('pick', { key: k.key })} />
      {/each}
    </div>
  {:else}<span></span>{/if}
  {#if $$slots.aside}<div class="ds-aside"><slot name="aside" /></div>{/if}
</header>
{#if $$slots.tools}<div class="ol-tools ds-tools"><slot name="tools" /></div>{/if}

<style>
  .ds-strip { flex: none; }
  .ds-strip :global(.ol-title) { white-space: nowrap; }
  .ds-kpis { grid-template-columns: repeat(var(--ds-n), minmax(0, 1fr)); }
  .ds-aside { display: flex; gap: 8px; align-items: center; }
  .ds-tools { flex: none; flex-wrap: wrap; gap: 14px; }

  @media (max-height: 820px) {
    .ds-kpis :global(.ol-kpi) { padding: 5px 10px; }
    .ds-kpis :global(.ol-kpi b) { font-size: 18px; }
    .ds-strip :global(.ol-title) { font-size: 19px; }
  }
  @media (max-width: 700px) { .ds-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
