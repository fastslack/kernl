<!--
  FailureGroupCard — one problem in the chief's office: the same failure of
  one agent, however many times it repeated.

  It used to be the kernel's error line and nothing else ("failed", "Stale run
  cleaned up on startup"). Now it says, in this order: what happened in plain
  words and why (failure-explain.ts), what the run was trying to do and how far
  it got (its goal, trigger, steps, time and last step, fetched from the run),
  the kernel's own error text, and the one action that fixes it.
-->
<script lang="ts">
  import { t } from '$lib/i18n/index.js';
  import { fmtRelTime } from '$lib/display-format.js';
  import { LLM_SETTINGS_HREF } from '$lib/llm-error.js';
  import { explainFailure, type RunContext } from '$lib/office/failure-explain.js';
  import type { ReportGroup } from '$lib/office/report-groups.js';

  export let g: ReportGroup;
  /** The newest run's context; undefined while loading, null if it failed to load. */
  export let ctx: RunContext | null | undefined = undefined;
  /** "✓ audited 2/3" — only on the Errors tab. */
  export let audited: number | null = null;
  export let retrying = false;
  export let onOpen: () => void;
  export let onDismiss: () => void;
  export let onRetry: () => void;
  export let onSettings: () => void;
  /** "Report to Kernl": file this failure as a bug in Kernl itself (KernlBugsTab). */
  export let onReport: ((askChief: boolean) => Promise<void>) | null = null;
  /** Already filed from this card. */
  export let reported = false;
  export let onOpenKernl: () => void = () => {};

  let reportOpen = false;
  let reportBusy = false;
  let reportError = '';
  async function report(askChief: boolean): Promise<void> {
    if (!onReport || reportBusy) return;
    reportBusy = true;
    reportError = '';
    try {
      await onReport(askChief);
      reportOpen = false;
    } catch (e) {
      reportError = (e as Error).message;
    } finally {
      reportBusy = false;
    }
  }


  // A report that only carried the status ("failed") reads the run's own error.
  $: errorText = !g.text.trim() || /^failed\.?$/i.test(g.text.trim()) ? (ctx?.error || g.text) : g.text;
  $: ex = explainFailure(errorText);

  function fmtDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }
</script>

