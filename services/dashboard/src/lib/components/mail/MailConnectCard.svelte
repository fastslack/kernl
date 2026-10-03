<script lang="ts">
  /**
   * One-step mail connection: email + password → auto-detected IMAP/SMTP,
   * tested before saving. `mode="card"` is the Settings tile (keeps its own
   * account list); `mode="step"` is the same flow embedded as a wizard step
   * (no list, starts on the form, has a "skip" way out).
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import type { I18nKey } from '$lib/i18n/en.js';
  import StatusPill from '$lib/components/settings/StatusPill.svelte';
  import {
    discoverMail, connectMail, listMailAccounts, fetchGoogleConfigured,
    type Discovery, type MailAccount, type ConnectResult, type ServerEndpoint,
  } from '$lib/mail-connect.js';

  export let mode: 'card' | 'step' = 'card';

  const dispatch = createEventDispatcher<{ connected: MailAccount; skip: void }>();

  type View = 'list' | 'form' | 'testing' | 'done';
  let view: View = mode === 'step' ? 'form' : 'list';
  let accounts: MailAccount[] = [];
  let email = '';
  let password = '';
  let showPassword = false;
  let discovery: Discovery | null = null;
  let detecting = false;
  let detectSeq = 0;
  let advancedOpen = false;
  let advancedTouched = false;
  let imap: ServerEndpoint = { host: '', port: 993, secure: true };
  let smtp: ServerEndpoint = { host: '', port: 465, secure: true };
  let user = '';
  let result: ConnectResult | null = null;
  let google: { configured: boolean; authUrl?: string } = { configured: false };
  let cardEl: HTMLElement | null = null;

  $: auth = discovery?.provider.auth ?? 'password';
  $: providerName = discovery?.provider.name ?? '';
  $: canSubmit = !!email && !!password && auth !== 'oauth_only' && view !== 'testing';
  $: errorCode = result && !result.ok ? result.code : null;
  $: notDetected = errorCode === 'unreachable' && discovery?.source === 'guess';
  $: errorKey = (errorCode
    ? notDetected ? 'mail.connect.err.not_detected' : `mail.connect.err.${errorCode}`
    : '') as I18nKey;
  $: errorDetail = result && !result.ok ? result.detail : '';
  $: isGmail = discovery?.provider.id === 'gmail';
  $: showGoogleOauth = google.configured && isGmail && auth !== 'oauth_only';
  $: readOnly = result && result.ok ? result.readOnly : false;
  $: bridgeErrorIsDuplicate = auth === 'bridge' && errorCode === 'bridge';

  async function refresh(): Promise<void> {
    accounts = await listMailAccounts();
  }

  /**
   * After a submit, the result (error or success) may render above the
   * user's current scroll position inside `.mc-scroll` — e.g. they scrolled
   * down to Advanced before pressing the pinned Connect button. Bring the
   * box that reflects THIS submit's outcome into view — marked `data-result`
   * (the generic error box, or in the done view the read-only warning when
   * present, else the success box) so a leftover guidance box from before
   * the submit (e.g. the top bridge notice, which stays on screen when the
   * auth is `bridge` but the submit failed with a different code) is never
   * picked instead — without moving focus away from the button (the ARIA
   * live region already covers screen readers).
   */
  async function revealResult(): Promise<void> {
    await tick();
    const box = cardEl?.querySelector<HTMLElement>('[data-result]');
    if (!box) return;
    const reduceMotion =
      typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    box.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function onEmailInput(): void {
    // The user is typing a different address: drop the previous address's
    // detection and connect result so its app-password/oauth/bridge guidance
    // and any stale error don't linger on the new address.
    discovery = null;
    result = null;
  }

  async function detect(): Promise<void> {
    const target = email;
    if (!target.includes('@')) return;
    const seq = ++detectSeq;
    detecting = true;
    const found = await discoverMail(target);
    // A newer lookup owns the "detecting" flag; an older one only leaves.
    if (seq !== detectSeq) return;
    detecting = false;
    if (target !== email) return; // email changed while this call was in flight: drop the stale answer
    discovery = found;
    if (discovery?.imap && !advancedTouched) imap = { ...discovery.imap };
    if (discovery?.smtp && !advancedTouched) smtp = { ...discovery.smtp };
    if (discovery?.provider.auth === 'bridge') advancedOpen = true;
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    view = 'testing';
    result = await connectMail({
      email, password,
      ...(advancedTouched ? { overrides: { imap, smtp, ...(user ? { user } : {}) } } : {}),
    });
    if (result.ok) {
      view = 'done';
      password = '';
      await refresh();
      if (mode === 'card') dispatch('connected', result.account);
    } else {
      view = 'form';
      if (result.discovery) discovery = result.discovery;
      if (result.code === 'unreachable' || result.code === 'tls' || result.code === 'bridge') advancedOpen = true;
    }
    await revealResult();
  }

  function startNew(): void {
    email = ''; password = ''; discovery = null; result = null;
    advancedOpen = false; advancedTouched = false; user = '';
    view = 'form';
  }

  function touchAdvanced(): void {
    advancedTouched = true;
  }

  function backToList(): void {
    result = null;
    view = 'list';
  }

  function continueFromDone(): void {
    if (result?.ok) dispatch('connected', result.account);
  }

  function statusKey(status: MailAccount['status']): I18nKey {
    return `mail.connect.status.${status}` as I18nKey;
  }

  onMount(async () => {
    google = await fetchGoogleConfigured();
    if (mode === 'card') await refresh();
  });
</script>

<div class="mc" class:mc-step={mode === 'step'} bind:this={cardEl}>
  {#if mode === 'step'}
    <header class="mc-head">
      <h2 class="mc-title">{$t('mail.connect.title')}</h2>
      <p class="mc-lede">{$t('mail.connect.lede')}</p>
    </header>
  {/if}
  {#if view === 'list'}
    <p class="mc-lede">{$t('mail.connect.lede')}</p>
    {#if accounts.length > 0}
      <ul class="mc-accounts">
        {#each accounts as acc (acc.id)}
          <li class="mc-acc">
            <span class="mc-acc-email">{acc.email}</span>
            <StatusPill
              status={acc.status === 'ok' ? 'ok' : acc.status === 'read_only' ? 'warn' : 'error'}
              label={$t(statusKey(acc.status))}
            />
          </li>
        {/each}
      </ul>
      <div class="mc-row">
        <a class="mc-link" href="/mail/accounts">{$t('mail.connect.manage')}</a>
        <button type="button" class="mc-btn ghost" on:click={startNew}>+ {$t('mail.connect.add')}</button>
      </div>
    {:else}
      <button type="button" class="mc-btn primary mc-btn-wide" on:click={startNew}>+ {$t('mail.connect.add')}</button>
    {/if}
  {:else if view === 'form' || view === 'testing'}
    <form class="mc-form" on:submit|preventDefault={submit}>
      <div class="mc-scroll">
      <label class="mc-label" for="mc-email">{$t('mail.connect.email')}</label>
      <input
        id="mc-email"
        class="mc-input"
        type="email"
        autocomplete="email"
        bind:value={email}
        on:input={onEmailInput}
        on:blur={detect}
        disabled={view === 'testing'}
      />
      {#if detecting}
        <p class="mc-hint">{$t('mail.connect.detecting')}</p>
      {:else if discovery && auth === 'password'}
        <p class="mc-hint mc-hint-ok">✓ {$t('mail.connect.detected', { name: providerName })}</p>
      {/if}

      {#if auth === 'oauth_only'}
        <div class="mc-box err" role="alert">{$t('mail.connect.err.oauth_only', { name: providerName })}</div>
      {:else}
        {#if auth === 'bridge'}
          <div class="mc-box err" role="alert">{$t('mail.connect.err.bridge')}</div>
        {/if}
        {#if auth === 'app_password'}
          <div class="mc-box warn">
            <p class="mc-box-title">{$t('mail.connect.app_pw_title', { name: providerName })}</p>
            <ol class="mc-steps">
              <li>{$t('mail.connect.app_pw_step1')}</li>
              <li>
                {#if discovery?.helpUrl}
                  <a href={discovery.helpUrl} target="_blank" rel="noopener noreferrer">{$t('mail.connect.app_pw_step2')}</a>
                {:else}
                  {$t('mail.connect.app_pw_step2')}
                {/if}
              </li>
              <li>{$t('mail.connect.app_pw_step3')}</li>
            </ol>
          </div>
        {/if}

        <label class="mc-label" for="mc-password">
          {auth === 'app_password' ? $t('mail.connect.app_password') : $t('mail.connect.password')}
        </label>
        <div class="mc-pw">
          {#if showPassword}
            <input
              id="mc-password"
              class="mc-input"
              type="text"
              autocomplete="current-password"
              bind:value={password}
              disabled={view === 'testing'}
            />
          {:else}
            <input
              id="mc-password"
              class="mc-input"
              type="password"
              autocomplete="current-password"
              bind:value={password}
              disabled={view === 'testing'}
            />
          {/if}
          <button
            type="button"
            class="mc-eye"
            tabindex="-1"
            aria-label={showPassword ? $t('mail.connect.hide') : $t('mail.connect.show')}
            on:click={() => (showPassword = !showPassword)}
          >
            {#if showPassword}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
            {:else}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
            {/if}
          </button>
        </div>

        {#if showGoogleOauth}
          <a class="mc-hint mc-google" href={google.authUrl || '/mail/accounts'}>{$t('mail.connect.google_oauth')}</a>
        {/if}
      {/if}

      {#if errorKey && view === 'form' && !bridgeErrorIsDuplicate}
        <div class="mc-box err" role="alert" data-result>
          <p>{$t(errorKey, { name: providerName })}</p>
          {#if errorCode === 'already_connected'}
            <a class="mc-link" href="/mail/accounts">{$t('mail.connect.manage')}</a>
          {/if}
          {#if errorDetail}
            <details class="mc-detail"><summary>{$t('mail.connect.see_detail')}</summary>{errorDetail}</details>
          {/if}
        </div>
      {/if}

      <details class="mc-advanced" bind:open={advancedOpen}>
        <summary>{$t('mail.connect.advanced')}</summary>
        <div class="mc-adv-grid">
          <div class="mc-field">
            <label class="mc-label" for="mc-imap-host">{$t('mail.connect.imap_host')}</label>
            <input id="mc-imap-host" class="mc-input" bind:value={imap.host} on:input={touchAdvanced} />
          </div>
          <div class="mc-adv-row">
            <div class="mc-field mc-field-port">
              <label class="mc-label" for="mc-imap-port">{$t('mail.connect.port')}</label>
              <input id="mc-imap-port" class="mc-input mc-input-num" type="number" bind:value={imap.port} on:input={touchAdvanced} />
            </div>
            <label class="mc-check"><input type="checkbox" bind:checked={imap.secure} on:change={touchAdvanced} />{$t('mail.connect.tls')}</label>
          </div>
          <div class="mc-field">
            <label class="mc-label" for="mc-smtp-host">{$t('mail.connect.smtp_host')}</label>
            <input id="mc-smtp-host" class="mc-input" bind:value={smtp.host} on:input={touchAdvanced} />
          </div>
          <div class="mc-adv-row">
            <div class="mc-field mc-field-port">
              <label class="mc-label" for="mc-smtp-port">{$t('mail.connect.port')}</label>
              <input id="mc-smtp-port" class="mc-input mc-input-num" type="number" bind:value={smtp.port} on:input={touchAdvanced} />
            </div>
            <label class="mc-check"><input type="checkbox" bind:checked={smtp.secure} on:change={touchAdvanced} />{$t('mail.connect.tls')}</label>
          </div>
          <div class="mc-field">
            <label class="mc-label" for="mc-user">{$t('mail.connect.user')}</label>
            <input id="mc-user" class="mc-input" bind:value={user} on:input={touchAdvanced} />
          </div>
        </div>
      </details>
      </div>

      <div class="mc-actions">
        {#if mode === 'card' && accounts.length > 0}
          <button type="button" class="mc-btn ghost" on:click={() => (view = 'list')} disabled={view === 'testing'}>{$t('mail.connect.cancel')}</button>
        {:else if mode === 'step'}
          <button type="button" class="mc-btn ghost" on:click={() => dispatch('skip')} disabled={view === 'testing'}>{$t('mail.connect.later')}</button>
        {/if}
        <span class="mc-spacer"></span>
        <button type="submit" class="mc-btn primary" disabled={!canSubmit}>
          {view === 'testing' ? $t('mail.connect.testing') : $t('mail.connect.submit')}
        </button>
      </div>

      {#if view === 'testing'}
        <div class="mc-testing" role="status" aria-live="polite">
          <p><span class="mc-spin" aria-hidden="true"></span>{$t('mail.connect.test_imap')}</p>
          <p><span class="mc-spin" aria-hidden="true"></span>{$t('mail.connect.test_smtp')}</p>
        </div>
      {/if}
    </form>
  {:else if view === 'done'}
    <div class="mc-done">
      <div class="mc-box ok" role="status" data-result={!readOnly || undefined}>✓ {$t('mail.connect.done')}</div>
      {#if readOnly}
        <div class="mc-box warn" role="status" data-result>{$t('mail.connect.err.smtp_failed')}</div>
      {/if}
      <div class="mc-actions">
        {#if mode === 'step'}
          <button type="button" class="mc-btn primary" on:click={continueFromDone}>{$t('mail.connect.continue')}</button>
        {:else}
          <a class="mc-btn ghost" href="/mail/accounts">{$t('mail.connect.manage')}</a>
          <span class="mc-spacer"></span>
          <button type="button" class="mc-btn primary" on:click={backToList}>{$t('mail.connect.back')}</button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .mc {
    display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--text-1);
    max-height: min(560px, calc(100dvh - 170px)); min-height: 0;
  }
  /* Wizard step: the page chrome around it (header, progress, step padding)
     takes ~320px of a 720px screen; the scroll region inside absorbs the rest. */
  .mc.mc-step { max-height: calc(100dvh - 320px); min-height: 280px; }
  .mc-head { flex-shrink: 0; }
  .mc-title { margin: 0 0 2px; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: var(--text-1); }
  .mc-lede { margin: 0 0 2px; font-size: 12px; color: var(--text-2); line-height: 1.45; }

  .mc-accounts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .mc-acc {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 6px 0; border-bottom: 1px solid var(--border);
  }
  .mc-acc:last-child { border-bottom: none; }
  .mc-acc-email { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text-1); }

  .mc-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
  .mc-link { font-size: 12px; color: var(--teal); text-decoration: none; }
  .mc-link:hover { text-decoration: underline; }

  .mc-form { display: flex; flex-direction: column; gap: 6px; min-height: 0; flex: 1; }
  .mc-scroll { display: flex; flex-direction: column; gap: 6px; min-height: 0; flex: 1; overflow-y: auto; padding-right: 2px; }
  .mc-label { margin: 4px 0 0; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--text-2); }
  .mc-input {
    width: 100%; min-height: 34px; padding: 6px 10px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface-1); color: var(--text-1);
    font-family: var(--font-body); font-size: 13px; box-sizing: border-box;
  }
  .mc-input:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .mc-input:disabled { opacity: 0.5; }
  .mc-input-num { width: 100%; }

  .mc-pw { position: relative; display: flex; align-items: center; }
  .mc-pw .mc-input { padding-right: 32px; }
  .mc-eye {
    position: absolute; right: 4px; width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    border: none; background: none; color: var(--text-3); cursor: pointer; border-radius: 4px; padding: 0;
  }
  .mc-eye:hover { color: var(--text-1); background: var(--surface-3); }

  .mc-hint { margin: 0; font-size: 11px; color: var(--text-2); }
  .mc-hint-ok { color: var(--green); }
  .mc-google { color: var(--teal); text-decoration: none; }
  .mc-google:hover { text-decoration: underline; }

  .mc-box { border-radius: var(--radius-sm); padding: 8px 10px; font-size: 12px; line-height: 1.45; }
  .mc-box p { margin: 0; }
  .mc-box-title { font-weight: 600; margin-bottom: 4px; }
  .mc-box.warn {
    background: color-mix(in srgb, var(--orange) 12%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--orange) 45%, var(--border));
    color: var(--text-1);
  }
  .mc-box.err {
    background: color-mix(in srgb, var(--red) 12%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--red) 45%, var(--border));
    color: var(--text-1);
  }
  .mc-box.ok {
    background: color-mix(in srgb, var(--green) 12%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--green) 45%, var(--border));
    color: var(--text-1);
  }
  .mc-steps { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; }
  .mc-steps a { color: var(--teal); }
  .mc-detail { margin-top: 4px; font-size: 11px; color: var(--text-2); }
  .mc-detail summary { cursor: pointer; color: var(--teal); }

  .mc-advanced { font-size: 12px; }
  .mc-advanced summary { cursor: pointer; color: var(--text-2); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; padding: 2px 0; }
  .mc-adv-grid { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
  .mc-adv-row { display: flex; align-items: flex-end; gap: 10px; }
  .mc-field { flex: 1; min-width: 0; }
  .mc-field-port { flex: 0 0 90px; }
  .mc-check { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-2); padding-bottom: 6px; }

  .mc-actions { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-shrink: 0; }
  .mc-spacer { flex: 1; }
  .mc-btn {
    min-height: 34px; padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600;
    cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center;
    font-family: var(--font-body); transition: background 150ms ease-out, border-color 150ms ease-out;
  }
  .mc-btn:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .mc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .mc-btn.ghost { border: 1px solid var(--border); background: transparent; color: var(--text-1); }
  .mc-btn.ghost:hover:not(:disabled) { border-color: var(--border-h); }
  .mc-btn.primary { border: 1px solid var(--teal); background: var(--teal); color: var(--bg); }
  .mc-btn.primary:hover:not(:disabled) { opacity: 0.9; }
  .mc-btn-wide { width: 100%; justify-content: center; }

  .mc-testing { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-2); flex-shrink: 0; }
  .mc-testing p { margin: 0; display: flex; align-items: center; gap: 6px; }
  .mc-spin {
    width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--border-h); border-top-color: var(--teal);
    animation: mc-rot 0.8s linear infinite; flex-shrink: 0;
  }
  @keyframes mc-rot { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .mc-spin { animation: none; }
    .mc-btn { transition: none; }
  }

  .mc-done { display: flex; flex-direction: column; gap: 8px; }
</style>
