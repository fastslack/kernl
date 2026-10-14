<script lang="ts">
  /**
   * Step one of connecting: pick a provider. Two balanced columns of compact
   * rows — what costs nothing or runs here on the left, pay-as-you-go on the
   * right — so all of them fit on one screen and line up.
   */
  import { createEventDispatcher } from 'svelte';
  import { t, locale } from '$lib/i18n/index.js';
  import { groupProviders, pick, type CatalogProvider } from '$lib/llm-connect.js';

  export let providers: CatalogProvider[] = [];

  const dispatch = createEventDispatcher<{ select: string }>();
  $: groups = groupProviders(providers);
  // Paid is the longest group: it gets a column of its own and the rest stack
  // in the other one, which keeps both columns about the same height.
  $: columns = [groups.filter((g) => g.group !== 'paid'), groups.filter((g) => g.group === 'paid')]
    .filter((c) => c.length > 0);
</script>

<div class="pg">
  {#each columns as col, ci (ci)}
    <div class="pg-col">
      {#each col as g (g.group)}
        <section class="pg-group" aria-labelledby="pg-{g.group}">
          <h3 id="pg-{g.group}" class="pg-title">
            {$t(`llm.group.${g.group}`)}
            <span class="pg-count">{g.providers.length}</span>
          </h3>
          <ul class="pg-list">
            {#each g.providers as p (p.slug)}
              <li>
                <button
                  type="button"
                  class="pg-row"
                  class:rec={p.recommended}
                  class:on={p.connected}
                  on:click={() => dispatch('select', p.slug)}
                >
                  <img class="pg-logo" src={p.logo} alt="" width="32" height="32" loading="lazy" />
                  <span class="pg-text">
                    <span class="pg-name">{p.name}</span>
                    <span class="pg-tag">{pick(p.tag, $locale)}</span>
                  </span>
                  {#if p.connected}
                    <span class="pg-badge on">
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                      {$t('llm.connected')}
                    </span>
                  {:else if p.recommended}
                    <span class="pg-badge rec">★ {$t('llm.recommended')}</span>
                  {/if}
                  <svg class="pg-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {/each}
</div>

<style>
  .pg { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
  .pg-col { display: grid; gap: 12px; min-width: 0; }
  .pg-title {
    display: flex; align-items: center; gap: 6px;
    margin: 0 0 5px 2px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text-2);
  }
  .pg-count {
    min-width: 18px; padding: 1px 6px; border-radius: 999px;
    background: var(--surface-3); color: var(--text-2);
    font-size: 10px; letter-spacing: 0; text-align: center; font-variant-numeric: tabular-nums;
  }
  .pg-list {
    margin: 0; padding: 0; list-style: none;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--surface-2);
    overflow: hidden;
  }
  .pg-list li + li { border-top: 1px solid var(--border); }
  .pg-row {
    display: grid; grid-template-columns: 32px minmax(0, 1fr) auto 14px; align-items: center; column-gap: 12px;
    width: 100%; min-height: 44px; padding: 6px 12px;
    border: 0; background: transparent; color: var(--text-1);
    text-align: left; cursor: pointer;
    transition: background 150ms ease-out;
  }
  .pg-row:hover { background: var(--surface-3); }
  .pg-row:focus-visible { outline: 2px solid var(--teal); outline-offset: -2px; }
  /* A hairline ring keeps dark tiles (Ollama, Kimi, Z.ai) from melting into the panel. */
  .pg-logo { display: block; width: 32px; height: 32px; border-radius: 8px; box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-1) 12%, transparent); }
  .pg-text { display: grid; gap: 1px; min-width: 0; }
  .pg-name, .pg-tag { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .pg-name { font-size: 14px; font-weight: 600; line-height: 1.3; }
  .pg-tag { font-size: 12px; line-height: 1.3; color: var(--text-2); }
  .pg-badge {
    grid-column: 3;
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 600; white-space: nowrap;
  }
  .pg-badge.on { color: var(--green); background: color-mix(in srgb, var(--green) 14%, transparent); }
  .pg-badge.rec { color: var(--gold); background: color-mix(in srgb, var(--gold) 14%, transparent); }
  .pg-chev { grid-column: 4; color: var(--text-3, var(--text-2)); transition: transform 150ms ease-out, color 150ms ease-out; }
  .pg-row:hover .pg-chev { color: var(--text-1); transform: translateX(2px); }
  @media (max-width: 760px) {
    .pg { grid-template-columns: minmax(0, 1fr); }
  }
  @media (prefers-reduced-motion: reduce) {
    .pg-row, .pg-chev { transition: none; }
  }
</style>
