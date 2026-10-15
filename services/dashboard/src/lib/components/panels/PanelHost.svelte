<!-- src/lib/components/panels/PanelHost.svelte -->
<script lang="ts">
  /**
   * An office's declared panels: one tab per view, plus Activity. Data comes
   * only from the panel gateway; nothing here talks to agents directly.
   */
  import { onDestroy } from 'svelte';
  import { locale } from '$lib/i18n/index.js';
  import { fetchPanel, pollSource, fetchAudit } from '$lib/panels/client.js';
  import { textOf } from '$lib/panels/template.js';
  import { toRows, joinRows } from '$lib/panels/rows.js';
  import { tabViews, firstView } from '$lib/panels/views.js';
  import type { PanelSpec, PanelView } from '$lib/panels/types.js';
  import PanelTable from './PanelTable.svelte';
  import PanelBoard from './PanelBoard.svelte';
  import PanelDetail from './PanelDetail.svelte';
  import PanelForm from './PanelForm.svelte';
  import PanelTimeline from './PanelTimeline.svelte';
  import PanelKpis from './PanelKpis.svelte';

  export let flowId: string;
  export let initialView: string | null = null;

  let spec: PanelSpec | null = null;
  let active = '';
  let rows: Array<Record<string, unknown>> = [];
  /** A board's real total per column, when its source caps the cards it sends. */
  let counts: Record<string, number> | null = null;
  let error = '';
  let stop: (() => void) | null = null;
  let stops: Array<() => void> = [];
  let detailKey: string | null = null;
  let audit: Awaited<ReturnType<typeof fetchAudit>> = [];

  $: tabs = spec ? tabViews(spec) : [];
  $: view = (spec?.views ?? []).find((v) => v.id === active) ?? null;
  $: detailView = view?.detail ? spec?.views.find((v) => v.id === view?.detail) ?? null : null;

  async function load(id: string) {
    // Another office: nothing of the previous one may keep polling or show.
    stopAll();
    spec = null;
    active = '';
    rows = [];
    error = '';
    const loaded = (await fetchPanel(id))?.spec ?? null;
    if (id !== flowId) return; // the operator moved on while this loaded
    spec = loaded;
    const first = spec ? firstView(spec, initialView) : null;
    if (first) select(first);
  }
  $: if (flowId) void load(flowId);

  function select(id: string) {
    active = id;
    detailKey = null;
    error = '';
    rows = [];
    counts = null;
    stopAll();
    const v = spec?.views.find((x) => x.id === id);
    if (id === '__activity') { void fetchAudit(flowId).then((a) => (audit = a)); return; }
    if (!v?.data) return;
    const [source, select] = splitRef(v.data);
    let base: Array<Record<string, unknown>> = [];
    const extra: Record<string, Array<Record<string, unknown>>> = {};
    const recompute = () => {
      let out = base;
      for (const [src, field] of Object.entries(v.join ?? {})) out = joinRows(out, extra[src] ?? [], field);
      rows = out;
    };
    stops.push(pollSource(flowId, source, { select }, (d) => { base = toRows(d); error = ''; recompute(); }, (m) => (error = m)));
    for (const src of Object.keys(v.join ?? {})) {
      stops.push(pollSource(flowId, src, { select: '$' }, (d) => { extra[src] = toRows(d); recompute(); }, () => {}));
    }
    if (v.counts) {
      const [cSource, cSelect] = splitRef(v.counts);
      stops.push(pollSource(flowId, cSource, { select: cSelect }, (d) => {
        counts = d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, number>) : null;
      }, () => {}));
    }
  }

  function splitRef(ref: string): [string, string] {
    const i = ref.indexOf(':');
    return [ref.slice(0, i), ref.slice(i + 1)];
  }
  function stopAll() { for (const s of stops) s(); stops = []; stop?.(); stop = null; }
  onDestroy(stopAll);
</script>

{#if spec}
  <div class="ph">
    <div class="ph-tabs" role="tablist">
      {#each tabs as t (t.id)}
        <button role="tab" aria-selected={active === t.id} class:on={active === t.id} on:click={() => select(t.id)}>{textOf(t.title, $locale)}</button>
      {/each}
      <button role="tab" aria-selected={active === '__activity'} class:on={active === '__activity'} on:click={() => select('__activity')}>
        {$locale.startsWith('en') ? 'Activity' : 'Actividad'}
      </button>
    </div>
    {#if error}<p class="ph-err" role="alert">{error}</p>{/if}
    {#if active === '__activity'}
      <PanelTimeline items={audit.map((a) => ({ at: a.at, text: `${a.ok ? '✓' : '✗'} ${a.action} — ${a.result}` }))} />
    {:else if view}
      {#if detailKey && detailView}
        <PanelDetail {flowId} view={detailView} spec={spec} rowKey={detailKey} on:back={() => (detailKey = null)} />
      {:else if view.component === 'kpis'}
        <PanelKpis {rows} />
      {:else if view.component === 'table'}
        <PanelTable {view} {rows} on:open={(e) => (detailKey = e.detail)} />
      {:else if view.component === 'board'}
        <PanelBoard {view} {rows} {counts} on:open={(e) => (detailKey = e.detail)} />
      {:else if view.component === 'timeline'}
        <PanelTimeline items={rows.map((r) => ({ at: String(r[view?.time ?? 'updated_at'] ?? ''), text: view?.text ? view.text.replace(/\{\{\s*([\w.#-]+)\s*\}\}/g, (_m, k) => String(r[k] ?? '')) : String(r.key ?? '') }))} />
      {:else if view.component === 'detail'}
        <PanelDetail {flowId} {view} {spec} rowKey={null} />
      {:else if view.component === 'form' && view.action && spec.actions?.[view.action]}
        {#key `${flowId}:${view.action}`}<PanelForm {flowId} actionId={view.action} action={spec.actions[view.action]} />{/key}
        {#each view.actions ?? [] as a (a)}
          {#if spec.actions?.[a]}
            <div class="ph-extra">{#key `${flowId}:${a}`}<PanelForm {flowId} actionId={a} action={spec.actions[a]} />{/key}</div>
          {/if}
        {/each}
      {/if}
    {/if}
  </div>
{/if}

<style>
  .ph { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
  .ph-tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .ph-tabs button { background: none; border: 1px solid transparent; border-radius: 6px; padding: 4px 10px; color: var(--text-2); font: 600 11.5px 'Manrope', sans-serif; cursor: pointer; min-height: 30px; }
  .ph-tabs button:hover { color: var(--text-1); background: color-mix(in srgb, #22D3EE 6%, transparent); }
  .ph-tabs button.on {
    color: var(--text-1); border-color: color-mix(in srgb, #22D3EE 45%, var(--border));
    background: linear-gradient(135deg, color-mix(in srgb, #22D3EE 20%, var(--surface-2)), color-mix(in srgb, #A78BFA 16%, var(--surface-2)));
    box-shadow: 0 6px 16px -10px #22D3EE;
  }
  .ph-tabs button:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .ph-extra { border-top: 1px solid var(--border); padding-top: 8px; }
  .ph-err { margin: 0; padding: 6px 10px; border-radius: 6px; background: rgba(240, 71, 112, .12); color: #ff9fb5; font: 500 11.5px 'Manrope', sans-serif; }
</style>
