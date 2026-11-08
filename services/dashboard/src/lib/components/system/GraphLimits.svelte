<script lang="ts">
  /*
    System › Storage › Grafo (Neo4j). Una tarjeta en la columna izquierda con
    el tamaño del grafo y lo que tiene; «Configurar» abre un cajón con los
    límites: tope de tamaño, historial de transacciones y, por cada módulo que
    llena el grafo (hoy Cine), el tope de ítems y las fuentes que entran.

    Todo sale de storage.graph.get; cada cambio se guarda al instante con
    storage.graph.set y se aplica de noche o con «Aplicar ahora».
  */
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { rpcPost } from '$lib/api';
  import { timeAgo } from '$lib/llm-connect';
  import Panel from '$shared/components/Panel.svelte';
  import Drawer from '$lib/components/ui/Drawer.svelte';
  import { fmtBytes, fmtCount, fmtCap } from '$lib/storage-view';

  export let say: (message: string, kind?: 'success' | 'error' | 'info') => void = () => {};

  type ApplyResult = { removed: number; readmitted: number; orphansRemoved: number };
  type Budget = {
    id: string; label: string; unit: string; capOptions: number[];
    maxItems: number | null; excluded: string[];
    sources: Array<{ key: string; count: number }>;
    inGraph: number | null; keptOut: number | null; nodes: Record<string, number>;
    lastApply: { at: string; result?: ApplyResult; error?: string } | null;
  };
  type Overview = {
    connected: boolean;
    disk: { storeBytes: number; txBytes: number } | null;
    maxGb: number | null; gbOptions: number[];
    txlog: 'min' | 'day' | 'default';
    frozen: boolean; applying: boolean;
    budgets: Budget[];
  };

  const TXLOG = ['min', 'day', 'default'] as const;

  let ov: Overview | null = null;
  let open = false;
  let saving = false;
  let poll: ReturnType<typeof setInterval> | null = null;

  $: total = ov?.disk ? ov.disk.storeBytes + ov.disk.txBytes : null;
  $: tr = (key: string, fallback: string): string => {
    const v = $t(key);
    return v === key ? fallback : v;
  };
  $: budgetName = (b: Budget): string => tr(`storage.graph.budget.${b.id}`, b.label);
  $: unitName = (b: Budget): string => tr(`storage.graph.unit.${b.unit}`, b.unit);
  $: ago = (iso: string): string => {
    const a = timeAgo(iso);
    return $t(a.key, { n: a.n });
  };

  function fail(err: unknown) {
    say($t('storage.toast.error', { error: err instanceof Error ? err.message : String(err) }), 'error');
  }

  async function load() {
    try {
      ov = (await rpcPost('storage.graph.get')) as Overview;
      if (ov.applying) follow();
    } catch (err) {
      fail(err);
    }
  }

  async function save(patch: Record<string, unknown>) {
    saving = true;
    try {
      ov = (await rpcPost('storage.graph.set', patch)) as Overview;
      say($t('storage.toast.graph_saved'));
    } catch (err) {
      fail(err);
    } finally {
      saving = false;
    }
  }

  const optional = (value: string): number | null => (value === '' ? null : Number(value));

  function toggleSource(b: Budget, key: string, included: boolean) {
    const excluded = included ? b.excluded.filter((k) => k !== key) : [...b.excluded, key];
    save({ budget: b.id, excluded });
  }

  /** Re-read every 3 s while the kernel applies, then say how it went. */
  function follow() {
    if (poll) return;
    poll = setInterval(async () => {
      try {
        const next = (await rpcPost('storage.graph.get')) as Overview;
        ov = next;
        if (!next.applying) {
          stopFollowing();
          const err = next.budgets.find((b) => b.lastApply?.error)?.lastApply?.error;
          if (err) say($t('storage.toast.error', { error: err }), 'error');
          else say($t('storage.graph.last', lastParams(next.budgets[0])));
        }
      } catch (err) {
        stopFollowing();
        fail(err);
      }
    }, 3000);
  }

  function stopFollowing() {
    if (poll) clearInterval(poll);
    poll = null;
  }

  async function applyNow() {
    try {
      await rpcPost('storage.graph.apply');
      if (ov) ov = { ...ov, applying: true };
      say($t('storage.toast.graph_applying'), 'info');
      follow();
    } catch (err) {
      fail(err);
    }
  }

  function lastParams(b: Budget | undefined) {
    const r = b?.lastApply?.result;
    return {
      ago: b?.lastApply ? ago(b.lastApply.at) : '',
      removed: fmtCount(r?.removed ?? 0),
      readmitted: fmtCount(r?.readmitted ?? 0),
      orphans: fmtCount(r?.orphansRemoved ?? 0),
    };
  }

  onMount(load);
  onDestroy(stopFollowing);
