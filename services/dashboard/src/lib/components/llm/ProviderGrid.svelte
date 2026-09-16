<script lang="ts">
  /**
   * Step one of connecting: pick a provider. Grouped by what it costs and
   * where it runs, one tile each, so the whole choice fits on one screen.
   */
  import { createEventDispatcher } from 'svelte';
  import { t, locale } from '$lib/i18n/index.js';
  import { groupProviders, pick, type CatalogProvider } from '$lib/llm-connect.js';

  export let providers: CatalogProvider[] = [];

  const dispatch = createEventDispatcher<{ select: string }>();
  $: groups = groupProviders(providers);
</script>

<div class="pg">
  {#each groups as g (g.group)}
    <section class="pg-group" aria-labelledby="pg-{g.group}">
      <h3 id="pg-{g.group}" class="pg-title">{$t(`llm.group.${g.group}`)}</h3>
      <div class="pg-tiles">
        {#each g.providers as p (p.slug)}
          <button
            type="button"
            class="pg-tile"
            class:rec={p.recommended}
            class:on={p.connected}
            on:click={() => dispatch('select', p.slug)}
          >
            <img class="pg-logo" src={p.logo} alt="" width="28" height="28" loading="lazy" />
            <span class="pg-name">
              {p.name}
              {#if p.recommended}<span class="pg-star">★ <span class="sr">{$t('llm.recommended')}</span></span>{/if}
            </span>
            <span class="pg-tag">{p.connected ? $t('llm.connected') : pick(p.tag, $locale)}</span>
          </button>
        {/each}
      </div>
    </section>
  {/each}
</div>

<style>
  .pg { display: grid; gap: 12px; }
  .pg-title {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-2);
  }
  .pg-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 8px; }
  .pg-tile {
    display: grid;
    grid-template-columns: 28px 1fr;
    column-gap: 10px;
    align-items: center;
    min-height: 58px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text-1);
    text-align: left;
    cursor: pointer;
    transition: border-color 150ms ease-out, background 150ms ease-out;
  }
  .pg-tile:hover { border-color: var(--border-h); background: var(--surface-3); }
  .pg-tile:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .pg-tile.rec { border-color: color-mix(in srgb, var(--gold) 55%, var(--border)); }
  .pg-logo { grid-row: span 2; border-radius: 6px; }
  .pg-name { font-size: 14px; font-weight: 600; }
  .pg-star { color: var(--gold); margin-left: 4px; }
  .pg-tag { font-size: 12px; color: var(--text-2); }
  .pg-tile.on .pg-tag { color: var(--green); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  @media (prefers-reduced-motion: reduce) { .pg-tile { transition: none; } }
</style>
