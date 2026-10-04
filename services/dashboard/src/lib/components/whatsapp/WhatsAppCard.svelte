<script lang="ts">
  /**
   * WhatsApp linking card — QR or phone-code, live status, who-can-talk
   * chips with a chat picker. `mode="card"` is the Settings → Channels
   * tile (owns allowedNumbers/chips/unlink); `mode="step"` is the same
   * flow embedded as an optional wizard step (no chips, a "Later" way out,
   * "Continue" once linked).
   */
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte';
  import QRCode from 'qrcode';
  import { t } from '$lib/i18n/index.js';
  import {
    waStatus, waLink, waCancel, waChats, waLogout, waLoadConfig, waEditAllowed, waTest,
    subscribeWaLive, normalizePhone, type WaStatus, type ChatItem,
  } from '$lib/whatsapp.js';

  export let mode: 'card' | 'step' = 'card';

  const dispatch = createEventDispatcher<{ linked: { jid: string }; skip: void }>();

  let status: WaStatus = { bridge_connected: false, state: 'unknown' };
  let loadingStatus = true;
  let unsubscribeLive: (() => void) | null = null;

  /** Which link button the user pressed, before the backend confirms a state change. */
  let pendingKind: 'qr' | 'phone' | null = null;
  let phoneRaw = '';
  let starting = false;

  let qrImgSrc = '';
  let qrSeq = 0;

  let now = Date.now();
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  let allowedNumbers: string[] = [];
  let showChats = false;
  let chatQuery = '';
  let chats: ChatItem[] = [];
  let chatsLoading = false;

  let unlinkConfirming = false;
  let cancelBtnEl: HTMLButtonElement | null = null;
  let testSending = false;
  let testOk = false;
  let testFailed = false;
  let testOkTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set right before `waLogout()` so the next `logged_out` status (the
   *  backend's own confirmation of the unlink we just asked for) doesn't
   *  read as "WhatsApp kicked you out" — it reads that way again once the
   *  user starts a fresh link attempt. */
  let userUnlinked = false;

  /** A link/pairing attempt failed for a reason other than "expired" — shown
   *  as a box; 'generic' vs 'bridge' picks the message. */
  let linkError: 'generic' | 'bridge' | null = null;
  /** The backend rejected the phone number after the client-side format
   *  check already passed (so `phoneInvalid` alone would stay false). */
  let phoneServerInvalid = false;

  let configError = false;
  let configErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let configRetryTimer: ReturnType<typeof setTimeout> | null = null;
  function flashConfigError(): void {
    configError = true;
    if (configErrorTimer) clearTimeout(configErrorTimer);
    configErrorTimer = setTimeout(() => (configError = false), 3000);
  }

  function jidNumber(jid: string): string {
    return jid.split('@')[0].split(':')[0];
  }

  /** "5491123456789" -> "+54 9 11…789" for the AR mobile shape; a generic
   *  "+<first 4>…<last 3>" mask otherwise. */
  function maskPhone(digits?: string): string {
    if (!digits) return '';
    const ar = digits.match(/^(\d{2})9(\d{2})\d+(\d{3})$/);
    if (ar) return `+${ar[1]} 9 ${ar[2]}…${ar[3]}`;
    if (digits.length <= 6) return `+${digits}`;
    return `+${digits.slice(0, 4)}…${digits.slice(-3)}`;
  }

  function formatCode(code?: string): string {
    if (!code) return '';
    if (code.includes('-')) return code;
    return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  }

  $: phoneDigits = normalizePhone(phoneRaw);
  $: phoneInvalid = phoneRaw.length > 0 && !phoneDigits;
  $: bridgeDown = status.state === 'unknown' && !status.bridge_connected;

  // Waiting for a phone-code request to come back with an actual code.
  $: awaitingPairingCode = status.state === 'linking' && status.mode === 'phone' && !status.pairing_code;

  $: view = ((): 'bridge_down' | 'qr' | 'phone_entry' | 'phone_code' | 'linked' | 'unlinked' => {
    if (bridgeDown) return 'bridge_down';
    if (status.state === 'connected' || status.state === 'disconnected') return 'linked';
    if (status.pairing_code) return 'phone_code';
    if (pendingKind === 'qr' || (status.state === 'linking' && status.mode === 'qr')) return 'qr';
    if (pendingKind === 'phone' || (status.state === 'linking' && status.mode === 'phone')) return 'phone_entry';
    return 'unlinked'; // idle, logged_out, or inactive (channel not started; linking starts it)
  })();

  async function renderQr(code: string): Promise<void> {
    const seq = ++qrSeq;
    try {
      const url = await QRCode.toDataURL(code, { margin: 1, width: 220 });
      if (seq === qrSeq) qrImgSrc = url;
    } catch { /* keep whatever was rendered before */ }
  }
  $: if (status.qr) {
    void renderQr(status.qr);
  } else {
    qrImgSrc = '';
  }

  function startCountdown(): void {
    if (countdownTimer) return;
    countdownTimer = setInterval(() => { now = Date.now(); }, 1000);
  }
  function stopCountdown(): void {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }
  $: if (status.pairing_expires_at) startCountdown(); else stopCountdown();

  $: countdownLabel = (() => {
    if (!status.pairing_expires_at) return '';
    const secs = Math.max(0, Math.round((status.pairing_expires_at - now) / 1000));
    return `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
  })();
  $: codeExpired = !!status.pairing_expires_at && now >= status.pairing_expires_at;

  function onLive(ev: { channel: string; data: unknown }): void {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.channel === 'whatsapp:status') {
      const prevState = status.state;
      const nextState = typeof d.state === 'string' ? d.state : status.state;
      const jid = typeof d.jid === 'string' ? d.jid : status.jid;
      status = {
        ...status,
        // Every session push carries it (false when mtw-server lost the bridge).
        bridge_connected: typeof d.bridge_connected === 'boolean' ? d.bridge_connected : status.bridge_connected,
        state: nextState,
        mode: typeof d.mode === 'string' ? d.mode : status.mode,
        jid,
        reason: typeof d.reason === 'string' ? d.reason : undefined,
        phoneNumber: jid ? jidNumber(jid) : status.phoneNumber,
        // A fresh status push outside "linking" means the previous QR/code
        // no longer applies — carrying it over would show a stale code.
        // Inside "linking", a REAL live push never carries qr/pairing_code
        // (the bridge sends those on their own channels) — but the WS-down
        // poll fallback delivers a full `waStatus()` read through this same
        // branch, and that read's qr/pairing_code/pairing_expires_at (already
        // normalized to ms by `waStatus()`) are the only way those fields
        // ever reach the card while the WS is down. So: take them when
        // present, otherwise leave whatever is already there untouched.
        ...(nextState === 'linking'
          ? {
              ...(typeof d.qr === 'string' ? { qr: d.qr } : {}),
              ...(typeof d.pairing_code === 'string' ? { pairing_code: d.pairing_code } : {}),
              ...(typeof d.pairing_expires_at === 'number' ? { pairing_expires_at: d.pairing_expires_at } : {}),
            }
          : { qr: undefined, pairing_code: undefined, pairing_expires_at: undefined }),
      };
      // Any status that isn't "linking" — idle (cancelled/expired/error),
      // connected, disconnected, logged_out — means no link is in progress
      // any more, so the pending button-press state is stale.
      if (nextState !== 'linking') pendingKind = null;
      noteStateChange(prevState, nextState);
    } else if (ev.channel === 'whatsapp:qr') {
      // A QR for a link that is no longer in progress is stale (e.g. a
      // store replay, or a code that arrived after a cancel) — never show it.
      if (status.state === 'linking' && typeof d.code === 'string') status = { ...status, qr: d.code };
    } else if (ev.channel === 'whatsapp:pairing') {
      if (status.state === 'linking' && typeof d.code === 'string') {
        status = {
          ...status,
          pairing_code: d.code,
          pairing_expires_at: typeof d.expires_at === 'number' ? d.expires_at : undefined,
        };
      }
    }
  }

  async function loadConfig(): Promise<void> {
    try {
      const { config } = await waLoadConfig();
      const raw = typeof config.allowedNumbers === 'string' ? config.allowedNumbers : '';
      allowedNumbers = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } catch { /* chips start empty; the card still works without them */ }
  }

  /**
   * Linking just finished: the kernel fills `allowedNumbers` with the linked
   * number on its own (asynchronously), so the chips loaded at mount are
   * stale. Reload now, and once more a second later if it was still empty.
   */
  function noteStateChange(prev: string, next: string): void {
    if (mode !== 'card' || next !== 'connected' || prev === 'connected') return;
    void (async () => {
      await loadConfig();
      if (configRetryTimer) clearTimeout(configRetryTimer);
      if (allowedNumbers.length === 0) {
        configRetryTimer = setTimeout(() => { configRetryTimer = null; void loadConfig(); }, 1000);
      }
    })();
  }

  async function refreshStatus(): Promise<void> {
    try {
      const prevState = status.state;
      status = await waStatus();
      noteStateChange(prevState, status.state);
      // A refreshed status that isn't "linking" means whatever button the
      // user pressed to get here no longer has anything pending.
      if (status.state !== 'linking') pendingKind = null;
    } catch { /* keep the last known status */ }
  }

  /** Classifies a `waLink`/`waLink` failure code for the error box: a
   *  bridge/provider that is down gets its own message, an invalid phone
   *  (caught here even though the client already validates — the backend
   *  can still say no) goes to the inline field message instead of a box,
   *  anything else is the generic "couldn't start linking". */
  function describeLinkError(code: string | undefined): 'bridge' | 'invalid_phone' | 'generic' {
    if (code === 'invalid_phone') return 'invalid_phone';
    const c = code ?? '';
    if (c === 'mtw_not_connected' || c.includes('bridge') || c.includes('not_connected')) return 'bridge';
    return 'generic';
  }

  /**
   * `waLink` can also REJECT instead of resolving `{ ok: false }` — the
   * kernel turns `invalid_phone`/`invalid_mode` into an HTTP 400
   * (operations.ts `channels.whatsapp.link`) and a missing provider into a
   * 404 (`requireWhatsApp`); over HTTP that surfaces as `jpost` throwing
   * `Error("HTTP 400"/"HTTP 404")` (no body is read), over WS as
   * `RpcAnsweredError` whose message is whatever the kernel's `HttpError`
   * said (`"invalid_phone"`, `"WhatsApp provider not registered"`, …), and
   * a WS write that never gets an answer within 10s (rpc-call.ts) rejects
   * with a timeout `Error`. Same three buckets as `describeLinkError`,
   * read from the exception's message instead of a `{ code }` field.
   */
  function describeLinkException(err: unknown, phoneAttempt: boolean): 'bridge' | 'invalid_phone' | 'generic' {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (phoneAttempt && (msg.includes('invalid_phone') || msg.includes('400'))) return 'invalid_phone';
    if (msg.includes('404') || msg.includes('not registered')) return 'bridge';
    return 'generic';
  }

  async function startLink(kind: 'qr' | 'phone'): Promise<void> {
    userUnlinked = false;
    linkError = null;
    pendingKind = kind;
    if (kind === 'phone') return; // the form still needs the number
    starting = true;
    try {
      const res = await waLink('qr');
      if (!res.ok) {
        pendingKind = null;
        const kind2 = describeLinkError(res.code);
        linkError = kind2 === 'invalid_phone' ? 'generic' : kind2;
      } else {
        await refreshStatus();
      }
    } catch (err) {
      pendingKind = null;
      const kind2 = describeLinkException(err, false);
      linkError = kind2 === 'invalid_phone' ? 'generic' : kind2;
    } finally { starting = false; }
  }

  async function submitPhone(): Promise<void> {
    if (!phoneDigits) return;
    starting = true;
    linkError = null;
    phoneServerInvalid = false;
    try {
      const res = await waLink('phone', phoneDigits);
      if (!res.ok) {
        const kind2 = describeLinkError(res.code);
        if (kind2 === 'invalid_phone') phoneServerInvalid = true;
        else { pendingKind = null; linkError = kind2; }
      } else {
        await refreshStatus();
      }
    } catch (err) {
      const kind2 = describeLinkException(err, true);
      if (kind2 === 'invalid_phone') phoneServerInvalid = true;
      else { pendingKind = null; linkError = kind2; }
    } finally { starting = false; }
  }

  function chooseLinkPhone(): void {
    userUnlinked = false;
    linkError = null;
    pendingKind = 'phone';
  }

  async function newCodeFromIdle(): Promise<void> {
    if (status.mode === 'phone') { chooseLinkPhone(); return; }
    await startLink('qr');
  }

  /** "Pedir otro" from the phone-code view. The phone field may be empty
   *  after a reload (phoneRaw is component-local, not persisted) — fall
   *  back to the number the backend already has for this link. During
   *  "linking"/phone the backend has no jid/phoneNumber yet either (those
   *  only populate once connected), so there may be nothing to fall back
   *  to: drop the stale pairing code so the view actually switches to the
   *  phone-entry form instead of staying stuck on a dead code (`view`
   *  prefers `status.pairing_code` over `pendingKind`). */
  async function requestNewCode(): Promise<void> {
    const digits = phoneDigits || status.phoneNumber || (status.jid ? jidNumber(status.jid) : null);
    if (!digits) {
      status = { ...status, pairing_code: undefined, pairing_expires_at: undefined };
      chooseLinkPhone();
      return;
    }
    starting = true;
    linkError = null;
    phoneServerInvalid = false;
    try {
      const res = await waLink('phone', digits);
      if (!res.ok) {
        const kind2 = describeLinkError(res.code);
        if (kind2 === 'invalid_phone') { pendingKind = 'phone'; phoneServerInvalid = true; }
        else linkError = kind2;
      } else {
        phoneRaw = digits;
        await refreshStatus();
      }
    } catch (err) {
      const kind2 = describeLinkException(err, true);
      if (kind2 === 'invalid_phone') { pendingKind = 'phone'; phoneServerInvalid = true; }
      else linkError = kind2;
    } finally { starting = false; }
  }

  async function cancelLink(): Promise<void> {
    linkError = null;
    try { await waCancel(); } finally {
      pendingKind = null;
      status = { ...status, state: 'idle', qr: undefined, pairing_code: undefined, pairing_expires_at: undefined, reason: undefined };
    }
  }

  async function sendTest(): Promise<void> {
    testSending = true;
    try {
      const res = await waTest();
      testOk = res.success;
    } catch { testOk = false; }
    finally {
      testSending = false;
      testFailed = !testOk;
      if (testOkTimer) clearTimeout(testOkTimer);
      testOkTimer = setTimeout(() => { testOk = false; testFailed = false; }, 3000);
    }
  }

  // Both edit the stored list (read-modify-write in `waEditAllowed`), never
  // the local copy, which can miss what the kernel auto-configured.
  async function removeAllowed(entry: string): Promise<void> {
    const prev = allowedNumbers;
    allowedNumbers = allowedNumbers.filter((n) => n !== entry);
    try {
      allowedNumbers = await waEditAllowed('remove', entry);
    } catch {
      allowedNumbers = prev; // the save failed — the chip never actually left
      flashConfigError();
    }
  }

  async function addAllowed(entry: string): Promise<void> {
    const prev = allowedNumbers;
    if (!allowedNumbers.includes(entry)) allowedNumbers = [...allowedNumbers, entry];
    try {
      allowedNumbers = await waEditAllowed('add', entry);
      showChats = false;
      chatQuery = '';
    } catch {
      allowedNumbers = prev;
      flashConfigError();
    }
  }

  async function openChats(): Promise<void> {
    showChats = true;
    chatsLoading = true;
    try {
      const res = await waChats(50);
      chats = res.ok ? res.items : [];
    } finally { chatsLoading = false; }
  }

  /** A name with no letter or digit ("$", ".") identifies nobody: show the number. */
  function chatDisplay(c: ChatItem): string {
    if (c.name && /[\p{L}\p{N}]/u.test(c.name)) return c.name;
    return c.jid.endsWith('@s.whatsapp.net') ? `+${jidNumber(c.jid)}` : (c.name || jidNumber(c.jid));
  }
  function chatEntry(c: ChatItem): string {
    return c.is_group ? c.jid : jidNumber(c.jid);
  }
  /** A group chip stores the full JID (`…@g.us`); show its name when the
   *  chat picker has already loaded it, else fall back to the JID itself —
   *  a bare group JID has no "number" worth extracting. */
  function chatNameFor(jid: string): string | null {
    return chats.find((c) => c.jid === jid)?.name || null;
  }
  $: filteredChats = (() => {
    const q = chatQuery.trim().toLowerCase();
    const hits = q ? chats.filter((c) => chatDisplay(c).toLowerCase().includes(q) || c.jid.toLowerCase().includes(q)) : chats;
    // Contacts first: groups can't be added, so they only fill the top of the list.
    return [...hits].sort((a, b) => Number(a.is_group) - Number(b.is_group));
  })();
  /** "+5491123456789" under a contact's name, so odd names stay identifiable. */
  function chatSubtitle(c: ChatItem): string {
    if (c.is_group || !c.jid.endsWith('@s.whatsapp.net')) return '';
    return `+${jidNumber(c.jid)}`;
  }

  function isYou(entry: string): boolean {
    return entry === status.phoneNumber || (!!status.jid && entry === jidNumber(status.jid));
  }

  function chipLabel(entry: string): string {
    if (isYou(entry)) return $t('settings.wa.you');
    if (entry.includes('@')) return chatNameFor(entry) || entry;
    return chats.find((c) => !c.is_group && jidNumber(c.jid) === entry)?.name || maskPhone(entry);
  }
  /** One or two letters for a chip avatar; a phone number gets a "#". */
  function initials(label: string): string {
    const words = label.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || /^\d/.test(words[0])) return '#';
    return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase();
  }

  /** The header badge: one look per state, never color alone (icon + text). */
  $: badge = ((): { tone: 'ok' | 'warn' | 'err' | 'idle'; label: string } => {
    if (view === 'bridge_down') return { tone: 'err', label: $t('settings.wa.badge.unavailable') };
    if (view === 'linked') {
      return status.state === 'connected'
        ? { tone: 'ok', label: $t('settings.wa.badge.connected') }
        : { tone: 'warn', label: $t('settings.wa.state.disconnected') };
    }
    if (view === 'qr' || view === 'phone_code' || (view === 'phone_entry' && status.state === 'linking')) {
      return { tone: 'warn', label: $t('settings.wa.state.linking') };
    }
    if (status.state === 'logged_out' && !userUnlinked) return { tone: 'err', label: $t('settings.wa.state.logged_out') };
    return { tone: 'idle', label: $t('settings.wa.state.idle') };
  })();

  $: codeChars = (status.pairing_code ?? '').replace(/-/g, '').split('');

  async function confirmUnlink(): Promise<void> {
    unlinkConfirming = true;
    await tick();
    cancelBtnEl?.focus();
  }
  async function doUnlink(): Promise<void> {
    unlinkConfirming = false;
    // The backend's own next status is "logged_out" too — this is the only
    // way to tell "I did that on purpose" from "WhatsApp kicked me out".
    userUnlinked = true;
    try { await waLogout(); } finally { await refreshStatus(); }
  }

  function continueStep(): void {
    if (status.jid) dispatch('linked', { jid: status.jid });
  }

  onMount(async () => {
    try { status = await waStatus(); } catch { /* stays "unknown" */ }
    loadingStatus = false;
    if (mode === 'card') await loadConfig();
    unsubscribeLive = subscribeWaLive(onLive, () => status.state);
  });

  onDestroy(() => {
    unsubscribeLive?.();
    stopCountdown();
    if (testOkTimer) clearTimeout(testOkTimer);
    if (configErrorTimer) clearTimeout(configErrorTimer);
    if (configRetryTimer) clearTimeout(configRetryTimer);
  });
</script>

<div class="wa" class:wa-step={mode === 'step'}>
  <header class="wa-header">
    <div class="wa-logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
        <path d="M15.6 13.9l-1.5-.7a.9.9 0 0 0-1 .2l-.6.7a6.4 6.4 0 0 1-2.6-2.6l.7-.6a.9.9 0 0 0 .2-1l-.7-1.5a.9.9 0 0 0-1-.5 2 2 0 0 0-1.6 2.1 7.4 7.4 0 0 0 6.9 6.9 2 2 0 0 0 2.1-1.6.9.9 0 0 0-.5-1z" />
      </svg>
    </div>
    <div class="wa-header-text">
      <h2 class="wa-title">{mode === 'step' ? $t('setup.step_whatsapp') : $t('settings.wa.title')}</h2>
      <p class="wa-subtitle">{$t('settings.wa.subtitle')}</p>
    </div>
    {#if !loadingStatus}
      <span class="wa-badge {badge.tone}" role="status">
        {#if badge.tone === 'ok'}
          <span class="wa-pulse" aria-hidden="true"></span>
        {:else if badge.tone === 'warn'}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>
        {:else if badge.tone === 'err'}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><line x1="12" y1="7.5" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12" y2="16.6" /></svg>
        {:else}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /></svg>
        {/if}
        {badge.label}
      </span>
    {/if}
  </header>

  <div class="wa-scroll">
    {#if loadingStatus}
      <div class="wa-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>

    {:else if view === 'bridge_down'}
      <div class="wa-empty">
        <div class="wa-empty-icon err" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a6 6 0 0 1-12 0V8Z" /><line x1="3" y1="3" x2="21" y2="21" /></svg>
        </div>
        <h3 class="wa-empty-title">{$t('settings.wa.bridge_title')}</h3>
        <p class="wa-empty-text">{$t('settings.wa.err.bridge')}</p>
      </div>

    {:else if view === 'qr'}
      {#if linkError}
        <div class="wa-box err" role="alert">{$t(linkError === 'bridge' ? 'settings.wa.err.bridge' : 'settings.wa.err.generic')}</div>
      {/if}
      <div class="wa-panel wa-link-panel">
        <div class="wa-qr-frame">
          {#if qrImgSrc}
            <img src={qrImgSrc} alt={$t('settings.wa.qr_alt')} class="wa-qr-img" width="208" height="208" />
          {:else}
            <div class="wa-qr-placeholder" aria-hidden="true"></div>
          {/if}
        </div>
        <div class="wa-link-side">
          <h3 class="wa-panel-title">{$t('settings.wa.qr_title')}</h3>
          <ol class="wa-stepper">
            <li><span class="wa-step-n">1</span>{$t('settings.wa.qr_step1')}</li>
            <li><span class="wa-step-n">2</span>{$t('settings.wa.qr_step2')}</li>
            <li><span class="wa-step-n">3</span>{$t('settings.wa.qr_step3')}</li>
            <li><span class="wa-step-n">4</span>{$t('settings.wa.qr_step4')}</li>
          </ol>
          <p class="wa-note">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4" /><polyline points="21 3 21 9 15 9" /></svg>
            {$t('settings.wa.qr_renews')}
          </p>
          <div class="wa-actions-row">
            <button type="button" class="wa-btn ghost" on:click={cancelLink}>{$t('settings.wa.cancel')}</button>
          </div>
        </div>
      </div>

    {:else if view === 'phone_entry'}
      <div class="wa-panel wa-form-panel">
        <h3 class="wa-panel-title">{$t('settings.wa.link_phone')}</h3>
        <label class="wa-label" for="wa-phone">{$t('settings.wa.phone_label')}</label>
        <div class="wa-input-wrap">
          <svg class="wa-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5" /><line x1="11" y1="18" x2="13" y2="18" /></svg>
          <input
            id="wa-phone"
            class="wa-input with-icon"
            type="tel"
            inputmode="numeric"
            autocomplete="tel"
            placeholder="+54 9 11 2345 6789"
            bind:value={phoneRaw}
            on:input={() => (phoneServerInvalid = false)}
            disabled={starting || awaitingPairingCode}
          />
        </div>
        {#if phoneInvalid || phoneServerInvalid}
          <p class="wa-err-text" role="alert">{$t('settings.wa.phone_invalid')}</p>
        {/if}
        {#if awaitingPairingCode}
          <p class="wa-note"><span class="wa-spinner" aria-hidden="true"></span>{$t('settings.wa.state.linking')}…</p>
        {/if}
        <div class="wa-actions-row">
          <button type="button" class="wa-btn ghost" on:click={cancelLink} disabled={starting}>{$t('settings.wa.cancel')}</button>
          <button
            type="button"
            class="wa-btn primary"
            disabled={!phoneDigits || starting || awaitingPairingCode}
            on:click={submitPhone}
          >{$t('settings.wa.get_code')}</button>
        </div>
      </div>

    {:else if view === 'phone_code'}
      {#if linkError}
        <div class="wa-box err" role="alert">{$t(linkError === 'bridge' ? 'settings.wa.err.bridge' : 'settings.wa.err.generic')}</div>
      {/if}
      <div class="wa-panel wa-link-panel">
        <div class="wa-code-side">
          <div class="wa-code" aria-label={formatCode(status.pairing_code)}>
            {#each codeChars as ch, i (i)}
              {#if i === 4}<span class="wa-code-dash" aria-hidden="true">–</span>{/if}
              <span class="wa-code-cell" aria-hidden="true">{ch}</span>
            {/each}
          </div>
          {#if codeExpired}
            <p class="wa-err-text" role="alert">{$t('settings.wa.code_expired')}</p>
          {:else}
            <p class="wa-note">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>
              {$t('settings.wa.code_expires', { time: countdownLabel })}
            </p>
          {/if}
        </div>
        <div class="wa-link-side">
          <h3 class="wa-panel-title">{$t('settings.wa.code_title')}</h3>
          <ol class="wa-stepper">
            <li><span class="wa-step-n">1</span>{$t('settings.wa.code_step1')}</li>
            <li><span class="wa-step-n">2</span>{$t('settings.wa.code_step2')}</li>
            <li><span class="wa-step-n">3</span>{$t('settings.wa.code_step3')}</li>
          </ol>
          <div class="wa-actions-row">
            <button type="button" class="wa-btn ghost" on:click={cancelLink}>{$t('settings.wa.cancel')}</button>
            <button type="button" class="wa-btn ghost" on:click={requestNewCode}>{$t('settings.wa.new_code')}</button>
          </div>
        </div>
      </div>

    {:else if view === 'linked'}
      {#if status.state === 'disconnected'}
        <div class="wa-box warn" role="status">{$t('settings.wa.err.disconnected')}</div>
      {/if}

      <div class="wa-grid">
        <div class="wa-card">
          <div class="wa-card-icon green" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5" /><line x1="11" y1="18" x2="13" y2="18" /></svg>
          </div>
          <span class="wa-card-label">{$t('settings.wa.account_label')}</span>
          <span class="wa-card-value">{maskPhone(status.phoneNumber)}</span>
          <span class="wa-card-meta" class:ok={status.state === 'connected'}>
            <span class="wa-dot" aria-hidden="true"></span>
            {status.state === 'connected' ? $t('settings.wa.live') : $t('settings.wa.state.disconnected')}
          </span>
        </div>

        <div class="wa-card">
          <div class="wa-card-icon teal" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>
          </div>
          <span class="wa-card-label">{$t('settings.wa.notify_title')}</span>
          <span class="wa-card-text">{$t('settings.wa.notify_body')}</span>
          <button type="button" class="wa-btn ghost sm" disabled={testSending || status.state !== 'connected'} on:click={sendTest}>
            {#if testSending}
              <span class="wa-spinner" aria-hidden="true"></span>
            {:else if testOk}
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" class="wa-ok-ico" aria-hidden="true"><polyline points="4 12 9 18 20 6" /></svg>
            {:else}
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" /></svg>
            {/if}
            {testOk ? $t('settings.wa.test_sent') : testFailed ? $t('settings.wa.test_failed') : $t('settings.wa.send_test')}
          </button>
        </div>

        <div class="wa-card">
          <div class="wa-card-icon purple" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="13" y2="13" /></svg>
          </div>
          <span class="wa-card-label">{$t('settings.wa.talk_title')}</span>
          <span class="wa-card-text">{$t('settings.wa.talk_body')}</span>
        </div>
      </div>

      {#if mode === 'card'}
        {#if configError}
          <div class="wa-box err" role="alert">{$t('settings.wa.err.generic')}</div>
        {/if}
        <section class="wa-panel">
          <div class="wa-panel-head">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /><path d="M16 3.1a4 4 0 0 1 0 7.8" /></svg>
            <h3 class="wa-panel-title">{$t('settings.wa.who_title')}</h3>
            <span class="wa-count">{allowedNumbers.length}</span>
          </div>
          <div class="wa-chips">
            {#each allowedNumbers as entry (entry)}
              {@const label = chipLabel(entry)}
              <span class="wa-chip" class:you={isYou(entry)}>
                <span class="wa-avatar" aria-hidden="true">{initials(label)}</span>
                <span class="wa-chip-name">{label}</span>
                <button type="button" class="wa-chip-x" aria-label="{$t('settings.wa.remove')} {label}" on:click={() => removeAllowed(entry)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" /></svg>
                </button>
              </span>
            {/each}
            <button type="button" class="wa-chip wa-chip-add" aria-expanded={showChats} on:click={() => (showChats ? (showChats = false) : openChats())}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              {$t('settings.wa.add')}
            </button>
          </div>

          {#if showChats}
            <div class="wa-chats">
              <div class="wa-input-wrap">
                <svg class="wa-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" /></svg>
                <!-- svelte-ignore a11y-autofocus -->
                <input class="wa-input with-icon" type="text" placeholder={$t('settings.wa.search_chats')} aria-label={$t('settings.wa.search_chats')} bind:value={chatQuery} autofocus />
              </div>
              {#if chatsLoading}
                <div class="wa-skeleton rows" aria-hidden="true"><span></span><span></span><span></span></div>
              {:else if filteredChats.length === 0}
                <p class="wa-note">{$t('settings.wa.no_chats')}</p>
              {:else}
                <ul class="wa-chat-list">
                  {#each filteredChats as c (c.jid)}
                    <li class="wa-chat-row">
                      <span class="wa-avatar" class:group={c.is_group} aria-hidden="true">{initials(chatDisplay(c))}</span>
                      <span class="wa-chat-name">
                        <span class="wa-chat-title">{chatDisplay(c)}</span>
                        {#if c.is_group}<span class="wa-muted">{$t('settings.wa.group_no_office')}</span>
                        {:else if chatSubtitle(c) && chatSubtitle(c) !== chatDisplay(c)}<span class="wa-muted">{chatSubtitle(c)}</span>{/if}
                      </span>
                      <!-- Group messages never reach the office (message routing
                           drops them on purpose), so a group chip would do nothing. -->
                      <button
                        type="button"
                        class="wa-btn ghost sm"
                        disabled={c.is_group || allowedNumbers.includes(chatEntry(c))}
                        on:click={() => addAllowed(chatEntry(c))}
                      >{$t('settings.wa.add')}</button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </section>

        <footer class="wa-danger">
          {#if unlinkConfirming}
            <span class="wa-danger-text">{$t('settings.wa.unlink_confirm')}</span>
            <button type="button" class="wa-btn ghost" bind:this={cancelBtnEl} on:click={() => (unlinkConfirming = false)}>{$t('settings.wa.cancel')}</button>
            <button type="button" class="wa-btn danger-solid" on:click={doUnlink}>{$t('settings.wa.unlink')}</button>
          {:else}
            <span class="wa-danger-text">{$t('settings.wa.unlink_hint')}</span>
            <button type="button" class="wa-btn danger" on:click={confirmUnlink}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7" /><path d="M15 7h2a5 5 0 0 1 4 8" /><line x1="8" y1="12" x2="12" y2="12" /><line x1="2" y1="2" x2="22" y2="22" /></svg>
              {$t('settings.wa.unlink')}
            </button>
          {/if}
        </footer>
      {/if}

    {:else}
      <!-- unlinked: idle, or logged_out -->
      {#if status.state === 'logged_out' && !userUnlinked}
        <div class="wa-box err" role="alert">{$t('settings.wa.err.logged_out')}</div>
      {/if}
      {#if status.reason === 'expired'}
        <div class="wa-box warn" role="status">
          {$t('settings.wa.code_expired')}
          <button type="button" class="wa-link" on:click={newCodeFromIdle}>{$t('settings.wa.new_code')}</button>
        </div>
      {:else if status.reason === 'error' || status.reason === 'outdated'}
        <!-- Backend-reported idle failure (e.g. the bridge's pairing attempt
             itself failed after `link` already returned ok) — "cancelled"
             and an unset reason show nothing, this is a real error. -->
        <div class="wa-box err" role="alert">{$t('settings.wa.err.generic')}</div>
      {/if}
      {#if linkError}
        <div class="wa-box err" role="alert">{$t(linkError === 'bridge' ? 'settings.wa.err.bridge' : 'settings.wa.err.generic')}</div>
      {/if}

      <div class="wa-intro">
        <ul class="wa-benefits">
          <li>
            <span class="wa-card-icon teal" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg></span>
            <span>{$t('settings.wa.benefit_notify')}</span>
          </li>
          <li>
            <span class="wa-card-icon purple" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg></span>
            <span>{$t('settings.wa.benefit_chat')}</span>
          </li>
          <li>
            <span class="wa-card-icon green" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg></span>
            <span>{$t('settings.wa.benefit_private')}</span>
          </li>
        </ul>

        <div class="wa-options">
          <button type="button" class="wa-option primary" disabled={starting} on:click={() => startLink('qr')}>
            <span class="wa-option-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></svg>
            </span>
            <span class="wa-option-text">
              <span class="wa-option-title">{$t('settings.wa.link_qr')}</span>
              <span class="wa-option-desc">{$t('settings.wa.opt_qr_desc')}</span>
            </span>
            {#if starting && pendingKind === 'qr'}
              <span class="wa-spinner" aria-hidden="true"></span>
            {:else}
              <svg class="wa-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18" /></svg>
            {/if}
          </button>
          <button type="button" class="wa-option" disabled={starting} on:click={chooseLinkPhone}>
            <span class="wa-option-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5" /><line x1="9.5" y1="7" x2="14.5" y2="7" /><line x1="9.5" y1="11" x2="14.5" y2="11" /><line x1="11" y1="18" x2="13" y2="18" /></svg>
            </span>
            <span class="wa-option-text">
              <span class="wa-option-title">{$t('settings.wa.link_phone')}</span>
              <span class="wa-option-desc">{$t('settings.wa.opt_phone_desc')}</span>
            </span>
            <svg class="wa-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18" /></svg>
          </button>
        </div>
      </div>
    {/if}
  </div>

  {#if mode === 'step'}
    <div class="wa-footer">
      <button type="button" class="wa-btn ghost" on:click={() => dispatch('skip')}>{$t('mail.connect.later')}</button>
      <span class="wa-spacer"></span>
      {#if status.state === 'connected'}
        <button type="button" class="wa-btn primary" on:click={continueStep}>{$t('mail.connect.continue')}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .wa {
    display: flex; flex-direction: column; gap: 14px; font-size: 14px; color: var(--text-1);
    max-height: min(640px, calc(100dvh - 150px)); min-height: 0;
  }
  /* Wizard step: the page chrome around it (header, progress, step padding)
     takes ~320px of a 720px screen; the scroll region inside absorbs the rest. */
  .wa.wa-step { max-height: calc(100dvh - 300px); min-height: 300px; }

  /* ── Header ── */
  .wa-header { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
  .wa-logo {
    width: 48px; height: 48px; border-radius: 14px; flex-shrink: 0;
    display: grid; place-items: center; color: #fff;
    background: linear-gradient(145deg, color-mix(in srgb, var(--green) 85%, #fff), color-mix(in srgb, var(--green) 80%, #000));
    box-shadow: 0 6px 18px color-mix(in srgb, var(--green) 30%, transparent);
  }
  .wa-header-text { min-width: 0; flex: 1; }
  .wa-title { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: var(--text-1); line-height: 1.2; }
  .wa-subtitle { margin: 2px 0 0; font-size: 13px; color: var(--text-2); }

  .wa-badge {
    display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;
    padding: 8px 14px; border-radius: 999px; font-size: 14px; font-weight: 600;
    border: 1px solid var(--border); background: var(--surface-1); color: var(--text-2);
  }
  .wa-badge.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, var(--border)); background: color-mix(in srgb, var(--green) 12%, var(--surface-1)); }
  .wa-badge.warn { color: var(--orange); border-color: color-mix(in srgb, var(--orange) 45%, var(--border)); background: color-mix(in srgb, var(--orange) 12%, var(--surface-1)); }
  .wa-badge.err { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, var(--border)); background: color-mix(in srgb, var(--red) 12%, var(--surface-1)); }
  .wa-pulse {
    width: 10px; height: 10px; border-radius: 50%; background: var(--green); position: relative;
  }
  .wa-pulse::after {
    content: ''; position: absolute; inset: 0; border-radius: 50%; background: var(--green);
    animation: wa-pulse 1.8s ease-out infinite;
  }
  @keyframes wa-pulse { from { transform: scale(1); opacity: 0.6; } to { transform: scale(2.6); opacity: 0; } }

  .wa-scroll { display: flex; flex-direction: column; gap: 14px; min-height: 0; flex: 1; overflow-y: auto; padding: 2px; }

  /* ── Shared bits ── */
  .wa-note { margin: 0; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); line-height: 1.45; }
  .wa-err-text { margin: 0; font-size: 13px; color: var(--red); }
  .wa-muted { color: var(--text-3); font-size: 12px; }

  .wa-box { border-radius: var(--radius-sm); padding: 10px 12px; font-size: 13px; line-height: 1.5; flex-shrink: 0; }
  .wa-box.warn { background: color-mix(in srgb, var(--orange) 12%, var(--surface-1)); border: 1px solid color-mix(in srgb, var(--orange) 45%, var(--border)); }
  .wa-box.err { background: color-mix(in srgb, var(--red) 12%, var(--surface-1)); border: 1px solid color-mix(in srgb, var(--red) 45%, var(--border)); }
  .wa-link { border: none; background: none; padding: 0; margin-left: 6px; color: var(--teal); cursor: pointer; font-size: 13px; font-weight: 600; text-decoration: underline; }

  .wa-panel {
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1);
    padding: 16px; display: flex; flex-direction: column; gap: 12px; flex-shrink: 0;
  }
  .wa-panel-head { display: flex; align-items: center; gap: 8px; color: var(--text-2); }
  .wa-panel-title { margin: 0; font-size: 15px; font-weight: 650; color: var(--text-1); }
  .wa-count {
    margin-left: auto; min-width: 24px; padding: 2px 8px; border-radius: 999px; text-align: center;
    font-size: 12px; font-weight: 600; background: var(--surface-2); color: var(--text-2);
  }

  .wa-card-icon {
    width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; flex-shrink: 0;
  }
  .wa-card-icon.green { color: var(--green); background: color-mix(in srgb, var(--green) 15%, transparent); }
  .wa-card-icon.teal { color: var(--teal); background: color-mix(in srgb, var(--teal) 15%, transparent); }
  .wa-card-icon.purple { color: var(--purple); background: color-mix(in srgb, var(--purple) 15%, transparent); }

  /* ── Linked: three cards ── */
  .wa-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; flex-shrink: 0; }
  .wa-card {
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1);
    padding: 16px; display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
    transition: border-color 150ms ease-out;
  }
  .wa-card:hover { border-color: var(--border-h); }
  .wa-card .wa-card-icon { margin-bottom: 4px; }
  .wa-card-label { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
  .wa-card-value { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .wa-card-text { font-size: 13px; color: var(--text-2); line-height: 1.45; flex: 1; }
  .wa-card-meta { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--orange); }
  .wa-card-meta.ok { color: var(--green); }
  .wa-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .wa-card .wa-btn { margin-top: 4px; }
  .wa-ok-ico { color: var(--green); }

  /* ── Chips ── */
  .wa-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .wa-chip {
    display: inline-flex; align-items: center; gap: 8px; min-height: 36px;
    border: 1px solid var(--border); border-radius: 999px; padding: 3px 6px 3px 4px;
    font-size: 14px; color: var(--text-1); background: var(--surface-2);
  }
  .wa-chip.you { border-color: color-mix(in srgb, var(--green) 40%, var(--border)); }
  .wa-chip-name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wa-avatar {
    width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0; display: grid; place-items: center;
    font-size: 11px; font-weight: 700; color: var(--teal); background: color-mix(in srgb, var(--teal) 18%, transparent);
  }
  .wa-chip.you .wa-avatar { color: var(--green); background: color-mix(in srgb, var(--green) 18%, transparent); }
  .wa-avatar.group { color: var(--text-3); background: var(--surface-3); }
  .wa-chip-x {
    width: 24px; height: 24px; border-radius: 50%; border: none; background: transparent; padding: 0;
    display: grid; place-items: center; color: var(--text-3); cursor: pointer;
    transition: background 150ms ease-out, color 150ms ease-out;
  }
  .wa-chip-x:hover { color: var(--red); background: color-mix(in srgb, var(--red) 14%, transparent); }
  .wa-chip-x:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .wa-chip-add {
    cursor: pointer; padding: 3px 14px; color: var(--teal); border-style: dashed; background: transparent;
    font-family: var(--font-body); font-weight: 600; transition: background 150ms ease-out;
  }
  .wa-chip-add:hover { background: color-mix(in srgb, var(--teal) 10%, transparent); }
  .wa-chip-add:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }

  .wa-chats { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; }
  .wa-chat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; max-height: 200px; overflow-y: auto; }
  .wa-chat-row { display: flex; align-items: center; gap: 10px; padding: 6px 4px; border-radius: var(--radius-sm); }
  .wa-chat-row:hover { background: var(--surface-2); }
  .wa-chat-name { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .wa-chat-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }

  /* ── Danger zone ── */
  .wa-danger {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap; flex-shrink: 0;
    padding-top: 12px; border-top: 1px solid var(--border);
  }
  .wa-danger-text { flex: 1; min-width: 200px; font-size: 13px; color: var(--text-2); }

  /* ── Unlinked ── */
  .wa-intro { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; align-items: start; }
  .wa-benefits {
    list-style: none; margin: 0; padding: 16px; display: flex; flex-direction: column; gap: 12px;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1);
  }
  .wa-benefits li { display: flex; align-items: center; gap: 12px; font-size: 14px; line-height: 1.4; }
  .wa-options { display: flex; flex-direction: column; gap: 10px; }
  .wa-option {
    display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; cursor: pointer;
    padding: 16px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface-1);
    color: var(--text-1); font-family: var(--font-body);
    transition: border-color 150ms ease-out, background 150ms ease-out, transform 150ms ease-out;
  }
  .wa-option:hover:not(:disabled) { border-color: var(--teal); background: color-mix(in srgb, var(--teal) 6%, var(--surface-1)); }
  .wa-option:active:not(:disabled) { transform: scale(0.99); }
  .wa-option:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .wa-option:disabled { opacity: 0.55; cursor: not-allowed; }
  .wa-option.primary { border-color: color-mix(in srgb, var(--teal) 55%, var(--border)); }
  .wa-option-icon {
    width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0; display: grid; place-items: center;
    color: var(--teal); background: color-mix(in srgb, var(--teal) 15%, transparent);
  }
  .wa-option.primary .wa-option-icon { color: var(--bg); background: var(--teal); }
  .wa-option-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .wa-option-title { font-size: 15px; font-weight: 650; }
  .wa-option-desc { font-size: 13px; color: var(--text-2); line-height: 1.4; }
  .wa-chev { color: var(--text-3); flex-shrink: 0; }

  /* ── Linking ── */
  .wa-link-panel { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 24px; }
  .wa-link-side { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 12px; }
  .wa-qr-frame {
    padding: 12px; border-radius: 16px; background: #fff; flex-shrink: 0; line-height: 0;
    box-shadow: 0 0 0 1px var(--border), 0 10px 30px rgba(0, 0, 0, 0.25);
  }
  .wa-qr-img { display: block; border-radius: 4px; }
  .wa-qr-placeholder {
    width: 208px; height: 208px; border-radius: 4px;
    background: linear-gradient(90deg, #eee 0%, #f8f8f8 50%, #eee 100%) 0 0 / 200% 100%;
    animation: wa-shimmer 1.4s linear infinite;
  }
  .wa-stepper { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
  .wa-stepper li { display: flex; align-items: center; gap: 10px; font-size: 14px; }
  .wa-step-n {
    width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0; display: grid; place-items: center;
    font-size: 12px; font-weight: 700; color: var(--teal); background: color-mix(in srgb, var(--teal) 15%, transparent);
  }

  .wa-form-panel { max-width: 460px; }
  .wa-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .wa-input-wrap { position: relative; display: flex; align-items: center; }
  .wa-input-icon { position: absolute; left: 12px; color: var(--text-3); pointer-events: none; }
  .wa-input {
    width: 100%; min-height: 42px; padding: 8px 12px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1);
    font-family: var(--font-body); font-size: 14px; box-sizing: border-box;
  }
  .wa-input.with-icon { padding-left: 38px; }
  .wa-input:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .wa-input:disabled { opacity: 0.5; }

  .wa-code-side { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .wa-code { display: flex; align-items: center; gap: 6px; }
  .wa-code-cell {
    width: 40px; height: 52px; display: grid; place-items: center; border-radius: 10px;
    font-family: var(--font-mono); font-size: 26px; font-weight: 700;
    background: var(--surface-2); border: 1px solid var(--border-h); color: var(--text-1);
  }
  .wa-code-dash { color: var(--text-3); font-size: 22px; padding: 0 2px; }

  /* ── Bridge down ── */
  .wa-empty {
    display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px;
    padding: 32px 16px; border: 1px dashed var(--border); border-radius: var(--radius);
  }
  .wa-empty-icon { width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center; margin-bottom: 4px; }
  .wa-empty-icon.err { color: var(--red); background: color-mix(in srgb, var(--red) 14%, transparent); }
  .wa-empty-title { margin: 0; font-size: 16px; font-weight: 650; }
  .wa-empty-text { margin: 0; font-size: 13px; color: var(--text-2); max-width: 420px; line-height: 1.5; }

  /* ── Loading ── */
  .wa-skeleton { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .wa-skeleton.rows { grid-template-columns: 1fr; gap: 6px; }
  .wa-skeleton span {
    height: 110px; border-radius: var(--radius);
    background: linear-gradient(90deg, var(--surface-1) 0%, var(--surface-2) 50%, var(--surface-1) 100%) 0 0 / 200% 100%;
    animation: wa-shimmer 1.4s linear infinite;
  }
  .wa-skeleton.rows span { height: 36px; }
  @keyframes wa-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  .wa-spinner {
    width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
    border: 2px solid color-mix(in srgb, currentColor 30%, transparent); border-top-color: currentColor;
    animation: wa-spin 0.8s linear infinite;
  }
  @keyframes wa-spin { to { transform: rotate(360deg); } }

  /* ── Buttons ── */
  .wa-actions-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex-shrink: 0; }
  .wa-footer { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .wa-spacer { flex: 1; }
  .wa-btn {
    min-height: 40px; padding: 8px 16px; border-radius: var(--radius-sm); font-size: 14px; font-weight: 600;
    cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    font-family: var(--font-body); transition: background 150ms ease-out, border-color 150ms ease-out, opacity 150ms ease-out;
  }
  .wa-btn.sm { min-height: 34px; padding: 6px 12px; font-size: 13px; }
  .wa-btn:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .wa-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .wa-btn.ghost { border: 1px solid var(--border); background: transparent; color: var(--text-1); }
  .wa-btn.ghost:hover:not(:disabled) { border-color: var(--border-h); background: var(--surface-2); }
  .wa-btn.primary { border: 1px solid var(--teal); background: var(--teal); color: var(--bg); }
  .wa-btn.primary:hover:not(:disabled) { opacity: 0.9; }
  .wa-btn.danger { border: 1px solid color-mix(in srgb, var(--red) 55%, var(--border)); background: transparent; color: var(--red); }
  .wa-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--red) 12%, transparent); }
  .wa-btn.danger-solid { border: 1px solid var(--red); background: var(--red); color: #fff; }

  @media (prefers-reduced-motion: reduce) {
    .wa-pulse::after, .wa-skeleton span, .wa-qr-placeholder, .wa-spinner { animation: none; }
    .wa-option, .wa-btn, .wa-card { transition: none; }
  }
</style>
