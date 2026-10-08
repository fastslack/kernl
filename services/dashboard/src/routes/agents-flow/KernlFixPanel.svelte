<!--
  KernlFixPanel — the "Que lo arregle Claude Code" block of an open Kernl bug.

  The kernel runs the fixer agent on an isolated worktree and branch
  (kernl-bugs-fix.ts); this block starts it, follows it while it runs
  (polling, since a run lasts minutes) and shows what it left: the branch,
  the changed files, the agent's summary and the diff. Integrating the branch
  is left to the operator.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { confirm as confirmDialog } from '$shared/feedback';
  import { formatRunOutput } from '$lib/run-format.js';
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import { bugsApi, FIX_ACTIVE, type KernlBug, type KernlFix, type FixPreflight, type FixStatus } from '$lib/kernl-bugs.js';

  export let bug: KernlBug;
  /** Called whenever the fix status changes, so the list can show it. */
  export let onStatus: (id: string, status: FixStatus | null) => void = () => {};
  export let onOutputClick: (e: MouseEvent) => void = () => {};

  let fix: KernlFix | null = null;
  let pre: FixPreflight | null = null;
  let loading = true;
  let busy: '' | 'start' | 'discard' = '';
  let error = '';
  let showDiff = false;
  let diff = '';
  let diffLoading = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  let tickNow = Date.now();

  $: active = !!fix && FIX_ACTIVE.has(fix.status);
  $: canStart = (bug.status === 'new' || bug.status === 'published')
    && (!fix || fix.status === 'failed' || fix.status === 'no_changes' || fix.status === 'discarded');
  $: elapsed = fix ? fmtElapsed(tickNow - Date.parse(fix.started_at)) : '';

  function fmtElapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
  }

  function setFix(f: KernlFix | null): void {
    const before = fix?.status ?? null;
    fix = f;
    const now = f && f.status !== 'discarded' ? f.status : null;
    if (now !== before) onStatus(bug.id, now);
    if (active && !poll) poll = setInterval(refresh, 4000);
    if (!active && poll) { clearInterval(poll); poll = null; }
  }

  async function refresh(): Promise<void> {
    tickNow = Date.now();
    try { setFix(await bugsApi.fix(bug.id)); } catch { /* keep the last state; the next tick retries */ }
  }

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      const [f, p] = await Promise.all([bugsApi.fix(bug.id), bugsApi.fixPreflight()]);
      pre = p;
      setFix(f);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  onMount(load);
  onDestroy(() => { if (poll) clearInterval(poll); });

  async function start(): Promise<void> {
    if (busy) return;
    if (!(await confirmDialog({ title: $t('office.kernl.fix_confirm_start', { title: bug.title }) }))) return;
    busy = 'start';
    error = '';
    showDiff = false;
    diff = '';
    try { setFix(await bugsApi.startFix(bug.id)); }
    catch (e) { error = (e as Error).message; }
    finally { busy = ''; }
  }

  async function discard(): Promise<void> {
    if (busy || !fix) return;
    if (!(await confirmDialog({ title: $t('office.kernl.fix_confirm_discard', { branch: fix.branch }) }))) return;
    busy = 'discard';
    error = '';
    try { setFix(await bugsApi.discardFix(bug.id)); showDiff = false; diff = ''; }
    catch (e) { error = (e as Error).message; }
    finally { busy = ''; }
  }

  async function toggleDiff(): Promise<void> {
    showDiff = !showDiff;
    if (!showDiff || diff) return;
    diffLoading = true;
    try { diff = await bugsApi.fixDiff(bug.id); }
    catch (e) { error = (e as Error).message; showDiff = false; }
    finally { diffLoading = false; }
  }

  const lineClass = (l: string) =>
    l.startsWith('+++') || l.startsWith('---') ? 'meta'
    : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk'
    : l.startsWith('diff ') ? 'file' : '';
</script>

