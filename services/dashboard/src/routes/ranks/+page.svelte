<script lang="ts">
  /*
    /ranks — the agents' hierarchy on one screen, no page scroll.

    Left, the ladder: every rank as one dense row (insignia, name, level, how
    many agents hold it), joined by a rail from the top rank down; edit and
    delete live in the row's ⋯ menu. Right, the agents of the rank picked on
    the ladder (or the ones with no rank), with search, an office filter and
    the select that moves each one. Creating and editing open one modal with a
    live preview. Only the agents list scrolls, inside its card.
  */
  import { readApiError } from '$lib/api.js';
  import { onMount } from 'svelte';
  import { confirm as confirmDialog } from '$shared/feedback';
  import Skeleton from '$shared/components/Skeleton.svelte';
  import { locale } from '$lib/i18n';
  import { PALETTE } from '$lib/components/bench/model.js';

  interface Rank { id: string; name: string; level: number; insignia: string; color: string; description: string; active: number }
  interface AgentRow { id: string; name: string; rank_id?: string; flow_id?: string; role?: string; active?: number; description?: string }
  interface Flow { id: string; name: string; color: string }

  const L = {
    es: {
      title: 'Rangos', sub: '{r} rangos · {a} agentes con rango · {u} sin rango', create: 'Nuevo rango',
      kRanks: 'rangos', kAssigned: 'con rango', kNone: 'sin rango', kTop: 'nivel más alto', ofAll: 'del total',
      ladder: 'Escalafón', ladderHint: 'De arriba hacia abajo: quién responde a quién. Tocá un rango para ver sus agentes.',
      agents: 'agentes', agent: 'agente', none: 'Sin rango', noneHint: 'Agentes sin lugar en el escalafón: asignales uno.',
      search: 'Buscar agente…', all: 'Todas', empty: 'Ningún agente con este rango.', emptySearch: 'Ningún agente coincide.',
      edit: 'Editar', del: 'Eliminar', view: 'Ver agentes', move: 'Mover a', noRank: '— sin rango —',
      mTitleNew: 'Nuevo rango', mTitleEdit: 'Editar rango', name: 'Nombre', namePh: 'Ej.: Coronel', level: 'Nivel', levelHint: '1 = el más bajo',
      insignia: 'Insignia', insigniaHint: 'símbolos, ej. ★★★', color: 'Color', desc: 'Descripción', descPh: 'Qué hace este rango (opcional)',
      preview: 'Así se ve', save: 'Guardar', saving: 'Guardando…', cancel: 'Cancelar',
      delTitle: '¿Eliminar «{n}»?', delWith: '{c} agente(s) van a quedar sin rango. No se puede deshacer.', delPlain: 'No se puede deshacer.', delOk: 'Eliminar rango',
      noRanks: 'Todavía no hay rangos. Creá el primero con «Nuevo rango».', err: 'Error',
    },
    en: {
      title: 'Ranks', sub: '{r} ranks · {a} agents ranked · {u} unranked', create: 'New rank',
      kRanks: 'ranks', kAssigned: 'ranked', kNone: 'no rank', kTop: 'highest level', ofAll: 'of all',
      ladder: 'Chain of command', ladderHint: 'Top to bottom: who answers to whom. Pick a rank to see its agents.',
      agents: 'agents', agent: 'agent', none: 'No rank', noneHint: 'Agents with no place on the ladder: give them one.',
      search: 'Search agent…', all: 'All', empty: 'No agent holds this rank.', emptySearch: 'No agent matches.',
      edit: 'Edit', del: 'Delete', view: 'See agents', move: 'Move to', noRank: '— no rank —',
      mTitleNew: 'New rank', mTitleEdit: 'Edit rank', name: 'Name', namePh: 'E.g.: Colonel', level: 'Level', levelHint: '1 = lowest',
      insignia: 'Insignia', insigniaHint: 'symbols, e.g. ★★★', color: 'Color', desc: 'Description', descPh: 'What this rank does (optional)',
      preview: 'Preview', save: 'Save', saving: 'Saving…', cancel: 'Cancel',
      delTitle: 'Delete "{n}"?', delWith: '{c} agent(s) will be left without a rank. This cannot be undone.', delPlain: 'This cannot be undone.', delOk: 'Delete rank',
      noRanks: 'No ranks yet. Create the first one with "New rank".', err: 'Error',
    },
  };
  $: tx = $locale === 'es' ? L.es : L.en;
  const fill = (s: string, p: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''));

  let ranks: Rank[] = [];
  let agents: AgentRow[] = [];
  let flows: Flow[] = [];
  let loading = true;
  let error = '';

  $: sorted = [...ranks].sort((a, b) => b.level - a.level);
  $: byRank = (() => {
    const m = new Map<string, AgentRow[]>();
    for (const a of agents) { const k = a.rank_id || ''; if (!m.has(k)) m.set(k, []); m.get(k)!.push(a); }
    return m;
  })();
  $: unranked = byRank.get('') ?? [];
  $: assigned = agents.length - unranked.length;
  $: maxCount = Math.max(1, ...sorted.map((r) => (byRank.get(r.id) ?? []).length));
  $: top = sorted[0] ?? null;

  // ── selection: a rank id, or '' for the agents with no rank ──
  let selected: string | null = null;
  // First visit: the agents with no rank if any (they need a decision), else the most populated rank.
  $: if (selected === null && !loading) selected = unranked.length ? ''
    : ([...sorted].sort((a, b) => (byRank.get(b.id) ?? []).length - (byRank.get(a.id) ?? []).length)[0]?.id ?? '');
  $: selRank = selected ? sorted.find((r) => r.id === selected) ?? null : null;
  $: selColor = selRank?.color ?? PALETTE.pink;
  let query = '';
  let flowFilter = '';
  $: pool = selected === null ? [] : (byRank.get(selected) ?? []);
  $: flowCounts = (() => {
    const m = new Map<string, number>();
    for (const a of pool) m.set(a.flow_id ?? '', (m.get(a.flow_id ?? '') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  })();
  $: fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  $: shown = pool
    .filter((a) => !flowFilter || (a.flow_id ?? '') === flowFilter)
    .filter((a) => !query.trim() || fold(`${a.name} ${flowName(a.flow_id)}`).includes(fold(query.trim())))
    .sort((a, b) => flowName(a.flow_id).localeCompare(flowName(b.flow_id)) || a.name.localeCompare(b.name));
  function pick(id: string) { selected = id; flowFilter = ''; query = ''; menuFor = ''; }

  onMount(() => {
    void load();
    const close = () => (menuFor = '');
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  });

  async function load() {
    loading = ranks.length === 0;
    try {
      const [rr, gr] = await Promise.all([fetch('/api/agents/ranks').then((r) => r.json()), fetch('/api/agents/graph').then((r) => r.json())]);
      ranks = rr.ranks ?? [];
      agents = (gr.agents ?? []).filter((a: AgentRow) => a.active !== 0);
      flows = gr.flows ?? [];
    } catch (e) {
      error = `${tx.err}: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      loading = false;
    }
  }
  const flowOf = (fid?: string) => flows.find((f) => f.id === fid);
  function flowName(fid?: string): string { return flowOf(fid)?.name ?? ''; }

  // ── ⋯ menu ──
  let menuFor = '';
  function toggleMenu(id: string, e: MouseEvent) { e.stopPropagation(); menuFor = menuFor === id ? '' : id; }

  // ── create / edit modal ──
  let modal: null | { id: string; name: string; level: number; insignia: string; color: string; description: string } = null;
  let saving = false;
  function openNew() {
    const lvl = (top?.level ?? 0) + 1;
    modal = { id: '', name: '', level: lvl, insignia: '★', color: PALETTE.gold, description: '' };
  }
  function openEdit(r: Rank) { menuFor = ''; modal = { id: r.id, name: r.name, level: r.level, insignia: r.insignia, color: r.color, description: r.description }; }
  async function saveModal() {
    if (!modal || !modal.name.trim()) return;
    saving = true;
    try {
      const body = JSON.stringify({ name: modal.name.trim(), level: Number(modal.level) || 1, insignia: modal.insignia, color: modal.color, description: modal.description });
      const res = await fetch(modal.id ? `/api/agents/ranks/${modal.id}` : '/api/agents/ranks', { method: modal.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok) throw new Error((await readApiError(res)) ?? res.statusText);
      modal = null;
      await load();
    } catch (e) {
      error = `${tx.err}: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      saving = false;
    }
  }
  async function deleteRank(r: Rank) {
    menuFor = '';
    const c = (byRank.get(r.id) ?? []).length;
    if (!(await confirmDialog({ title: fill(tx.delTitle, { n: r.name }), body: c ? fill(tx.delWith, { c }) : tx.delPlain, confirmLabel: tx.delOk, danger: true }))) return;
    try {
      const res = await fetch(`/api/agents/ranks/${r.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(res.statusText);
      if (selected === r.id) selected = null;
      await load();
    } catch (e) {
      error = `${tx.err}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  let moving = '';
  async function moveAgent(a: AgentRow, ev: Event) {
    const rankId = (ev.currentTarget as HTMLSelectElement).value;
    moving = a.id;
    try {
      const res = await fetch(`/api/agents/${a.id}/rank`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rank_id: rankId }) });
      if (!res.ok) throw new Error(res.statusText);
      await load();
    } catch (e) {
      error = `${tx.err}: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      moving = '';
    }
  }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { if (modal) modal = null; menuFor = ''; } }
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
</script>

<svelte:window on:keydown={onKey} />

<div class="rk">
  <header class="top">
    <div class="ttl">
      <h1>{tx.title}</h1>
      <p>{fill(tx.sub, { r: ranks.length, a: assigned, u: unranked.length })}</p>
    </div>
    <div class="kpis">
      <div class="kpi" style="--c: {PALETTE.gold}"><span class="kic">◆</span><div><b class="num">{ranks.length}</b><small>{tx.kRanks}</small></div></div>
      <div class="kpi" style="--c: {PALETTE.emerald}"><span class="kic">✓</span><div><b class="num">{assigned}</b><small>{tx.kAssigned} · {pct(assigned, agents.length)}% {tx.ofAll}</small></div></div>
      <button class="kpi" class:alert={unranked.length > 0} style="--c: {unranked.length ? PALETTE.pink : PALETTE.sky}" on:click={() => pick('')}>
        <span class="kic">!</span><div><b class="num">{unranked.length}</b><small>{tx.kNone}</small></div>
      </button>
      <div class="kpi" style="--c: {top?.color ?? PALETTE.violet}">
        <span class="kic glyph">{top?.insignia || '·'}</span><div><b>{top?.name ?? '—'}</b><small>{tx.kTop}{top ? ` · L${top.level}` : ''}</small></div>
      </div>
    </div>
    <button class="btn primary" on:click={openNew}>+ {tx.create}</button>
  </header>

  {#if error}
    <div class="err" role="alert">{error}<button aria-label="×" on:click={() => (error = '')}>×</button></div>
  {/if}

  {#if loading}
    <Skeleton variant="rows" rows={8} />
  {:else}
    <div class="body">
      <!-- ── The ladder ─────────────────────────────────────── -->
      <section class="card ladder">
        <div class="ch"><h2>{tx.ladder}</h2><small>{tx.ladderHint}</small></div>
        {#if !sorted.length}
          <p class="muted">{tx.noRanks}</p>
        {:else}
          <ol class="rail" style="--n: {sorted.length}">
            {#each sorted as r (r.id)}
              {@const count = (byRank.get(r.id) ?? []).length}
              <li class="rung" class:sel={selected === r.id} style="--rc: {r.color}">
                <button class="rbtn" on:click={() => pick(r.id)} aria-pressed={selected === r.id} title={r.description || r.name}>
                  <span class="disc" aria-hidden="true"><span>{r.insignia || '·'}</span></span>
                  <span class="rname"><b>{r.name}</b>{#if r.description}<small>{r.description}</small>{/if}</span>
                  <span class="lvl num">L{r.level}</span>
                  <span class="bar" aria-hidden="true"><i style="width: {count ? Math.max(6, (100 * count) / maxCount) : 0}%"></i></span>
                  <span class="cnt num" class:zero={!count}>{count}</span>
                </button>
                <div class="more">
                  <button class="dots" aria-label="{tx.edit} / {tx.del}" aria-haspopup="menu" aria-expanded={menuFor === r.id} on:click={(e) => toggleMenu(r.id, e)}>⋯</button>
                  {#if menuFor === r.id}
                    <div class="menu" role="menu" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
                      <button role="menuitem" on:click={() => pick(r.id)}>{tx.view}</button>
                      <button role="menuitem" on:click={() => openEdit(r)}>{tx.edit}</button>
                      <button role="menuitem" class="danger" on:click={() => deleteRank(r)}>{tx.del}</button>
                    </div>
                  {/if}
                </div>
              </li>
            {/each}
          </ol>
          {#if unranked.length}
            <button class="norank" class:sel={selected === ''} on:click={() => pick('')}>
              <span class="disc warn" aria-hidden="true"><span>!</span></span>
              <span class="rname"><b>{tx.none}</b><small>{tx.noneHint}</small></span>
              <span class="cnt num">{unranked.length}</span>
            </button>
          {/if}
        {/if}
      </section>

      <!-- ── Agents of the picked rank ──────────────────────── -->
      <section class="card people" style="--rc: {selColor}">
        <div class="ph">
          <span class="disc big" class:warn={!selRank} aria-hidden="true"><span>{selRank ? selRank.insignia || '·' : '!'}</span></span>
          <div class="phx">
            <h2>{selRank?.name ?? tx.none}</h2>
            <small>{pool.length} {pool.length === 1 ? tx.agent : tx.agents}{selRank ? ` · L${selRank.level}` : ''}{selRank?.description ? ` · ${selRank.description}` : ''}</small>
          </div>
          {#if selRank}<button class="btn ghost sm" on:click={() => selRank && openEdit(selRank)}>{tx.edit}</button>{/if}
        </div>
        {#if pool.length}
          <div class="filters">
            <input class="search" bind:value={query} placeholder={tx.search} aria-label={tx.search} />
            <div class="chips">
              <button class="chip" class:on={!flowFilter} on:click={() => (flowFilter = '')}>{tx.all} <i>{pool.length}</i></button>
              {#each flowCounts as [fid, n] (fid)}
                {@const f = flowOf(fid)}
                <button class="chip" class:on={flowFilter === fid} style="--fc: {f?.color ?? '#94a3b8'}" on:click={() => (flowFilter = flowFilter === fid ? '' : fid)}>
                  <span class="fdot"></span>{f?.name ?? '—'} <i>{n}</i>
                </button>
              {/each}
            </div>
          </div>
          <ul class="list">
            {#each shown as a (a.id)}
              {@const f = flowOf(a.flow_id)}
              <li class="ag" style="--fc: {f?.color ?? '#94a3b8'}">
                <span class="av" aria-hidden="true">{initials(a.name)}</span>
                <span class="an"><b title={a.name}>{a.name}</b><small>{f?.name ?? '—'}{a.role ? ` · ${a.role}` : ''}</small></span>
                <label class="mv">
                  <span class="sr">{tx.move}</span>
                  <select value={a.rank_id || ''} disabled={moving === a.id} on:change={(ev) => moveAgent(a, ev)}>
                    <option value="">{tx.noRank}</option>
                    {#each sorted as o (o.id)}<option value={o.id}>{o.insignia} {o.name} · L{o.level}</option>{/each}
                  </select>
                </label>
              </li>
            {:else}
              <li class="muted pad">{tx.emptySearch}</li>
            {/each}
          </ul>
        {:else}
          <p class="muted pad">{tx.empty}</p>
        {/if}
      </section>
    </div>
  {/if}
</div>

{#if modal}
  <!-- The scrim closes on click; Escape (svelte:window) is the keyboard way out. -->
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
  <div class="scrim" role="presentation" on:click={() => (modal = null)}>
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="rk-mt" style="--rc: {modal.color}" on:click|stopPropagation on:keydown|stopPropagation>
      <h2 id="rk-mt">{modal.id ? tx.mTitleEdit : tx.mTitleNew}</h2>
      <div class="mgrid">
        <label class="f wide"><span>{tx.name}</span><input bind:value={modal.name} placeholder={tx.namePh} /></label>
        <label class="f"><span>{tx.level} <em>{tx.levelHint}</em></span><input type="number" min="1" bind:value={modal.level} /></label>
        <label class="f"><span>{tx.insignia} <em>{tx.insigniaHint}</em></span><input bind:value={modal.insignia} /></label>
        <label class="f"><span>{tx.color}</span>
          <span class="colorrow">
            <input type="color" bind:value={modal.color} aria-label={tx.color} />
            <input bind:value={modal.color} aria-label="{tx.color} hex" />
          </span>
          <span class="swatches">
            {#each Object.values(PALETTE) as c}<button type="button" class="sw" class:on={modal.color.toLowerCase() === c.toLowerCase()} style="--c: {c}" aria-label={c} on:click={() => modal && (modal.color = c)}></button>{/each}
          </span>
        </label>
        <label class="f wide"><span>{tx.desc}</span><input bind:value={modal.description} placeholder={tx.descPh} /></label>
      </div>
      <div class="pv">
        <small>{tx.preview}</small>
        <div class="rung sel demo" style="--rc: {modal.color}">
          <span class="disc" aria-hidden="true"><span>{modal.insignia || '·'}</span></span>
          <span class="rname"><b>{modal.name || '—'}</b>{#if modal.description}<small>{modal.description}</small>{/if}</span>
          <span class="lvl num">L{modal.level}</span>
        </div>
      </div>
      <div class="mact">
        <button class="btn ghost" on:click={() => (modal = null)}>{tx.cancel}</button>
        <button class="btn primary" disabled={saving || !modal.name.trim()} on:click={saveModal}>{saving ? tx.saving : tx.save}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* One screen: the page takes the window's height; only the agents list scrolls, inside its card. */
  .rk { height: 100%; min-height: 0; box-sizing: border-box; padding: 12px 18px 14px; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
  .num { font-variant-numeric: tabular-nums; }

  /* ── header: title · KPI tiles · primary action ── */
  .top { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px; align-items: center; }
  .ttl h1 { margin: 0; font-size: 22px; font-weight: 800; line-height: 1.1;
    background: linear-gradient(90deg, #FBBF24, #F472B6 55%, #A78BFA); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .ttl p { margin: 2px 0 0; font-size: 11.5px; color: var(--text-3); }
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .kpi { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 12px; border-radius: 12px; text-align: left; font: inherit; color: inherit;
    background: linear-gradient(160deg, color-mix(in srgb, var(--c) 18%, var(--surface-1)), var(--surface-1) 72%);
    border: 1px solid color-mix(in srgb, var(--c) 34%, var(--border)); transition: transform 0.15s, box-shadow 0.15s; }
  button.kpi { cursor: pointer; }
  button.kpi:hover { transform: translateY(-1px); box-shadow: 0 10px 22px -16px var(--c); }
  .kpi.alert { animation: pulse 2.4s ease-in-out infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 18%, transparent); } }
  .kic { flex: none; width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; font-weight: 900; font-size: 14px;
    color: var(--c); background: color-mix(in srgb, var(--c) 18%, transparent); text-shadow: 0 0 10px var(--c); }
  .kic.glyph { font-size: 11px; letter-spacing: 1px; }
  .kpi div { display: flex; flex-direction: column; min-width: 0; }
  .kpi b { font-size: 20px; font-weight: 800; line-height: 1.1; color: color-mix(in srgb, var(--c) 75%, white); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kpi small { font-size: 10.5px; color: color-mix(in srgb, var(--c) 45%, var(--text-2)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .btn { font: 700 12.5px var(--font-body, inherit); border-radius: 9px; padding: 8px 14px; cursor: pointer; border: 1px solid transparent; white-space: nowrap; transition: transform 0.15s, filter 0.15s; }
  .btn.primary { color: #1a1206; background: linear-gradient(135deg, #FDE68A, #FBBF24); box-shadow: 0 8px 20px -12px #FBBF24; }
  .btn.primary:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.05); }
  .btn.ghost { background: none; color: var(--text-2); border-color: var(--border); }
  .btn.ghost:hover { color: var(--text-1); border-color: var(--text-3); }
  .btn.sm { padding: 4px 10px; font-size: 11.5px; }
  .btn:disabled { opacity: 0.45; cursor: default; }

  .err { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 7px 12px; border-radius: 9px; font-size: 12.5px;
    color: #fda4af; background: color-mix(in srgb, #F43F5E 12%, transparent); border: 1px solid color-mix(in srgb, #F43F5E 40%, transparent); }
  .err button { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }

  /* ── body: ladder | agents ── */
  .body { flex: 1; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 12px; min-height: 0; }
  .card { min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 14px;
    background: linear-gradient(160deg, color-mix(in srgb, var(--rc, #A78BFA) 7%, var(--surface-1)), var(--surface-1) 60%); border: 1px solid var(--border); }
  .ch { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  h2 { margin: 0; font-size: 13.5px; font-weight: 800; color: var(--text-1); display: flex; align-items: center; gap: 8px; }
  .ch h2::before { content: ''; width: 3px; height: 14px; border-radius: 2px; background: linear-gradient(#22D3EE, #A78BFA); }
  .ch small { font-size: 11px; color: var(--text-3); }
  .muted { color: var(--text-3); font-size: 12px; margin: 0; }
  .pad { padding: 10px 2px; }

  /* the ladder: a rail from the top rank down, one dense row per rank */
  .rail { list-style: none; margin: 0; padding: 0; flex: 1; display: grid; grid-auto-rows: minmax(30px, 1fr); max-height: calc(var(--n, 11) * 52px); gap: 3px; position: relative; overflow: auto; min-height: 0; }
  .rail::before { content: ''; position: absolute; left: 19px; top: 18px; bottom: 18px; width: 2px; border-radius: 2px;
    background: linear-gradient(#A78BFA, #F472B6 35%, #FBBF24 70%, #34D399); opacity: 0.35; }
  .rung { position: relative; display: flex; align-items: center; gap: 4px; border-radius: 11px; border: 1px solid transparent; transition: background 0.15s, border-color 0.15s, box-shadow 0.15s; }
  .rung:hover { background: color-mix(in srgb, var(--rc) 7%, transparent); }
  .rung.sel { background: linear-gradient(90deg, color-mix(in srgb, var(--rc) 20%, transparent), color-mix(in srgb, var(--rc) 4%, transparent));
    border-color: color-mix(in srgb, var(--rc) 50%, transparent); box-shadow: 0 8px 22px -18px var(--rc); }
  .rbtn, .norank { flex: 1; min-width: 0; display: grid; grid-template-columns: 38px minmax(0, 1fr) 40px minmax(60px, 0.6fr) 28px; gap: 10px; align-items: center;
    padding: 4px 6px 4px 1px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 11px; }
  .rbtn:focus-visible, .norank:focus-visible, .dots:focus-visible, .chip:focus-visible, button.kpi:focus-visible { outline: 2px solid #22D3EE; outline-offset: 1px; }
  .disc { position: relative; z-index: 1; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; flex: none;
    background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--rc) 50%, white), color-mix(in srgb, var(--rc) 30%, var(--surface-1)) 60%, var(--surface-1));
    border: 1.5px solid color-mix(in srgb, var(--rc) 70%, transparent); box-shadow: 0 0 14px -2px color-mix(in srgb, var(--rc) 65%, transparent), inset 0 0 10px color-mix(in srgb, var(--rc) 25%, transparent); }
  .disc span { font-weight: 900; font-size: 10.5px; letter-spacing: 0.5px; line-height: 1; color: color-mix(in srgb, var(--rc) 50%, white); text-shadow: 0 0 8px var(--rc); max-width: 32px; overflow: hidden; white-space: nowrap; }
  .disc.warn { --rc: #F472B6; }
  .disc.big { width: 44px; height: 44px; }
  .disc.big span { font-size: 13px; max-width: 40px; }
  .rname { display: flex; flex-direction: column; min-width: 0; }
  .rname b { font-size: 13px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rname small { font-size: 10.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lvl { justify-self: center; font: 800 10.5px var(--font-mono); padding: 2px 7px; border-radius: 999px;
    color: color-mix(in srgb, var(--rc) 70%, white); background: color-mix(in srgb, var(--rc) 16%, transparent); border: 1px solid color-mix(in srgb, var(--rc) 40%, transparent); }
  .bar { height: 7px; border-radius: 4px; background: color-mix(in srgb, var(--rc) 10%, var(--surface-2, #1f2230)); overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, color-mix(in srgb, var(--rc) 60%, transparent), var(--rc)); box-shadow: 0 0 10px color-mix(in srgb, var(--rc) 60%, transparent); transition: width 0.4s ease; }
  .cnt { justify-self: end; font-size: 13px; font-weight: 800; color: color-mix(in srgb, var(--rc, #F472B6) 70%, white); }
  .cnt.zero { color: var(--text-3); font-weight: 600; }
  .more { position: relative; flex: none; }
  .dots { width: 28px; height: 28px; border-radius: 8px; border: 1px solid transparent; background: none; color: var(--text-3); font-size: 16px; line-height: 1; cursor: pointer; }
  .rung:hover .dots, .dots[aria-expanded='true'] { color: var(--text-1); border-color: var(--border); background: var(--surface-2, #1f2230); }
  .menu { position: absolute; right: 0; top: 32px; z-index: 30; min-width: 150px; padding: 4px; border-radius: 10px; display: flex; flex-direction: column;
    background: var(--surface-1); border: 1px solid var(--border); box-shadow: 0 16px 34px -14px rgba(0, 0, 0, 0.7); }
  .menu button { text-align: left; padding: 7px 10px; border: 0; background: none; color: var(--text-1); font: 600 12.5px var(--font-body, inherit); border-radius: 7px; cursor: pointer; }
  .menu button:hover { background: var(--surface-2, #1f2230); }
  .menu .danger { color: #fda4af; }
  .menu .danger:hover { background: color-mix(in srgb, #F43F5E 14%, transparent); }
  .norank { --rc: #F472B6; grid-template-columns: 38px minmax(0, 1fr) 28px; margin-top: 4px; border: 1px dashed color-mix(in srgb, #F472B6 45%, transparent); }
  .norank.sel { background: color-mix(in srgb, #F472B6 14%, transparent); border-style: solid; }

  /* agents of the picked rank */
  .people { --rc-soft: color-mix(in srgb, var(--rc) 22%, transparent); }
  .ph { display: flex; align-items: center; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  .phx { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .phx h2 { font-size: 16px; color: color-mix(in srgb, var(--rc) 55%, white); }
  .phx small { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .filters { display: flex; flex-direction: column; gap: 6px; }
  .search { background: var(--bg, #0d0f16); border: 1px solid var(--border); color: var(--text-1); border-radius: 9px; padding: 6px 10px; font-size: 12.5px; }
  .search:focus { outline: none; border-color: var(--rc); }
  .chips { display: flex; gap: 5px; flex-wrap: wrap; max-height: 52px; overflow: hidden; }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font: 700 11px var(--font-body, inherit); cursor: pointer;
    color: var(--text-2); background: none; border: 1px solid var(--border); }
  .chip i { font-style: normal; color: var(--text-3); font-weight: 600; }
  .chip.on { color: color-mix(in srgb, var(--fc, var(--rc)) 70%, white); background: color-mix(in srgb, var(--fc, var(--rc)) 18%, transparent); border-color: color-mix(in srgb, var(--fc, var(--rc)) 45%, transparent); }
  .fdot { width: 7px; height: 7px; border-radius: 50%; background: var(--fc); box-shadow: 0 0 6px var(--fc); }
  .list { list-style: none; margin: 0; padding: 0; overflow: auto; min-height: 0; flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); align-content: start; gap: 4px; }
  .ag { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 6px; align-items: center; padding: 4px 6px; border-radius: 9px;
    background: color-mix(in srgb, var(--fc) 5%, transparent); border: 1px solid color-mix(in srgb, var(--fc) 14%, transparent); }
  .av { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font: 800 10.5px var(--font-body, inherit);
    color: color-mix(in srgb, var(--fc) 75%, white); background: color-mix(in srgb, var(--fc) 22%, transparent); }
  .an { display: flex; flex-direction: column; min-width: 0; }
  .an b { font-size: 12px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .an small { font-size: 10.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mv { position: relative; }
  .mv select { max-width: 112px; background: var(--surface-2, #1f2230); border: 1px solid var(--border); color: var(--text-2); border-radius: 7px; padding: 2px 4px; font-size: 11px; cursor: pointer; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

  /* modal */
  .scrim { position: fixed; inset: 0; z-index: 100; background: rgba(4, 6, 12, 0.6); backdrop-filter: blur(3px); display: grid; place-items: center; }
  .modal { width: min(560px, calc(100vw - 32px)); padding: 18px 20px; border-radius: 16px; display: flex; flex-direction: column; gap: 14px;
    background: linear-gradient(160deg, color-mix(in srgb, var(--rc) 14%, var(--surface-1)), var(--surface-1) 65%); border: 1px solid color-mix(in srgb, var(--rc) 40%, var(--border));
    box-shadow: 0 30px 60px -30px rgba(0, 0, 0, 0.8), 0 0 40px -24px var(--rc); animation: pop 0.18s ease-out; }
  @keyframes pop { from { transform: scale(0.97); opacity: 0; } }
  .modal h2 { font-size: 16px; }
  .mgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
  .f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--text-2); font-weight: 600; }
  .f em { font-style: normal; font-weight: 400; color: var(--text-3); }
  .f.wide { grid-column: 1 / -1; }
  .f input:not([type='color']) { background: var(--bg, #0d0f16); border: 1px solid var(--border); color: var(--text-1); border-radius: 8px; padding: 7px 10px; font-size: 13px; }
  .f input:focus { outline: none; border-color: var(--rc); }
  .colorrow { display: flex; gap: 6px; }
  .colorrow input[type='color'] { width: 38px; height: 32px; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: none; cursor: pointer; }
  .colorrow input:last-child { flex: 1; min-width: 0; font-family: var(--font-mono); }
  .swatches { display: flex; gap: 5px; flex-wrap: wrap; }
  .sw { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; background: var(--c); box-shadow: 0 0 8px -2px var(--c); cursor: pointer; }
  .sw.on { border-color: #fff; }
  .pv small { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3); }
  .rung.demo { display: grid; grid-template-columns: 38px minmax(0, 1fr) 40px; gap: 10px; padding: 6px 8px; margin-top: 4px; }
  .mact { display: flex; justify-content: flex-end; gap: 8px; }

  /* Short windows: rungs drop their description and shrink, so the whole ladder still fits. */
  @media (max-height: 800px) {
    .rail .rname small { display: none; }
    .rail .disc { width: 28px; height: 28px; }
    .rail .disc span { font-size: 9px; max-width: 24px; }
    .rail .rbtn { grid-template-columns: 30px minmax(0, 1fr) 40px minmax(60px, 0.6fr) 28px; padding-block: 1px; }
    .rail::before { left: 15px; }
    .dots { height: 24px; }
  }
  @media (prefers-reduced-motion: reduce) { .kpi.alert, .modal { animation: none; } }
  @media (max-width: 1100px), (max-height: 640px) {
    .rk { height: auto; overflow: visible; }
    .top { grid-template-columns: 1fr auto; }
    .kpis { grid-column: 1 / -1; grid-row: 2; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .body { grid-template-columns: 1fr; }
    .list { max-height: 60vh; }
  }
</style>
