<script lang="ts">
  /*
    System › Storage. Qué pesa la base, qué se puede liberar y las políticas de
    retención que aplica el job nocturno storage:retention. Todo sale de una
    sola lectura (storage.get); mientras corre una limpieza o una compactación
    se sigue el progreso con storage.progress.get y al terminar se relee.

    Pensado para entrar en una pantalla: columna izquierda con los números y
    el historial, derecha con la tabla de políticas (que scrollea sola si una
    instalación con muchas extensiones no entra).
  */
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { rpcPost } from '$lib/api';
  import { timeAgo } from '$lib/llm-connect';
  import Panel from '$shared/components/Panel.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import Drawer from '$lib/components/ui/Drawer.svelte';
  import Toast from '$lib/components/ui/Toast.svelte';
  import ConfirmDialog from '$lib/components/commander/ConfirmDialog.svelte';
  import { fmtBytes, fmtCount, sparkPoints, kindShares, KIND_COLOR, type StorageKind } from '$lib/storage-view';

  type Policy = {
    id: string; owner: string; label: string; description: string;
    kind: Exclude<StorageKind, 'unclassified'>; enabled: boolean; days: number | null;
    defaultDays: number | null; dayOptions: number[]; customized: boolean;
    bytes: number | null; eligibleRows: number | null; eligibleBytes: number | null;
  };
  type Run = {
    id: string; trigger: 'cron' | 'manual'; startedAt: string; freedBytesEst: number;
    deletedRows: number; vacuumed: boolean; error: string; details: Array<{ id: string; error?: string }>;
  };
  type Progress = { trigger: string; phase: 'purge' | 'vacuum'; policy: string | null; deleted: number } | null;

  let ov: any = null;
  let loading = true;
  let loadError = '';
  let busy = false;
  let progress: Progress = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let menuFor: string | null = null;
  let strayOpen = false;
  let toast = { message: '', kind: 'success' as 'success' | 'error' | 'info' };
  let confirm: null | { title: string; message: string; ok: string; variant: 'primary' | 'danger'; run: () => Promise<void> } = null;

  $: policies = (ov?.policies ?? []) as Policy[];
  $: runs = (ov?.runs ?? []) as Run[];
  $: shares = kindShares(ov?.byKind ?? {});
  $: spark = sparkPoints((ov?.history ?? []).map((h: any) => h.dbBytes), 96, 22);
  $: compact = ov?.compact;
  $: strayFiles = (ov?.stray?.files ?? []) as Array<{ name: string; bytes: number; modified: string }>;
  $: enabledEligible = policies.filter((p) => p.enabled).reduce((s, p) => s + (p.eligibleRows ?? 0), 0);

  function policyText(p: Policy, field: 'label' | 'desc'): string {
    const key = `storage.policy.${p.id}.${field}`;
    const v = $t(key);
    return v === key ? (field === 'label' ? p.label : p.description) : v;
  }

  function ago(iso: string): string {
    const a = timeAgo(iso);
    return $t(a.key, { n: a.n });
  }

  function say(message: string, kind: 'success' | 'error' | 'info' = 'success') {
    toast = { message, kind };
  }

  function fail(err: unknown) {
    say($t('storage.toast.error', { error: err instanceof Error ? err.message : String(err) }), 'error');
  }

  async function load() {
    try {
      ov = await rpcPost('storage.get');
      loadError = '';
      progress = ov?.progress ?? null;
      if (progress) startPolling();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const r = await rpcPost('storage.progress.get');
        progress = r?.progress ?? null;
        if (!progress) {
          stopPolling();
          const lastBefore = ov?.runs?.[0]?.id;
          await load();
          const last = ov?.runs?.[0];
          if (last && last.id !== lastBefore) {
            say($t('storage.toast.done', { rows: fmtCount(last.deletedRows), size: fmtBytes(last.freedBytesEst) }));
          }
        }
      } catch {
        /* keep polling; a restart answers 502 for a moment */
      }
    }, 1500);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function savePolicy(p: Policy, patch: { enabled?: boolean; days?: number }) {
    try {
      const updated = await rpcPost('storage.policy.set', { id: p.id, ...patch });
      ov = { ...ov, policies: policies.map((x) => (x.id === p.id ? updated : x)) };
      ov.liberableBytes = ov.policies.filter((x: Policy) => x.enabled).reduce((s: number, x: Policy) => s + (x.eligibleBytes ?? 0), 0);
    } catch (err) {
      fail(err);
      await load();
    }
  }

  async function resetPolicy(p: Policy) {
    menuFor = null;
    try {
      await rpcPost('storage.policy.reset', { id: p.id });
      await load();
      say($t('storage.toast.saved'));
    } catch (err) {
      fail(err);
    }
  }

  async function measure() {
    busy = true;
    try {
      ov = await rpcPost('storage.measure');
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  function askClean(only?: Policy) {
    menuFor = null;
    const rows = only ? only.eligibleRows ?? 0 : enabledEligible;
    const size = only ? only.eligibleBytes ?? 0 : ov?.liberableBytes ?? 0;
    confirm = {
      title: $t('storage.confirm.clean.title'),
      message: only
        ? $t('storage.confirm.clean.one', { rows: fmtCount(rows), size: fmtBytes(size), label: policyText(only, 'label') })
        : $t('storage.confirm.clean.body', { rows: fmtCount(rows), size: fmtBytes(size) }),
      ok: $t('storage.confirm.clean.ok'),
      variant: 'danger',
      run: async () => {
        await rpcPost('storage.run', only ? { policy: only.id } : {});
        progress = { trigger: 'manual', phase: 'purge', policy: null, deleted: 0 };
        say($t('storage.toast.started'), 'info');
        startPolling();
      },
    };
  }

  function askCompact() {
    confirm = {
      title: $t('storage.confirm.compact.title'),
      message: $t('storage.confirm.compact.body', { size: fmtBytes(compact?.reclaimableBytes) }),
      ok: $t('storage.confirm.compact.ok'),
      variant: 'primary',
      run: async () => {
        await rpcPost('storage.compact');
        progress = { trigger: 'manual', phase: 'vacuum', policy: null, deleted: 0 };
        say($t('storage.toast.compact_started'), 'info');
        startPolling();
      },
    };
  }

  function askDeleteStray(f: { name: string; bytes: number }) {
    confirm = {
      title: $t('storage.confirm.stray.title', { name: f.name }),
      message: $t('storage.confirm.stray.body', { size: fmtBytes(f.bytes) }),
      ok: $t('storage.confirm.stray.ok'),
      variant: 'danger',
      run: async () => {
        await rpcPost('storage.stray.delete', { name: f.name });
        say($t('storage.toast.deleted', { name: f.name }));
        await load();
      },
    };
  }

  async function onConfirm() {
    const c = confirm;
    confirm = null;
    if (!c) return;
    try {
      await c.run();
    } catch (err) {
      fail(err);
    }
  }

  $: compactHint = !compact
    ? ''
    : compact.reason === 'no_space'
      ? $t('storage.compact.no_space', { size: fmtBytes(compact.neededBytes) })
      : compact.reason === 'no_disk_info'
        ? $t('storage.compact.no_disk_info')
        : compact.reason === 'little'
          ? $t('storage.compact.little')
          : '';

  function onWindowClick(e: MouseEvent) {
    if (menuFor && !(e.target as HTMLElement).closest('.st-menu-wrap')) menuFor = null;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') menuFor = null;
  }

  onMount(load);
  onDestroy(stopPolling);
</script>

<svelte:window on:click={onWindowClick} on:keydown={onKey} />

{#if loading}
  <Panel cls="anim"><div class="st-skeleton" aria-busy="true"></div></Panel>
{:else if loadError}
  <Panel cls="anim"><Empty message={$t('storage.toast.error', { error: loadError })} /></Panel>
{:else if ov}
  <div class="st-grid anim">
    <!-- ── Columna izquierda: números, peso por tipo, historial ── -->
    <div class="st-side">
      <div class="st-kpis">
        <div class="kpi st-kpi">
          <div class="kpi-label">{$t('storage.kpi.db')}</div>
          <div class="st-kpi-row">
            <div class="kpi-value tabular">{fmtBytes(ov.dbBytes)}</div>
            {#if spark}
              <svg class="st-spark" viewBox="0 0 96 22" width="96" height="22" aria-hidden="true">
                <polyline points={spark} fill="none" stroke="var(--teal)" stroke-width="1.5" />
              </svg>
            {/if}
          </div>
          <div class="kpi-sub">{$t('storage.kpi.db_sub', { wal: fmtBytes(ov.walBytes) })}</div>
        </div>
        <div class="kpi st-kpi">
          <div class="kpi-label">{$t('storage.kpi.liberable')}</div>
          <div class="kpi-value tabular" style="color:var(--green)">{fmtBytes(ov.liberableBytes)}</div>
          <div class="kpi-sub">{$t('storage.kpi.liberable_sub')}</div>
        </div>
        <div class="kpi st-kpi">
          <div class="kpi-label">{$t('storage.kpi.stray')}</div>
          <div class="st-kpi-row">
            <div class="kpi-value tabular" style={strayFiles.length ? 'color:var(--orange)' : ''}>{fmtBytes(ov.stray.totalBytes)}</div>
            {#if strayFiles.length}
              <button type="button" class="k-btn st-mini" on:click={() => (strayOpen = true)}>{$t('storage.action.stray')}</button>
            {/if}
          </div>
          <div class="kpi-sub">
            {strayFiles.length ? $t('storage.kpi.stray_sub', { n: strayFiles.length }) : $t('storage.kpi.stray_none')}
          </div>
        </div>
        <div class="kpi st-kpi">
          <div class="kpi-label">{$t('storage.kpi.disk')}</div>
          <div class="kpi-value tabular">
            {compact && compact.diskFreeBytes >= 0 ? fmtBytes(compact.diskFreeBytes) : $t('storage.kpi.disk_unknown')}
          </div>
          <div class="kpi-sub">{$t('storage.kpi.reclaim', { size: fmtBytes(compact?.reclaimableBytes ?? 0) })}</div>
        </div>
      </div>

      <Panel title={$t('storage.kind.title')} dotColor="var(--blue)" cls="st-panel">
        {#if shares.length}
          <div class="st-bar" role="img" aria-label={shares.map((s) => `${$t(`storage.kind.${s.kind}`)} ${fmtBytes(s.bytes)}`).join(', ')}>
            {#each shares as s}
              <span style="width:{Math.max(s.pct, 1.5)}%;background:{KIND_COLOR[s.kind]}" title="{$t(`storage.kind.${s.kind}`)} · {fmtBytes(s.bytes)}"></span>
            {/each}
          </div>
          <ul class="st-legend">
            {#each shares as s}
              <li title={$t(`storage.kind.hint.${s.kind}`)}>
                <span class="st-sw" style="background:{KIND_COLOR[s.kind]}"></span>
                <span class="st-legend-name">{$t(`storage.kind.${s.kind}`)}</span>
                <span class="tabular">{fmtBytes(s.bytes)}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="st-muted">{$t('storage.empty')}</p>
        {/if}
      </Panel>

      <Panel title={$t('storage.runs.title')} dotColor="var(--teal)" cls="st-panel st-runs">
        {#if runs.length}
          <ul class="st-runlist">
            {#each runs as r}
              <li>
                <span class="st-muted">{ago(r.startedAt)} · {$t(r.trigger === 'cron' ? 'storage.runs.cron' : 'storage.runs.manual')}</span>
                <span class="tabular">−{fmtBytes(r.freedBytesEst)}</span>
                <span class="st-runflags">
                  {#if r.vacuumed}<span class="badge">{$t('storage.runs.compacted')}</span>{/if}
                  {#if r.error || r.details.some((d) => d.error)}
                    <span class="st-err">⚠ {$t('storage.runs.errors', { n: r.details.filter((d) => d.error).length || 1 })}</span>
                  {:else}
                    <span class="st-ok" aria-label="ok">✓</span>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="st-muted">{$t('storage.runs.none')}</p>
        {/if}
      </Panel>
    </div>

    <!-- ── Columna derecha: políticas ── -->
    <Panel cls="st-main">
      <div class="st-table-wrap">
        <table class="st-table">
          <thead>
            <tr>
              <th>{$t('storage.col.policy')}</th>
              <th>{$t('storage.col.kind')}</th>
              <th class="num">{$t('storage.col.weight')}</th>
              <th class="num">{$t('storage.col.frees')}</th>
              <th>{$t('storage.col.keep')}</th>
              <th class="center">{$t('storage.col.on')}</th>
              <th><span class="sr-only">⋯</span></th>
            </tr>
          </thead>
          <tbody>
            {#each policies as p (p.id)}
              <tr class:off={!p.enabled}>
                <td class="st-name">
                  <span class="st-label">{policyText(p, 'label')}</span>
                  <span class="st-desc" title={policyText(p, 'desc')}>{policyText(p, 'desc')}</span>
                </td>
                <td><span class="st-kind" style="--k:{KIND_COLOR[p.kind]}">{$t(`storage.kind.short.${p.kind}`)}</span></td>
                <td class="num tabular">{fmtBytes(p.bytes)}</td>
                <td class="num tabular" class:dim={!p.eligibleBytes}>{p.eligibleBytes ? fmtBytes(p.eligibleBytes) : '—'}</td>
                <td>
                  {#if p.defaultDays === null}
                    <span class="st-muted">{$t('storage.no_age')}</span>
                  {:else}
                    <select
                      class="st-select"
                      aria-label={$t('storage.keep_label', { label: policyText(p, 'label') })}
                      value={p.days}
                      on:change={(e) => savePolicy(p, { days: Number(e.currentTarget.value) })}
                    >
                      {#each (p.dayOptions.includes(p.days ?? -1) ? p.dayOptions : [...p.dayOptions, p.days ?? 0].sort((a, b) => a - b)) as d}
                        <option value={d}>{$t('storage.days', { n: d })}</option>
                      {/each}
                    </select>
                  {/if}
                </td>
                <td class="center">
                  <label class="st-switch">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      aria-label={$t('storage.toggle_label', { label: policyText(p, 'label') })}
                      on:change={(e) => savePolicy(p, { enabled: e.currentTarget.checked })}
                    />
                    <span aria-hidden="true"></span>
                  </label>
                </td>
                <td class="st-menu-wrap">
                  <button
                    type="button"
                    class="k-icon-btn st-dots"
                    aria-haspopup="menu"
                    aria-expanded={menuFor === p.id}
                    aria-label={$t('storage.menu', { label: policyText(p, 'label') })}
                    on:click={() => (menuFor = menuFor === p.id ? null : p.id)}
                  >⋯</button>
                  {#if menuFor === p.id}
                    <div class="st-menu" role="menu">
                      <button type="button" role="menuitem" disabled={!!progress || !p.eligibleRows} on:click={() => askClean(p)}>{$t('storage.menu.clean_one')}</button>
                      <button type="button" role="menuitem" disabled={!p.customized} on:click={() => resetPolicy(p)}>{$t('storage.menu.reset')}</button>
                      <span class="st-menu-meta">{$t('storage.menu.owner', { owner: p.owner })}</span>
                    </div>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="st-actions">
        <div class="st-status" aria-live="polite">
          {#if progress}
            <span class="st-spinner" aria-hidden="true"></span>
            {progress.phase === 'vacuum'
              ? $t('storage.progress.vacuum')
              : progress.policy
                ? $t('storage.progress.purge', { policy: progress.policy, n: fmtCount(progress.deleted) })
                : $t('storage.progress.purge_start')}
          {:else if ov.snapshot}
            {$t('storage.measured', { ago: ago(ov.snapshot.measuredAt) })}{ov.snapshot.exact ? '' : ` · ${$t('storage.measured_estimate')}`}
            {#if compactHint}<span class="st-muted"> · {compactHint}</span>{/if}
          {:else}
            {$t('storage.never_measured')}
          {/if}
        </div>
        <button type="button" class="k-btn" disabled={busy || !!progress} on:click={measure}>{$t('storage.action.measure')}</button>
        <button type="button" class="k-btn" disabled={!!progress || !compact?.ok} title={compactHint} on:click={askCompact}>{$t('storage.action.compact')}</button>
        <button type="button" class="k-btn k-btn--primary" disabled={!!progress || enabledEligible === 0} on:click={() => askClean()}>{$t('storage.action.clean')}</button>
      </div>
    </Panel>
  </div>
{/if}

<Drawer open={strayOpen} width="440px" label={$t('storage.stray.title')} on:close={() => (strayOpen = false)}>
  <div class="st-drawer">
    <h3>{$t('storage.stray.title')}</h3>
    <p class="st-muted">{$t('storage.stray.hint')}</p>
    {#if strayFiles.length}
      <ul class="st-stray">
        {#each strayFiles as f (f.name)}
          <li>
            <div>
              <div class="st-label mono">{f.name}</div>
              <div class="st-muted">{fmtBytes(f.bytes)} · {$t('storage.stray.modified', { date: new Date(f.modified).toLocaleDateString() })}</div>
            </div>
            <button type="button" class="k-btn k-btn--danger" on:click={() => askDeleteStray(f)}>{$t('storage.stray.delete')}</button>
          </li>
        {/each}
      </ul>
    {:else}
      <Empty message={$t('storage.stray.empty')} />
    {/if}
  </div>
</Drawer>

{#if confirm}
  <ConfirmDialog
    title={confirm.title}
    message={confirm.message}
    confirmLabel={confirm.ok}
    cancelLabel={$t('storage.cancel')}
    variant={confirm.variant}
    on:confirm={onConfirm}
    on:cancel={() => (confirm = null)}
  />
{/if}

<Toast message={toast.message} kind={toast.kind} on:dismiss={() => (toast = { ...toast, message: '' })} />

<style>
  .st-grid {
    display: grid;
    grid-template-columns: minmax(280px, 330px) 1fr;
    gap: 12px;
    /* Page header + tabs above; the grid takes the rest of the viewport. */
    height: calc(100vh - var(--header-h) - 150px);
    min-height: 460px;
  }
  .st-side { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .st-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .st-kpi { padding: 10px 12px; min-width: 0; }
  .st-kpi .kpi-value { font-size: 18px; }
  .st-kpi-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .st-spark { flex-shrink: 0; }
  .st-mini { padding: 2px 8px; font-size: 11px; }
  :global(.st-panel) { margin: 0 !important; }
  :global(.st-runs) { flex: 1; min-height: 0; overflow: auto; }
  .st-bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; gap: 2px; margin: 4px 0 10px; }
  .st-bar span { display: block; height: 100%; }
  .st-legend, .st-runlist, .st-stray { list-style: none; margin: 0; padding: 0; }
  .st-legend li { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 3px 0; }
  .st-legend-name { flex: 1; color: var(--text-2); }
  .st-sw { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
  .st-runlist li { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; font-size: 12.5px; padding: 4px 0; border-bottom: 1px solid var(--border); }
  .st-runlist li:last-child { border-bottom: none; }
  .st-runflags { display: flex; gap: 6px; align-items: center; }
  .st-ok { color: var(--green); }
  .st-err { color: var(--orange); font-size: 12px; }
  .st-muted { color: var(--text-3); font-size: 12.5px; margin: 0; }
  .tabular { font-variant-numeric: tabular-nums; }
  .mono { font-family: var(--font-mono); }

  :global(.st-main) { margin: 0 !important; display: flex; flex-direction: column; min-height: 0; padding: 0 !important; overflow: hidden; }
  .st-table-wrap { flex: 1; overflow: auto; min-height: 0; }
  .st-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .st-table thead th {
    position: sticky; top: 0; background: var(--surface-1); z-index: 1;
    text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;
    color: var(--text-3); padding: 9px 10px; border-bottom: 1px solid var(--border);
  }
  .st-table td { padding: 5px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; height: 40px; }
  .st-table tr:hover td { background: var(--surface-2); }
  .st-table tr.off .st-label { color: var(--text-2); }
  .num { text-align: right; white-space: nowrap; }
  .center { text-align: center; }
  .dim { color: var(--text-3); }
  .st-name { max-width: 0; width: 46%; }
  .st-label { display: block; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .st-desc { display: block; font-size: 11.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .st-kind {
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.5px; padding: 2px 6px; border-radius: 4px;
    color: var(--k); border: 1px solid color-mix(in srgb, var(--k) 45%, transparent);
  }
  .st-select {
    background: var(--surface-2); color: var(--text-1); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 4px 6px; font-size: 12.5px; min-height: 30px; cursor: pointer;
  }
  .st-select:focus-visible, .st-switch input:focus-visible + span { outline: 2px solid var(--teal); outline-offset: 2px; }
  .st-switch { position: relative; display: inline-block; width: 34px; height: 20px; cursor: pointer; }
  .st-switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .st-switch span { position: absolute; inset: 0; background: var(--surface-3); border-radius: 10px; transition: background 0.15s; }
  .st-switch span::after {
    content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%;
    background: var(--text-2); transition: transform 0.15s var(--ease-out);
  }
  .st-switch input:checked + span { background: color-mix(in srgb, var(--teal) 55%, transparent); }
  .st-switch input:checked + span::after { transform: translateX(14px); background: var(--text-1); }
  .st-menu-wrap { position: relative; width: 36px; }
  .st-dots { width: 30px; height: 30px; font-size: 16px; }
  .st-menu {
    position: absolute; right: 8px; top: 34px; z-index: var(--z-drawer); min-width: 210px;
    background: var(--surface-2); border: 1px solid var(--border-h); border-radius: var(--radius-sm);
    padding: 4px; display: flex; flex-direction: column; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .st-menu button {
    text-align: left; background: none; border: none; color: var(--text-1); padding: 8px 10px;
    border-radius: 4px; font-size: 13px; cursor: pointer;
  }
  .st-menu button:hover:not(:disabled) { background: var(--surface-3); }
  .st-menu button:disabled { opacity: 0.45; cursor: default; }
  .st-menu-meta { font-size: 11px; color: var(--text-3); padding: 6px 10px 4px; border-top: 1px solid var(--border); margin-top: 2px; }
  .st-actions { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
  .st-status { flex: 1; font-size: 12.5px; color: var(--text-2); display: flex; align-items: center; gap: 8px; min-width: 0; }
  .st-spinner {
    width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--border-h); border-top-color: var(--teal);
    animation: st-spin 0.8s linear infinite; flex-shrink: 0;
  }
  @keyframes st-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .st-spinner { animation: none; } }
  .st-skeleton { height: 420px; border-radius: var(--radius); background: var(--surface-2); }
  .st-drawer { padding: 20px; }
  .st-drawer h3 { margin: 0 0 6px; font-size: 16px; }
  .st-stray li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  @media (max-width: 900px) {
    .st-grid { grid-template-columns: 1fr; height: auto; }
    .st-table-wrap { max-height: 70vh; }
  }
</style>
