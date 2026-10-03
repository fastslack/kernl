<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { timeAgo } from '$lib/llm-connect.js';
  import { bannerFor, isAuthError, summarize, type SyncReport } from '$lib/mail-sync.js';

  /** null until the first status load — the banner stays hidden meanwhile. */
  export let report: SyncReport | null = null;
  /** The account the list shows; '' = all accounts. */
  export let accountId = '';

  const dispatch = createEventDispatcher<{ select: string }>();

  function ago(iso: string | undefined): string {
    if (!iso) return '';
    const a = timeAgo(iso);
    return $t(a.key, { n: a.n });
  }

  $: account = report && accountId ? report.accounts.find((a) => a.account_id === accountId) ?? null : null;
  $: view = account ? bannerFor(account) : null;
  $: summary = report && !accountId ? summarize(report.accounts) : null;
  $: showSummary = !!summary && (summary.pending.length > 0 || summary.failing.length > 0);
  $: poll = report?.poll_minutes ?? 3;
</script>

{#if account && view}
  <div class="sync-banner tone-{view.tone}" role="status" aria-live="polite">
    <div class="sync-icon" aria-hidden="true">
      {#if view.tone === 'progress'}
        <span class="spinner"></span>
      {:else if view.tone === 'error'}
        ⚠️
      {:else if view.tone === 'ok'}
        ✅
      {:else}
        <span class="pulse">📬</span>
      {/if}
    </div>

    <div class="sync-text">
      {#if view.kind === 'waiting'}
        <div class="sync-title">{$t('mailsync.waiting.title')}</div>
        <p>{$t('mailsync.waiting.body', { email: account.email, poll, batch: report?.batch ?? 20 })}</p>
      {:else if view.kind === 'connecting'}
        <div class="sync-title">{$t('mailsync.connecting.title')}</div>
        <p>{$t('mailsync.connecting.body', { email: account.email })}</p>
      {:else if view.kind === 'downloading'}
        <div class="sync-title">{$t('mailsync.downloading.title')}</div>
        <p>{$t('mailsync.downloading.body', { done: account.fetch?.done ?? 0, total: account.fetch?.on_wire ?? 0, email: account.email })}</p>
        <div class="sync-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={view.percent ?? 0}>
          <div class="sync-bar-fill" style="width: {view.percent ?? 0}%"></div>
        </div>
      {:else if view.kind === 'error'}
        <div class="sync-title">{$t('mailsync.error.title', { email: account.email })}</div>
        {#if account.fetch?.error}
          <p class="sync-error-detail">{$t('mailsync.error.server', { error: account.fetch.error })}</p>
        {/if}
        <p>
          {isAuthError(account.fetch?.error) ? $t('mailsync.error.auth_hint') : $t('mailsync.error.retry_hint', { poll })}
          {#if account.fetch?.last_success_at}
            {$t('mailsync.error.last_ok', { ago: ago(account.fetch.last_success_at) })}
          {/if}
        </p>
        {#if isAuthError(account.fetch?.error)}
          <a class="sync-action" href="/mail/accounts">{$t('mailsync.error.accounts_link')} →</a>
        {/if}
      {:else if view.kind === 'empty'}
        <div class="sync-title">{$t('mailsync.empty.title')}</div>
        <p>{$t('mailsync.empty.body', { email: account.email, ago: ago(account.fetch?.last_success_at ?? account.fetch?.finished_at), poll })}</p>
      {:else if view.kind === 'gmail_waiting'}
        <div class="sync-title">{$t('mailsync.gmail.title')}</div>
        <p>{$t('mailsync.gmail.body')}</p>
      {/if}
    </div>
  </div>
{:else if summary && showSummary}
  <div class="sync-banner tone-{summary.failing.length && !summary.pending.length ? 'error' : 'progress'}" role="status" aria-live="polite">
    <div class="sync-icon" aria-hidden="true">
      {#if summary.pending.length}<span class="spinner"></span>{:else}⚠️{/if}
    </div>
    <div class="sync-text">
      <div class="sync-title">{$t('mailsync.summary.title')}</div>
      {#if summary.pending.length}
        <div class="sync-group">
          <span class="sync-group-label">{$t('mailsync.summary.pending')}</span>
          {#each summary.pending as a (a.account_id)}
            <button class="sync-chip" on:click={() => dispatch('select', a.account_id)}>
              {a.email}
              {#if a.fetch?.state === 'fetching' && a.fetch.on_wire}
                <span class="sync-chip-count">{a.fetch.done ?? 0}/{a.fetch.on_wire}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
      {#if summary.failing.length}
        <div class="sync-group">
          <span class="sync-group-label">{$t('mailsync.summary.failing')}</span>
          {#each summary.failing as a (a.account_id)}
            <button class="sync-chip chip-error" on:click={() => dispatch('select', a.account_id)}>{a.email}</button>
          {/each}
        </div>
      {/if}
      <p class="sync-meta">
        {#if summary.ready}{$t('mailsync.summary.ready', { n: summary.ready })} · {/if}{$t('mailsync.summary.hint')}
      </p>
    </div>
  </div>
{/if}

<style>
  .sync-banner {
    --tone: var(--blue, #3b82f6);
    display: flex;
    gap: 14px;
    align-items: flex-start;
    margin: 12px 12px 4px;
    padding: 14px 16px;
    border-radius: var(--radius, 10px);
    border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent);
    background: color-mix(in srgb, var(--tone) 10%, var(--surface-1, transparent));
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.5;
  }
  .tone-progress { --tone: var(--teal, #14b8a6); }
  .tone-error { --tone: var(--red, #f04770); }
  .tone-ok { --tone: var(--green, #22c55e); }

  .sync-icon {
    flex: none;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 18%, transparent);
    font-size: 17px;
  }
  .sync-text { flex: 1; min-width: 0; }
  .sync-title { font-weight: 600; font-size: 14px; margin-bottom: 2px; }
  .sync-text p { margin: 2px 0 0; color: var(--text-2); }
  .sync-error-detail {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    word-break: break-word;
  }
  .sync-meta { font-size: 12px; color: var(--text-3) !important; margin-top: 8px !important; }

  .sync-bar {
    margin-top: 10px;
    height: 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--tone) 18%, transparent);
    overflow: hidden;
  }
  .sync-bar-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--tone);
    transition: width 0.6s var(--ease-out, ease-out);
  }

  .sync-action {
    display: inline-block;
    margin-top: 8px;
    color: var(--tone);
    font-weight: 600;
    text-decoration: none;
  }
  .sync-action:hover { text-decoration: underline; }

  .sync-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
  .sync-group-label { font-size: 12px; color: var(--text-3); margin-right: 2px; }
  .sync-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--tone) 40%, transparent);
    background: var(--surface-2, transparent);
    color: var(--text-1);
    font-size: 12px;
    cursor: pointer;
  }
  .sync-chip:hover { border-color: var(--tone); }
  .chip-error { --tone: var(--red, #f04770); }
  .sync-chip-count { color: var(--text-3); font-variant-numeric: tabular-nums; }

  .spinner {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--tone) 30%, transparent);
    border-top-color: var(--tone);
    animation: sync-spin 0.9s linear infinite;
  }
  .pulse { animation: sync-pulse 1.8s ease-in-out infinite; }
  @keyframes sync-spin { to { transform: rotate(360deg); } }
  @keyframes sync-pulse { 50% { transform: scale(1.12); opacity: 0.75; } }
  @media (prefers-reduced-motion: reduce) {
    .spinner, .pulse { animation: none; }
    .sync-bar-fill { transition: none; }
  }
</style>
