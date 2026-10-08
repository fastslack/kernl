<!--
  KernlBugsTab — Kernl's own bugs, in the chief's office.

  The chief files them (kernel_kernl_bug_report) when a failure is Kernl's
  fault, and the operator can from any failure card. They are stored locally
  and redacted; this tab is where one is read, edited and — only on the
  operator's OK — published as a GitHub issue. The preview shown is exactly
  what GitHub will receive.

  A report opens in place, right under its row. Every request shows what it is
  doing while it runs and how it ended, next to the control that started it.
-->
<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { confirm as confirmDialog } from '$shared/feedback';
  import { fmtRelTime } from '$lib/display-format.js';
  import { formatRunOutput } from '$lib/run-format.js';
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import KernlFixPanel from './KernlFixPanel.svelte';
  import {
    bugsApi, statusTone, filterBugs, bugCounts, bugClipboardText, FIX_ACTIVE,
    type KernlBug, type BugStatus, type BugFilter, type FixStatus,
  } from '$lib/kernl-bugs.js';

  const STATUS_KEY = {
    new: 'office.kernl.status_new',
    published: 'office.kernl.status_published',
    fixed: 'office.kernl.status_fixed',
    dismissed: 'office.kernl.status_dismissed',
  } as const satisfies Record<BugStatus, string>;

  const FILTERS: Array<{ id: BugFilter; key: string }> = [
    { id: 'open', key: 'office.kernl.f_open' },
    { id: 'fixed', key: 'office.kernl.f_fixed' },
    { id: 'dismissed', key: 'office.kernl.f_dismissed' },
    { id: 'all', key: 'office.kernl.f_all' },
  ];

  type Action = 'save' | 'publish' | 'fixed' | 'dismiss' | 'reopen';
  const BUSY_KEY: Record<Action, string> = {
    save: 'office.kernl.saving',
    publish: 'office.kernl.publishing',
    fixed: 'office.kernl.marking_fixed',
    dismiss: 'office.kernl.dismissing',
    reopen: 'office.kernl.reopening',
  };
  const DONE_KEY: Record<Action, string> = {
    save: 'office.kernl.saved',
    publish: 'office.kernl.published_ok',
    fixed: 'office.kernl.marked_fixed',
    dismiss: 'office.kernl.dismissed_ok',
    reopen: 'office.kernl.reopened',
  };

  /** bind: — reports waiting for a decision (status new): the tab's badge. */
  export let count = 0;
  export let onOutputClick: (e: MouseEvent) => void = () => {};

  let loading = true;
  let refreshing = false;
  let loadError = '';
  let bugs: KernlBug[] = [];
  /** Fix status per report id (kernl-bugs-fix.ts), for the row chip. */
  let fixStatus: Record<string, FixStatus> = {};
  let settings = { repo: 'fastslack/kernl', token_set: false };

  // List
  let filter: BugFilter = 'open';
  let query = '';

  // GitHub form
  let ghOpen = false;
  let repoInput = '';
  let tokenInput = '';
  let ghBusy: '' | 'save' | 'test' = '';
  let ghMsg = '';
  let ghOk = false;

  // The open report
  let selectedId: string | null = null;
  let preview: { title: string; body: string; labels: string[] } | null = null;
  let previewLoading = false;
  let previewError = '';
  let editTitle = '';
  let editDiagnosis = '';
  let actionBusy: Action | '' = '';
  let actionError = '';
  let actionDone = '';
  let doneTimer: ReturnType<typeof setTimeout> | null = null;

  $: count = bugs.filter((b) => b.status === 'new').length;
  $: counts = bugCounts(bugs);
  $: visible = filterBugs(bugs, filter, query, selectedId);
  $: selected = bugs.find((b) => b.id === selectedId) ?? null;
  $: dirty = !!selected && selected.status !== 'published'
    && (editTitle !== selected.title || editDiagnosis !== selected.diagnosis);

  async function load(): Promise<void> {
    loadError = '';
    try {
      const [list, s] = await Promise.all([bugsApi.overview(), bugsApi.settings()]);
      bugs = list.bugs;
      fixStatus = list.fixes;
      settings = s;
      repoInput = s.repo;
    } catch (e) {
      loadError = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  onMount(load);
  onDestroy(() => { if (doneTimer) clearTimeout(doneTimer); });

  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    await load();
    refreshing = false;
  }

  async function loadPreview(id: string): Promise<void> {
    previewLoading = true;
    previewError = '';
    try {
      const r = await bugsApi.get(id);
      if (selectedId === id) preview = r.issue_preview;
    } catch (e) {
      if (selectedId === id) previewError = (e as Error).message;
    } finally {
      if (selectedId === id) previewLoading = false;
    }
  }

  async function toggle(id: string): Promise<void> {
    if (actionBusy) return;
    if (dirty && selected
      && !(await confirmDialog({ title: $t('office.kernl.discard_edits', { title: selected.title }) }))) return;
    if (selectedId === id) { selectedId = null; return; }
    selectedId = id;
    preview = null;
    actionError = '';
    actionDone = '';
    const b = bugs.find((x) => x.id === id);
    editTitle = b?.title ?? '';
    editDiagnosis = b?.diagnosis ?? '';
    void loadPreview(id);
    await tick();
    document.getElementById(`kb-row-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function setFixStatus(id: string, status: FixStatus | null): void {
    const next = { ...fixStatus };
    if (status) next[id] = status; else delete next[id];
    fixStatus = next;
  }

  function replace(bug: KernlBug): void {
    bugs = bugs.map((b) => (b.id === bug.id ? bug : b));
  }

  async function act(name: Action, fn: () => Promise<KernlBug>): Promise<void> {
    if (actionBusy) return;
    actionBusy = name;
    actionError = '';
    actionDone = '';
    try {
      const bug = await fn();
      replace(bug);
      editTitle = bug.title;
      editDiagnosis = bug.diagnosis;
      actionDone = $t(DONE_KEY[name]);
      if (doneTimer) clearTimeout(doneTimer);
      doneTimer = setTimeout(() => (actionDone = ''), 3500);
      if (selectedId === bug.id) void loadPreview(bug.id);
    } catch (e) {
      actionError = (e as Error).message;
    } finally {
      actionBusy = '';
    }
  }

  const save = (b: KernlBug) => act('save', () => bugsApi.update(b.id, { title: editTitle, diagnosis: editDiagnosis }));
  const markFixed = (b: KernlBug) => act('fixed', () => bugsApi.update(b.id, { status: 'fixed' }));
  const dismiss = (b: KernlBug) => act('dismiss', () => bugsApi.update(b.id, { status: 'dismissed' }));
  const reopen = (b: KernlBug) => act('reopen', () => bugsApi.update(b.id, { status: b.issue_url ? 'published' : 'new' }));
  async function publish(b: KernlBug): Promise<void> {
    if (!(await confirmDialog({ title: $t('office.kernl.confirm_publish', { title: b.title, repo: settings.repo }) }))) return;
    void act('publish', () => bugsApi.publish(b.id));
  }

  async function saveGh(): Promise<void> {
    if (ghBusy) return;
    ghBusy = 'save';
    ghMsg = '';
    try {
      settings = await bugsApi.saveSettings({ repo: repoInput.trim(), ...(tokenInput.trim() ? { token: tokenInput.trim() } : {}) });
      tokenInput = '';
      ghOk = true;
      ghMsg = $t('office.kernl.gh_saved');
    } catch (e) {
      ghOk = false;
      ghMsg = (e as Error).message;
    } finally {
      ghBusy = '';
    }
  }
  async function testGh(): Promise<void> {
    if (ghBusy) return;
    ghBusy = 'test';
    ghMsg = '';
    try {
      await bugsApi.testSettings();
      ghOk = true;
      ghMsg = $t('office.kernl.gh_test_ok', { repo: settings.repo });
    } catch (e) {
      ghOk = false;
      ghMsg = (e as Error).message;
    } finally {
      ghBusy = '';
    }
  }
</script>

<div class="kb">
  <!-- GitHub connection: one line until it is opened -->
  <section class="kb-gh" class:open={ghOpen}>
    <div class="kb-gh-line">
      <span class="kb-dot" class:ok={settings.token_set} aria-hidden="true"></span>
      <span class="kb-gh-state">
        {settings.token_set ? $t('office.kernl.gh_connected', { repo: settings.repo }) : $t('office.kernl.gh_disconnected')}
      </span>
      <button class="kb-btn kb-btn-sm" type="button" aria-expanded={ghOpen} on:click={() => (ghOpen = !ghOpen)}>
        {ghOpen ? $t('office.chief.close') : settings.token_set ? $t('office.kernl.gh_change') : $t('office.kernl.gh_connect')}
      </button>
    </div>
    {#if ghOpen}
      <div class="kb-gh-form">
        <p class="kb-gh-sub">{$t('office.kernl.gh_sub')}</p>
        <div class="kb-gh-grid">
          <label class="kb-field">
            <span>{$t('office.kernl.gh_repo')}</span>
            <input bind:value={repoInput} placeholder="fastslack/kernl" autocomplete="off" disabled={!!ghBusy} />
          </label>
          <label class="kb-field">
            <span>{$t('office.kernl.gh_token')}</span>
            <input type="password" bind:value={tokenInput} autocomplete="off" disabled={!!ghBusy}
                   placeholder={settings.token_set ? $t('office.kernl.gh_token_keep') : 'ghp_…'} />
          </label>
        </div>
        <div class="kb-row">
          <button class="kb-btn kb-btn-primary" type="button" on:click={saveGh} disabled={!!ghBusy}>
            {#if ghBusy === 'save'}<span class="kb-spin" aria-hidden="true"></span>{/if}{$t('office.kernl.gh_save')}
          </button>
          <button class="kb-btn" type="button" on:click={testGh} disabled={!!ghBusy || !settings.token_set}>
            {#if ghBusy === 'test'}<span class="kb-spin" aria-hidden="true"></span>{/if}{$t('office.kernl.gh_test')}
          </button>
          <span class="kb-msg" class:ok={ghOk && !ghBusy} class:bad={!ghOk && !ghBusy} role="status" aria-live="polite">
            {ghBusy === 'save' ? $t('office.kernl.gh_saving') : ghBusy === 'test' ? $t('office.kernl.gh_testing') : ghMsg}
          </span>
        </div>
      </div>
    {/if}
  </section>

  {#if loading}
    <div class="kb-skel" role="status" aria-label={$t('office.chief.loading')}>
      {#each [0, 1, 2, 3] as n (n)}<span class="kb-skel-line" style="animation-delay:{n * 120}ms"></span>{/each}
    </div>
  {:else if loadError && bugs.length === 0}
    <div class="kb-errbox" role="alert">
      <span>{loadError}</span>
      <button class="kb-btn kb-btn-sm" type="button" on:click={refresh} disabled={refreshing}>
        {#if refreshing}<span class="kb-spin" aria-hidden="true"></span>{/if}{$t('office.kernl.retry')}
      </button>
    </div>
  {:else if bugs.length === 0}
    <div class="kb-empty">
      <div class="kb-empty-t">{$t('office.kernl.empty_title')}</div>
      <p>{$t('office.kernl.empty_body')}</p>
    </div>
  {:else}
    <!-- Filters -->
    <div class="kb-bar">
      <div class="kb-seg" role="tablist" aria-label={$t('office.kernl.tab_title')}>
        {#each FILTERS as f (f.id)}
          <button class="kb-seg-btn" class:on={filter === f.id} type="button" role="tab"
                  aria-selected={filter === f.id} on:click={() => (filter = f.id)}>
            {$t(f.key)}<span class="kb-seg-n">{counts[f.id]}</span>
          </button>
        {/each}
      </div>
      <input class="kb-search" type="search" bind:value={query} placeholder={$t('office.kernl.search')}
             aria-label={$t('office.kernl.search')} />
      <button class="kb-icon-btn" type="button" on:click={refresh} disabled={refreshing}
              title={$t('office.kernl.reload')} aria-label={$t('office.kernl.reload')}>
        {#if refreshing}<span class="kb-spin" aria-hidden="true"></span>{:else}↻{/if}
      </button>
    </div>
    {#if loadError}<p class="kb-err" role="alert">{loadError}</p>{/if}

    {#if visible.length === 0}
      <p class="kb-none">{$t('office.kernl.no_match')}</p>
    {:else}
      <ul class="kb-list">
        {#each visible as b (b.id)}
          {@const open = b.id === selectedId}
          <li class="kb-li" class:open id="kb-row-{b.id}">
            <div class="kb-item">
              <button class="kb-item-main" type="button" aria-expanded={open} aria-controls="kb-detail-{b.id}"
                      on:click={() => toggle(b.id)}>
                <span class="kb-item-t">{b.title}</span>
                <span class="kb-item-meta">
                  <span class="kb-status kb-tone-{statusTone(b.status)}">{$t(STATUS_KEY[b.status])}</span>
                  {#if b.area}<code class="kb-area">{b.area}</code>{/if}
                  {#if b.occurrences > 1}<span class="kb-count">×{b.occurrences}</span>{/if}
                  {#if fixStatus[b.id] && FIX_ACTIVE.has(fixStatus[b.id])}
                    <span class="kb-fix kb-fix-run"><span class="kb-spin" aria-hidden="true"></span>{$t('office.kernl.chip_fixing')}</span>
                  {:else if fixStatus[b.id] === 'ready'}
                    <span class="kb-fix kb-fix-ok">✓ {$t('office.kernl.chip_fix_ready')}</span>
                  {:else if fixStatus[b.id] === 'failed'}
                    <span class="kb-fix kb-fix-bad">{$t('office.kernl.chip_fix_failed')}</span>
                  {/if}
                  <span class="kb-src">{b.source === 'chief' ? 'Chief' : $t('office.kernl.source_you')}</span>
                  <span class="kb-time">{fmtRelTime(b.last_seen_at)}</span>
                </span>
              </button>
              <span class="kb-item-tools">
                <CopyTextBtn inline title={$t('office.kernl.copy_row')} text={bugClipboardText(b)} />
                <span class="kb-chev" class:open aria-hidden="true">▾</span>
              </span>
            </div>

            {#if open && selected}
              <section class="kb-detail" id="kb-detail-{b.id}">
                <label class="kb-field">
                  <span>{$t('office.kernl.f_title')}</span>
                  <input bind:value={editTitle} maxlength="120" disabled={selected.status === 'published' || !!actionBusy} />
                </label>
                <label class="kb-field">
                  <span>{$t('office.kernl.f_diagnosis')}</span>
                  <textarea rows="5" bind:value={editDiagnosis} disabled={selected.status === 'published' || !!actionBusy}></textarea>
                </label>
                {#if dirty || actionBusy === 'save'}
                  <div class="kb-row">
                    <button class="kb-btn" type="button" on:click={() => save(selected)} disabled={!!actionBusy}>
                      {#if actionBusy === 'save'}<span class="kb-spin" aria-hidden="true"></span>{/if}{$t('office.kernl.save')}
                    </button>
                    <span class="kb-unsaved">{$t('office.kernl.unsaved')}</span>
                  </div>
                {/if}

                <div class="kb-preview-h">
                  <span>{$t('office.kernl.preview')}</span>
                  {#if preview && !previewLoading}
                    <CopyTextBtn inline title={$t('office.chief.copy')}
                      text={`# ${preview.title}\n\n${preview.labels.length ? `Labels: ${preview.labels.join(', ')}\n\n` : ''}${preview.body}`} />
                  {/if}
                </div>
                {#if previewError}
                  <div class="kb-errbox" role="alert">
                    <span>{$t('office.kernl.preview_failed')}: {previewError}</span>
                    <button class="kb-btn kb-btn-sm" type="button" on:click={() => loadPreview(b.id)}>{$t('office.kernl.retry')}</button>
                  </div>
                {:else if preview}
                  <div class="kb-preview" class:stale={previewLoading}>
                    <div class="kb-preview-title">{preview.title}</div>
                    <div class="kb-labels">{#each preview.labels as l (l)}<span class="kb-label">{l}</span>{/each}</div>
                    <div class="kb-preview-body ip-out-md" on:click={onOutputClick} role="presentation">{@html formatRunOutput(preview.body)}</div>
                  </div>
                {:else}
                  <div class="kb-loading" role="status">
                    <span class="kb-spin" aria-hidden="true"></span>{$t('office.kernl.loading_preview')}
                  </div>
                {/if}

                <div class="kb-row kb-actions">
                  {#if selected.status === 'published' && selected.issue_url}
                    <a class="kb-btn kb-btn-primary" href={selected.issue_url} target="_blank" rel="noopener noreferrer">{$t('office.kernl.open_issue')} ↗</a>
                  {:else if selected.status === 'new'}
                    <button class="kb-btn kb-btn-primary" type="button" on:click={() => publish(selected)}
                            disabled={!!actionBusy || !settings.token_set || dirty}
                            title={settings.token_set ? '' : $t('office.kernl.need_token')}>
                      {#if actionBusy === 'publish'}<span class="kb-spin" aria-hidden="true"></span>{/if}{$t('office.kernl.publish')}
                    </button>
                  {/if}
                  {#if selected.status === 'new' || selected.status === 'published'}
                    <button class="kb-btn" type="button" on:click={() => markFixed(selected)} disabled={!!actionBusy}>
                      {#if actionBusy === 'fixed'}<span class="kb-spin" aria-hidden="true"></span>{/if}{$t('office.kernl.mark_fixed')}
                    </button>
                  {/if}
                  {#if selected.status === 'new'}
                    <button class="kb-btn kb-btn-ghost" type="button" on:click={() => dismiss(selected)} disabled={!!actionBusy}>
                      {#if actionBusy === 'dismiss'}<span class="kb-spin" aria-hidden="true"></span>{/if}{$t('office.chief.dismiss')}
                    </button>
                  {/if}
                  {#if selected.status === 'fixed' || selected.status === 'dismissed'}
                    <button class="kb-btn" type="button" on:click={() => reopen(selected)} disabled={!!actionBusy}>
                      {#if actionBusy === 'reopen'}<span class="kb-spin" aria-hidden="true"></span>{/if}{$t('office.kernl.reopen')}
                    </button>
                  {/if}
                  <button class="kb-link kb-link-dim kb-collapse" type="button" on:click={() => toggle(b.id)} disabled={!!actionBusy}>
                    {$t('office.kernl.collapse')}
                  </button>
                </div>
                <div class="kb-status-line" role="status" aria-live="polite">
                  {#if actionBusy}
                    <span class="kb-msg"><span class="kb-spin" aria-hidden="true"></span>{$t(BUSY_KEY[actionBusy])}</span>
                  {:else if actionError}
                    <span class="kb-msg bad">{actionError}</span>
                  {:else if actionDone}
                    <span class="kb-msg ok">✓ {actionDone}</span>
                  {/if}
                </div>

                {#key selected.id}
                  <KernlFixPanel bug={selected} onStatus={setFixStatus} {onOutputClick} />
                {/key}
              </section>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .kb{display:flex;flex-direction:column;gap:10px;padding:12px 14px 18px}

  /* GitHub */
  .kb-gh{border-radius:9px;background:rgba(255,255,255,.02);border:1px solid rgba(120,130,160,.14);padding:7px 10px}
  .kb-gh.open{padding-bottom:12px}
  .kb-gh-line{display:flex;align-items:center;gap:8px;font:500 11.5px 'Manrope',sans-serif;color:#a8aec4}
  .kb-gh-state{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .kb-dot{width:7px;height:7px;border-radius:50%;background:#f0b874;flex:none}
  .kb-dot.ok{background:#78dc8c}
  .kb-gh-form{display:flex;flex-direction:column;gap:9px;margin-top:9px;padding-top:9px;border-top:1px solid rgba(120,130,160,.12)}
  .kb-gh-sub{margin:0;font:500 11px/1.45 'Manrope',sans-serif;color:#8a8fa8}
  .kb-gh-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  @media (max-width:520px){ .kb-gh-grid{grid-template-columns:1fr} }

  .kb-field{display:flex;flex-direction:column;gap:4px;font:600 10.5px 'Manrope',sans-serif;color:#8a8fa8}
  .kb-field input, .kb-field textarea{
    background:rgba(10,12,20,.7);color:#dde0ea;border:1px solid rgba(120,130,160,.25);border-radius:6px;
    padding:7px 9px;font:500 12px 'Manrope',sans-serif;resize:vertical;
  }
  .kb-field input:focus, .kb-field textarea:focus{outline:none;border-color:rgba(120,170,255,.6)}
  .kb-field input:disabled, .kb-field textarea:disabled{opacity:.65}
  .kb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

  /* Buttons */
  .kb-btn{
    height:30px;padding:0 12px;border-radius:7px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;
    font:600 11.5px 'Manrope',sans-serif;color:#dde0ea;background:rgba(255,255,255,.04);border:1px solid rgba(120,130,160,.3);
    transition:background .15s ease, border-color .15s ease;
  }
  .kb-btn:hover:not(:disabled){background:rgba(255,255,255,.09)}
  .kb-btn:disabled{opacity:.5;cursor:not-allowed}
  .kb-btn-sm{height:26px;padding:0 10px;font-size:11px}
  .kb-btn-primary{color:#0a0e14;background:#c9a84c;border-color:#c9a84c}
  .kb-btn-primary:hover:not(:disabled){background:#d8b85a}
  .kb-btn-ghost{background:none;border-color:transparent;color:#8a8fa8}
  .kb-btn-ghost:hover:not(:disabled){color:#ef8090;background:rgba(239,93,110,.08)}
  .kb-btn:focus-visible, .kb-link:focus-visible, .kb-item-main:focus-visible, .kb-seg-btn:focus-visible,
  .kb-icon-btn:focus-visible, .kb-search:focus-visible{outline:2px solid rgba(120,170,255,.7);outline-offset:2px}
  .kb-link{background:none;border:none;padding:0;cursor:pointer;font:600 11px 'Manrope',sans-serif;color:#9fb4e8}
  .kb-link:hover:not(:disabled){text-decoration:underline;text-underline-offset:2px}
  .kb-link:disabled{opacity:.5;cursor:not-allowed}
  .kb-link-dim{color:#8a8fa8}
  .kb-collapse{margin-left:auto}

  /* Feedback */
  .kb-msg{display:inline-flex;align-items:center;gap:6px;font:500 11px 'Manrope',sans-serif;color:#a8aec4}
  .kb-msg.ok{color:#78dc8c}
  .kb-msg.bad{color:#ef8090}
  .kb-err{margin:0;font:500 11.5px 'Manrope',sans-serif;color:#ef8090}
  .kb-errbox{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:8px;
    font:500 11.5px 'Manrope',sans-serif;color:#ef8090;background:rgba(239,93,110,.08);border:1px solid rgba(239,93,110,.25)}
  .kb-status-line{min-height:16px}
  .kb-unsaved{font:600 10.5px 'Manrope',sans-serif;color:#f0b874}
  .kb-loading{display:flex;align-items:center;gap:8px;padding:12px;border-radius:8px;border:1px dashed rgba(120,130,160,.22);
    font:500 11.5px 'Manrope',sans-serif;color:#8a8fa8}
  .kb-spin{width:11px;height:11px;border-radius:50%;flex:none;display:inline-block;
    border:2px solid currentColor;border-right-color:transparent;animation:kb-rot .7s linear infinite}
  @keyframes kb-rot{to{transform:rotate(360deg)}}

  .kb-empty{padding:18px 16px;border-radius:9px;border:1px dashed rgba(120,130,160,.25);text-align:center}
  .kb-empty-t{font:700 13px 'Manrope',sans-serif;color:#dfe2ec;margin-bottom:4px}
  .kb-empty p{margin:0;font:500 11.5px/1.5 'Manrope',sans-serif;color:#8a8fa8}
  .kb-none{margin:0;padding:14px;text-align:center;font:500 11.5px 'Manrope',sans-serif;color:#8a8fa8}

  /* Filter bar */
  .kb-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .kb-seg{display:inline-flex;padding:2px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(120,130,160,.16)}
  .kb-seg-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:none;border-radius:6px;cursor:pointer;
    background:none;color:#8a8fa8;font:600 11px 'Manrope',sans-serif;transition:background .15s ease, color .15s ease}
  .kb-seg-btn:hover{color:#dde0ea}
  .kb-seg-btn.on{background:rgba(201,168,76,.16);color:#e7d39a}
  .kb-seg-n{font:700 10px 'JetBrains Mono',monospace;opacity:.8}
  .kb-search{flex:1;min-width:140px;height:30px;padding:0 10px;border-radius:7px;background:rgba(10,12,20,.7);color:#dde0ea;
    border:1px solid rgba(120,130,160,.25);font:500 11.5px 'Manrope',sans-serif}
  .kb-search:focus{outline:none;border-color:rgba(120,170,255,.6)}
  .kb-icon-btn{width:30px;height:30px;display:inline-grid;place-items:center;border-radius:7px;cursor:pointer;flex:none;
    background:rgba(255,255,255,.04);border:1px solid rgba(120,130,160,.3);color:#a8aec4;font-size:14px}
  .kb-icon-btn:hover:not(:disabled){background:rgba(255,255,255,.09)}
  .kb-icon-btn:disabled{cursor:progress}

  /* List */
  .kb-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
  .kb-li{border-radius:8px;background:rgba(255,255,255,.02);border:1px solid rgba(120,130,160,.14);transition:border-color .15s ease, background .15s ease}
  .kb-li:hover{background:rgba(255,255,255,.04)}
  .kb-li.open{border-color:rgba(201,168,76,.55);background:rgba(201,168,76,.05)}
  .kb-item{display:flex;align-items:flex-start;gap:6px}
  .kb-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;padding:8px 4px 8px 12px;cursor:pointer;text-align:left;
    background:none;border:none;color:inherit;border-radius:8px}
  .kb-item-tools{display:flex;align-items:center;gap:4px;padding:8px 10px 0 0}
  .kb-item-tools :global(button){opacity:.75;transition:opacity .15s ease}
  .kb-li:hover .kb-item-tools :global(button), .kb-li.open .kb-item-tools :global(button),
  .kb-item-tools :global(button:focus-visible){opacity:1}
  .kb-chev{font-size:11px;color:#7a7f92;transition:transform .2s ease}
  .kb-chev.open{transform:rotate(180deg);color:#c9a84c}
  .kb-item-t{font:700 12.5px/1.35 'Manrope',sans-serif;color:#e7e9f4;display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;
    -webkit-box-orient:vertical;overflow:hidden}
  .kb-item-meta{display:flex;align-items:center;gap:7px;min-width:0;font:500 10.5px 'Manrope',sans-serif;color:#7a7f92}
  .kb-status{flex:none;font:700 9.5px 'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.4px;padding:1px 6px;border-radius:4px}
  .kb-tone-warn{color:#f0b874;background:rgba(240,184,116,.12)}
  .kb-tone-info{color:#9fb4e8;background:rgba(159,180,232,.12)}
  .kb-tone-ok{color:#78dc8c;background:rgba(120,220,140,.12)}
  .kb-tone-muted{color:#8a8fa8;background:rgba(120,130,160,.12)}
  .kb-area{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 10px 'JetBrains Mono',monospace;color:#d0b87a}
  .kb-count{flex:none;font:700 10px 'JetBrains Mono',monospace;color:#ef8090}
  .kb-src{flex:none}
  .kb-fix{flex:none;display:inline-flex;align-items:center;gap:4px;font:700 9.5px 'JetBrains Mono',monospace;
    text-transform:uppercase;letter-spacing:.4px;padding:1px 6px;border-radius:4px}
  .kb-fix .kb-spin{width:8px;height:8px;border-width:1.5px}
  .kb-fix-run{color:#9fb4e8;background:rgba(159,180,232,.12)}
  .kb-fix-ok{color:#78dc8c;background:rgba(120,220,140,.12)}
  .kb-fix-bad{color:#ef8090;background:rgba(239,93,110,.12)}
  .kb-time{flex:none;margin-left:auto}

  /* Detail, in place under its row */
  .kb-detail{display:flex;flex-direction:column;gap:9px;margin:0 10px 10px;padding:12px;border-radius:8px;
    background:rgba(0,0,0,.22);border:1px solid rgba(120,130,160,.16);animation:kb-in .18s ease-out}
  @keyframes kb-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .kb-preview-h{display:flex;align-items:center;justify-content:space-between;gap:8px;font:700 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;color:#8a8fa8;margin-top:4px}
  .kb-preview{border-radius:8px;border:1px solid rgba(120,130,160,.18);background:rgba(10,12,20,.6);padding:10px 12px;transition:opacity .15s ease}
  .kb-preview.stale{opacity:.55}
  .kb-preview-title{font:700 13px 'Manrope',sans-serif;color:#f0f2f7;margin-bottom:5px}
  .kb-labels{display:flex;gap:5px;margin-bottom:8px}
  .kb-label{font:600 10px 'Manrope',sans-serif;padding:1px 8px;border-radius:999px;color:#ef8090;background:rgba(239,93,110,.12);border:1px solid rgba(239,93,110,.3)}
  .kb-preview-body{max-height:280px;overflow-y:auto;font:400 12px/1.55 'Manrope',sans-serif;color:#d0d4e0;word-break:break-word}
  .kb-actions{margin-top:2px}

  .kb-skel{display:flex;flex-direction:column;gap:8px}
  .kb-skel-line{
    display:block;height:34px;border-radius:8px;
    background:linear-gradient(90deg, rgba(120,130,160,.08) 0%, rgba(120,130,160,.2) 50%, rgba(120,130,160,.08) 100%);
    background-size:200% 100%;animation:kb-shimmer 1.3s ease-in-out infinite;
  }
  @keyframes kb-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
  @media (prefers-reduced-motion: reduce){
    .kb-skel-line, .kb-detail{animation:none}
    .kb-spin{animation-duration:2s}
    .kb-chev{transition:none}
  }
</style>
