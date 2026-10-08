<script lang="ts">
  /**
   * "Connect with my subscription" for Claude Code, on its own so it can sit
   * wherever the missing session shows up (the connect dialog, an agent that
   * paused on "Not logged in", a chat reply) instead of sending the operator
   * to Settings to find it.
   *
   * The kernel runs the official CLI's sign-in, which opens the approval page;
   * this polls until it exits. In Docker the page is opened here and the
   * redirect comes back by paste. `onDone` is awaited before the done state
   * shows, so the caller can wire the session in (Detect) or resume an agent.
   */
  import { onDestroy, onMount } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import {
    cancelClaudeLogin, claudeLoginStatus, deliverClaudeLogin, fetchCatalog, startClaudeLogin,
    type ClaudeLoginStatus,
  } from '$lib/llm-connect.js';

  /** The kernel can open Claude's approval page itself (a native install). null: ask the catalog. */
  export let browserLogin: boolean | null = null;
  /** Docker: open the approval page here and take the redirect back by paste. null: ask the catalog. */
  export let pasteLogin: boolean | null = null;
  export let disabled = false;
  /** Shown instead of the button once signed in; the connect dialog has its own status box. */
  export let showDone = false;
  /** Where to send the operator when this install cannot sign in from the dashboard. */
  export let fallbackHref = '/settings?section=ai&card=providers&connect=claude-code';
  export let onStart: () => void = () => {};
  export let onDone: () => void | Promise<void> = () => {};

  let login: ClaudeLoginStatus = { state: 'idle' };
  let loginTimer: ReturnType<typeof setTimeout> | null = null;
  let pasted = '';
  let delivering = false;
  let deliverError = '';
  let tabBlocked = false;
  let done = false;
  const pasteId = `cs-paste-${Math.random().toString(36).slice(2, 8)}`;
  let resolved = browserLogin !== null && pasteLogin !== null;

  $: available = !!(browserLogin || pasteLogin);
  $: loginErrorKey = login.error === 'timeout' ? 'llm.cc_login_timeout'
    : login.error === 'no_cli' ? 'llm.cc_login_no_cli' : 'llm.cc_login_failed';

  onMount(async () => {
    if (resolved) return;
    try {
      const c = await fetchCatalog();
      if (browserLogin === null) browserLogin = c.claudeCodeBrowserLogin ?? false;
      if (pasteLogin === null) pasteLogin = c.claudeCodePasteLogin ?? false;
    } catch {
      if (browserLogin === null) browserLogin = false;
      if (pasteLogin === null) pasteLogin = false;
    }
    resolved = true;
  });

  async function signIn(): Promise<void> {
    onStart();
    done = false; pasted = ''; deliverError = ''; tabBlocked = false;
    // Docker: the tab has to be opened inside the click, or the browser blocks
    // it as a popup; it is pointed at the approval page once the kernel has it.
    const tab = pasteLogin ? window.open('about:blank', '_blank') : null;
    try {
      login = await startClaudeLogin();
      if (pasteLogin) {
        for (let i = 0; i < 20 && login.state === 'waiting' && !login.authorizeUrl; i++) {
          await new Promise((r) => setTimeout(r, 300));
          login = await claudeLoginStatus();
        }
        if (tab && login.authorizeUrl) {
          tab.opener = null;
          tab.location.href = login.authorizeUrl;
        } else {
          tab?.close();
          tabBlocked = true;
        }
      }
    } catch (e) {
      tab?.close();
      login = { state: 'failed', error: 'exit', detail: e instanceof Error ? e.message : String(e) };
    }
    pollLogin();
  }

  async function deliverPaste(): Promise<void> {
    delivering = true; deliverError = '';
    try {
      const r = await deliverClaudeLogin(pasted);
      if (r.deliverError) deliverError = r.deliverError;
      else login = r;
    } catch {
      deliverError = 'unreachable';
    }
    delivering = false;
  }

  function pollLogin(): void {
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = null;
    if (login.state === 'done') { login = { state: 'idle' }; void finish(); return; }
    if (login.state !== 'waiting') return;
    loginTimer = setTimeout(async () => {
      try { login = await claudeLoginStatus(); } catch { /* keep waiting; the next poll retries */ }
      pollLogin();
    }, 1500);
  }

  async function finish(): Promise<void> {
    try { await onDone(); } catch { /* the caller reports its own failure */ }
    done = true;
  }

  async function cancelSignIn(): Promise<void> {
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = null;
    try { login = await cancelClaudeLogin(); } catch { login = { state: 'idle' }; }
  }

  onDestroy(() => {
    if (loginTimer) clearTimeout(loginTimer);
    // Closing the panel mid-flow must not leave the CLI waiting for ten minutes.
    if (login.state === 'waiting') void cancelClaudeLogin().catch(() => {});
  });
