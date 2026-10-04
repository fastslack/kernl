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

  const PROVIDER_KEYS: Record<string, I18nKey> = {
    gmail: 'mail.connect.provider.gmail',
    imap_smtp: 'mail.connect.provider.imap_smtp',
    resend: 'mail.connect.provider.resend',
  };

  function initial(acc: MailAccount): string {
    return (acc.label || acc.email).trim().charAt(0).toUpperCase() || '@';
  }

  /** What the office does with a connected mailbox — the reason to connect one. */
  const CAPABILITIES: Array<{ key: I18nKey; icon: 'inbox' | 'calendar' | 'draft' }> = [
    { key: 'mail.connect.cap.triage', icon: 'inbox' },
    { key: 'mail.connect.cap.agenda', icon: 'calendar' },
    { key: 'mail.connect.cap.drafts', icon: 'draft' },
  ];

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
    <header class="mc-top">
      <div class="mc-top-text">
        <h2 class="mc-title">{$t('mail.connect.title')}</h2>
        <p class="mc-lede">{$t('mail.connect.lede')}</p>
      </div>
      {#if accounts.length > 0}
        <button type="button" class="mc-btn primary" on:click={startNew}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          {$t('mail.connect.add')}
        </button>
      {/if}
    </header>

    <ul class="mc-caps">
      {#each CAPABILITIES as cap (cap.key)}
        <li class="mc-cap">
          <span class="mc-cap-icon" aria-hidden="true">
            {#if cap.icon === 'inbox'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
            {:else if cap.icon === 'calendar'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
            {:else}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            {/if}
          </span>
          <span class="mc-cap-text">{$t(cap.key)}</span>
        </li>
      {/each}
    </ul>

    {#if accounts.length > 0}
      <section class="mc-panel" aria-labelledby="mc-accounts-title">
        <h3 id="mc-accounts-title" class="mc-section">{$t('mail.connect.accounts')}</h3>
        <ul class="mc-accounts">
          {#each accounts as acc (acc.id)}
            <li class="mc-acc">
              <span class="mc-avatar" aria-hidden="true">{initial(acc)}</span>
              <span class="mc-acc-main">
                <span class="mc-acc-email" title={acc.email}>{acc.email}</span>
                <span class="mc-acc-meta">{PROVIDER_KEYS[acc.provider] ? $t(PROVIDER_KEYS[acc.provider]) : acc.provider}</span>
              </span>
              <StatusPill
                status={acc.status === 'ok' ? 'ok' : acc.status === 'read_only' ? 'warn' : 'error'}
                label={$t(statusKey(acc.status))}
              />
            </li>
          {/each}
        </ul>
        <footer class="mc-panel-foot">
          <a class="mc-link" href="/mail/accounts">{$t('mail.connect.manage')}</a>
        </footer>
      </section>
    {:else}
      <section class="mc-empty">
        <span class="mc-empty-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></svg>
        </span>
        <p class="mc-empty-title">{$t('mail.connect.empty_title')}</p>
        <p class="mc-empty-body">{$t('mail.connect.empty_body')}</p>
        <button type="button" class="mc-btn primary" on:click={startNew}>{$t('mail.connect.add')}</button>
      </section>
    {/if}
  {:else if view === 'form' || view === 'testing'}
    {#if mode === 'card'}
      <header class="mc-top">
        <div class="mc-top-text">
          <h2 class="mc-title">{$t('mail.connect.add')}</h2>
          <p class="mc-lede">{$t('mail.connect.form_lede')}</p>
        </div>
      </header>
    {/if}
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

  /* ── Settings tile (card mode): list view ── */
  .mc:not(.mc-step) { max-width: 760px; gap: 14px; }
  .mc-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .mc-top-text { min-width: 0; }
  .mc-top .mc-lede { font-size: 13px; }
  .mc-top .mc-btn { flex-shrink: 0; gap: 6px; }

  .mc-caps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .mc-cap {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1);
  }
  .mc-cap-icon {
    flex-shrink: 0; width: 30px; height: 30px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    color: var(--teal); background: color-mix(in srgb, var(--teal) 12%, transparent);
  }
  .mc-cap-text { font-size: 12px; line-height: 1.35; color: var(--text-2); }

  .mc-panel { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1); overflow: hidden; }
  .mc-section {
    margin: 0; padding: 10px 14px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3); border-bottom: 1px solid var(--border);
  }
  .mc-accounts { list-style: none; margin: 0; padding: 0; }
  .mc-acc {
    display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 14px;
    border-bottom: 1px solid var(--border); transition: background 150ms ease-out;
  }
  .mc-acc:last-child { border-bottom: none; }
  .mc-acc:hover { background: var(--surface-2); }
  .mc-avatar {
    flex-shrink: 0; width: 34px; height: 34px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--teal);
    background: color-mix(in srgb, var(--teal) 14%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--teal) 30%, var(--border));
  }
  .mc-acc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .mc-acc-email {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 13px; font-weight: 600; color: var(--text-1);
  }
  .mc-acc-meta { font-size: 11px; color: var(--text-3); }
  .mc-panel-foot { display: flex; justify-content: flex-end; padding: 8px 14px; border-top: 1px solid var(--border); background: var(--surface-2); }

  .mc:not(.mc-step) .mc-form {
    flex: 0 1 auto; padding: 14px 16px; border: 1px solid var(--border);
    border-radius: var(--radius); background: var(--surface-1);
  }
  .mc:not(.mc-step) .mc-form .mc-input { background: var(--surface-2); }
  .mc:not(.mc-step) .mc-actions { padding-top: 10px; border-top: 1px solid var(--border); margin-top: 8px; }

  .mc-empty {
    display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px;
    padding: 28px 20px; border: 1px dashed var(--border-h); border-radius: var(--radius); background: var(--surface-1);
  }
  .mc-empty-icon {
    width: 44px; height: 44px; border-radius: 12px; margin-bottom: 4px;
    display: flex; align-items: center; justify-content: center;
    color: var(--teal); background: color-mix(in srgb, var(--teal) 12%, transparent);
  }
  .mc-empty-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-1); }
  .mc-empty-body { margin: 0 0 8px; max-width: 420px; font-size: 12px; line-height: 1.5; color: var(--text-2); }

  @media (max-width: 720px) {
    .mc-caps { grid-template-columns: 1fr; }
    .mc-top { flex-direction: column; }
  }

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
    .mc-acc { transition: none; }
  }

  .mc-done { display: flex; flex-direction: column; gap: 8px; }
</style>
