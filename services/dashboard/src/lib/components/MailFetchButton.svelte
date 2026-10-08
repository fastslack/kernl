<script lang="ts">
  /**
   * ↻ next to the mail search: runs the IMAP Fetcher now instead of waiting
   * for its cron, and says how it went. `onTick` is the page's sync-status
   * poll, called while the run goes so new mail shows up as it lands.
   */
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { newCountFrom, runInboxFetch } from '$lib/mail-fetch.js';

  export let onTick: () => void | Promise<void> = () => {};

  let busy = false;
  let note = '';
  let failed = false;
  let detail = '';
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  function show(text: string, isError = false, why = ''): void {
    note = text; failed = isError; detail = why;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { note = ''; detail = ''; }, isError ? 12000 : 5000);
  }

  async function check(): Promise<void> {
    if (busy) return;
    busy = true; note = ''; detail = '';
    try {
      const out = await runInboxFetch(() => (destroyed ? undefined : onTick()));
      if (destroyed) return;
      if (out.status === 'running') show($t('mailsync.check.slow'));
      else if (out.status !== 'completed') show($t('mailsync.check.failed'), true, out.text);
      else {
        const n = newCountFrom(out.text);
        show(n === null ? $t('mailsync.check.done') : n > 0 ? $t('mailsync.check.found', { n: String(n) }) : $t('mailsync.check.none'));
      }
    } catch (e) {
      if (!destroyed) show($t('mailsync.check.failed'), true, e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  onDestroy(() => {
    destroyed = true;
    if (clearTimer) clearTimeout(clearTimer);
  });
</script>

<button type="button" class="mf-btn" on:click={check} disabled={busy}
        title={$t('mailsync.check.button')} aria-label={$t('mailsync.check.button')}>
  <svg class:mf-spin={busy} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
       stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
  </svg>
</button>
{#if busy || note}
  <span class="mf-note" class:err={failed} role="status" aria-live="polite" title={detail || undefined}>
    {busy ? $t('mailsync.check.running') : note}
  </span>
{/if}

<style>
  .mf-btn {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 32px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .mf-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
  .mf-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
  .mf-btn:disabled { cursor: progress; opacity: 0.8; }
  .mf-spin { animation: mf-rot 0.9s linear infinite; }
  @keyframes mf-rot { to { transform: rotate(360deg); } }
  .mf-note {
    flex: none;
    align-self: center;
    font-size: 11.5px;
    color: var(--text-2, var(--text));
    white-space: nowrap;
  }
  .mf-note.err { color: var(--red, #f87171); cursor: help; }
  @media (prefers-reduced-motion: reduce) { .mf-spin { animation: none; } }
</style>
