<script lang="ts">
  /*
    System › Storage. Qué pesa la base, qué se puede liberar, los topes de los
    catálogos que crecen solos y las políticas de retención que aplica el job
    nocturno storage:retention. Todo sale de una sola lectura (storage.get).

    Cada acción muestra su estado mientras corre: el botón con spinner y
    verbo en gerundio, una barra de progreso arriba de la tabla (real al
    limpiar, indeterminada al medir/compactar), la fila que se está limpiando
    resaltada con su contador, y un cronómetro. Al terminar, los números que
    cambiaron destellan y sale un aviso.

    Pensado para entrar en una pantalla: columna izquierda con números,
    topes e historial; derecha con la tabla (scrollea sola si no entra).
  */
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { rpcPost } from '$lib/api';
  import { timeAgo } from '$lib/llm-connect';
  import Panel from '$shared/components/Panel.svelte';
  import Empty from '$shared/components/Empty.svelte';
  import Drawer from '$lib/components/ui/Drawer.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import Toast from '$lib/components/ui/Toast.svelte';
  import {
    fmtBytes, fmtCount, fmtCap, capPct, capChoices, sparkPoints, kindShares, KIND_COLOR, type StorageKind,
  } from '$lib/storage-view';

  type Capacity = {
    unit: string; count: number; cap: number | null; defaultCap: number | null;
    capOptions: number[]; status: 'collecting' | 'capped'; bytesPerUnit: number;
  };
  type Policy = {
    id: string; owner: string; label: string; description: string;
    kind: Exclude<StorageKind, 'unclassified'>; enabled: boolean; days: number | null;
    defaultDays: number | null; dayOptions: number[]; customized: boolean;
    bytes: number | null; eligibleRows: number | null; eligibleBytes: number | null;
    capacity: Capacity | null;
  };
  type Run = {
    id: string; trigger: 'cron' | 'manual'; startedAt: string; freedBytesEst: number;
    deletedRows: number; vacuumed: boolean; error: string; details: Array<{ id: string; error?: string }>;
  };
  type Progress = {
    phase: 'purge' | 'vacuum'; policy: string | null; policyId: string | null;
    policyDeleted: number; deleted: number; startedAt: string;
  } | null;
  type Action = 'measure' | 'clean' | 'compact' | null;

  let ov: any = null;
  let loading = true;
  let loadError = '';
  let action: Action = null;
  let progress: Progress = null;
  let expectedRows = 0;
  let startedAt = 0;
  let elapsed = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let clock: ReturnType<typeof setInterval> | null = null;
  let menuFor: string | null = null;
  let strayOpen = false;
  let savingCap: string | null = null;
  let toast = { message: '', kind: 'success' as 'success' | 'error' | 'info' };
  let confirm: null | { title: string; message: string; ok: string; danger: boolean; run: () => Promise<void> } = null;
  let confirmBusy = false;

  $: policies = (ov?.policies ?? []) as Policy[];
  $: runs = (ov?.runs ?? []) as Run[];
  $: catalogs = policies.filter((p) => p.capacity);
  $: shares = kindShares(ov?.byKind ?? {});
  $: spark = sparkPoints((ov?.history ?? []).map((h: any) => h.dbBytes), 96, 22);
  $: compact = ov?.compact;
  $: strayFiles = (ov?.stray?.files ?? []) as Array<{ name: string; bytes: number; modified: string }>;
  $: enabledEligible = policies.filter((p) => p.enabled).reduce((s, p) => s + (p.eligibleRows ?? 0), 0);
  $: busy = action !== null;
  $: pct = action === 'clean' && progress && expectedRows > 0 ? Math.min(99, (progress.deleted / expectedRows) * 100) : null;

  // Reactive on $t: the locale loads after the first render, and a plain
  // function call in the markup would keep the English it rendered with.
  $: policyText = (p: Policy, field: 'label' | 'desc'): string => {
    const key = `storage.policy.${p.id}.${field}`;
    const v = $t(key);
    return v === key ? (field === 'label' ? p.label : p.description) : v;
  };
  $: catalogName = (p: Policy): string => {
    const key = `storage.cap.name.${p.id}`;
    const v = $t(key);
    return v === key ? policyText(p, 'label') : v;
  };
  $: ago = (iso: string): string => {
    const a = timeAgo(iso);
    return $t(a.key, { n: a.n });
  };

  function say(message: string, kind: 'success' | 'error' | 'info' = 'success') {
    toast = { message, kind };
  }

  function fail(err: unknown) {
    say($t('storage.toast.error', { error: err instanceof Error ? err.message : String(err) }), 'error');
  }

  function begin(a: Exclude<Action, null>) {
    action = a;
    startedAt = Date.now();
    elapsed = 0;
    if (clock) clearInterval(clock);
    clock = setInterval(() => (elapsed = Math.round((Date.now() - startedAt) / 1000)), 1000);
  }

  function end() {
    action = null;
    progress = null;
    if (clock) clearInterval(clock);
    clock = null;
  }

  async function load() {
    try {
      ov = await rpcPost('storage.get');
      loadError = '';
      // A cleanup started elsewhere (the nightly job, another tab) shows up live too.
      if (ov?.progress && !action) {
        progress = ov.progress;
        begin(ov.progress.phase === 'vacuum' ? 'compact' : 'clean');
        startedAt = Date.parse(ov.progress.startedAt) || Date.now();
        startPolling();
      }
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
        if (r?.progress) {
          progress = r.progress;
          return;
        }
        stopPolling();
        const lastBefore = runs[0]?.id;
        const dbBefore = ov?.dbBytes ?? 0;
        const was = action;
        await load();
        end();
        const last = runs[0];
        if (was === 'compact') {
          say($t('storage.toast.compacted', { before: fmtBytes(dbBefore), after: fmtBytes(ov?.dbBytes) }));
        } else if (last && last.id !== lastBefore) {
          say($t('storage.toast.done', { rows: fmtCount(last.deletedRows), size: fmtBytes(last.freedBytesEst) }));
        }
      } catch {
        /* keep polling; a kernel restart answers 502 for a moment */
      }
    }, 1000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function savePolicy(p: Policy, patch: { enabled?: boolean; days?: number; cap?: number | null }) {
    try {
      const updated = (await rpcPost('storage.policy.set', { id: p.id, ...patch })) as Policy;
      const next = policies.map((x) => (x.id === p.id ? updated : x));
      ov = {
        ...ov,
        policies: next,
        liberableBytes: next.filter((x) => x.enabled).reduce((s, x) => s + (x.eligibleBytes ?? 0), 0),
      };
      return true;
    } catch (err) {
      fail(err);
      await load();
      return false;
    }
  }

  async function saveCap(p: Policy, value: string) {
    savingCap = p.id;
    const ok = await savePolicy(p, { cap: value === '' ? null : Number(value) });
    savingCap = null;
    if (ok) say($t('storage.toast.cap_saved'));
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
    begin('measure');
    try {
      ov = await rpcPost('storage.measure');
      say($t('storage.toast.measured', { size: fmtBytes(ov?.dbBytes) }));
    } catch (err) {
      fail(err);
    } finally {
      end();
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
      danger: true,
      run: async () => {
        await rpcPost('storage.run', only ? { policy: only.id } : {});
        expectedRows = rows;
        begin('clean');
        progress = { phase: 'purge', policy: null, policyId: null, policyDeleted: 0, deleted: 0, startedAt: new Date().toISOString() };
        startPolling();
      },
    };
  }

  function askCompact() {
    confirm = {
      title: $t('storage.confirm.compact.title'),
      message: $t('storage.confirm.compact.body', { size: fmtBytes(compact?.reclaimableBytes) }),
      ok: $t('storage.confirm.compact.ok'),
      danger: false,
      run: async () => {
        await rpcPost('storage.compact');
        begin('compact');
        progress = { phase: 'vacuum', policy: null, policyId: null, policyDeleted: 0, deleted: 0, startedAt: new Date().toISOString() };
        startPolling();
      },
    };
  }

  function askDeleteStray(f: { name: string; bytes: number }) {
    confirm = {
      title: $t('storage.confirm.stray.title', { name: f.name }),
      message: $t('storage.confirm.stray.body', { size: fmtBytes(f.bytes) }),
      ok: $t('storage.confirm.stray.ok'),
      danger: true,
      run: async () => {
        await rpcPost('storage.stray.delete', { name: f.name });
        say($t('storage.toast.deleted', { name: f.name }));
        await load();
      },
    };
  }

  async function onConfirm() {
    const c = confirm;
    if (!c) return;
    confirmBusy = true;
    try {
      await c.run();
      confirm = null;
    } catch (err) {
      confirm = null;
      fail(err);
    } finally {
      confirmBusy = false;
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

  $: statusText = action === 'measure'
    ? $t('storage.progress.measure')
    : progress?.phase === 'vacuum'
      ? $t('storage.progress.vacuum')
      : progress?.policy
        ? $t('storage.progress.purge', { policy: progress.policy, n: fmtCount(progress.deleted) })
        : action === 'clean'
          ? $t('storage.progress.purge_start')
          : '';

  function onWindowClick(e: MouseEvent) {
    if (menuFor && !(e.target as HTMLElement).closest('.st-menu-wrap')) menuFor = null;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') menuFor = null;
  }

  onMount(load);
  onDestroy(() => {
    stopPolling();
    if (clock) clearInterval(clock);
  });
</script>

<svelte:window on:click={onWindowClick} on:keydown={onKey} />

{#if loading}
  <div class="st-grid anim">
    <div class="st-side"><div class="st-skeleton" style="height:160px"></div><div class="st-skeleton" style="flex:1"></div></div>
    <div class="st-skeleton"></div>
  </div>
{:else if loadError}
  <Panel cls="anim"><Empty message={$t('storage.toast.error', { error: loadError })} /></Panel>
{:else if ov}
  <div class="st-grid anim">
    <!-- ── Columna izquierda ── -->
    <div class="st-side">
      <div class="st-kpis">
        <div class="kpi st-kpi">
          <div class="kpi-label">{$t('storage.kpi.db')}</div>
          <div class="st-kpi-row">
            {#key ov.dbBytes}<div class="kpi-value tabular st-flash">{fmtBytes(ov.dbBytes)}</div>{/key}
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
          {#key ov.liberableBytes}<div class="kpi-value tabular st-flash" style="color:var(--green)">{fmtBytes(ov.liberableBytes)}</div>{/key}
          <div class="kpi-sub">{$t('storage.kpi.liberable_sub')}</div>
        </div>
        <div class="kpi st-kpi">
          <div class="kpi-label">{$t('storage.kpi.stray')}</div>
          <div class="st-kpi-row">
            {#key ov.stray.totalBytes}<div class="kpi-value tabular st-flash" style={strayFiles.length ? 'color:var(--orange)' : ''}>{fmtBytes(ov.stray.totalBytes)}</div>{/key}
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
          {#key compact?.diskFreeBytes}
            <div class="kpi-value tabular st-flash">
              {compact && compact.diskFreeBytes >= 0 ? fmtBytes(compact.diskFreeBytes) : $t('storage.kpi.disk_unknown')}
            </div>
          {/key}
          <div class="kpi-sub">{$t('storage.kpi.reclaim', { size: fmtBytes(compact?.reclaimableBytes ?? 0) })}</div>
        </div>
      </div>

      {#if catalogs.length}
        <Panel title={$t('storage.cap.title')} dotColor="var(--blue)" cls="st-panel">
          <p class="st-muted st-cap-hint">{$t('storage.cap.hint')}</p>
          <ul class="st-caps">
            {#each catalogs as p (p.id)}
              {@const c = p.capacity}
              {#if c}
                {@const fill = capPct(c.count, c.cap)}
                <li>
                  <div class="st-cap-head">
                    <span class="st-label">{catalogName(p)}</span>
                    <span class="st-pill" class:capped={c.status === 'capped'}>
                      <span class="st-dot" aria-hidden="true"></span>
                      {c.status === 'capped' ? $t('storage.cap.capped') : $t('storage.cap.collecting')}
                    </span>
                    <select
                      class="st-select st-cap-select"
                      aria-label={$t('storage.cap.label', { label: catalogName(p) })}
                      value={c.cap === null ? '' : String(c.cap)}
                      disabled={savingCap === p.id}
                      on:change={(e) => saveCap(p, e.currentTarget.value)}
                    >
                      <option value="">{$t('storage.cap.unlimited')}</option>
                      {#each capChoices(c.capOptions, c.cap) as n}
                        <option value={String(n)}>{fmtCap(n)}</option>
                      {/each}
                    </select>
                  </div>
                  <div class="st-capbar" class:none={fill === null} aria-hidden="true">
                    <span
                      style="width:{fill ?? 100}%"
                      class:warn={fill !== null && fill >= 90 && fill < 100}
                      class:full={fill === 100}
                    ></span>
                  </div>
                  <div class="st-cap-foot">
                    <span class="tabular">
                      {c.cap === null
                        ? $t('storage.cap.count_unlimited', { count: fmtCount(c.count) })
                        : $t('storage.cap.count', { count: fmtCount(c.count), cap: fmtCount(c.cap) })}
                    </span>
                    {#if c.bytesPerUnit > 0}
                      <span class="st-muted">
                        {c.cap === null
                          ? $t('storage.cap.per100k', { size: fmtBytes(c.bytesPerUnit * 100_000) })
                          : $t('storage.cap.at_cap', { size: fmtBytes(c.bytesPerUnit * c.cap) })}
                      </span>
                    {/if}
                  </div>
                </li>
              {/if}
            {/each}
          </ul>
        </Panel>
      {/if}

      <Panel title={$t('storage.kind.title')} dotColor="var(--teal)" cls="st-panel">
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

      <Panel title={$t('storage.runs.title')} dotColor="var(--purple)" cls="st-panel st-runs">
        {#if runs.length}
          <ul class="st-runlist">
            {#each runs as r (r.id)}
              <li class="st-enter">
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
      <div class="st-progress" class:on={busy} aria-hidden={!busy}>
        <span class:indeterminate={pct === null} style={pct !== null ? `width:${pct}%` : ''}></span>
      </div>
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
              {@const active = progress?.phase === 'purge' && progress.policyId === p.id}
              <tr class:off={!p.enabled} class:active>
                <td class="st-name">
                  <span class="st-label">{policyText(p, 'label')}</span>
                  <span class="st-desc" title={policyText(p, 'desc')}>{policyText(p, 'desc')}</span>
                </td>
                <td><span class="st-kind" style="--k:{KIND_COLOR[p.kind]}">{$t(`storage.kind.short.${p.kind}`)}</span></td>
                {#key p.bytes}<td class="num tabular st-flash">{fmtBytes(p.bytes)}</td>{/key}
                <td class="num tabular" class:dim={!p.eligibleBytes && !active}>
                  {#if active && progress}
                    <span class="st-live"><span class="st-spinner sm" aria-hidden="true"></span>{$t('storage.row.cleaning', { n: fmtCount(progress.policyDeleted) })}</span>
                  {:else}
                    {p.eligibleBytes ? fmtBytes(p.eligibleBytes) : '—'}
                  {/if}
                </td>
                <td>
                  {#if p.defaultDays === null}
                    <span class="st-muted">{$t('storage.no_age')}</span>
                  {:else}
                    <select
                      class="st-select"
                      aria-label={$t('storage.keep_label', { label: policyText(p, 'label') })}
                      value={p.days}
                      disabled={busy}
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
                      disabled={busy}
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
                      <button type="button" role="menuitem" disabled={busy || !p.eligibleRows} on:click={() => askClean(p)}>{$t('storage.menu.clean_one')}</button>
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
          {#if busy}
            <span class="st-spinner" aria-hidden="true"></span>
            <span class="st-status-text">{statusText}</span>
            <span class="st-elapsed tabular">{$t('storage.elapsed', { s: elapsed })}</span>
            {#if pct !== null}<span class="st-pct tabular">{Math.round(pct)}%</span>{/if}
          {:else if ov.snapshot}
            <span class="st-status-text">
              {$t('storage.measured', { ago: ago(ov.snapshot.measuredAt) })}{ov.snapshot.exact ? '' : ` · ${$t('storage.measured_estimate')}`}
              {#if compactHint}<span class="st-muted"> · {compactHint}</span>{/if}
            </span>
          {:else}
            {$t('storage.never_measured')}
          {/if}
        </div>
        <button type="button" class="k-btn st-act" class:running={action === 'measure'} disabled={busy} on:click={measure}>
          {#if action === 'measure'}<span class="st-spinner sm" aria-hidden="true"></span>{$t('storage.busy.measure')}{:else}{$t('storage.action.measure')}{/if}
        </button>
        <button type="button" class="k-btn st-act" class:running={action === 'compact'} disabled={busy || !compact?.ok} title={compactHint} on:click={askCompact}>
          {#if action === 'compact'}<span class="st-spinner sm" aria-hidden="true"></span>{$t('storage.busy.compact')}{:else}{$t('storage.action.compact')}{/if}
        </button>
        <button type="button" class="k-btn k-btn--primary st-act" class:running={action === 'clean'} disabled={busy || enabledEligible === 0} on:click={() => askClean()}>
          {#if action === 'clean'}<span class="st-spinner sm dark" aria-hidden="true"></span>{$t('storage.busy.clean')}{:else}{$t('storage.action.clean')}{/if}
        </button>
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

<Modal open={!!confirm} title={confirm?.title ?? ''} width="460px" on:close={() => { if (!confirmBusy) confirm = null; }}>
  <p class="st-confirm-body">{confirm?.message ?? ''}</p>
  <svelte:fragment slot="footer">
    <span class="st-spacer"></span>
    <button class="k-btn k-btn--ghost" type="button" disabled={confirmBusy} on:click={() => (confirm = null)}>{$t('storage.cancel')}</button>
    <button
      class="k-btn {confirm?.danger ? 'k-btn--danger' : 'k-btn--primary'}"
      type="button"
      disabled={confirmBusy}
      on:click={onConfirm}
    >
      {#if confirmBusy}<span class="st-spinner sm" aria-hidden="true"></span>{/if}{confirm?.ok ?? ''}
    </button>
  </svelte:fragment>
</Modal>

<Toast message={toast.message} kind={toast.kind} on:dismiss={() => (toast = { ...toast, message: '' })} />

<style>
  .st-grid {
    display: grid;
    grid-template-columns: minmax(290px, 340px) 1fr;
    gap: 12px;
    /* Page header + tabs above; the grid takes the rest of the viewport. */
    height: calc(100vh - var(--header-h) - 150px);
    min-height: 480px;
  }
  .st-side { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; }
  .st-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .st-kpi { padding: 10px 12px; min-width: 0; }
  .st-kpi .kpi-value { font-size: 18px; }
  .st-kpi-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .st-spark { flex-shrink: 0; }
  .st-mini { padding: 2px 8px; font-size: 11px; }
  :global(.st-panel) { margin: 0 !important; }
  :global(.st-runs) { flex: 1; min-height: 90px; overflow: auto; }
  .st-bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; gap: 2px; margin: 4px 0 10px; }
  .st-bar span { display: block; height: 100%; transition: width 0.4s var(--ease-out); }
  .st-legend, .st-runlist, .st-stray, .st-caps { list-style: none; margin: 0; padding: 0; }
  .st-legend li { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 3px 0; }
  .st-legend-name { flex: 1; color: var(--text-2); }
  .st-sw { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
  .st-runlist li { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; font-size: 12.5px; padding: 4px 0; border-bottom: 1px solid var(--border); }
  .st-runlist li:last-child { border-bottom: none; }
  .st-runflags { display: flex; gap: 6px; align-items: center; }
  .st-ok { color: var(--green); }
  .st-err { color: var(--orange); font-size: 12px; }
  .st-muted { color: var(--text-3); font-size: 12px; margin: 0; }
  .tabular { font-variant-numeric: tabular-nums; }
  .mono { font-family: var(--font-mono); }

  /* ── Catalog limits ── */
  .st-cap-hint { margin: -2px 0 8px; line-height: 1.4; }
  .st-caps li { padding: 6px 0; border-top: 1px solid var(--border); }
  .st-caps li:first-child { border-top: none; padding-top: 0; }
  .st-cap-head { display: flex; align-items: center; gap: 8px; }
  .st-cap-head .st-label { flex: 1; }
  .st-cap-select { min-width: 96px; }
  .st-pill {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
    color: var(--teal); white-space: nowrap;
  }
  .st-pill.capped { color: var(--orange); }
  .st-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: st-pulse 1.6s ease-in-out infinite; }
  .st-pill.capped .st-dot { animation: none; }
  .st-capbar { height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; margin: 7px 0 5px; }
  .st-capbar span { display: block; height: 100%; background: var(--teal); border-radius: 3px; transition: width 0.5s var(--ease-out); }
  .st-capbar span.warn { background: var(--gold); }
  .st-capbar span.full { background: var(--orange); }
  .st-capbar.none span {
    background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--teal) 35%, transparent) 0 8px, transparent 8px 14px);
  }
  .st-cap-foot { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--text-2); }

  /* ── Table ── */
  :global(.st-main) { margin: 0 !important; display: flex; flex-direction: column; min-height: 0; padding: 0 !important; overflow: hidden; position: relative; }
  .st-progress { height: 3px; background: transparent; overflow: hidden; flex-shrink: 0; }
  .st-progress.on { background: var(--surface-3); }
  .st-progress span { display: block; height: 100%; width: 0; background: var(--teal); transition: width 0.6s var(--ease-out); }
  .st-progress.on span.indeterminate { width: 35%; animation: st-indeterminate 1.3s ease-in-out infinite; }
  .st-table-wrap { flex: 1; overflow: auto; min-height: 0; }
  .st-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .st-table thead th {
    position: sticky; top: 0; background: var(--surface-1); z-index: 1;
    text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;
    color: var(--text-3); padding: 9px 10px; border-bottom: 1px solid var(--border);
  }
  .st-table td { padding: 5px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; height: 40px; transition: background 0.2s; }
  .st-table tr:hover td { background: var(--surface-2); }
  .st-table tr.off .st-label { color: var(--text-2); }
  .st-table tr.active td { animation: st-row 1.4s ease-in-out infinite; }
  .st-table tr.active td:first-child { box-shadow: inset 3px 0 0 var(--teal); }
  .num { text-align: right; white-space: nowrap; }
  .center { text-align: center; }
  .dim { color: var(--text-3); }
  .st-live { display: inline-flex; align-items: center; gap: 6px; color: var(--teal); font-weight: 600; }
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
  .st-select:disabled { opacity: 0.5; cursor: default; }
  .st-select:focus-visible, .st-switch input:focus-visible + span { outline: 2px solid var(--teal); outline-offset: 2px; }
  .st-switch { position: relative; display: inline-block; width: 34px; height: 20px; cursor: pointer; }
  .st-switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .st-switch input:disabled { cursor: default; }
  .st-switch input:disabled + span { opacity: 0.5; }
  .st-switch span { position: absolute; inset: 0; background: var(--surface-3); border-radius: 10px; transition: background 0.15s; }
  .st-switch span::after {
    content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%;
    background: var(--text-2); transition: transform 0.18s var(--ease-out);
  }
  .st-switch input:checked + span { background: color-mix(in srgb, var(--teal) 55%, transparent); }
  .st-switch input:checked + span::after { transform: translateX(14px); background: var(--text-1); }
  .st-menu-wrap { position: relative; width: 36px; }
  .st-dots { width: 30px; height: 30px; font-size: 16px; }
  .st-menu {
    position: absolute; right: 8px; top: 34px; z-index: var(--z-drawer); min-width: 210px;
    background: var(--surface-2); border: 1px solid var(--border-h); border-radius: var(--radius-sm);
    padding: 4px; display: flex; flex-direction: column; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    animation: st-pop 0.14s var(--ease-out);
  }
  .st-menu button {
    text-align: left; background: none; border: none; color: var(--text-1); padding: 8px 10px;
    border-radius: 4px; font-size: 13px; cursor: pointer;
  }
  .st-menu button:hover:not(:disabled) { background: var(--surface-3); }
  .st-menu button:disabled { opacity: 0.45; cursor: default; }
  .st-menu-meta { font-size: 11px; color: var(--text-3); padding: 6px 10px 4px; border-top: 1px solid var(--border); margin-top: 2px; }

  /* ── Action bar ── */
  .st-actions { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
  .st-status { flex: 1; font-size: 12.5px; color: var(--text-2); display: flex; align-items: center; gap: 8px; min-width: 0; }
  .st-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-elapsed, .st-pct { color: var(--text-3); flex-shrink: 0; }
  .st-pct { color: var(--teal); font-weight: 600; }
  .st-act { display: inline-flex; align-items: center; gap: 7px; min-width: 112px; justify-content: center; transition: background 0.15s, border-color 0.15s, opacity 0.15s; }
  .st-act:disabled:not(.running) { opacity: 0.45; cursor: default; }
  .st-act.running { opacity: 1; cursor: progress; border-color: var(--teal); }
  .st-spinner {
    width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--border-h); border-top-color: var(--teal);
    animation: st-spin 0.75s linear infinite; flex-shrink: 0; display: inline-block;
  }
  .st-spinner.sm { width: 11px; height: 11px; }
  .st-spinner.dark { border-color: color-mix(in srgb, var(--bg) 35%, transparent); border-top-color: var(--bg); }
  .st-flash { animation: st-flash 0.9s var(--ease-out); }
  .st-enter { animation: st-pop 0.25s var(--ease-out); }
  .st-skeleton { border-radius: var(--radius); background: linear-gradient(90deg, var(--surface-1), var(--surface-2), var(--surface-1)); background-size: 200% 100%; animation: st-shimmer 1.4s linear infinite; min-height: 120px; }
  .st-drawer { padding: 20px; }
  .st-drawer h3 { margin: 0 0 6px; font-size: 16px; }
  .st-stray li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .st-confirm-body { margin: 0; color: var(--text-2); font-size: 13.5px; line-height: 1.55; }
  .st-spacer { flex: 1; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  @keyframes st-spin { to { transform: rotate(360deg); } }
  @keyframes st-indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
  @keyframes st-row { 0%, 100% { background: color-mix(in srgb, var(--teal) 6%, transparent); } 50% { background: color-mix(in srgb, var(--teal) 14%, transparent); } }
  @keyframes st-flash { 0% { color: var(--teal); text-shadow: 0 0 12px color-mix(in srgb, var(--teal) 60%, transparent); } 100% { text-shadow: none; } }
  @keyframes st-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes st-pop { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
  @keyframes st-shimmer { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) {
    .st-spinner, .st-dot, .st-skeleton, .st-flash, .st-enter, .st-menu, .st-table tr.active td { animation: none; }
    .st-progress.on span.indeterminate { animation: none; width: 100%; opacity: 0.5; }
  }

  @media (max-width: 900px) {
    .st-grid { grid-template-columns: 1fr; height: auto; }
    .st-table-wrap { max-height: 70vh; }
  }
</style>
