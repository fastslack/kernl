<!-- src/lib/components/panels/PanelTable.svelte -->
<script lang="ts">
  /**
   * A list of records, dense and readable: quick filters on top (one chip per
   * state with its count, plus the rows missing an email), a fixed layout that
   * never scrolls sideways, and a second line per cell when the field names a
   * `sub` (the place under the name, "vencido" under the next step).
   *
   * A view that declares `actions` gets those buttons on every row (a record action keyed "up:{{key}}" shows as
   * an arrow), and one that declares `action` lets rows be dragged; the drop runs it with { key, pos }. The new
   * order shows at once and holds until the office's data catches up with it.
   *
   * A row that carries an `agent` (who is working it right now) moves to a "working now" group at the top of the
   * same table, with the agent's name under the row's name; the rest follow under "queued". Same columns, one
   * header, nothing listed twice. Empty `agent` means nobody is on it.
   *
   * The search and the quick filters share one bar, so the rows start right under it: the filters are one list
   * (a state and its count per option), not a row of chips that grows with every state.
   */
  import { createEventDispatcher } from 'svelte';
  import { locale } from '$lib/i18n/index.js';
  import { textOf } from '$lib/panels/template.js';
  import { kindOf, hrefOf, tone, humanize, RED, type FieldKind } from '$lib/panels/look.js';
  import type { PanelAction, PanelView } from '$lib/panels/types.js';
  import { runAction } from '$lib/panels/client.js';
  import { moveKey, moveOf, actionGlyph, targetOf } from '$lib/panels/reorder.js';
  import Icon from '$lib/components/ui/Icon.svelte';
  export let view: PanelView;
  export let rows: Array<Record<string, unknown>> = [];
  export let flowId = '';
  export let actions: Record<string, PanelAction> = {};
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
  // ── moving rows in place ──
  $: rowActions = flowId ? (view.actions ?? []).filter((a) => actions[a]) : [];
  // The row buttons stay folded: one header button opens them on every row, so the list keeps its width.
  let showMoves = false;
  $: dragAction = flowId && view.action && actions[view.action] ? view.action : '';
  /** The order the operator just set, shown until the polled rows arrive in it (or a minute passes). */
  let pending: { keys: string[]; until: number } | null = null;
  let busyKey = '';
  let moveMsg = '';
  $: keysOf = (list: Array<Record<string, unknown>>) => list.map((r) => String(r.key ?? ''));
  $: if (pending && (Date.now() > pending.until || keysOf(rows).join('|') === pending.keys.join('|'))) pending = null;
  $: ordered = pending
    ? [...rows].sort((a, b) => pending!.keys.indexOf(String(a.key ?? '')) - pending!.keys.indexOf(String(b.key ?? '')))
    : rows;
  async function move(actionId: string, values: Record<string, unknown>, keys: string[]) {
    pending = { keys, until: Date.now() + 60_000 };
    busyKey = String(values.key);
    moveMsg = '';
    try { await runAction(flowId, actionId, values); }
    catch (e) { pending = null; moveMsg = e instanceof Error ? e.message : String(e); }
    finally { busyKey = ''; }
  }
  function rowMove(actionId: string, r: Record<string, unknown>) {
    const m = moveOf(actions[actionId].key);
    const keys = keysOf(ordered);
    const key = String(r.key ?? '');
    void move(actionId, { key }, m ? moveKey(keys, key, targetOf(m, keys.indexOf(key), keys.length)) : keys);
  }
  let dragKey = '';
  let overKey = '';
  $: canDrag = !!dragAction && !q && !filter;
  function drop(target: Record<string, unknown>) {
    const key = dragKey, to = String(target.key ?? '');
    dragKey = ''; overKey = '';
    if (!key || key === to) return;
    const keys = keysOf(ordered);
    const pos = keys.indexOf(to);
    void move(dragAction, { key, pos: pos + 1 }, moveKey(keys, key, pos));
  }

  $: shown = ordered.filter((r) => matches(r, filter) && (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())));
  // The filter list's value: '' for everything, else the filter as JSON (one option per state, plus "no email").
  $: filterValue = filter ? JSON.stringify(filter) : '';
  function pick(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    filter = v ? (JSON.parse(v) as Filter) : null;
  }

  // Who works what right now (see the header comment): only when the view does not show `agent` as a column.
  $: showAgent = !fields.some((f) => f.key === 'agent');
  $: busy = showAgent ? shown.filter((r) => cell(r.agent) !== '') : [];
  $: groups = busy.length
    ? [
        { id: 'now', label: en ? 'Working now' : 'Trabajando ahora', rows: busy },
        { id: 'queue', label: en ? 'Queued' : 'En cola', rows: shown.filter((r) => cell(r.agent) === '') },
      ]
    : [{ id: 'all', label: '', rows: shown }];
  $: cols = fields.length + (canDrag ? 1 : 0) + (rowActions.length ? 1 : 0);

  const open = (r: Record<string, unknown>) => view.detail && dispatch('open', String(r.key ?? ''));
  // The wide column is the row's name: the field with a second line (sub), else the first one that is not a number.
  // 28/10: a leading position number (#) took 26% of an office's queue while the issue's name was cut off.
  $: mainKey = (fields.find((f) => f.sub) ?? fields.find((f) => kinds[f.key] !== 'number') ?? fields[0])?.key;
  $: width = (key: string, _i: number) =>
    key === mainKey ? '40%' : kinds[key] === 'number' ? (/^(pos|#|n|nro)$/i.test(key) ? '44px' : '76px')
      : kinds[key] === 'status' ? '124px' : kinds[key] === 'phone' ? '128px' : 'auto';
</script>

<div class="pt-bar">
  <label class="pt-q">
    <Icon name="search" size={13} />
    <input placeholder={en ? 'Search…' : 'Buscar…'} bind:value={q} aria-label={en ? 'Search' : 'Buscar'} />
    <span class="pt-n" title={en ? 'Rows shown' : 'Filas a la vista'}>{shown.length}{#if shown.length !== rows.length}<small>/{rows.length}</small>{/if}</span>
  </label>
  {#if facets.length || noEmail}
    <label class="pt-filter" class:on={!!filter} style="--tone:{filter && 'value' in filter ? tone(filter.value) : filter ? RED : '#A78BFA'}">
      <i aria-hidden="true"></i>
      <select value={filterValue} on:change={pick} aria-label={en ? 'Filter' : 'Filtrar'}>
        <option value="">{en ? 'All' : 'Todos'} · {rows.length}</option>
        {#each facets as fc (fc.key)}
          {#if facets.length > 1}<option disabled>── {humanize(fc.key)}</option>{/if}
          {#each fc.values as [v, n] (v)}
            <option value={JSON.stringify({ key: fc.key, value: v })}>{v.replace(/_/g, ' ')} · {n}</option>
          {/each}
        {/each}
        {#if noEmail && emailField}
          <option value={JSON.stringify({ missing: emailField.key })}>{en ? 'No email' : 'Sin email'} · {noEmail}</option>
        {/if}
      </select>
    </label>
    {#if filter}
      <button type="button" class="pt-clear" on:click={() => (filter = null)} aria-label={en ? 'Clear filter' : 'Quitar filtro'} title={en ? 'Clear filter' : 'Quitar filtro'}><Icon name="x" size={11} /></button>
    {/if}
  {/if}
</div>

{#if moveMsg}<div class="pt-movemsg" role="alert">{moveMsg}</div>{/if}
<div class="pt-wrap">
  <table class="pt" class:pt--open={!!view.detail}>
    <colgroup>{#if canDrag}<col style="width:26px" />{/if}{#each fields as f, i (f.key)}<col style="width:{width(f.key, i)}" />{/each}{#if rowActions.length}<col style="width:{showMoves ? rowActions.length * 30 + 12 : 92}px" />{/if}</colgroup>
    <thead><tr>{#if canDrag}<th aria-label={en ? 'Drag' : 'Arrastrar'}></th>{/if}{#each fields as f (f.key)}<th>{textOf(f.label, $locale) || humanize(f.key)}</th>{/each}{#if rowActions.length}<th class="pt-moves-h"><button type="button" class="pt-moves-toggle" class:on={showMoves} aria-expanded={showMoves}
      on:click={() => (showMoves = !showMoves)}><Icon name="move" size={11} />{showMoves ? (en ? 'Done' : 'Listo') : (en ? 'Reorder' : 'Ordenar')}</button></th>{/if}</tr></thead>
    {#each groups as grp (grp.id)}
    <tbody class="pt-grp pt-grp--{grp.id}">
      {#if grp.label}
        <tr class="pt-grp-h"><td colspan={cols}><i aria-hidden="true"></i>{grp.label}<b>{grp.rows.length}</b></td></tr>
      {/if}
      {#each grp.rows as r, i (r.key ?? i)}
        <tr tabindex="0" on:click={() => open(r)} on:keydown={(e) => e.key === 'Enter' && open(r)}
          class:pt-dragging={dragKey === String(r.key ?? '')} class:pt-over={overKey === String(r.key ?? '') && dragKey !== overKey}
          class:pt-busy={busyKey === String(r.key ?? '')}
          class:pt-worked={showAgent && cell(r.agent) !== ''}
          draggable={canDrag}
          on:dragstart={(e) => { dragKey = String(r.key ?? ''); e.dataTransfer?.setData('text/plain', dragKey); }}
          on:dragover|preventDefault={() => { if (dragKey) overKey = String(r.key ?? ''); }}
          on:dragleave={() => { if (overKey === String(r.key ?? '')) overKey = ''; }}
          on:drop|preventDefault={() => drop(r)}
          on:dragend={() => { dragKey = ''; overKey = ''; }}>
          {#if canDrag}<td class="pt-grip" title={en ? 'Drag to reorder' : 'Arrastrá para reordenar'} aria-hidden="true">⠿</td>{/if}
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
              {#if showAgent && f.key === mainKey && cell(r.agent)}
                <div class="pt-sub"><span class="pt-agent" title={en ? 'Working on it now' : 'Lo está trabajando ahora'}><i aria-hidden="true"></i>{cell(r.agent)}</span>{sub}</div>
              {:else if sub}
                <div class="pt-sub" class:pt-sub--alert={/vencid|overdue|lost|perdid/i.test(sub)}>{sub}</div>
              {/if}
            </td>
          {/each}
          {#if rowActions.length}
            <td class="pt-moves">
              {#if showMoves}
              {#each rowActions as a (a)}
                <button type="button" class="pt-move" title={textOf(actions[a].label, $locale)} aria-label={`${textOf(actions[a].label, $locale)} ${String(r.key ?? '')}`}
                  disabled={!!busyKey} on:click|stopPropagation={() => rowMove(a, r)}>{actionGlyph(actions[a].key) ?? textOf(actions[a].label, $locale)}</button>
              {/each}
              {/if}
            </td>
          {/if}
        </tr>
      {:else}
        {#if grp.id !== 'now'}
          <tr><td colspan={cols || 1} class="pt-empty">
            <Icon name="inbox" size={22} />
            <span>{q || filter ? (en ? 'Nothing matches.' : 'Nada coincide.') : grp.id === 'queue' ? (en ? 'Nothing else queued.' : 'No queda nada más en cola.') : (en ? 'Nothing here yet.' : 'Todavía no hay nada.')}</span>
          </td></tr>
        {/if}
      {/each}
    </tbody>
    {/each}
  </table>
</div>

<style>
  /* One bar: the search on the left, the quick filters after it, wrapping only when the panel is narrow. */
  .pt-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .pt-q {
    flex: 0 1 240px; min-width: 160px; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 4px 0 10px; border-radius: 8px; color: #22D3EE;
    background: linear-gradient(160deg, color-mix(in srgb, #22D3EE 8%, var(--surface-1)), var(--surface-1) 70%);
    border: 1px solid color-mix(in srgb, #22D3EE 26%, var(--border)); transition: border-color .2s, box-shadow .2s;
  }
  .pt-q:focus-within { border-color: #22D3EE; box-shadow: 0 0 0 3px color-mix(in srgb, #22D3EE 18%, transparent); }
  .pt-q input { flex: 1; min-width: 0; border: 0; background: none; outline: none; color: var(--text-1); font: 500 12px 'Manrope', sans-serif; }
  .pt-n {
    flex: none; font: 800 10px 'Manrope', sans-serif; padding: 2px 7px; border-radius: 999px; font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, #A78BFA 70%, white); background: color-mix(in srgb, #A78BFA 18%, transparent); border: 1px solid color-mix(in srgb, #A78BFA 45%, transparent);
  }
  .pt-n small { opacity: .7; font-size: 9px; }

  /* The filters as one list, coloured by the state it shows. */
  .pt-filter {
    position: relative; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px 0 10px; border-radius: 8px;
    background: color-mix(in srgb, var(--tone) 10%, var(--surface-1)); border: 1px solid color-mix(in srgb, var(--tone) 35%, var(--border));
  }
  .pt-filter i { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--tone); }
  .pt-filter.on { border-color: var(--tone); box-shadow: 0 0 0 2px color-mix(in srgb, var(--tone) 20%, transparent); }
  .pt-filter.on i { box-shadow: 0 0 8px var(--tone); }
  .pt-filter select {
    appearance: none; -webkit-appearance: none; border: 0; outline: none; background: none; cursor: pointer; padding-right: 14px;
    font: 700 11.5px 'Manrope', sans-serif; color: var(--text-1);
    background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
    background-position: right 4px center, right 0 center; background-size: 4px 4px, 4px 4px; background-repeat: no-repeat;
  }
  .pt-filter select option { color: #111; }
  .pt-filter:focus-within { outline: 2px solid var(--tone); outline-offset: 1px; }
  .pt-clear {
    display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 999px; cursor: pointer;
    color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border);
  }
  .pt-clear:hover { color: var(--text-1); }
  .pt-clear:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }

  .pt-wrap { margin-top: 8px; max-height: calc(100vh - 300px); min-height: 240px; overflow-y: auto; overflow-x: hidden; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-1); }
  .pt { width: 100%; table-layout: fixed; border-collapse: collapse; font: 500 12px 'Manrope', sans-serif; }
  .pt th {
    position: sticky; top: 0; z-index: 1; text-align: left; padding: 6px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: linear-gradient(180deg, color-mix(in srgb, #22D3EE 10%, var(--surface-2)), var(--surface-2));
    color: #22D3EE; font-weight: 800; font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em;
    border-bottom: 1px solid color-mix(in srgb, #22D3EE 25%, var(--border));
  }
  .pt td { padding: 4px 8px; border-top: 1px solid var(--border); color: var(--text-2); vertical-align: middle; overflow: hidden; }
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
  .pt-moves { white-space: nowrap; text-align: right; }
  .pt-moves-h { text-align: right; }
  .pt-moves-toggle {
    display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 6px; cursor: pointer;
    font: inherit; font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--text-2);
    background: transparent; border: 1px solid var(--border); transition: all .15s;
  }
  .pt-moves-toggle:hover, .pt-moves-toggle.on { color: #22D3EE; border-color: color-mix(in srgb, #22D3EE 55%, transparent); background: color-mix(in srgb, #22D3EE 12%, transparent); }
  .pt-moves-toggle:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }
  .pt-move {
    width: 23px; height: 23px; margin-left: 2px; border-radius: 7px; cursor: pointer; font: 800 13px 'Manrope', sans-serif; line-height: 1;
    color: #22D3EE; background: color-mix(in srgb, #22D3EE 10%, transparent); border: 1px solid color-mix(in srgb, #22D3EE 30%, transparent);
    transition: background .15s, border-color .15s, transform .15s ease-out;
  }
  .pt-move:hover:not(:disabled) { background: color-mix(in srgb, #22D3EE 24%, transparent); border-color: #22D3EE; transform: translateY(-1px); }
  .pt-move:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }
  .pt-move:disabled { opacity: .4; cursor: default; }
  .pt-grip { cursor: grab; color: var(--text-3); text-align: center; font-size: 14px; user-select: none; }
  .pt tbody tr.pt-dragging { opacity: .45; }
  .pt tbody tr.pt-over { box-shadow: inset 0 2px 0 #22D3EE; }
  .pt tbody tr.pt-busy { opacity: .7; }
  /* The two groups of a queue: what the agents are on now, then what waits. */
  .pt-grp-h td {
    padding: 5px 8px !important; font: 800 9.5px 'Manrope', sans-serif; text-transform: uppercase; letter-spacing: .06em;
    color: var(--text-3); background: var(--surface-2); border-top: 1px solid var(--border);
  }
  .pt-grp-h td i { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--text-3); vertical-align: 0; }
  .pt-grp-h td b { margin-left: 6px; font-weight: 800; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .pt-grp--now .pt-grp-h td { color: #34D399; background: color-mix(in srgb, #34D399 9%, var(--surface-2)); }
  .pt-grp--now .pt-grp-h td i { background: #34D399; box-shadow: 0 0 8px #34D399; animation: pt-pulse 1.6s ease-in-out infinite; }
  .pt-grp--now + .pt-grp .pt-grp-h td { border-top: 2px solid color-mix(in srgb, #34D399 30%, var(--border)); }
  .pt .pt-grp-h:hover { background: none; box-shadow: none; }
  .pt-agent i { width: 6px; height: 6px; border-radius: 50%; background: #34D399; box-shadow: 0 0 8px #34D399; animation: pt-pulse 1.6s ease-in-out infinite; flex: none; }
  .pt-agent { display: inline-flex; align-items: center; gap: 5px; margin-right: 6px; padding: 0 7px; border-radius: 999px; vertical-align: 0;
    font: 700 9.5px 'Manrope', sans-serif; color: #a7f3d0; background: color-mix(in srgb, #34D399 14%, transparent); border: 1px solid color-mix(in srgb, #34D399 40%, transparent); }
  .pt tbody tr.pt-worked { background: linear-gradient(90deg, color-mix(in srgb, #34D399 9%, transparent), transparent 60%); box-shadow: inset 3px 0 0 #34D399; }
  @keyframes pt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
  .pt-movemsg { margin-top: 8px; padding: 6px 10px; border-radius: 8px; font: 600 11.5px 'Manrope', sans-serif; color: #fecdd3; background: rgba(244,63,94,.12); border: 1px solid rgba(244,63,94,.35); }
  .pt-empty { text-align: center; padding: 28px 10px !important; color: var(--text-3) !important; }
  .pt-empty :global(svg) { display: block; margin: 0 auto 6px; color: #A78BFA; }
  @media (prefers-reduced-motion: reduce) {
    .pt tbody tr, .pt-q { transition: none; }
    .pt-grp--now .pt-grp-h td i, .pt-agent i { animation: none; }
  }
</style>
