<!-- src/lib/components/panels/PanelBoard.svelte -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { locale } from '$lib/i18n/index.js';
  import { renderText, textOf } from '$lib/panels/template.js';
  import { groupBy } from '$lib/panels/rows.js';
  import type { PanelView } from '$lib/panels/types.js';
  export let view: PanelView;
  export let rows: Array<Record<string, unknown>> = [];
  const dispatch = createEventDispatcher<{ open: string }>();
  $: columns = groupBy(rows, view.columns ?? 'state', view.order ?? []);
  const safeHref = (h: string) => (/^https?:\/\//i.test(h) ? h : null);
</script>

<div class="pb">
  {#each columns as col (col.column)}
    <section class="pb-col" aria-label={col.column}>
      <header>{col.column} <span>{col.rows.length}</span></header>
      {#each col.rows as r, i (i)}
        <div class="pb-card" role="button" tabindex="0" on:click={() => view.detail && dispatch('open', String(r.key ?? ''))}
                 on:keydown={(e) => e.key === 'Enter' && view.detail && dispatch('open', String(r.key ?? ''))}>
          <div class="pb-t">{renderText(view.card?.title ?? '{{key}}', r)}</div>
          {#if view.card?.subtitle}<div class="pb-s">{renderText(view.card.subtitle, r)}</div>{/if}
          {#if view.card?.badges?.length}
            <div class="pb-b">{#each view.card.badges as b, bi (bi)}{#if r[b]}<span>{String(r[b])}</span>{/if}{/each}</div>
          {/if}
          {#if view.card?.links?.length}
            <div class="pb-l">{#each view.card.links as l, li (li)}{@const href = safeHref(renderText(l.href, r))}{#if href}<a {href} target="_blank" rel="noopener noreferrer" on:click|stopPropagation>{textOf(l.label, $locale)}</a>{/if}{/each}</div>
          {/if}
        </div>
      {/each}
    </section>
  {/each}
</div>

<style>
  .pb { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(170px, 1fr); gap: 8px; overflow-x: auto; max-height: 62vh; }
  .pb-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .pb-col header { font: 700 10px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .05em; color: var(--text-3); display: flex; justify-content: space-between; padding: 0 2px; }
  .pb-card { padding: 7px 9px; border-radius: 7px; background: var(--surface-1); border: 1px solid var(--border); cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
  .pb-card:hover, .pb-card:focus-visible { border-color: var(--border-h); outline: none; }
  .pb-t { font: 600 11.5px 'Manrope', sans-serif; color: var(--text-1); overflow-wrap: anywhere; }
  .pb-s { font: 500 11px 'Manrope', sans-serif; color: var(--text-2); }
  .pb-b, .pb-l { display: flex; gap: 4px; flex-wrap: wrap; }
  .pb-b span { font: 600 9.5px 'JetBrains Mono', monospace; padding: 1px 6px; border-radius: 999px; background: var(--surface-3); color: var(--text-2); }
  .pb-l a { font: 600 10.5px 'Manrope', sans-serif; color: var(--teal); }
</style>