<div class="fg">
  <div class="fg-head">
    <span class="fg-dot" style="background:{g.color}"></span>
    <span class="fg-name" style="color:{g.color}">{g.agentName}</span>
    {#if g.count > 1}<span class="fg-count" title={$t('office.chief.repeats_title')}>×{g.count}</span>{/if}
    {#if audited !== null}
      {#if audited > 0}
        <span class="fg-audit fg-audit-ok" title={$t('office.chief.audited_title')}>✓ {$t('office.chief.audited')}{g.count > 1 ? ` ${audited}/${g.count}` : ''}</span>
      {:else}
        <span class="fg-audit" title={$t('office.chief.audit_pending_title')}>● {$t('office.chief.audit_pending')}</span>
      {/if}
    {/if}
    <span class="fg-time">{fmtRelTime(new Date(g.latestTs).toISOString())}</span>
  </div>

  <button class="fg-main" type="button" on:click={onOpen} title={$t('office.chief.see_report')}>
    <span class="fg-title fg-kind-{ex.kind}">{$t(ex.titleKey, ex.params)}</span>
    <span class="fg-why">{$t(ex.whyKey, ex.params)}</span>
  </button>

  <!-- What it was doing when it stopped. -->
  {#if ctx === undefined}
    <div class="fg-ctx fg-ctx-loading"><span class="fg-skel"></span><span class="fg-skel fg-skel-short"></span></div>
  {:else if ctx}
    <dl class="fg-ctx">
      {#if ctx.goal}<dt>{$t('office.fail.ctx_goal')}</dt><dd class="fg-goal" title={ctx.goal}>{ctx.goal}</dd>{/if}
      <dt>{$t('office.fail.ctx_run')}</dt>
      <dd>
        {#if ctx.trigger}<span class="fg-chip">{ctx.trigger}</span>{/if}
        {$t('office.fail.ctx_steps', { n: String(ctx.steps) })}{#if ctx.durationMs !== null} · {fmtDuration(ctx.durationMs)}{/if}
      </dd>
      {#if ctx.lastStep}<dt>{$t('office.fail.ctx_last')}</dt><dd class="fg-last" title={ctx.lastStep}>{ctx.lastStep}</dd>{/if}
    </dl>
  {/if}

  <code class="fg-raw" title={errorText}>{errorText || '—'}</code>

  <div class="fg-actions">
    {#if ex.fix === 'settings'}
      <button class="fg-fix" type="button" on:click={onSettings}>{$t('office.fail.fix_settings')}</button>
    {:else if ex.fix === 'llm'}
      <a class="fg-fix" href={LLM_SETTINGS_HREF}>{$t('office.fail.fix_llm')}</a>
    {/if}
    <button class="fg-fix" class:fg-fix-2={ex.fix !== 'retry'} type="button" on:click={onRetry} disabled={retrying}>
      {retrying ? '…' : $t('office.fail.fix_retry')}
    </button>
    {#if onReport && g.reports[0].runId}
      {#if reported}
        <button class="fg-link fg-reported" type="button" on:click={onOpenKernl}>{$t('office.kernl.reported')} ↗</button>
      {:else}
        <span class="fg-report">
          <button class="fg-link" type="button" aria-haspopup="menu" aria-expanded={reportOpen}
                  on:click={() => (reportOpen = !reportOpen)} disabled={reportBusy}>
            {reportBusy ? '…' : $t('office.kernl.report')}
          </button>
          {#if reportOpen}
            <span class="fg-report-menu" role="menu">
              <button role="menuitem" type="button" on:click={() => report(true)}>{$t('office.kernl.report_ask_chief')}</button>
              <button role="menuitem" type="button" on:click={() => report(false)}>{$t('office.kernl.report_as_is')}</button>
            </span>
          {/if}
          {#if reportError}<span class="fg-report-err">{reportError}</span>{/if}
        </span>
      {/if}
    {/if}
    <span class="fg-spacer"></span>
    <button class="fg-link" type="button" on:click={onOpen}>{$t('office.chief.see_report')}</button>
    <button class="fg-link fg-link-dim" type="button" on:click={onDismiss}>
      {g.count > 1 ? $t('office.chief.dismiss_n', { n: String(g.count) }) : $t('office.chief.dismiss')}
    </button>
  </div>
</div>

<style>
  .fg{
    border-radius:9px;padding:10px 12px;display:flex;flex-direction:column;gap:7px;
    background:rgba(239,93,110,.045);
    border:1px solid rgba(239,93,110,.2);border-left:3px solid rgba(239,93,110,.7);
  }
  .fg-head{display:flex;align-items:center;gap:7px;min-width:0}
  .fg-dot{width:7px;height:7px;border-radius:50%;flex:none}
  .fg-name{font:700 12px 'Manrope',sans-serif}
  .fg-count{
    font:700 10px 'JetBrains Mono',monospace;padding:1px 6px;border-radius:4px;
    color:#ef5d6e;background:rgba(239,93,110,.14);border:1px solid rgba(239,93,110,.3);
  }
  .fg-audit{
    font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.4px;padding:2px 6px;border-radius:4px;
    color:#c9a84c;background:rgba(201,168,76,.08);border:1px dashed rgba(201,168,76,.3);
  }
  .fg-audit-ok{color:#78dc8c;background:rgba(120,220,140,.12);border:1px solid rgba(120,220,140,.3)}
  .fg-time{margin-left:auto;font:500 10px 'JetBrains Mono',monospace;color:#6a6f82}

  .fg-main{display:flex;flex-direction:column;gap:2px;padding:0;background:none;border:none;text-align:left;cursor:pointer;color:inherit}
  .fg-title{font:700 13px 'Manrope',sans-serif;color:#f6c3ca}
  .fg-kind-restart{color:#c4c8d6}
  .fg-why{font:500 11.5px/1.45 'Manrope',sans-serif;color:#a8aec4}
  .fg-main:hover .fg-title{text-decoration:underline;text-underline-offset:2px}

  .fg-ctx{
    display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;margin:0;
    padding:7px 9px;border-radius:7px;background:rgba(0,0,0,.22);border:1px solid rgba(120,130,160,.1);
    font:500 11px/1.4 'Manrope',sans-serif;
  }
  .fg-ctx dt{color:#7a7f92;white-space:nowrap}
  .fg-ctx dd{margin:0;color:#c9cdda;min-width:0}
  .fg-goal, .fg-last{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fg-last{font:500 10.5px 'JetBrains Mono',monospace;color:#d0b87a}
  .fg-chip{
    font:600 9.5px 'JetBrains Mono',monospace;padding:0 5px;margin-right:5px;border-radius:4px;
    color:#a0a5b8;background:rgba(120,130,160,.14);
  }
  .fg-ctx-loading{display:flex;flex-direction:column;gap:6px}
  .fg-skel{
    height:8px;width:85%;border-radius:4px;
    background:linear-gradient(90deg, rgba(120,130,160,.1) 0%, rgba(120,130,160,.24) 50%, rgba(120,130,160,.1) 100%);
    background-size:200% 100%;animation:fg-shimmer 1.3s ease-in-out infinite;
  }
  .fg-skel-short{width:50%}
  @keyframes fg-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}

  .fg-raw{
    display:block;font:500 10.5px/1.4 'JetBrains Mono',monospace;color:#e8a3ad;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }

  .fg-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .fg-fix{
    height:26px;padding:0 10px;border-radius:6px;cursor:pointer;text-decoration:none;
    display:inline-flex;align-items:center;
    font:600 11px 'Manrope',sans-serif;color:#0a0e14;background:#dde0ea;border:1px solid #dde0ea;
  }
  .fg-fix:hover:not(:disabled){background:#fff}
  .fg-fix-2{color:#dde0ea;background:rgba(255,255,255,.04);border-color:rgba(120,130,160,.3)}
  .fg-fix-2:hover:not(:disabled){background:rgba(255,255,255,.09)}
  .fg-fix:disabled{opacity:.6;cursor:wait}
  .fg-fix:focus-visible, .fg-link:focus-visible{outline:2px solid rgba(120,170,255,.7);outline-offset:2px}
  .fg-spacer{flex:1}
  .fg-link{background:none;border:none;padding:0;cursor:pointer;font:600 11px 'Manrope',sans-serif;color:#9fb4e8}
  .fg-link:hover{color:#c4d3f7;text-decoration:underline;text-underline-offset:2px}
  .fg-link-dim{color:#8a8fa8}
  .fg-link-dim:hover{color:#dde0ea}
  @media (prefers-reduced-motion: reduce){ .fg-skel{animation:none} }
  /* Report to Kernl — a link-weight action with a two-item menu. */
  .fg-report{position:relative}
  .fg-report-menu{
    position:absolute;left:0;bottom:calc(100% + 6px);z-index:5;min-width:230px;padding:5px;border-radius:8px;
    display:flex;flex-direction:column;background:#11131d;border:1px solid rgba(120,130,160,.28);
    box-shadow:0 14px 30px -10px rgba(0,0,0,.7);
  }
  .fg-report-menu button{
    padding:7px 10px;border-radius:6px;border:none;background:none;cursor:pointer;text-align:left;
    font:600 11.5px 'Manrope',sans-serif;color:#dde0ea;
  }
  .fg-report-menu button:hover{background:rgba(255,255,255,.06)}
  .fg-reported{color:#78dc8c}
  .fg-report-err{font:500 11px 'Manrope',sans-serif;color:#ef8090}
</style>
