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
    The header the Oficinas directory uses, for any page: an eyebrow and a
    gradient title on the left, coloured KPI tiles that double as filters or
    links in the middle, and an optional action on the right (slot "aside").
    Slot "tools" sits under it: search, counts, a clear button.
  */
  import { createEventDispatcher } from 'svelte';
  export let eyebrow = '';
  export let title: string;
  export let kpis: StripKpi[] = [];
  /** A KPI is a button only when the page listens for picks. */
  export let interactive = true;
  const dispatch = createEventDispatcher<{ pick: { key: string } }>();
</script>

<header class="ds-strip" style="--ds-n: {Math.max(kpis.length, 1)}">
  <div class="ds-ttl">
    {#if eyebrow}<p class="ds-eyebrow">{eyebrow}</p>{/if}
    <h1>{title}</h1>
  </div>
  {#if kpis.length}
    <div class="ds-kpis">
      {#each kpis as k (k.key)}
        {#if interactive}
          <button class="ds-kpi" class:on={k.on} class:live={k.live} style="--c: {k.color}" title={k.title ?? ''}
            aria-pressed={k.on ?? false} on:click={() => dispatch('pick', { key: k.key })}>
            <b>{k.n}</b><small>{k.label}</small>
          </button>
        {:else}
          <div class="ds-kpi" class:live={k.live} style="--c: {k.color}" title={k.title ?? ''}><b>{k.n}</b><small>{k.label}</small></div>
        {/if}
      {/each}
    </div>
  {:else}<span></span>{/if}
  {#if $$slots.aside}<div class="ds-aside"><slot name="aside" /></div>{/if}
</header>
{#if $$slots.tools}<div class="ds-tools"><slot name="tools" /></div>{/if}

<style>
  .ds-strip { flex: none; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px; align-items: center; }
  .ds-eyebrow { margin: 0; color: var(--gold); font: 700 10px/1.4 var(--font-body); letter-spacing: .14em; text-transform: uppercase; }
  h1 { margin: 2px 0 0; font: 700 22px/1.15 var(--font-display); letter-spacing: -.02em; white-space: nowrap;
    background: linear-gradient(90deg, #FBBF24, #F472B6 50%, #A78BFA); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .ds-kpis { display: grid; grid-template-columns: repeat(var(--ds-n), minmax(0, 1fr)); gap: 10px; }
  .ds-kpi { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; padding: 7px 12px; border-radius: 12px; font: inherit; color: inherit; text-align: left;
    background: linear-gradient(160deg, color-mix(in srgb, var(--c) 18%, var(--surface-1)), var(--surface-1) 72%); border: 1px solid color-mix(in srgb, var(--c) 32%, var(--border));
    transition: transform .15s, box-shadow .15s, border-color .15s; }
  button.ds-kpi { cursor: pointer; }
  button.ds-kpi:hover { transform: translateY(-1px); box-shadow: 0 10px 22px -16px var(--c); }
  .ds-kpi.on { border-color: var(--c); box-shadow: 0 0 0 1px var(--c) inset, 0 10px 24px -16px var(--c); }
  .ds-kpi:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .ds-kpi b { font-size: 21px; font-weight: 800; line-height: 1.1; color: color-mix(in srgb, var(--c) 75%, white); font-variant-numeric: tabular-nums; text-shadow: 0 0 14px color-mix(in srgb, var(--c) 45%, transparent); }
  .ds-kpi small { font-size: 10.5px; color: color-mix(in srgb, var(--c) 45%, var(--text-2)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .ds-kpi.live b::after { content: ''; display: inline-block; width: 7px; height: 7px; margin-left: 7px; vertical-align: middle; border-radius: 50%; background: var(--c); box-shadow: 0 0 10px var(--c); animation: ds-blink 1.4s ease-in-out infinite; }
  @keyframes ds-blink { 50% { opacity: .35; } }
  .ds-aside { display: flex; gap: 8px; align-items: center; }
  .ds-tools { flex: none; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }

  @media (max-height: 820px) { .ds-kpi { padding: 5px 10px; } .ds-kpi b { font-size: 18px; } h1 { font-size: 19px; } }
  @media (max-width: 1100px) { .ds-strip { grid-template-columns: 1fr auto; } .ds-kpis { grid-column: 1 / -1; grid-row: 2; } }
  @media (max-width: 700px) { .ds-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (prefers-reduced-motion: reduce) { .ds-kpi { transition: none; } .ds-kpi.live b::after { animation: none; } }
</style>
