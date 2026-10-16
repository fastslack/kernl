<!-- src/lib/components/panels/PanelBoard.svelte -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { locale } from '$lib/i18n/index.js';
  import { renderText, textOf } from '$lib/panels/template.js';
  import { groupBy } from '$lib/panels/rows.js';
  import type { PanelView } from '$lib/panels/types.js';
  import { tone, isLive, humanize } from '$lib/panels/look.js';
  export let view: PanelView;
  export let rows: Array<Record<string, unknown>> = [];
  /** Real total per column when the source sends only some cards; absent → the cards are all there is. */
  export let counts: Record<string, number> | null = null;
  const totalOf = (column: string, shown: number) => {
    const n = counts?.[column];
    return typeof n === 'number' && n > shown ? n : shown;
  };
  const dispatch = createEventDispatcher<{ open: string }>();
  $: columns = groupBy(rows, view.columns ?? 'state', view.order ?? []);
  const safeHref = (h: string) => (/^https?:\/\//i.test(h) ? h : null);
  /** A badge says what it counts or when, never a raw ISO stamp; a date already past reads late. */
  function badge(key: string, v: unknown): { text: string; late: boolean } {
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return { text: d.toLocaleDateString($locale.startsWith('en') ? 'en' : 'es', { day: '2-digit', month: '2-digit' }), late: d.getTime() < Date.now() };
    }
    if (/^\d+$/.test(s)) return { text: `${s} ${humanize(key).toLowerCase()}`, late: false };
    return { text: s, late: false };
  }
</script>

<div class="pb">
  {#each columns as col (col.column)}
    <section class="pb-col" class:pb-col--empty={col.rows.length === 0} aria-label={col.column} style="--tone:{tone(col.column)}">
      <header>
        <span class="pb-dot" class:pb-dot--live={isLive(col.column) && col.rows.length > 0} aria-hidden="true"></span>
        <span class="pb-name">{col.column}</span>
        <span class="pb-count">{totalOf(col.column, col.rows.length)}</span>
      </header>
      {#if col.rows.length === 0}<div class="pb-empty" aria-hidden="true"></div>{/if}
      {#each col.rows as r, i (i)}
        <div class="pb-card" role="button" tabindex="0" on:click={() => view.detail && dispatch('open', String(r.key ?? ''))}
                 on:keydown={(e) => e.key === 'Enter' && view.detail && dispatch('open', String(r.key ?? ''))}>
          <div class="pb-t">{renderText(view.card?.title ?? '{{key}}', r)}</div>
          {#if view.card?.subtitle}<div class="pb-s">{renderText(view.card.subtitle, r)}</div>{/if}
          {#if view.card?.badges?.length}
            <div class="pb-b">{#each view.card.badges as b, bi (bi)}{#if r[b]}{@const bd = badge(b, r[b])}<span class:pb-late={bd.late} title={humanize(b)}>{bd.text}</span>{/if}{/each}</div>
          {/if}
          {#if view.card?.links?.length}
            <div class="pb-l">{#each view.card.links as l, li (li)}{@const href = safeHref(renderText(l.href, r))}{#if href}<a {href} target="_blank" rel="noopener noreferrer" on:click|stopPropagation>{textOf(l.label, $locale)}</a>{/if}{/each}</div>
          {/if}
        </div>
      {/each}
      {#if totalOf(col.column, col.rows.length) > col.rows.length}
        <div class="pb-more">+{totalOf(col.column, col.rows.length) - col.rows.length} {$locale.startsWith('en') ? 'more' : 'más'}</div>
      {/if}
    </section>
  {/each}
</div>

<style>
  .pb { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(200px, 1fr); gap: 10px; overflow-x: auto; max-height: 62vh; padding: 2px 2px 6px; }
  .pb-col {
    display: flex; flex-direction: column; gap: 7px; min-width: 0; padding: 9px; border-radius: 12px;
    background: linear-gradient(170deg, color-mix(in srgb, var(--tone) 16%, var(--surface-1)), var(--surface-1) 55%);
    border: 1px solid color-mix(in srgb, var(--tone) 34%, var(--border));
  }
  .pb-col--empty { background: linear-gradient(170deg, color-mix(in srgb, var(--tone) 8%, var(--surface-1)), var(--surface-1) 40%); border-color: color-mix(in srgb, var(--tone) 18%, var(--border)); }
  .pb-col header { display: flex; align-items: center; gap: 7px; padding: 0 2px 2px; font: 800 10.5px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--tone); }
  .pb-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pb-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--tone); box-shadow: 0 0 8px var(--tone); }
  .pb-dot--live { animation: pb-pulse 1.4s ease-in-out infinite; }
  .pb-count {
    font: 800 10px 'Manrope', sans-serif; padding: 1px 8px; border-radius: 999px;
    color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 18%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent);
  }
  .pb-more { padding: 6px 4px; font-size: 11px; color: var(--text-3); text-align: center; }
  .pb-empty { flex: 1; min-height: 64px; border: 1px dashed color-mix(in srgb, var(--tone) 35%, transparent); border-radius: 10px; }
  .pb-card {
    padding: 9px 11px; border-radius: 10px; cursor: pointer; display: flex; flex-direction: column; gap: 6px;
    background: linear-gradient(160deg, color-mix(in srgb, var(--tone) 12%, var(--surface-2)), var(--surface-1) 75%);
    border: 1px solid color-mix(in srgb, var(--tone) 30%, var(--border));
    transition: transform .2s ease-out, box-shadow .2s, border-color .2s;
  }
  .pb-card:hover, .pb-card:focus-visible {
    outline: none; transform: translateY(-2px);
    border-color: color-mix(in srgb, var(--tone) 65%, var(--border));
    box-shadow: 0 12px 24px -14px var(--tone);
  }
  .pb-t { font: 700 12px/1.4 'Manrope', sans-serif; color: var(--text-1); overflow-wrap: anywhere; }
  .pb-s { font: 600 11px 'Manrope', sans-serif; color: color-mix(in srgb, var(--tone) 55%, var(--text-2)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pb-b span.pb-late { color: #fecdd3; background: color-mix(in srgb, #F43F5E 22%, transparent); border-color: color-mix(in srgb, #F43F5E 55%, transparent); }
  .pb-b, .pb-l { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
  .pb-b span {
    font: 800 9.5px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .04em; padding: 1px 7px; border-radius: 999px;
    color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 18%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent);
  }
  .pb-l a {
    font: 700 10.5px 'Manrope', sans-serif; color: #22D3EE; text-decoration: none;
    padding: 1px 9px; border-radius: 999px; background: color-mix(in srgb, #22D3EE 10%, transparent); border: 1px solid color-mix(in srgb, #22D3EE 40%, transparent);
  }
  .pb-l a:hover { background: color-mix(in srgb, #22D3EE 22%, transparent); }
  @keyframes pb-pulse {
    0%, 100% { box-shadow: 0 0 6px var(--tone); transform: scale(1); }
    50% { box-shadow: 0 0 14px var(--tone), 0 0 0 4px color-mix(in srgb, var(--tone) 22%, transparent); transform: scale(1.15); }
  }
  @media (prefers-reduced-motion: reduce) {
    .pb-dot--live { animation: none; }
    .pb-card { transition: none; }
    .pb-card:hover, .pb-card:focus-visible { transform: none; }
  }
</style>