</script>

{#if ov}
  <Panel title={$t('storage.graph.title')} dotColor="var(--purple)" cls="st-panel">
    <div class="gl-head">
      <div>
        <div class="kpi-value tabular gl-size">{total === null ? $t('storage.graph.size_unknown') : $t('storage.graph.size', { size: fmtBytes(total) })}</div>
        {#if ov.disk}
          <div class="gl-muted">{$t('storage.graph.size_sub', { store: fmtBytes(ov.disk.storeBytes), tx: fmtBytes(ov.disk.txBytes) })}</div>
        {/if}
      </div>
      <button type="button" class="k-btn gl-mini" on:click={() => (open = true)}>{$t('storage.graph.configure')}</button>
    </div>
    {#if !ov.connected}
      <p class="gl-warn">{$t('storage.graph.offline')}</p>
    {/if}
    {#if ov.frozen}
      <p class="gl-warn">{$t('storage.graph.frozen')}</p>
    {/if}
    <ul class="gl-budgets">
      {#each ov.budgets as b (b.id)}
        <li>
          <span class="gl-name">{budgetName(b)}</span>
          <span class="gl-muted tabular">
            {b.inGraph === null ? '—' : $t('storage.graph.items', { n: fmtCount(b.inGraph), unit: unitName(b) })}{#if b.keptOut}{' · '}{$t('storage.graph.kept_out', { n: fmtCount(b.keptOut) })}{/if}
          </span>
        </li>
      {/each}
    </ul>
  </Panel>

  <Drawer {open} width="460px" label={$t('storage.graph.title')} on:close={() => (open = false)}>
    <div class="gl-drawer">
      <h3>{$t('storage.graph.title')}</h3>
      <p class="gl-muted">{$t('storage.graph.hint')}</p>

      <div class="gl-row">
        <label class="gl-field" for="gl-maxgb">
          <span class="gl-label">{$t('storage.graph.max_gb')}</span>
          <span class="gl-muted">{ov.disk ? $t('storage.graph.max_gb_hint') : $t('storage.graph.no_disk')}</span>
        </label>
        <select id="gl-maxgb" class="st-select gl-select" disabled={saving || !ov.disk}
          value={ov.maxGb === null ? '' : String(ov.maxGb)}
          on:change={(e) => save({ maxGb: optional(e.currentTarget.value) })}>
          <option value="">{$t('storage.graph.unlimited')}</option>
          {#each ov.gbOptions as gb}<option value={String(gb)}>{gb} GB</option>{/each}
        </select>
      </div>

      <div class="gl-row">
        <label class="gl-field" for="gl-txlog">
          <span class="gl-label">{$t('storage.graph.txlog')}</span>
          <span class="gl-muted">{$t('storage.graph.txlog_hint')}</span>
        </label>
        <select id="gl-txlog" class="st-select gl-select" disabled={saving || !ov.connected}
          value={ov.txlog} on:change={(e) => save({ txlog: e.currentTarget.value })}>
          {#each TXLOG as k}<option value={k}>{$t(`storage.graph.txlog.${k}`)}</option>{/each}
        </select>
      </div>

      {#each ov.budgets as b (b.id)}
        <section class="gl-budget">
          <h4>{budgetName(b)}</h4>
          <div class="gl-row">
            <label class="gl-field" for="gl-items-{b.id}">
              <span class="gl-label">{$t('storage.graph.max_items')}</span>
              <span class="gl-muted">{$t('storage.graph.max_items_hint')}</span>
            </label>
            <select id="gl-items-{b.id}" class="st-select gl-select" disabled={saving}
              value={b.maxItems === null ? '' : String(b.maxItems)}
              on:change={(e) => save({ budget: b.id, maxItems: optional(e.currentTarget.value) })}>
              <option value="">{$t('storage.graph.unlimited')}</option>
              {#each b.capOptions as n}<option value={String(n)}>{fmtCap(n)}</option>{/each}
            </select>
          </div>

          <div class="gl-label">{$t('storage.graph.sources')}</div>
          <div class="gl-muted">{$t('storage.graph.sources_hint')}</div>
          {#if b.sources.length}
            <ul class="gl-sources">
              {#each b.sources as s (s.key)}
                {@const included = !b.excluded.includes(s.key)}
                <li class:off={!included}>
                  <label>
                    <input type="checkbox" checked={included} disabled={saving}
                      on:change={(e) => toggleSource(b, s.key, e.currentTarget.checked)} />
                    <span class="gl-src">{s.key}</span>
                  </label>
                  <span class="gl-muted tabular">{fmtCount(s.count)}</span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="gl-muted">{$t('storage.graph.sources_empty')}</p>
          {/if}

          <p class="gl-muted gl-last">
            {#if b.lastApply?.error}
              {$t('storage.graph.last_error', { ago: ago(b.lastApply.at), error: b.lastApply.error })}
            {:else if b.lastApply}
              {$t('storage.graph.last', lastParams(b))}
            {:else}
              {$t('storage.graph.never')}
            {/if}
          </p>
        </section>
      {/each}

      <div class="gl-actions">
        <button type="button" class="k-btn k-btn--primary" class:running={ov.applying}
          disabled={ov.applying || !ov.connected} on:click={applyNow}>
          {ov.applying ? $t('storage.graph.applying') : $t('storage.graph.apply')}
        </button>
        <span class="gl-muted">{$t('storage.graph.apply_hint')}</span>
      </div>
    </div>
  </Drawer>
{/if}

<style>
  .gl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .gl-size { font-size: 18px; }
  .gl-mini { padding: 2px 8px; font-size: 11px; }
  .gl-muted { color: var(--text-3); font-size: 11.5px; line-height: 1.35; }
  .gl-warn { margin: 6px 0 0; font-size: 12px; color: var(--orange); }
  .gl-budgets { list-style: none; margin: 6px 0 0; padding: 0; }
  .gl-budgets li { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; padding: 3px 0; border-top: 1px solid var(--border); }
  .gl-budgets li:first-child { border-top: none; }
  .gl-name { font-weight: 600; color: var(--text-1); }

  .gl-drawer { display: flex; flex-direction: column; gap: 12px; padding: 16px; height: 100%; box-sizing: border-box; overflow-y: auto; }
  .gl-drawer h3 { margin: 0; font-size: 15px; }
  .gl-drawer h4 { margin: 0 0 6px; font-size: 13px; color: var(--text-1); }
  .gl-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .gl-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .gl-label { font-weight: 600; font-size: 12.5px; color: var(--text-1); }
  .gl-select { min-width: 150px; flex-shrink: 0; }
  .gl-budget { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); padding-top: 10px; }
  .gl-sources { list-style: none; margin: 0; padding: 0; max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .gl-sources li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; font-size: 12.5px; border-top: 1px solid var(--border); }
  .gl-sources li:first-child { border-top: none; }
  .gl-sources li.off .gl-src { color: var(--text-3); text-decoration: line-through; }
  .gl-sources label { display: flex; align-items: center; gap: 8px; min-width: 0; cursor: pointer; }
  .gl-src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gl-last { margin: 0; }
  .gl-actions { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; margin-top: auto; }
</style>
