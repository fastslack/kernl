<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  type Provider = 'gmail' | 'resend' | 'imap_smtp';
  type AccountType = 'personal' | 'work' | 'transactional' | 'marketing';

  interface EmailAccount {
    id: string;
    label: string;
    email: string;
    type: AccountType;
    provider: Provider;
    company: string;
    signature: string;
    provider_config: string;
    is_default: number;
    created_at: string;
    updated_at: string;
  }

  interface TestResult {
    ok: boolean;
    provider: string;
    details: Record<string, unknown>;
  }

  interface GoogleProfile {
    authenticated: boolean;
    configured: boolean;
    email?: string;
    name?: string;
    picture?: string;
    authUrl?: string;
    needsReauth?: boolean;
    status?: string;
    message?: string;
    error?: string;
  }

  let accounts: EmailAccount[] = [];
  let loading = true;
  let saving = false;
  let error = '';
  let testResults: Record<string, TestResult> = {};
  let googleProfile: GoogleProfile | null = null;
  let googleProfileLoading = false;

  // Editing state
  let editId: string | null = null;
  let isNew = false;
  let form = emptyForm();

  function emptyForm() {
    return {
      id: '',
      label: '',
      email: '',
      provider: 'gmail' as Provider,
      type: 'personal' as AccountType,
      company: '',
      signature: '',
      is_default: false,
      // Provider-specific
      resend_api_key: '',
      imap_host: '',
      imap_port: 993,
      imap_secure: true,
      smtp_host: '',
      smtp_port: 465,
      smtp_secure: true,
      user: '',
      pass: '',
      from: '',
    };
  }

  async function load() {
    loading = true;
    try {
      const r = await fetch('/api/email-accounts');
      accounts = r.ok ? await r.json() : [];
    } finally {
      loading = false;
    }
  }

  async function loadGoogleProfile() {
    googleProfileLoading = true;
    try {
      const r = await fetch('/api/email-accounts/google-profile');
      googleProfile = r.ok ? await r.json() : null;
    } finally {
      googleProfileLoading = false;
    }
  }

  function autofillFromGoogle() {
    if (!googleProfile?.authenticated) return;
    if (googleProfile.email && !form.email) form.email = googleProfile.email;
    if (googleProfile.name && !form.label) form.label = `${googleProfile.name} (Gmail)`;
    else if (googleProfile.email && !form.label) form.label = `Gmail — ${googleProfile.email}`;
  }

  function beginCreate() {
    form = emptyForm();
    editId = null;
    isNew = true;
    error = '';
    // Gmail is the default provider — auto-fill from existing Google auth if present
    if (googleProfile?.authenticated) autofillFromGoogle();
  }

  // Re-autofill when the user switches the form provider to gmail
  $: if (isNew && form.provider === 'gmail' && googleProfile?.authenticated && !form.email) {
    autofillFromGoogle();
  }

  function beginEdit(acc: EmailAccount) {
    form = emptyForm();
    editId = acc.id;
    isNew = false;
    error = '';
    form.id = acc.id;
    form.label = acc.label;
    form.email = acc.email;
    form.provider = acc.provider;
    form.type = acc.type;
    form.company = acc.company;
    form.signature = acc.signature;
    form.is_default = !!acc.is_default;

    try {
      const cfg = JSON.parse(acc.provider_config || '{}');
      if (acc.provider === 'resend') {
        form.resend_api_key = cfg.api_key ?? '';
      } else if (acc.provider === 'imap_smtp') {
        form.imap_host = cfg.imap_host ?? '';
        form.imap_port = cfg.imap_port ?? 993;
        form.imap_secure = cfg.imap_secure ?? true;
        form.smtp_host = cfg.smtp_host ?? '';
        form.smtp_port = cfg.smtp_port ?? 465;
        form.smtp_secure = cfg.smtp_secure ?? true;
        form.user = cfg.user ?? '';
        form.pass = cfg.pass ?? '';
        form.from = cfg.from ?? '';
      }
    } catch { /* ignore parse errors */ }
  }

  function cancelEdit() {
    editId = null;
    isNew = false;
    error = '';
    form = emptyForm();
  }

  function buildProviderConfig(): Record<string, unknown> {
    if (form.provider === 'resend') {
      return { api_key: form.resend_api_key };
    }
    if (form.provider === 'imap_smtp') {
      return {
        imap_host: form.imap_host,
        imap_port: Number(form.imap_port) || 993,
        imap_secure: form.imap_secure,
        smtp_host: form.smtp_host,
        smtp_port: Number(form.smtp_port) || 465,
        smtp_secure: form.smtp_secure,
        user: form.user,
        pass: form.pass,
        from: form.from || form.email,
      };
    }
    return {};
  }

  async function save() {
    error = '';
    if (!form.label.trim() || !form.email.trim()) {
      error = 'Label and email are required';
      return;
    }
    saving = true;
    try {
      if (isNew) {
        const r = await fetch('/api/email-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: form.label,
            email: form.email,
            provider: form.provider,
            type: form.type,
            company: form.company,
            signature: form.signature,
            provider_config: buildProviderConfig(),
            is_default: form.is_default,
          }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${r.status}`);
        }
      } else {
        const r = await fetch('/api/email-accounts/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: form.id,
            label: form.label,
            email: form.email,
            type: form.type,
            company: form.company,
            signature: form.signature,
            provider_config: buildProviderConfig(),
            is_default: form.is_default,
          }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${r.status}`);
        }
      }
      cancelEdit();
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function deleteAccount(acc: EmailAccount) {
    if (!confirm(`Delete account "${acc.label}" (${acc.email})? Linked messages will be kept but unlabelled.`)) return;
    const r = await fetch('/api/email-accounts/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: acc.id }),
    });
    if (r.ok) await load();
  }

  async function setDefault(acc: EmailAccount) {
    await fetch('/api/email-accounts/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: acc.id, is_default: true }),
    });
    await load();
  }

  async function testAccount(acc: EmailAccount) {
    testResults[acc.id] = { ok: false, provider: acc.provider, details: { status: 'testing...' } };
    testResults = { ...testResults };
    try {
      const r = await fetch('/api/email-accounts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: acc.id }),
      });
      const data = await r.json();
      testResults[acc.id] = data;
    } catch (e) {
      testResults[acc.id] = {
        ok: false,
        provider: acc.provider,
        details: { error: e instanceof Error ? e.message : String(e) },
      };
    }
    testResults = { ...testResults };
  }

  function providerLabel(p: Provider): string {
    switch (p) {
      case 'gmail': return 'Gmail (OAuth)';
      case 'resend': return 'Resend (API)';
      case 'imap_smtp': return 'IMAP / SMTP';
    }
  }

  function providerColor(p: Provider): string {
    switch (p) {
      case 'gmail': return '#ea4335';
      case 'resend': return '#000000';
      case 'imap_smtp': return '#3b82f6';
    }
  }

  onMount(() => {
    load();
    loadGoogleProfile();
  });
