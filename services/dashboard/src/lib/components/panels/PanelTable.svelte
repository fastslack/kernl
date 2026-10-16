<!-- src/lib/components/panels/PanelTable.svelte -->
<script lang="ts">
  /**
   * A list of records, dense and readable: quick filters on top (one chip per
   * state with its count, plus the rows missing an email), a fixed layout that
   * never scrolls sideways, and a second line per cell when the field names a
   * `sub` (the place under the name, "vencido" under the next step).
   */
  import { createEventDispatcher } from 'svelte';
  import { locale } from '$lib/i18n/index.js';
  import { textOf } from '$lib/panels/template.js';
  import { kindOf, hrefOf, tone, humanize, RED, type FieldKind } from '$lib/panels/look.js';
  import type { PanelView } from '$lib/panels/types.js';
  import Icon from '$lib/components/ui/Icon.svelte';
  export let view: PanelView;
  export let rows: Array<Record<string, unknown>> = [];
  const dispatch = createEventDispatcher<{ open: string }>();

  type Filter = { key: string; value: string } | { missing: string } | null;
  let q = '';
  let filter: Filter = null;

  $: en = $locale.startsWith('en');
  $: fields = view.fields ?? Object.keys(rows[0] ?? {}).filter((k) => !k.startsWith('_')).slice(0, 6).map((key) => ({ key, label: humanize(key), sub: undefined as string | undefined }));
  const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  // A column's kind comes from its first filled value, so every cell of it reads the same way.
  $: kinds = Object.fromEntries(fields.map((f) => {
    const sample = rows.find((r) => cell(r[f.key]) !== '');
    return [f.key, sample ? kindOf(f.key, sample[f.key]) : 'text'];
  })) as Record<string, FieldKind>;
  $: statusFields = fields.filter((f) => kinds[f.key] === 'status');
  $: emailField = fields.find((f) => kinds[f.key] === 'email' || /e-?mail/i.test(f.key)) ?? null;

  $: facets = statusFields.map((f) => {
    const counts = new Map<string, number>();
    for (const r of rows) { const v = cell(r[f.key]); if (v) counts.set(v, (counts.get(v) ?? 0) + 1); }
    return { key: f.key, values: [...counts.entries()].sort((a, b) => b[1] - a[1]) };
  }).filter((f) => f.values.length > 0);
  $: noEmail = emailField ? rows.filter((r) => cell(r[emailField!.key]) === '').length : 0;

  const matches = (r: Record<string, unknown>, f: Filter) =>
    !f || ('missing' in f ? cell(r[f.missing]) === '' : cell(r[f.key]) === f.value);
  $: shown = rows.filter((r) => matches(r, filter) && (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())));
  const isOn = (f: Filter, g: Filter) => JSON.stringify(f) === JSON.stringify(g);
  function toggle(g: Filter) { filter = isOn(filter, g) ? null : g; }

  const open = (r: Record<string, unknown>) => view.detail && dispatch('open', String(r.key ?? ''));
  const width = (key: string, i: number) =>
    i === 0 ? '26%' : kinds[key] === 'number' ? '76px' : kinds[key] === 'status' ? '108px' : kinds[key] === 'phone' ? '128px' : 'auto';
</script>