</script>

{#if !resolved}
  <span class="cs-muted">…</span>
{:else if !available}
  <a class="cs-btn primary" href={fallbackHref}>{$t('llm.cc_open_settings')} →</a>
{:else if done && showDone}
  <span class="cs-done" role="status">✓ {$t('llm.cc_login_done')}</span>
{:else}
  <div class="cs">
    <div class="cs-row">
      {#if login.state === 'waiting'}
        <span class="cs-state cs-grow" role="status" aria-live="polite"><span class="cs-spin" aria-hidden="true"></span>{$t(pasteLogin ? 'llm.cc_paste_waiting' : 'llm.cc_login_waiting')}</span>
        <button type="button" class="cs-btn ghost" on:click={cancelSignIn}>{$t('llm.cc_login_cancel')}</button>
      {:else}
        <button type="button" class="cs-btn primary" on:click={signIn} {disabled}>{$t('llm.cc_login')}</button>
      {/if}
    </div>
    <!-- Native: no "didn't open?" link while waiting. The URL the CLI
         prints redirects to a page with a code to paste back, and
         `auth login` never reads one; the terminal route covers that. -->
    {#if login.state === 'waiting' && pasteLogin}
      {#if login.authorizeUrl}
        <a class="cs-open" href={login.authorizeUrl} target="_blank" rel="noopener noreferrer">
          {$t(tabBlocked ? 'llm.cc_paste_open' : 'llm.cc_paste_reopen')} ↗
        </a>
      {/if}
      <p class="cs-muted">{$t('llm.cc_paste_steps')}</p>
      <label class="cs-label" for={pasteId}>{$t('llm.cc_paste_label')}</label>
      <div class="cs-row">
        <input id={pasteId} class="cs-input cs-grow" bind:value={pasted}
               placeholder="http://localhost:…/callback?code=…" spellcheck="false" autocomplete="off" />
        <button type="button" class="cs-btn primary" on:click={deliverPaste} disabled={!pasted.trim() || delivering}>{$t('llm.cc_paste_submit')}</button>
      </div>
      {#if deliverError}<p class="cs-warn" role="alert">{$t(`llm.cc_paste_err_${deliverError}`)}</p>{/if}
    {:else if login.state === 'failed'}
      <p class="cs-warn" role="alert">{$t(loginErrorKey)}</p>
      {#if login.detail}<pre class="cs-detail">{login.detail}</pre>{/if}
    {:else if login.state !== 'waiting'}
      <p class="cs-muted">{$t(pasteLogin ? 'llm.cc_paste_hint' : 'llm.cc_login_hint')}</p>
    {/if}
  </div>
{/if}

<style>
  .cs { display: flex; flex-direction: column; gap: 8px; }
  .cs-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .cs-grow { flex: 1; min-width: 0; }
  .cs-muted { margin: 0; font-size: 12px; color: var(--text-2); line-height: 1.45; }
  .cs-label { margin: 4px 0 0; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--text-2); }
  .cs-warn { margin: 0; font-size: 12px; color: var(--orange); }
  .cs-done { font-size: 13px; color: var(--green); }
  .cs-open { font-size: 12px; color: var(--teal); text-decoration: none; }
  .cs-open:hover { text-decoration: underline; }
  .cs-input {
    min-height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface-1); color: var(--text-1); font-family: var(--font-mono); font-size: 13px;
  }
  .cs-input:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .cs-state {
    display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 8px 12px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface-1); font-size: 13px; color: var(--text-1);
  }
  .cs-spin {
    width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border-h); border-top-color: var(--teal);
    animation: cs-rot 0.8s linear infinite;
  }
  @keyframes cs-rot { to { transform: rotate(360deg); } }
  .cs-detail {
    margin: 0; max-height: 84px; overflow: auto; padding: 8px; border-radius: var(--radius-sm);
    background: var(--surface-1); font-family: var(--font-mono); font-size: 11px; color: var(--text-2); white-space: pre-wrap;
  }
  .cs-btn {
    min-height: 40px; padding: 8px 16px; border-radius: var(--radius-sm); font-size: 14px; font-weight: 600;
    cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; align-self: flex-start;
    transition: background 150ms ease-out, border-color 150ms ease-out;
  }
  .cs-btn:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .cs-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .cs-btn.ghost { border: 1px solid var(--border); background: transparent; color: var(--text-1); }
  .cs-btn.ghost:hover:not(:disabled) { border-color: var(--border-h); }
  .cs-btn.primary { border: 1px solid var(--teal); background: var(--teal); color: #06201d; }
  @media (prefers-reduced-motion: reduce) {
    .cs-spin { animation: none; }
    .cs-btn { transition: none; }
  }
</style>