<section class="kf" aria-live="polite">
  <div class="kf-h">
    <span class="kf-title">{$t('office.kernl.fix_h')}</span>
    {#if fix && (fix.status === 'ready' || fix.status === 'failed') && fix.branch && fix.commit_sha}
      <span class="kf-branch"><code>{fix.branch}</code><CopyTextBtn inline title={$t('office.kernl.fix_copy_branch')} text={fix.branch} /></span>
    {/if}
  </div>

  {#if loading}
    <div class="kf-line"><span class="kf-spin" aria-hidden="true"></span>{$t('office.kernl.fix_checking')}</div>
  {:else if active && fix}
    <div class="kf-progress" role="status">
      <span class="kf-spin" aria-hidden="true"></span>
      <span>
        {#if fix.status === 'preparing'}{$t('office.kernl.fix_preparing')}
        {:else if fix.status === 'committing'}{$t('office.kernl.fix_committing')}
        {:else}{$t('office.kernl.fix_running', { elapsed })}{/if}
      </span>
      <span class="kf-bar" aria-hidden="true"></span>
    </div>
  {:else}
    {#if fix?.status === 'ready'}
      <div class="kf-state ok">✓ {$t('office.kernl.fix_ready', { branch: fix.branch })}</div>
    {:else if fix?.status === 'no_changes'}
      <div class="kf-state">{$t('office.kernl.fix_no_changes')}</div>
    {:else if fix?.status === 'failed'}
      <div class="kf-state bad">{$t('office.kernl.fix_failed')}{fix.error ? `: ${fix.error}` : ''}</div>
    {/if}

    {#if fix && (fix.status === 'ready' || fix.status === 'failed') && fix.files.length}
      <div class="kf-sub">{$t('office.kernl.fix_files', { n: fix.files.length })}</div>
      <ul class="kf-files">
        {#each fix.files as f (f.path)}
          <li><span class="kf-fs kf-fs-{f.status[0]}">{f.status[0]}</span><code>{f.path}</code></li>
        {/each}
      </ul>
    {/if}

    {#if fix && fix.summary && fix.status !== 'discarded'}
      <details class="kf-summary" open={fix.status === 'ready' || fix.status === 'no_changes'}>
        <summary>{$t('office.kernl.fix_summary')}</summary>
        <div class="ip-out-md" on:click={onOutputClick} role="presentation">{@html formatRunOutput(fix.summary)}</div>
      </details>
    {/if}

    {#if showDiff}
      {#if diffLoading}
        <div class="kf-line"><span class="kf-spin" aria-hidden="true"></span>{$t('office.kernl.fix_diff_loading')}</div>
      {:else}
        <pre class="kf-diff">{#each diff.split('\n') as l, i (i)}<span class="kf-dl {lineClass(l)}">{l}
</span>{/each}</pre>
      {/if}
    {/if}

    <div class="kf-row">
      {#if canStart}
        <button class="kf-btn kf-btn-primary" type="button" on:click={start} disabled={!!busy || !pre?.ok}>
          {#if busy === 'start'}<span class="kf-spin" aria-hidden="true"></span>{/if}
          {fix && fix.status !== 'discarded' ? $t('office.kernl.fix_retry') : $t('office.kernl.fix_start')}
        </button>
      {/if}
      {#if fix?.commit_sha && (fix.status === 'ready' || fix.status === 'failed')}
        <button class="kf-btn" type="button" on:click={toggleDiff} aria-expanded={showDiff}>
          {showDiff ? $t('office.kernl.fix_diff_hide') : $t('office.kernl.fix_diff_show')}
        </button>
      {/if}
      {#if fix && (fix.status === 'ready' || fix.status === 'failed' || fix.status === 'no_changes')}
        <button class="kf-btn kf-btn-ghost" type="button" on:click={discard} disabled={!!busy}>
          {#if busy === 'discard'}<span class="kf-spin" aria-hidden="true"></span>{$t('office.kernl.fix_discarding')}{:else}{$t('office.kernl.fix_discard')}{/if}
        </button>
      {/if}
    </div>

    {#if fix?.status === 'ready'}
      <p class="kf-note">{$t('office.kernl.fix_integrate')}</p>
    {:else if canStart && pre && !pre.ok}
      <div class="kf-warn">
        <strong>{$t('office.kernl.fix_unavailable')}</strong>
        <ul>{#each pre.reasons as r (r)}<li>{r}</li>{/each}</ul>
      </div>
    {:else if canStart}
      <p class="kf-note">{$t('office.kernl.fix_hint')}</p>
    {/if}
  {/if}

  {#if error}<p class="kf-err" role="alert">{error}</p>{/if}
</section>

<style>
  .kf{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:8px;
    background:rgba(120,140,255,.04);border:1px solid rgba(140,160,255,.2)}
  .kf-h{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .kf-title{font:700 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;color:#9fb4e8}
  .kf-branch{display:inline-flex;align-items:center;gap:4px}
  .kf-branch code{font:600 10.5px 'JetBrains Mono',monospace;color:#d0b87a}
  .kf-line, .kf-progress{display:flex;align-items:center;gap:8px;font:500 11.5px 'Manrope',sans-serif;color:#a8aec4}
  .kf-progress{position:relative;padding:8px 10px;border-radius:7px;background:rgba(10,12,20,.45);overflow:hidden}
  .kf-bar{position:absolute;left:0;bottom:0;height:2px;width:30%;background:#9fb4e8;animation:kf-slide 1.6s ease-in-out infinite}
  @keyframes kf-slide{from{transform:translateX(-100%)}to{transform:translateX(340%)}}
  .kf-state{font:600 12px 'Manrope',sans-serif;color:#cdd2e0}
  .kf-state.ok{color:#78dc8c}
  .kf-state.bad{color:#ef8090;word-break:break-word}
  .kf-sub{font:600 10.5px 'Manrope',sans-serif;color:#8a8fa8}
  .kf-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:140px;overflow:auto}
  .kf-files li{display:flex;align-items:center;gap:7px;font:500 11px 'JetBrains Mono',monospace;color:#cdd2e0}
  .kf-fs{width:16px;text-align:center;font-weight:700;border-radius:3px}
  .kf-fs-M{color:#f0b874}
  .kf-fs-A{color:#78dc8c}
  .kf-fs-D{color:#ef8090}
  .kf-fs-R{color:#9fb4e8}
  .kf-summary{font:400 12px/1.5 'Manrope',sans-serif;color:#d0d4e0}
  .kf-summary summary{cursor:pointer;font:600 11px 'Manrope',sans-serif;color:#9fb4e8;margin-bottom:4px}
  .kf-summary > div{max-height:220px;overflow:auto;padding:8px 10px;border-radius:7px;background:rgba(10,12,20,.5)}
  .kf-diff{margin:0;max-height:340px;overflow:auto;padding:8px 10px;border-radius:7px;background:rgba(6,8,14,.85);
    border:1px solid rgba(120,130,160,.18);font:500 11px/1.45 'JetBrains Mono',monospace;color:#b8bdcc;white-space:pre}
  .kf-dl.add{color:#78dc8c}
  .kf-dl.del{color:#ef8090}
  .kf-dl.hunk{color:#9fb4e8}
  .kf-dl.file, .kf-dl.meta{color:#d0b87a;font-weight:700}
  .kf-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .kf-btn{height:30px;padding:0 12px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;
    font:600 11.5px 'Manrope',sans-serif;color:#dde0ea;background:rgba(255,255,255,.04);border:1px solid rgba(120,130,160,.3);
    transition:background .15s ease}
  .kf-btn:hover:not(:disabled){background:rgba(255,255,255,.09)}
  .kf-btn:disabled{opacity:.5;cursor:not-allowed}
  .kf-btn:focus-visible{outline:2px solid rgba(120,170,255,.7);outline-offset:2px}
  .kf-btn-primary{color:#0a0e14;background:#9fb4e8;border-color:#9fb4e8}
  .kf-btn-primary:hover:not(:disabled){background:#b4c5ee}
  .kf-btn-ghost{background:none;border-color:transparent;color:#8a8fa8}
  .kf-btn-ghost:hover:not(:disabled){color:#ef8090;background:rgba(239,93,110,.08)}
  .kf-note{margin:0;font:500 11px/1.45 'Manrope',sans-serif;color:#8a8fa8}
  .kf-warn{padding:8px 10px;border-radius:7px;font:500 11px/1.45 'Manrope',sans-serif;color:#f0b874;
    background:rgba(240,184,116,.07);border:1px solid rgba(240,184,116,.25)}
  .kf-warn ul{margin:4px 0 0;padding-left:16px;color:#d8c4a0}
  .kf-err{margin:0;font:500 11.5px 'Manrope',sans-serif;color:#ef8090}
  .kf-spin{width:11px;height:11px;border-radius:50%;flex:none;display:inline-block;
    border:2px solid currentColor;border-right-color:transparent;animation:kf-rot .7s linear infinite}
  @keyframes kf-rot{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion: reduce){ .kf-bar{animation:none} .kf-spin{animation-duration:2s} }
</style>
