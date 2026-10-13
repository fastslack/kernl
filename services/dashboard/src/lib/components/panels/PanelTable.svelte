<!-- src/lib/components/panels/PanelTable.svelte -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { locale } from '$lib/i18n/index.js';
  import { textOf } from '$lib/panels/template.js';
  import type { PanelView } from '$lib/panels/types.js';
  export let view: PanelView;
  export let rows: Array<Record<string, unknown>> = [];
  const dispatch = createEventDispatcher<{ open: string }>();
  let q = '';
  $: fields = view.fields ?? Object.keys(rows[0] ?? {}).filter((k) => !k.startsWith('_')).slice(0, 6).map((key) => ({ key, label: key }));
  $: shown = q ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q.toLowerCase())) : rows;
  const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
</script>

<input class="pt-q" placeholder={$locale.startsWith('en') ? 'Search…' : 'Buscar…'} bind:value={q} aria-label="search" />
<div class="pt-wrap">
  <table class="pt">
    <thead><tr>{#each fields as f (f.key)}<th>{textOf(f.label, $locale) || f.key}</th>{/each}</tr></thead>
    <tbody>
      {#each shown as r, i (String(r.key ?? i))}
        <tr tabindex="0" on:click={() => view.detail && dispatch('open', String(r.key ?? ''))} on:keydown={(e) => e.key === 'Enter' && view.detail && dispatch('open', String(r.key ?? ''))}>
          {#each fields as f (f.key)}<td title={cell(r[f.key])}>{cell(r[f.key])}</td>{/each}
        </tr>
      {:else}
        <tr><td colspan={fields.length || 1} class="pt-empty">{$locale.startsWith('en') ? 'Nothing here yet.' : 'Todavía no hay nada.'}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .pt-q { width: 100%; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-1); color: var(--text-1); font: 500 12px 'Manrope', sans-serif; }
  .pt-wrap { max-height: 60vh; overflow: auto; }
  .pt { width: 100%; border-collapse: collapse; font: 500 11.5px 'Manrope', sans-serif; }
  .pt th { position: sticky; top: 0; background: var(--surface-2); text-align: left; padding: 6px 8px; color: var(--text-3); font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  .pt td { padding: 7px 8px; border-top: 1px solid var(--border); color: var(--text-1); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pt tbody tr { cursor: pointer; }
  .pt tbody tr:hover, .pt tbody tr:focus-visible { background: var(--surface-2); outline: none; }
  .pt-empty { color: var(--text-3); text-align: center; }
</style>
