<script lang="ts">
  import { onMount } from 'svelte';

  // ── State ────────────────────────────────────────────────────────
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

  const BASE = (globalThis as { __API_BASE?: string }).__API_BASE ?? '';
  const SITE_URL = (globalThis as { __SITE_URL?: string }).__SITE_URL ?? 'https://github.com/fastslack/kernl';

  let status: LicenseStatus | null = null;
  let loading = true;
  let pasteValue = '';
  let saving = false;
  let clearing = false;
  let copying = false;
  let copied = false;
  let msg = '';
  let msgType: 'ok' | 'err' = 'ok';

  // ── Helpers ──────────────────────────────────────────────────────
  function flash(text: string, type: 'ok' | 'err' = 'ok') {
    msg = text;
    msgType = type;
    setTimeout(() => { msg = ''; }, 4000);
  }

  function fmtDate(epoch: number | null): string {
    if (!epoch) return '—';
    const d = new Date(epoch * 1000);
    return d.toUTCString();
  }

  function daysUntil(epoch: number | null): number | null {
    if (!epoch) return null;
    const now = Math.floor(Date.now() / 1000);
    return Math.floor((epoch - now) / 86400);
  }

  // ── API calls ────────────────────────────────────────────────────
  async function loadStatus() {
    loading = true;
    try {
      const res = await fetch(`${BASE}/api/license/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status = await res.json();
    } catch (err) {
      flash(`Failed to load license status: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      loading = false;
    }
  }

  async function saveLicense() {
    if (!pasteValue.trim()) {
      flash('Paste a license JWT first', 'err');
      return;
    }
    saving = true;
    try {
      const res = await fetch(`${BASE}/api/license/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jwt: pasteValue.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        // The server returns the typed status as part of body — surface it.
        const detail = body.message ?? `HTTP ${res.status}`;
        flash(`Rejected (${body.status ?? 'invalid'}): ${detail}`, 'err');
        return;
      }
      pasteValue = '';
      flash('License saved — Pro modules unlocked.', 'ok');
      await loadStatus();
    } catch (err) {
      flash(`Failed to save license: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      saving = false;
    }
  }

  /**
   * Put the raw JWT on the clipboard so it can be pasted into another
   * install. Never rendered on screen: a token valid until 2036 does not
   * belong in a screenshot or a shoulder-surfed settings pane, and the paste
   * box below is the only place a licence needs to be visible.
   *
   * The clipboard API needs a secure context, which a kernel reached over
   * plain http on a LAN address is not — so the fallback matters more here
   * than it usually would.
   */
  async function copyLicense() {
    copying = true;
    try {
      const res = await fetch(`${BASE}/api/license/export`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { jwt } = (await res.json()) as { jwt: string };
      try {
        await navigator.clipboard.writeText(jwt);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = jwt;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      copied = true;
      flash('License copied. Paste it into the other install and restart it.', 'ok');
      setTimeout(() => (copied = false), 2500);
    } catch (err) {
      flash(`Could not copy: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      copying = false;
    }
  }

  async function clearLicense() {
    if (!confirm('Remove the license? Pro modules will be locked until you re-paste a valid JWT.')) return;
    clearing = true;
    try {
      const res = await fetch(`${BASE}/api/license/clear`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      flash('License cleared.', 'ok');
      await loadStatus();
    } catch (err) {
      flash(`Failed to clear license: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      clearing = false;
    }
  }

  // Reactive derived helpers — Svelte 4 syntax (matches the rest of the dashboard).
  $: days = status?.expires_at ? daysUntil(status.expires_at) : null;
  $: isExpiringSoon = days !== null && days <= 7 && days >= 0;
  $: skuLabel =
    status?.sku === 'both' ? 'Pro + Cloud' :
    status?.sku === 'cloud' ? 'Cloud' :
    status?.sku === 'pro' ? 'Pro' :
    '—';

  onMount(loadStatus);
</script>

<svelte:head>
  <title>License · Settings · Kernl</title>
</svelte:head>

<div class="license-page">
  <header class="license-head">
    <h1>License</h1>
    <p class="lede">
      Kernl Pro modules check this license at boot. Paste a JWT issued by
      <a href={SITE_URL + '/pricing'} target="_blank" rel="noopener">github.com/fastslack/kernl</a>
      to unlock them.
    </p>
  </header>

  {#if msg}
    <div class="flash flash-{msgType}">{msg}</div>
  {/if}

  {#if loading}
    <div class="card card-loading">Loading…</div>
  {:else if status?.status === 'valid'}
    <div class="card card-active">
      <div class="status-row">
        <span class="status-pill status-ok">Active</span>
        <span class="status-sku">{skuLabel}</span>
        {#if isExpiringSoon}
          <span class="status-warn">Expires in {days} day{days === 1 ? '' : 's'}</span>
        {/if}
      </div>
      <dl class="status-meta">
        <dt>Email</dt><dd>{status.email}</dd>
        <dt>Expires</dt><dd>{fmtDate(status.expires_at)}</dd>
        <dt>Features</dt>
        <dd class="feature-list">
          {#each status.features as f}
            <code>{f}</code>
          {/each}
        </dd>
      </dl>
      <div class="actions">
        <button class="btn btn-secondary" disabled={copying} on:click={copyLicense}>
          {copied ? 'Copied' : copying ? 'Copying…' : 'Copy license'}
        </button>
        <button class="btn btn-secondary" on:click={() => loadStatus()}>Refresh</button>
        <button class="btn btn-danger" disabled={clearing} on:click={clearLicense}>
          {clearing ? 'Clearing…' : 'Remove license'}
        </button>
      </div>
    </div>

  {:else if status?.status === 'expired'}
    <div class="card card-warn">
      <div class="status-row">
        <span class="status-pill status-warn-pill">Expired</span>
        <span class="status-sku">{skuLabel}</span>
      </div>
      <p>
        Your license expired on <b>{fmtDate(status.expires_at)}</b>. Pro modules are now
        locked. Renew or restore at <a href={SITE_URL + '/account'} target="_blank" rel="noopener">{SITE_URL}/account</a>.
      </p>
    </div>

  {:else if status?.status === 'invalid' || status?.status === 'machine_mismatch'}
    <div class="card card-err">
      <span class="status-pill status-err-pill">Invalid</span>
      <p>{status.message ?? 'License rejected'}</p>
    </div>

  {:else}
    <div class="card card-none">
      <span class="status-pill">No license</span>
      <p>
        You're on the <b>Free Core</b> tier. All 45+ free modules work normally. To unlock the
        Pro modules (trading, advanced agents, graph intelligence, web intel pro, comms pro),
        get a license below.
      </p>
      <a class="btn btn-primary" href={SITE_URL + '/pricing'} target="_blank" rel="noopener">
        Get a license →
      </a>
    </div>
  {/if}

  <!-- Always render the paste form so users can replace an existing license. -->
  <div class="card card-paste">
    <h2>{status?.status === 'valid' ? 'Replace license' : 'Paste your license JWT'}</h2>
    <p class="muted">
      You can find the JWT in the welcome email you received after purchase,
      or recover it at <a href={SITE_URL + '/account'} target="_blank" rel="noopener">{SITE_URL}/account</a>.
    </p>
    <textarea
      bind:value={pasteValue}
      placeholder="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
      rows="6"
      disabled={saving}
    ></textarea>
    <div class="actions">
      <button class="btn btn-primary" disabled={saving || !pasteValue.trim()} on:click={saveLicense}>
        {saving ? 'Verifying…' : 'Save license'}
      </button>
      <button class="btn btn-secondary" disabled={saving} on:click={() => (pasteValue = '')}>
        Clear field
      </button>
    </div>
  </div>

  <div class="card card-info">
    <h2>Alternatives</h2>
    <ul>
      <li><b>File:</b> save the JWT as <code>~/.config/kernl/license.jwt</code> and restart the kernel.</li>
      <li><b>Env:</b> set <code>KERNEL_LICENSE_JWT</code> in <code>~/.config/kernl/.env</code>.</li>
      <li><b>CLI (coming soon):</b> <code>kernl license set &lt;jwt&gt;</code>.</li>
    </ul>
  </div>
</div>

<style>
  .license-page {
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 28px 96px;
    color: #e4e7f1;
    font-family: ui-sans-serif, system-ui, -apple-system, "Inter", sans-serif;
  }

  .license-head {
    margin-bottom: 32px;
  }
  .license-head h1 {
    font-size: 28px;
    font-weight: 800;
    margin: 0 0 8px;
    letter-spacing: -0.02em;
    color: #fff;
  }
  .lede {
    color: #b8bdd1;
    font-size: 14px;
    line-height: 1.55;
    margin: 0;
  }
  .lede a { color: #818cf8; }
  .lede a:hover { text-decoration: underline; }

  .card {
    padding: 24px;
    background: rgba(255,255,255,0.015);
    border: 1px solid #1d2138;
    border-radius: 14px;
    margin-bottom: 16px;
  }
  .card h2 {
    font-size: 16px;
    font-weight: 700;
    margin: 0 0 12px;
    color: #fff;
  }
  .card-loading { color: #8b91a8; text-align: center; padding: 32px; }
  .card-active { border-color: rgba(61,214,200,0.35); background: linear-gradient(180deg, rgba(61,214,200,0.04) 0%, rgba(0,0,0,0) 100%); }
  .card-warn   { border-color: rgba(255,200,120,0.35); background: linear-gradient(180deg, rgba(255,200,120,0.04) 0%, rgba(0,0,0,0) 100%); }
  .card-err    { border-color: rgba(255,100,100,0.35); background: linear-gradient(180deg, rgba(255,100,100,0.04) 0%, rgba(0,0,0,0) 100%); }
  .card-none   { /* default */ }
  .card-info   { background: rgba(99,102,241,0.03); border-color: rgba(99,102,241,0.2); }

  .status-row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .status-pill {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    background: rgba(99,102,241,0.15);
    border: 1px solid rgba(99,102,241,0.4);
    color: #818cf8;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-family: ui-monospace, Menlo, monospace;
  }
  .status-ok       { background: rgba(61,214,200,0.15); border-color: rgba(61,214,200,0.5); color: #3dd6c8; }
  .status-warn-pill{ background: rgba(255,200,120,0.15); border-color: rgba(255,200,120,0.5); color: #ffc878; }
  .status-err-pill { background: rgba(255,100,100,0.15); border-color: rgba(255,100,100,0.5); color: #ff8888; }
  .status-sku      { font-weight: 700; color: #fff; }
  .status-warn     { color: #ffc878; font-size: 13px; }

  .status-meta {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 6px 16px;
    margin: 0 0 18px;
    font-size: 13px;
  }
  .status-meta dt { color: #8b91a8; font-family: ui-monospace, Menlo, monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding-top: 2px; }
  .status-meta dd { color: #e4e7f1; margin: 0; }

  .feature-list { display: flex; flex-wrap: wrap; gap: 4px; }
  .feature-list code {
    background: rgba(99,102,241,0.1);
    color: #818cf8;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-family: ui-monospace, Menlo, monospace;
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 8px;
  }

  .btn {
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: 0;
    font-family: inherit;
    transition: all 0.15s;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary {
    background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
    color: #fff;
    box-shadow: 0 4px 12px rgba(99,102,241,0.3);
    text-decoration: none;
    display: inline-block;
  }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn-secondary {
    background: transparent;
    border: 1px solid #232742;
    color: #e4e7f1;
  }
  .btn-secondary:hover { border-color: #6366f1; background: rgba(99,102,241,0.05); }
  .btn-danger {
    background: rgba(255,100,100,0.1);
    border: 1px solid rgba(255,100,100,0.3);
    color: #ff8888;
  }
  .btn-danger:hover { background: rgba(255,100,100,0.15); }

  textarea {
    width: 100%;
    padding: 12px 14px;
    margin: 8px 0;
    background: #07080c;
    border: 1px solid #232742;
    border-radius: 8px;
    color: #d4d8e8;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px;
    line-height: 1.4;
    word-break: break-all;
    resize: vertical;
    box-sizing: border-box;
  }
  textarea:focus { outline: none; border-color: #6366f1; }

  .muted {
    color: #8b91a8;
    font-size: 12px;
    margin: 0 0 8px;
  }
  .muted code, .card-info code {
    background: rgba(0,0,0,0.4);
    padding: 1px 6px;
    border-radius: 3px;
    color: #a5b4fc;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px;
  }

  .card-info ul { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.7; color: #b8bdd1; }
  .card-info li b { color: #fff; font-weight: 600; }

  .flash {
    padding: 12px 16px;
    margin-bottom: 16px;
    border-radius: 8px;
    font-size: 13px;
  }
  .flash-ok  { background: rgba(61,214,200,0.08);  border: 1px solid rgba(61,214,200,0.3);  color: #3dd6c8; }
  .flash-err { background: rgba(255,100,100,0.08); border: 1px solid rgba(255,100,100,0.3); color: #ff8888; }
</style>
