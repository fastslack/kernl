<!--
  KernlBugsTab — Kernl's own bugs, in the chief's office.

  The chief files them (kernel_kernl_bug_report) when a failure is Kernl's
  fault, and the operator can from any failure card. They are stored locally
  and redacted; this tab is where one is read, edited and — only on the
  operator's OK — published as a GitHub issue. The preview shown is exactly
  what GitHub will receive.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { fmtRelTime } from '$lib/display-format.js';
  import { formatRunOutput } from '$lib/run-format.js';
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import { bugsApi, sortBugs, statusTone, type KernlBug, type BugStatus } from '$lib/kernl-bugs.js';

  const STATUS_KEY = {
    new: 'office.kernl.status_new',
    published: 'office.kernl.status_published',
    fixed: 'office.kernl.status_fixed',
    dismissed: 'office.kernl.status_dismissed',
  } as const satisfies Record<BugStatus, string>;

  /** bind: — reports waiting for a decision (status new): the tab's badge. */
  export let count = 0;
  export let onOutputClick: (e: MouseEvent) => void = () => {};

  let loading = true;
  let loadError = '';
  let bugs: KernlBug[] = [];
  let settings = { repo: 'fastslack/kernl', token_set: false };

  // GitHub form
  let ghOpen = false;
  let repoInput = '';
  let tokenInput = '';
  let ghBusy = false;
  let ghMsg = '';
  let ghOk = false;

  // Detail
  let selectedId: string | null = null;
  let preview: { title: string; body: string; labels: string[] } | null = null;
  let editTitle = '';
  let editDiagnosis = '';
  let actionBusy = '';
  let actionError = '';

  $: sorted = sortBugs(bugs);
  $: count = bugs.filter((b) => b.status === 'new').length;
  $: selected = bugs.find((b) => b.id === selectedId) ?? null;

  async function load(): Promise<void> {
    loadError = '';
    try {
      const [list, s] = await Promise.all([bugsApi.list(), bugsApi.settings()]);
      bugs = list;
      settings = s;
      repoInput = s.repo;
      ghOpen = !s.token_set;
    } catch (e) {
      loadError = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  onMount(load);

  async function select(id: string): Promise<void> {
    selectedId = id;
    preview = null;
    actionError = '';
    const b = bugs.find((x) => x.id === id);
    editTitle = b?.title ?? '';
    editDiagnosis = b?.diagnosis ?? '';
    try {
      const r = await bugsApi.get(id);
      preview = r.issue_preview;
    } catch (e) {
      actionError = (e as Error).message;
    }
  }

  function replace(bug: KernlBug): void {
    bugs = bugs.map((b) => (b.id === bug.id ? bug : b));
  }

  async function act(name: string, fn: () => Promise<KernlBug>): Promise<void> {
    if (actionBusy) return;
    actionBusy = name;
    actionError = '';
    try {
      const bug = await fn();
      replace(bug);
      if (selectedId === bug.id) {
        const r = await bugsApi.get(bug.id).catch(() => null);
        preview = r?.issue_preview ?? preview;
      }
    } catch (e) {
      actionError = (e as Error).message;
    } finally {
      actionBusy = '';
    }
  }

  const save = (b: KernlBug) => act('save', () => bugsApi.update(b.id, { title: editTitle, diagnosis: editDiagnosis }));
  const markFixed = (b: KernlBug) => act('fixed', () => bugsApi.update(b.id, { status: 'fixed' }));
  const dismiss = (b: KernlBug) => act('dismiss', () => bugsApi.update(b.id, { status: 'dismissed' }));
  function publish(b: KernlBug): void {
    if (!confirm($t('office.kernl.confirm_publish', { title: b.title, repo: settings.repo }))) return;
    void act('publish', () => bugsApi.publish(b.id));
  }

  async function saveGh(): Promise<void> {
    ghBusy = true;
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
      ghBusy = false;
    }
  }
  async function testGh(): Promise<void> {
    ghBusy = true;
    ghMsg = '';
    try {
      await bugsApi.testSettings();
      ghOk = true;
      ghMsg = $t('office.kernl.gh_test_ok', { repo: settings.repo });
    } catch (e) {
      ghOk = false;
      ghMsg = (e as Error).message;
    } finally {
      ghBusy = false;
    }
  }
</script>

<div class="kb">
  <!-- GitHub connection -->
  <section class="kb-gh">
    {#if settings.token_set && !ghOpen}
      <div class="kb-gh-line">
        <span>{$t('office.kernl.gh_connected', { repo: settings.repo })}</span>
        <button class="kb-link" type="button" on:click={() => (ghOpen = true)}>{$t('office.kernl.gh_change')}</button>
      </div>
    {:else}
      <div class="kb-gh-form">
        <div class="kb-gh-h">{$t('office.kernl.gh_title')}</div>
        <p class="kb-gh-sub">{$t('office.kernl.gh_sub')}</p>
        <label class="kb-field">
          <span>{$t('office.kernl.gh_repo')}</span>
          <input bind:value={repoInput} placeholder="fastslack/kernl" autocomplete="off" />
        </label>
        <label class="kb-field">
          <span>{$t('office.kernl.gh_token')}</span>
          <input type="password" bind:value={tokenInput} autocomplete="off"
                 placeholder={settings.token_set ? $t('office.kernl.gh_token_keep') : 'ghp_…'} />
        </label>
        <div class="kb-row">
          <button class="kb-btn kb-btn-primary" type="button" on:click={saveGh} disabled={ghBusy}>{$t('office.kernl.gh_save')}</button>
          <button class="kb-btn" type="button" on:click={testGh} disabled={ghBusy || !settings.token_set}>{$t('office.kernl.gh_test')}</button>
          {#if settings.token_set}<button class="kb-link" type="button" on:click={() => (ghOpen = false)}>{$t('office.chief.close')}</button>{/if}
          {#if ghMsg}<span class="kb-msg" class:ok={ghOk} class:bad={!ghOk}>{ghMsg}</span>{/if}
        </div>
      </div>
    {/if}
  </section>

  {#if loading}
    <div class="kb-skel" role="status" aria-label={$t('office.chief.loading')}>
      {#each [0, 1, 2] as n (n)}<span class="kb-skel-line" style="animation-delay:{n * 120}ms"></span>{/each}
    </div>
  {:else if loadError}
    <p class="kb-err">{loadError}</p>
  {:else if bugs.length === 0}
    <div class="kb-empty">
      <div class="kb-empty-t">{$t('office.kernl.empty_title')}</div>
      <p>{$t('office.kernl.empty_body')}</p>
    </div>
  {:else}
    <ul class="kb-list">
      {#each sorted as b (b.id)}
        <li>
          <button class="kb-item" class:on={b.id === selectedId} type="button" on:click={() => select(b.id)}>
            <span class="kb-item-t">{b.title}</span>
            <span class="kb-item-meta">
              <span class="kb-status kb-tone-{statusTone(b.status)}">{$t(STATUS_KEY[b.status])}</span>
              {#if b.area}<code class="kb-area">{b.area}</code>{/if}
              {#if b.occurrences > 1}<span class="kb-count">×{b.occurrences}</span>{/if}
              <span class="kb-src">{b.source === 'chief' ? 'Chief' : $t('office.kernl.source_you')}</span>
              <span class="kb-time">{fmtRelTime(b.last_seen_at)}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>

    {#if selected}
      <section class="kb-detail">
        <label class="kb-field">
          <span>{$t('office.kernl.f_title')}</span>
          <input bind:value={editTitle} maxlength="120" disabled={selected.status === 'published'} />
        </label>
        <label class="kb-field">
          <span>{$t('office.kernl.f_diagnosis')}</span>
          <textarea rows="5" bind:value={editDiagnosis} disabled={selected.status === 'published'}></textarea>
        </label>
        {#if selected.status !== 'published' && (editTitle !== selected.title || editDiagnosis !== selected.diagnosis)}
          <div class="kb-row"><button class="kb-btn" type="button" on:click={() => save(selected)} disabled={!!actionBusy}>{$t('office.kernl.save')}</button></div>
        {/if}

        <div class="kb-preview-h">
          <span>{$t('office.kernl.preview')}</span>
          {#if preview}
            <CopyTextBtn inline title={$t('office.chief.copy')}
              text={`# ${preview.title}\n\n${preview.labels.length ? `Labels: ${preview.labels.join(', ')}\n\n` : ''}${preview.body}`} />
          {/if}
        </div>
        {#if preview}
          <div class="kb-preview">
            <div class="kb-preview-title">{preview.title}</div>
            <div class="kb-labels">{#each preview.labels as l (l)}<span class="kb-label">{l}</span>{/each}</div>
            <div class="kb-preview-body ip-out-md" on:click={onOutputClick} role="presentation">{@html formatRunOutput(preview.body)}</div>
          </div>
        {:else}
          <span class="kb-skel-line"></span>
        {/if}

        <div class="kb-row kb-actions">
          {#if selected.status === 'published' && selected.issue_url}
            <a class="kb-btn kb-btn-primary" href={selected.issue_url} target="_blank" rel="noopener noreferrer">{$t('office.kernl.open_issue')} ↗</a>
          {:else}
            <button class="kb-btn kb-btn-primary" type="button" on:click={() => publish(selected)}
                    disabled={!!actionBusy || !settings.token_set}
                    title={settings.token_set ? '' : $t('office.kernl.need_token')}>
              {actionBusy === 'publish' ? '…' : $t('office.kernl.publish')}
            </button>
          {/if}
          {#if selected.status !== 'fixed'}
            <button class="kb-btn" type="button" on:click={() => markFixed(selected)} disabled={!!actionBusy}>{$t('office.kernl.mark_fixed')}</button>
          {/if}
          {#if selected.status !== 'dismissed'}
            <button class="kb-link kb-link-dim" type="button" on:click={() => dismiss(selected)} disabled={!!actionBusy}>{$t('office.chief.dismiss')}</button>
          {/if}
        </div>
        {#if actionError}<p class="kb-err">{actionError}</p>{/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .kb{display:flex;flex-direction:column;gap:12px;padding:12px 14px 18px}
  .kb-gh{border-radius:9px;background:rgba(255,255,255,.02);border:1px solid rgba(120,130,160,.14);padding:10px 12px}
  .kb-gh-line{display:flex;align-items:center;gap:10px;font:500 12px 'Manrope',sans-serif;color:#a8aec4}
  .kb-gh-form{display:flex;flex-direction:column;gap:8px}
  .kb-gh-h{font:700 12.5px 'Manrope',sans-serif;color:#e7e9f4}
  .kb-gh-sub{margin:0;font:500 11px/1.45 'Manrope',sans-serif;color:#8a8fa8}
  .kb-field{display:flex;flex-direction:column;gap:4px;font:600 10.5px 'Manrope',sans-serif;color:#8a8fa8}
  .kb-field input, .kb-field textarea{
    background:rgba(10,12,20,.7);color:#dde0ea;border:1px solid rgba(120,130,160,.25);border-radius:6px;
    padding:7px 9px;font:500 12px 'Manrope',sans-serif;resize:vertical;
  }
  .kb-field input:focus, .kb-field textarea:focus{outline:none;border-color:rgba(120,170,255,.6)}
  .kb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .kb-btn{
    height:30px;padding:0 12px;border-radius:7px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;
    font:600 11.5px 'Manrope',sans-serif;color:#dde0ea;background:rgba(255,255,255,.04);border:1px solid rgba(120,130,160,.3);
  }
  .kb-btn:hover:not(:disabled){background:rgba(255,255,255,.09)}
  .kb-btn:disabled{opacity:.5;cursor:not-allowed}
  .kb-btn-primary{color:#0a0e14;background:#c9a84c;border-color:#c9a84c}
  .kb-btn-primary:hover:not(:disabled){background:#d8b85a}
  .kb-btn:focus-visible, .kb-link:focus-visible, .kb-item:focus-visible{outline:2px solid rgba(120,170,255,.7);outline-offset:2px}
  .kb-link{background:none;border:none;padding:0;cursor:pointer;font:600 11px 'Manrope',sans-serif;color:#9fb4e8}
  .kb-link:hover{text-decoration:underline;text-underline-offset:2px}
  .kb-link-dim{color:#8a8fa8}
  .kb-msg{font:500 11px 'Manrope',sans-serif}
  .kb-msg.ok{color:#78dc8c}
  .kb-msg.bad{color:#ef8090}
  .kb-err{margin:0;font:500 11.5px 'Manrope',sans-serif;color:#ef8090}

  .kb-empty{padding:18px 16px;border-radius:9px;border:1px dashed rgba(120,130,160,.25);text-align:center}
  .kb-empty-t{font:700 13px 'Manrope',sans-serif;color:#dfe2ec;margin-bottom:4px}
  .kb-empty p{margin:0;font:500 11.5px/1.5 'Manrope',sans-serif;color:#8a8fa8}

  .kb-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
  .kb-item{
    width:100%;display:flex;flex-direction:column;gap:5px;padding:9px 12px;border-radius:8px;cursor:pointer;text-align:left;
    background:rgba(255,255,255,.02);border:1px solid rgba(120,130,160,.14);color:inherit;
  }
  .kb-item:hover{background:rgba(255,255,255,.05)}
  .kb-item.on{border-color:rgba(201,168,76,.55);background:rgba(201,168,76,.06)}
  .kb-item-t{font:700 12.5px/1.35 'Manrope',sans-serif;color:#e7e9f4}
  .kb-item-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font:500 10.5px 'Manrope',sans-serif;color:#7a7f92}
  .kb-status{font:700 9.5px 'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.4px;padding:1px 6px;border-radius:4px}
  .kb-tone-warn{color:#f0b874;background:rgba(240,184,116,.12)}
  .kb-tone-info{color:#9fb4e8;background:rgba(159,180,232,.12)}
  .kb-tone-ok{color:#78dc8c;background:rgba(120,220,140,.12)}
  .kb-tone-muted{color:#8a8fa8;background:rgba(120,130,160,.12)}
  .kb-area{font:500 10px 'JetBrains Mono',monospace;color:#d0b87a}
  .kb-count{font:700 10px 'JetBrains Mono',monospace;color:#ef8090}
  .kb-time{margin-left:auto}

  .kb-detail{display:flex;flex-direction:column;gap:9px;padding:12px;border-radius:9px;background:rgba(0,0,0,.2);border:1px solid rgba(120,130,160,.16)}
  .kb-preview-h{display:flex;align-items:center;justify-content:space-between;gap:8px;font:700 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;color:#8a8fa8;margin-top:4px}
  .kb-preview{border-radius:8px;border:1px solid rgba(120,130,160,.18);background:rgba(10,12,20,.6);padding:10px 12px}
  .kb-preview-title{font:700 13px 'Manrope',sans-serif;color:#f0f2f7;margin-bottom:5px}
  .kb-labels{display:flex;gap:5px;margin-bottom:8px}
  .kb-label{font:600 10px 'Manrope',sans-serif;padding:1px 8px;border-radius:999px;color:#ef8090;background:rgba(239,93,110,.12);border:1px solid rgba(239,93,110,.3)}
  .kb-preview-body{max-height:320px;overflow-y:auto;font:400 12px/1.55 'Manrope',sans-serif;color:#d0d4e0;word-break:break-word}
  .kb-actions{margin-top:2px}

  .kb-skel{display:flex;flex-direction:column;gap:8px}
  .kb-skel-line{
    display:block;height:34px;border-radius:8px;
    background:linear-gradient(90deg, rgba(120,130,160,.08) 0%, rgba(120,130,160,.2) 50%, rgba(120,130,160,.08) 100%);
    background-size:200% 100%;animation:kb-shimmer 1.3s ease-in-out infinite;
  }
  @keyframes kb-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
  @media (prefers-reduced-motion: reduce){ .kb-skel-line{animation:none} }
</style>
