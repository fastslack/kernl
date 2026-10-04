<script lang="ts">
  /**
   * The license, in one place: what it unlocks and how to add or replace it.
   *
   * Adding one has to be one step. Pasting checks and saves it immediately (no
   * second button to find), the file from the purchase email can be uploaded
   * as is, and a rejection says what to do next, beside the field. The kernel
   * cleans up what mail clients do to a long token (wrapped lines, invisible
   * characters) before verifying it, so a paste straight from the email works.
   *
   * Lives in Settings → License (first item of the rail) and is what
   * /settings/license redirects to.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { t, locale } from '$lib/i18n/index.js';

  interface LicenseStatus {
    status: 'none' | 'valid' | 'expired' | 'invalid' | 'machine_mismatch';
    isPro: boolean;
    sku: 'pro' | 'cloud' | 'both' | null;
    email: string | null;
    features: string[];
    issued_at: number | null;
    expires_at: number | null;
    message: string | null;
  }
  interface StoreItem { feature: string; name: string; icon?: string }

  const BASE = (globalThis as { __API_BASE?: string }).__API_BASE ?? '';
  const SITE_URL = (globalThis as { __SITE_URL?: string }).__SITE_URL ?? 'https://lifekernl.com';
  const dispatch = createEventDispatcher<{ change: LicenseStatus | null }>();

  let status: LicenseStatus | null = null;
  let loading = true;
  let names: Record<string, StoreItem> = {};
  let pasteValue = '';
  let saving = false;
  let error = '';
  let okList: string[] = [];
  let note = '';
  let confirmRemove = false;
  let fileInput: HTMLInputElement;

  const nameOf = (f: string) => {
    const it = names[f];
    return it ? `${it.icon ? `${it.icon} ` : ''}${it.name}` : f.replace(/^pro:/, '');
  };
  const fmtDate = (epoch: number | null) =>
    epoch ? new Date(epoch * 1000).toLocaleDateString($locale === 'es' ? 'es-AR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  $: days = status?.expires_at ? Math.floor((status.expires_at - Date.now() / 1000) / 86400) : null;

  async function loadStatus() {
    try {
      const res = await fetch(`${BASE}/api/license/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status = await res.json();
      dispatch('change', status);
    } catch (err) {
      error = $t('license.load_err', { msg: err instanceof Error ? err.message : String(err) });
    } finally {
      loading = false;
    }
  }

  async function loadNames() {
    try {
      const res = await fetch(`${BASE}/api/store/status`);
      if (!res.ok) return;
      const body = (await res.json()) as { items?: StoreItem[] };
      names = Object.fromEntries((body.items ?? []).map((i) => [i.feature, i]));
    } catch { /* names are cosmetic: fall back to the feature slug */ }
  }

  /**
   * Same cleanup the kernel does (core/license/verify.ts normalizeLicenseInput),
   * repeated here so a paste from an email also works against a kernel that
   * predates it: drop invisible characters, join a token the mail client
   * wrapped, keep only the eyJ… token.
   */
  function cleanPaste(raw: string): string {
    const compact = raw.replace(/[\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g, '').replace(/^\s*bearer\s+/i, '');
    const at = compact.indexOf('eyJ');
    if (at < 0) return raw.trim();
    // Mail clients turn the box's line wraps into newlines or spaces.
    const run = /^[A-Za-z0-9_\-.]+(?:[ \t]*\r?\n?[ \t]*[A-Za-z0-9_\-.]+)*/.exec(compact.slice(at))?.[0] ?? '';
    const parts = run.replace(/\s+/g, '').split('.');
    if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return raw.trim();
    // RS256 with a 2048-bit key: the signature is always 342 chars; whatever
    // follows is text copied from the email after the token.
    return `${parts[0]}.${parts[1]}.${parts[2].slice(0, 342)}`;
  }

  async function save(value = pasteValue) {
    error = ''; okList = []; note = '';
    if (!value.trim()) { error = $t('license.add.empty'); return; }
    const before = new Set(status?.features ?? []);
    saving = true;
    try {
      const res = await fetch(`${BASE}/api/license/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jwt: cleanPaste(value) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { error = body.message ?? `HTTP ${res.status}`; return; }
      pasteValue = '';
      await loadStatus();
      const gained = (status?.features ?? []).filter((f) => !before.has(f));
      okList = (gained.length ? gained : status?.features ?? []).map(nameOf);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  // Pasting is the whole gesture: check and save right away.
  function onPaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!text.trim()) return;
    e.preventDefault();
    pasteValue = text;
    void save(text);
  }

  async function onFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const text = await f.text();
    (e.target as HTMLInputElement).value = '';
    pasteValue = text;
    void save(text);
  }

  async function copyLicense() {
    try {
      const res = await fetch(`${BASE}/api/license/export`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { jwt } = (await res.json()) as { jwt: string };
      try {
        await navigator.clipboard.writeText(jwt);
      } catch {
        // No clipboard API over plain http on a LAN address: fall back.
        const ta = document.createElement('textarea');
        ta.value = jwt; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      }
      note = $t('license.copied');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function removeLicense() {
    confirmRemove = false;
    try {
      const res = await fetch(`${BASE}/api/license/clear`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      okList = [];
      note = $t('license.removed');
      await loadStatus();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  onMount(() => { void loadStatus(); void loadNames(); });
</script>

<section class="lic">
  <header class="lic-head">
    <h2>{$t('license.title')}</h2>
    <p>{$t('license.lede')}</p>
  </header>

  {#if loading}
    <div class="lic-card lic-muted">…</div>
  {:else}
    <div class="lic-card lic-state s-{status?.status ?? 'none'}">
      <div class="lic-state-row">
        <span class="lic-pill">{$t(`license.state.${status?.status === 'machine_mismatch' ? 'invalid' : (status?.status ?? 'none')}`)}</span>
        {#if status?.status === 'valid' && days !== null && days <= 14 && days >= 0}
          <span class="lic-warn">{$t('license.expiring', { n: days })}</span>
        {/if}
      </div>
      {#if status?.status === 'valid'}
        <dl class="lic-meta">
          <dt>{$t('license.email')}</dt><dd>{status.email ?? '—'}</dd>
          <dt>{$t('license.expires')}</dt><dd>{fmtDate(status.expires_at)}</dd>
          <dt>{$t('license.unlocked')}</dt>
          <dd class="lic-chips">{#each status.features as f (f)}<span>{nameOf(f)}</span>{/each}</dd>
        </dl>
        <div class="lic-actions">
          <button class="lic-btn" on:click={copyLicense}>{$t('license.copy')}</button>
          {#if confirmRemove}
            <span class="lic-confirm">{$t('license.remove.confirm')}</span>
            <button class="lic-btn danger" on:click={removeLicense}>{$t('license.remove.yes')}</button>
            <button class="lic-btn" on:click={() => (confirmRemove = false)}>{$t('license.cancel')}</button>
          {:else}
            <button class="lic-btn ghost" on:click={() => (confirmRemove = true)}>{$t('license.remove')}</button>
          {/if}
        </div>
      {:else if status?.status === 'expired'}
        <p>{$t('license.expired.body', { date: fmtDate(status.expires_at) })}</p>
      {:else if status?.status === 'invalid' || status?.status === 'machine_mismatch'}
        <p>{$t('license.invalid.body', { msg: status.message ?? '' })}</p>
      {:else}
        <p>{$t('license.none.body')}</p>
      {/if}
    </div>

    <div class="lic-card lic-add">
      <h3>{status?.status === 'valid' ? $t('license.replace.title') : $t('license.add.title')}</h3>
      <p class="lic-help">{$t('license.add.help')}</p>
      <textarea
        bind:value={pasteValue}
        on:paste={onPaste}
        placeholder={$t('license.add.placeholder')}
        rows="4"
        spellcheck="false"
        disabled={saving}
        aria-label={$t('license.add.placeholder')}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? 'lic-err' : undefined}
      ></textarea>

      {#if error}
        <div class="lic-msg err" id="lic-err" role="alert">
          <b>{$t('license.add.err_title')}</b>
          <span>{error}</span>
          <span class="lic-fix">{$t('license.add.err_fix')}</span>
        </div>
      {/if}
      {#if okList.length}
        <div class="lic-msg ok" role="status">
          <span>{$t('license.add.ok', { list: okList.join(', ') })}</span>
          <a href="/extensions">{$t('license.add.ok_cta')} →</a>
        </div>
      {/if}
      {#if note}<div class="lic-msg info" role="status">{note}</div>{/if}

      <div class="lic-actions">
        <button class="lic-btn primary" disabled={saving || !pasteValue.trim()} on:click={() => save()}>
          {saving ? $t('license.add.saving') : $t('license.add.save')}
        </button>
        <button class="lic-btn" disabled={saving} on:click={() => fileInput.click()}>{$t('license.add.file')}</button>
        <input bind:this={fileInput} type="file" accept=".jwt,.txt,text/plain" hidden on:change={onFile} />
        <span class="lic-grow"></span>
        <a class="lic-link" href={`${SITE_URL}/account`} target="_blank" rel="noopener">{$t('license.get.recover')} ↗</a>
        <a class="lic-link" href={`${SITE_URL}/pricing`} target="_blank" rel="noopener">{$t('license.get.buy')} ↗</a>
      </div>
    </div>
  {/if}
</section>

<style>
  .lic { display: flex; flex-direction: column; gap: 12px; max-width: 760px; }
  .lic-head h2 { margin: 0 0 4px; font-family: var(--font-display); font-size: 20px; color: var(--text-1); }
  .lic-head p { margin: 0; color: var(--text-2); font-size: 13.5px; line-height: 1.5; }
  .lic-card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
  .lic-card p { margin: 0; color: var(--text-2); font-size: 13.5px; line-height: 1.5; }
  .lic-muted { color: var(--text-3); }
  .lic-state.s-valid { border-color: var(--green); }
  .lic-state.s-expired { border-color: var(--gold); }
  .lic-state.s-invalid, .lic-state.s-machine_mismatch { border-color: var(--red); }
  .lic-state-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .lic-pill { font: 700 12px var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-2); }
  .s-valid .lic-pill { color: var(--green); border-color: var(--green); }
  .s-expired .lic-pill { color: var(--gold); border-color: var(--gold); }
  .s-invalid .lic-pill, .s-machine_mismatch .lic-pill { color: var(--red); border-color: var(--red); }
  .lic-warn { color: var(--gold); font-size: 13px; }
  .lic-meta { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; font-size: 13.5px; }
  .lic-meta dt { color: var(--text-3); }
  .lic-meta dd { margin: 0; color: var(--text-1); }
  .lic-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .lic-chips span { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1); }
  .lic-add h3 { margin: 0; font-size: 15px; color: var(--text-1); }
  .lic-help { font-size: 13px; }
  textarea { width: 100%; box-sizing: border-box; background: var(--bg); border: 1px dashed var(--border); border-radius: 8px; color: var(--text-1); padding: 10px 12px; font: 12px/1.5 var(--font-mono); resize: vertical; min-height: 84px; word-break: break-all; }
  textarea:focus { outline: 2px solid var(--teal); outline-offset: 1px; border-style: solid; }
  .lic-msg { border-radius: 8px; padding: 9px 12px; font-size: 13.5px; line-height: 1.5; display: flex; flex-direction: column; gap: 2px; }
  .lic-msg.err { border: 1px solid var(--red); background: rgba(255, 90, 90, 0.07); color: var(--text-1); }
  .lic-msg.err b { color: var(--red); }
  .lic-fix { color: var(--text-2); }
  .lic-msg.ok { border: 1px solid var(--green); background: rgba(61, 214, 140, 0.07); color: var(--text-1); }
  .lic-msg.ok a { color: var(--teal); text-decoration: none; font-weight: 600; }
  .lic-msg.info { border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); }
  .lic-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .lic-grow { flex: 1; }
  .lic-confirm { font-size: 13px; color: var(--text-2); }
  .lic-btn { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1); border-radius: 6px; padding: 8px 14px; min-height: 36px; font: inherit; font-size: 13px; cursor: pointer; }
  .lic-btn:hover:not(:disabled) { background: var(--surface-3); }
  .lic-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .lic-btn.primary { background: var(--teal); border-color: var(--teal); color: var(--bg); font-weight: 600; }
  .lic-btn.danger { background: none; border-color: var(--red); color: var(--red); }
  .lic-btn.ghost { background: none; color: var(--text-3); }
  .lic-btn:focus-visible, .lic-link:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .lic-link { font-size: 13px; color: var(--teal); text-decoration: none; }
</style>