<div class="pt-bar">
  <label class="pt-q">
    <Icon name="search" size={14} />
    <input placeholder={en ? 'Search…' : 'Buscar…'} bind:value={q} aria-label={en ? 'Search' : 'Buscar'} />
  </label>
  <span class="pt-n" title={en ? 'Rows shown' : 'Filas a la vista'}>{shown.length}{#if shown.length !== rows.length}<small>/{rows.length}</small>{/if}</span>
</div>

{#if facets.length || noEmail}
  <div class="pt-facets" role="group" aria-label={en ? 'Quick filters' : 'Filtros rápidos'}>
    {#each facets as fc (fc.key)}
      {#each fc.values as [v, n] (v)}
        {@const g = { key: fc.key, value: v }}
        <button type="button" class="pt-facet" class:on={isOn(filter, g)} aria-pressed={isOn(filter, g)} style="--tone:{tone(v)}" on:click={() => toggle(g)}>
          <i aria-hidden="true"></i>{v}<b>{n}</b>
        </button>
      {/each}
    {/each}
    {#if noEmail && emailField}
      {@const g = { missing: emailField.key }}
      <button type="button" class="pt-facet" class:on={isOn(filter, g)} aria-pressed={isOn(filter, g)} style="--tone:{RED}" on:click={() => toggle(g)}>
        <Icon name="mail" size={12} />{en ? 'No email' : 'Sin email'}<b>{noEmail}</b>
      </button>
    {/if}
    {#if filter}
      <button type="button" class="pt-clear" on:click={() => (filter = null)}><Icon name="x" size={12} />{en ? 'Clear' : 'Limpiar'}</button>
    {/if}
  </div>
{/if}

<div class="pt-wrap">
  <table class="pt" class:pt--open={!!view.detail}>
    <colgroup>{#each fields as f, i (f.key)}<col style="width:{width(f.key, i)}" />{/each}</colgroup>
    <thead><tr>{#each fields as f (f.key)}<th>{textOf(f.label, $locale) || humanize(f.key)}</th>{/each}</tr></thead>
    <tbody>
      {#each shown as r, i (r.key ?? i)}
        <tr tabindex="0" on:click={() => open(r)} on:keydown={(e) => e.key === 'Enter' && open(r)}>
          {#each fields as f, fi (f.key)}
            {@const text = cell(r[f.key])}
            {@const kind = text ? kindOf(f.key, r[f.key]) : kinds[f.key]}
            {@const href = text ? hrefOf(kind, text) : null}
            {@const sub = f.sub ? cell(r[f.sub]) : ''}
            <td title={sub ? `${text}\n${sub}` : text} class:pt-first={fi === 0}>
              <div class="pt-main">
                {#if !text && kind === 'email'}
                  <span class="pt-chip" style="--tone:{RED}">{en ? 'no email' : 'sin email'}</span>
                {:else if !text}
                  <span class="pt-none">—</span>
                {:else if kind === 'status'}
                  <span class="pt-chip" style="--tone:{tone(text)}"><i aria-hidden="true"></i>{text}</span>
                {:else if href}
                  <a class="pt-link" {href} target={kind === 'url' ? '_blank' : undefined} rel="noopener noreferrer" on:click|stopPropagation>{text}</a>
                {:else if kind === 'number'}
                  <span class="pt-num" class:pt-num--zero={Number(text) === 0}>{text}</span>
                {:else}
                  {text}
                {/if}
              </div>
              {#if sub}
                <div class="pt-sub" class:pt-sub--alert={/vencid|overdue|lost|perdid/i.test(sub)}>{sub}</div>
              {/if}
            </td>
          {/each}
        </tr>
      {:else}
        <tr><td colspan={fields.length || 1} class="pt-empty">
          <Icon name="inbox" size={22} />
          <span>{q || filter ? (en ? 'Nothing matches.' : 'Nada coincide.') : (en ? 'Nothing here yet.' : 'Todavía no hay nada.')}</span>
        </td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .pt-bar { display: flex; align-items: center; gap: 10px; }
  .pt-q {
    flex: 1; display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; border-radius: 10px; color: #22D3EE;
    background: linear-gradient(160deg, color-mix(in srgb, #22D3EE 8%, var(--surface-1)), var(--surface-1) 70%);
    border: 1px solid color-mix(in srgb, #22D3EE 26%, var(--border)); transition: border-color .2s, box-shadow .2s;
  }
  .pt-q:focus-within { border-color: #22D3EE; box-shadow: 0 0 0 3px color-mix(in srgb, #22D3EE 18%, transparent); }
  .pt-q input { flex: 1; min-width: 0; border: 0; background: none; outline: none; color: var(--text-1); font: 500 12.5px 'Manrope', sans-serif; }
  .pt-n {
    font: 800 11px 'Manrope', sans-serif; padding: 3px 10px; border-radius: 999px; font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, #A78BFA 70%, white); background: color-mix(in srgb, #A78BFA 18%, transparent); border: 1px solid color-mix(in srgb, #A78BFA 45%, transparent);
  }
  .pt-n small { opacity: .7; font-size: 10px; }

  .pt-facets { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .pt-facet, .pt-clear {
    display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 10px; border-radius: 999px; cursor: pointer;
    font: 700 11.5px 'Manrope', sans-serif; transition: background .2s, border-color .2s, box-shadow .2s, transform .2s ease-out;
  }
  .pt-facet {
    color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 10%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 35%, transparent);
  }
  .pt-facet i { width: 7px; height: 7px; border-radius: 50%; background: var(--tone); }
  .pt-facet b { font-weight: 800; color: var(--text-1); font-variant-numeric: tabular-nums; }
  .pt-facet:hover { transform: translateY(-1px); background: color-mix(in srgb, var(--tone) 18%, transparent); }
  .pt-facet.on { color: #fff; background: color-mix(in srgb, var(--tone) 32%, var(--surface-2)); border-color: var(--tone); box-shadow: 0 8px 18px -10px var(--tone); }
  .pt-facet.on i { box-shadow: 0 0 8px var(--tone); }
  .pt-facet:focus-visible, .pt-clear:focus-visible { outline: 2px solid var(--tone, #22D3EE); outline-offset: 2px; }
  .pt-clear { color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border); }
  .pt-clear:hover { color: var(--text-1); }

  .pt-wrap { margin-top: 8px; max-height: 60vh; overflow-y: auto; overflow-x: hidden; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-1); }
  .pt { width: 100%; table-layout: fixed; border-collapse: collapse; font: 500 12px 'Manrope', sans-serif; }
  .pt th {
    position: sticky; top: 0; z-index: 1; text-align: left; padding: 8px 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: linear-gradient(180deg, color-mix(in srgb, #22D3EE 10%, var(--surface-2)), var(--surface-2));
    color: #22D3EE; font-weight: 800; font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em;
    border-bottom: 1px solid color-mix(in srgb, #22D3EE 25%, var(--border));
  }
  .pt td { padding: 6px 10px; border-top: 1px solid var(--border); color: var(--text-2); vertical-align: middle; overflow: hidden; }
  .pt-main, .pt-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pt-sub { margin-top: 1px; font: 600 10.5px 'Manrope', sans-serif; color: var(--text-3); }
  .pt-sub--alert { color: #fb7185; }
  .pt td.pt-first .pt-main { color: var(--text-1); font-weight: 700; }
  .pt tbody tr { transition: background .15s, box-shadow .15s; }
  .pt--open tbody tr { cursor: pointer; }
  .pt tbody tr:hover, .pt tbody tr:focus-visible {
    background: linear-gradient(90deg, color-mix(in srgb, #22D3EE 10%, transparent), transparent 70%); outline: none;
    box-shadow: inset 3px 0 0 #22D3EE;
  }
  .pt-chip {
    display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 1px 8px; border-radius: 999px;
    font: 800 9.5px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .04em; overflow: hidden; text-overflow: ellipsis;
    color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 18%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent);
  }
  .pt-chip i { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--tone); box-shadow: 0 0 6px var(--tone); }
  .pt-link { color: #22D3EE; text-decoration: none; font-weight: 600; }
  .pt-link:hover { text-decoration: underline; }
  .pt-num { font-weight: 800; color: #FBBF24; font-variant-numeric: tabular-nums; }
  .pt-num--zero { color: var(--text-3); font-weight: 600; }
  .pt-none { color: var(--text-3); opacity: .6; }
  .pt-empty { text-align: center; padding: 28px 10px !important; color: var(--text-3) !important; }
  .pt-empty :global(svg) { display: block; margin: 0 auto 6px; color: #A78BFA; }
  @media (prefers-reduced-motion: reduce) {
    .pt tbody tr, .pt-q, .pt-facet { transition: none; }
    .pt-facet:hover { transform: none; }
  }
</style>