</script>

<div class="accounts-page">
  <header class="page-header">
    <div>
      <button class="back-btn" on:click={() => goto('/mail')}>← Back to Mail</button>
      <h1>Email Accounts</h1>
      <p class="subtitle">Manage all your email sources in one place — Gmail, Resend, or any IMAP/SMTP provider.</p>
    </div>
    {#if !isNew && editId === null}
      <button class="primary" on:click={beginCreate}>+ Add account</button>
    {/if}
  </header>

  {#if isNew || editId !== null}
    <section class="form-section">
      <h2>{isNew ? 'New account' : 'Edit account'}</h2>

      {#if error}<div class="error">{error}</div>{/if}

      <div class="form-grid">
        <label>
          <span>Label</span>
          <input type="text" bind:value={form.label} placeholder="e.g. Personal Gmail" />
        </label>

        <label>
          <span>Email address</span>
          <input type="email" bind:value={form.email} placeholder="you@example.com" />
        </label>

        <label>
          <span>Provider</span>
          <select bind:value={form.provider} disabled={!isNew}>
            <option value="gmail">Gmail (OAuth)</option>
            <option value="resend">Resend (API)</option>
            <option value="imap_smtp">IMAP / SMTP</option>
          </select>
          {#if !isNew}<small>Provider can't be changed after creation.</small>{/if}
        </label>

        <label>
          <span>Type</span>
          <select bind:value={form.type}>
            <option value="personal">Personal</option>
            <option value="work">Work</option>
            <option value="transactional">Transactional</option>
            <option value="marketing">Marketing</option>
          </select>
        </label>

        <label>
          <span>Company</span>
          <input type="text" bind:value={form.company} placeholder="optional" />
        </label>

        <label class="checkbox">
          <input type="checkbox" bind:checked={form.is_default} />
          <span>Set as default account</span>
        </label>

        <label class="full">
          <span>Signature</span>
          <textarea bind:value={form.signature} rows="3" placeholder="optional — appended to outbound mail"></textarea>
        </label>
      </div>

      {#if form.provider === 'gmail'}
        {#if googleProfileLoading}
          <div class="provider-help">Checking Google auth…</div>
        {:else if !googleProfile?.configured}
          <div class="provider-help warn">
            Google OAuth credentials are missing. Set <code>GOOGLE_CLIENT_ID</code> and
            <code>GOOGLE_CLIENT_SECRET</code> in <code>.env</code>, then reload.
          </div>
        {:else if googleProfile.authenticated}
          <div class="provider-help ok">
            <div class="gp-row">
              {#if googleProfile.picture}<img class="gp-avatar" src={googleProfile.picture} alt="" />{/if}
              <div class="gp-info">
                <div><strong>✓ Google authenticated</strong></div>
                <div class="gp-email">{googleProfile.email}{googleProfile.name ? ` — ${googleProfile.name}` : ''}</div>
              </div>
              {#if isNew}
                <button type="button" class="tertiary" on:click={autofillFromGoogle}>Autofill</button>
              {/if}
            </div>
            <small>This account will reuse the existing Google OAuth session (shared refresh token). After saving, the Gmail provider is wired immediately — no restart required.</small>
          </div>
        {:else}
          <div class="provider-help warn">
            {#if googleProfile.needsReauth}
              <div><strong>⚠️ Gmail disconnected — the Google token expired.</strong></div>
              <small>Sync is down (no new email is arriving). Reconnect to restore it.</small>
            {:else}
              <div><strong>Google not connected yet.</strong></div>
              <small>You have <code>GOOGLE_CLIENT_ID</code>/<code>GOOGLE_CLIENT_SECRET</code> but no OAuth tokens saved.</small>
            {/if}
            {#if googleProfile.authUrl}
              <div style="margin-top:8px">
                <a class="primary as-link" href={googleProfile.authUrl}>{googleProfile.needsReauth ? 'Reconectar Gmail →' : 'Connect Google →'}</a>
                <button type="button" class="tertiary" on:click={loadGoogleProfile}>Refresh status</button>
              </div>
            {/if}
            {#if googleProfile.error}<small class="err-text">Error: {googleProfile.error}</small>{/if}
          </div>
        {/if}
      {:else if form.provider === 'resend'}
        <div class="form-grid">
          <label class="full">
            <span>Resend API key</span>
            <input type="password" bind:value={form.resend_api_key} placeholder="re_..." autocomplete="off" />
          </label>
        </div>
      {:else if form.provider === 'imap_smtp'}
        <h3>Credentials</h3>
        <div class="form-grid">
          <label>
            <span>Username</span>
            <input type="text" bind:value={form.user} autocomplete="off" />
          </label>
          <label>
            <span>Password</span>
            <input type="password" bind:value={form.pass} autocomplete="off" />
          </label>
          <label>
            <span>From address (optional)</span>
            <input type="text" bind:value={form.from} placeholder="same as email by default" />
          </label>
        </div>

        <h3>IMAP (inbox)</h3>
        <div class="form-grid">
          <label>
            <span>Host</span>
            <input type="text" bind:value={form.imap_host} placeholder="imap.example.com" />
          </label>
          <label>
            <span>Port</span>
            <input type="number" bind:value={form.imap_port} />
          </label>
          <label class="checkbox">
            <input type="checkbox" bind:checked={form.imap_secure} />
            <span>Use TLS</span>
          </label>
        </div>

        <h3>SMTP (outbound)</h3>
        <div class="form-grid">
          <label>
            <span>Host</span>
            <input type="text" bind:value={form.smtp_host} placeholder="smtp.example.com" />
          </label>
          <label>
            <span>Port</span>
            <input type="number" bind:value={form.smtp_port} />
          </label>
          <label class="checkbox">
            <input type="checkbox" bind:checked={form.smtp_secure} />
            <span>Use TLS</span>
          </label>
        </div>
      {/if}

      <div class="form-actions">
        <button class="secondary" on:click={cancelEdit} disabled={saving}>Cancel</button>
        <button class="primary" on:click={save} disabled={saving}>
          {saving ? 'Saving...' : (isNew ? 'Create account' : 'Save changes')}
        </button>
      </div>
    </section>
  {/if}

  <section class="accounts-list">
    {#if loading}
      <div class="empty">Loading...</div>
    {:else if accounts.length === 0}
      <div class="empty">
        <p>No email accounts yet.</p>
        <button class="primary" on:click={beginCreate}>+ Add your first account</button>
      </div>
    {:else}
      {#each accounts as acc (acc.id)}
        {@const test = testResults[acc.id]}
        <article class="account-card">
          <div class="account-head">
            <span class="provider-pill" style="background:{providerColor(acc.provider)}">{providerLabel(acc.provider)}</span>
            <div class="account-title">
              <h3>{acc.label}</h3>
              {#if acc.is_default}<span class="default-badge">default</span>{/if}
            </div>
          </div>

          <div class="account-meta">
            <div><strong>Email:</strong> {acc.email}</div>
            <div><strong>Type:</strong> {acc.type}</div>
            {#if acc.company}<div><strong>Company:</strong> {acc.company}</div>{/if}
          </div>

          {#if test}
            <div class="test-result" class:ok={test.ok} class:err={!test.ok}>
              {test.ok ? '✓ Connection OK' : '✗ Test failed'}
              {#if test.details && Object.keys(test.details).length > 0}
                <pre>{JSON.stringify(test.details, null, 2)}</pre>
              {/if}
            </div>
          {/if}

          <div class="account-actions">
            <button class="tertiary" on:click={() => testAccount(acc)}>Test connection</button>
            <button class="tertiary" on:click={() => beginEdit(acc)}>Edit</button>
            {#if !acc.is_default}
              <button class="tertiary" on:click={() => setDefault(acc)}>Set default</button>
            {/if}
            <button class="danger" on:click={() => deleteAccount(acc)}>Delete</button>
          </div>
        </article>
      {/each}
    {/if}
  </section>
</div>

<style>
  .accounts-page { padding: 20px 24px; max-width: 980px; margin: 0 auto; }
  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
  .page-header h1 { font-size: 22px; margin: 8px 0 4px; color: var(--text); }
  .subtitle { color: var(--text-3); font-size: 13px; margin: 0; max-width: 520px; }
  .back-btn { background: none; border: none; color: var(--text-2); font-size: 12px; cursor: pointer; padding: 0 0 4px; }
  .back-btn:hover { color: var(--text); }

  button.primary { background: var(--primary); color: #fff; border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; font-weight: 600; font-size: 13px; }
  button.primary:disabled { opacity: 0.6; cursor: not-allowed; }
  button.primary:hover:not(:disabled) { filter: brightness(1.1); }
  button.secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; cursor: pointer; font-size: 13px; }
  button.tertiary { background: none; color: var(--text-2); border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
  button.tertiary:hover { background: var(--surface); color: var(--text); }
  button.danger { background: none; color: #ef4444; border: 1px solid rgba(239,68,68,.3); border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
  button.danger:hover { background: rgba(239,68,68,.1); }

  .form-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 22px;
    margin-bottom: 22px;
  }
  .form-section h2 { font-size: 16px; margin: 0 0 14px; color: var(--text); }
  .form-section h3 { font-size: 13px; margin: 18px 0 8px; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.5px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; }
  .form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-2); }
  .form-grid label.full { grid-column: 1 / -1; }
  .form-grid label.checkbox { flex-direction: row; align-items: center; gap: 8px; padding-top: 18px; }
  .form-grid input[type="text"], .form-grid input[type="email"], .form-grid input[type="password"], .form-grid input[type="number"], .form-grid select, .form-grid textarea {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 10px; color: var(--text); font-size: 13px; font-family: inherit;
  }
  .form-grid input:focus, .form-grid select:focus, .form-grid textarea:focus { border-color: var(--primary); outline: none; }
  .form-grid small { color: var(--text-3); font-size: 11px; margin-top: 2px; }
  .form-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
  .provider-help { background: rgba(59,130,246,.08); border-left: 3px solid #3b82f6; padding: 10px 14px; border-radius: 6px; font-size: 12px; color: var(--text-2); margin-top: 6px; }
  .provider-help code { background: var(--bg); padding: 1px 5px; border-radius: 4px; font-size: 11px; }
  .provider-help.ok { background: rgba(34,197,94,.08); border-left-color: #22c55e; }
  .provider-help.warn { background: rgba(245,158,11,.08); border-left-color: #f59e0b; }
  .provider-help small { display: block; margin-top: 6px; color: var(--text-3); font-size: 11px; }
  .provider-help small.err-text { color: #ef4444; }
  .gp-row { display: flex; align-items: center; gap: 10px; }
  .gp-avatar { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; }
  .gp-info { flex: 1; min-width: 0; }
  .gp-email { font-size: 11px; color: var(--text-3); margin-top: 2px; }
  a.primary.as-link { display: inline-block; text-decoration: none; margin-right: 8px; }

  .error { background: rgba(239,68,68,.1); color: #ef4444; border: 1px solid rgba(239,68,68,.3); border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; font-size: 13px; }

  .accounts-list { display: flex; flex-direction: column; gap: 12px; }
  .empty { text-align: center; padding: 40px 20px; color: var(--text-3); background: var(--surface); border: 1px dashed var(--border); border-radius: 12px; }

  .account-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .account-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .provider-pill { font-size: 10px; color: #fff; padding: 3px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
  .account-title { display: flex; align-items: center; gap: 10px; }
  .account-title h3 { font-size: 15px; margin: 0; color: var(--text); }
  .default-badge { font-size: 10px; text-transform: uppercase; background: rgba(34,197,94,.12); color: #22c55e; border: 1px solid rgba(34,197,94,.3); border-radius: 6px; padding: 1px 6px; letter-spacing: 0.3px; font-weight: 600; }

  .account-meta { display: flex; gap: 20px; font-size: 12px; color: var(--text-2); flex-wrap: wrap; }
  .account-actions { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 6px; border-top: 1px solid var(--border); margin-top: 4px; }

  .test-result { padding: 8px 12px; border-radius: 6px; font-size: 12px; }
  .test-result.ok { background: rgba(34,197,94,.1); color: #22c55e; border: 1px solid rgba(34,197,94,.3); }
  .test-result.err { background: rgba(239,68,68,.1); color: #ef4444; border: 1px solid rgba(239,68,68,.3); }
  .test-result pre { margin: 6px 0 0; font-size: 11px; color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
</style>
