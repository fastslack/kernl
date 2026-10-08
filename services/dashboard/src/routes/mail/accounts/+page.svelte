<script lang="ts">
  import { readApiError } from '$lib/api.js';
  import { confirm as confirmDialog } from '$shared/feedback';
  import { onMount } from 'svelte';
  import Skeleton from '$shared/components/Skeleton.svelte';
  import { goto } from '$app/navigation';
  import { fmtRelTime } from '$lib/display-format.js';
  import {
    buildAccountView, filterGroups,
    type SyncEntry, type AccountFilter, type AccountRow,
  } from '$lib/mail-accounts-view.js';

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

  // Sync health and unread counts per mailbox — what makes the list useful.
  let syncEntries: SyncEntry[] = [];
  let unreadById: Record<string, number> = {};
  let filter: AccountFilter = 'all';
  let query = '';
  let expandedId: string | null = null;
  let menuId: string | null = null;

  $: view = buildAccountView(accounts, syncEntries, unreadById);
  $: groups = filterGroups(view.groups, filter, query);
  $: typeCounts = accounts.reduce<Record<string, number>>((m, a) => ({ ...m, [a.type]: (m[a.type] ?? 0) + 1 }), {});
  $: problemCount = view.groups.flatMap((g) => g.rows).filter((r) => r.health.state === 'error' || r.health.state === 'never').length;

  async function load() {
    loading = true;
    try {
      const r = await fetch('/api/email-accounts');
      accounts = r.ok ? await r.json() : [];
    } finally {
      loading = false;
    }
    void loadHealth();
  }

  /** Sync status for every mailbox plus each one's unread count. Best effort:
   *  the list still renders from the accounts alone if these fail. */
  async function loadHealth() {
    try {
      const r = await fetch('/api/emails/sync-status');
      if (r.ok) syncEntries = ((await r.json()).accounts ?? []) as SyncEntry[];
    } catch { /* keep the previous status */ }
    const pairs = await Promise.all(accounts.map(async (a) => {
      try {
        const r = await fetch(`/api/emails/counts?account_id=${encodeURIComponent(a.id)}`);
        return [a.id, r.ok ? Number((await r.json()).unread ?? 0) : 0] as const;
      } catch { return [a.id, 0] as const; }
    }));
    unreadById = Object.fromEntries(pairs);
  }

  /** Open the mail list on this account. /mail restores its account filter
   *  from the same localStorage key its switcher writes, before it loads. */
  function openMailbox(id: string) {
    try {
      if (id) localStorage.setItem('mail.selected_account', id);
      else localStorage.removeItem('mail.selected_account');
    } catch { /* storage blocked: /mail opens on all accounts */ }
    goto('/mail');
  }
  function setFilter(t: string) {
    filter = t as AccountFilter;
  }
  function toggleRow(id: string) {
    expandedId = expandedId === id ? null : id;
  }
  function openMenu(e: MouseEvent, id: string) {
    e.stopPropagation();
    menuId = menuId === id ? null : id;
  }
  function runAction(e: MouseEvent, fn: () => void) {
    e.stopPropagation();
    menuId = null;
    fn();
  }
  const num = (n: number) => n.toLocaleString('es-AR');
  const TYPE_LABEL: Record<string, string> = { personal: 'Personal', work: 'Work', transactional: 'Transactional', marketing: 'Marketing' };
  function rowTest(r: AccountRow<EmailAccount>) { return testResults[r.id]; }

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
          throw new Error((await readApiError(r)) || `HTTP ${r.status}`);
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
          throw new Error((await readApiError(r)) || `HTTP ${r.status}`);
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
    if (!(await confirmDialog({
      title: `Delete account "${acc.label}"?`,
      body: `${acc.email} is disconnected and removed. Messages already downloaded stay, but lose their account label.`,
      confirmLabel: 'Delete account',
      danger: true,
      typeToConfirm: acc.label || acc.email,
    }))) return;
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
    // Mail is polled every few minutes; keep the health column honest.
    const t = setInterval(() => { void loadHealth(); }, 30_000);
    return () => clearInterval(t);
  });
</script>

<svelte:window on:click={() => (menuId = null)} on:keydown={(e) => e.key === 'Escape' && (menuId = null)} />

<div class="accounts-page">
  <header class="page-header">
    <div class="ph-title">
      <button class="back-btn" on:click={() => openMailbox('')}>← All mail</button>
      <h1>Email Accounts</h1>
    </div>
    {#if !loading && accounts.length}
      <div class="ph-stats" aria-label="Accounts summary">
        <span class="st"><b>{view.summary.total}</b> accounts</span>
        <span class="st st-ok"><span class="dot" aria-hidden="true"></span><b>{view.summary.healthy}</b> syncing fine</span>
        {#if view.summary.failing}<span class="st st-bad"><span class="dot" aria-hidden="true"></span><b>{view.summary.failing}</b> failing</span>{/if}
        {#if view.summary.syncing}<span class="st st-run"><span class="dot" aria-hidden="true"></span><b>{view.summary.syncing}</b> syncing now</span>{/if}
        <span class="st"><b>{num(view.summary.stored)}</b> messages</span>
        <span class="st"><b>{num(view.summary.unread)}</b> unread</span>
      </div>
    {/if}
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
      <Skeleton variant="rows" rows={4} />
    {:else if accounts.length === 0}
      <div class="empty">
        <p>No email accounts yet.</p>
        <button class="primary" on:click={beginCreate}>+ Add your first account</button>
      </div>
    {:else}
      <div class="toolbar">
        <input class="search" type="search" bind:value={query} placeholder="Search name, email or domain…" aria-label="Search accounts" />
        <div class="filters" role="group" aria-label="Filter accounts">
          <button class:on={filter === 'all'} aria-pressed={filter === 'all'} on:click={() => (filter = 'all')}>All <span>{accounts.length}</span></button>
          <button class="f-bad" class:on={filter === 'problems'} aria-pressed={filter === 'problems'} disabled={problemCount === 0} on:click={() => (filter = 'problems')}>Problems <span>{problemCount}</span></button>
          {#each Object.entries(typeCounts) as [t, n] (t)}
            <button class:on={filter === t} aria-pressed={filter === t} on:click={() => setFilter(t)}>{TYPE_LABEL[t] ?? t} <span>{n}</span></button>
          {/each}
        </div>
      </div>

      <div class="table" role="table" aria-label="Email accounts">
        <div class="thead" role="row">
          <span role="columnheader">Domain</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Mailbox</span>
          <span role="columnheader">Type</span>
          <span role="columnheader">Server</span>
          <span role="columnheader" class="r">Messages</span>
          <span role="columnheader" class="r">Unread</span>
          <span role="columnheader">Last sync</span>
          <span role="columnheader" class="sr">Open</span>
          <span role="columnheader" class="sr">Actions</span>
        </div>
        {#each groups as g (g.domain)}
          {#each g.rows as r, ri (r.id)}
            {@const open = expandedId === r.id}
            {@const test = rowTest(r)}
            <div class="row h-{r.health.state}" class:open class:gfirst={ri === 0} role="row" tabindex="0" aria-expanded={open}
                 on:click={() => toggleRow(r.id)} on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleRow(r.id))}>
              <span class="dom" title={g.domain}>
                {#if ri === 0}<b>{g.domain}</b>{#if g.rows.length > 1}<span class="dcount">{g.rows.length}</span>{/if}{#if g.failing}<span class="dbad">{g.failing} ✗</span>{/if}{/if}
              </span>
              <span class="health" title={r.health.detail}><span class="dot" aria-hidden="true"></span>{r.health.text}</span>
              <span class="mbox">
                <span class="prov prov-{r.provider}" aria-label={r.provider}>{r.provider === 'gmail' ? 'G' : r.provider === 'resend' ? 'R' : '✉'}</span>
                <span class="mname">{r.name}{#if r.isDefault}<span class="def" title="Default account">★ default</span>{/if}</span>
                <span class="memail">{r.email}</span>
              </span>
              <span class="type">{TYPE_LABEL[r.type] ?? r.type}</span>
              <span class="srv" title={r.servers ? `IMAP ${r.servers.imap} · SMTP ${r.servers.smtp}` : providerLabel(r.account.provider)}>{r.servers ? r.servers.imap.split(':')[0] : providerLabel(r.account.provider)}</span>
              <span class="r n">{num(r.stored)}</span>
              {#if r.unread}
                <button class="r n hot unread-link" title="Open {r.email} — {num(r.unread)} unread"
                        on:click|stopPropagation={() => openMailbox(r.id)}>{num(r.unread)}</button>
              {:else}
                <span class="r n">—</span>
              {/if}
              <span class="when">{r.health.at ? fmtRelTime(r.health.at) : '—'}</span>
              <button class="open-btn" title="Open the mail list on {r.email}" on:click|stopPropagation={() => openMailbox(r.id)}>Inbox →</button>
              <span class="act">
                <button class="kebab" aria-label="Actions for {r.email}" aria-haspopup="menu" aria-expanded={menuId === r.id} on:click={(e) => openMenu(e, r.id)}>⋯</button>
                {#if menuId === r.id}
                  <div class="menu" role="menu">
                    <button role="menuitem" on:click={(e) => runAction(e, () => openMailbox(r.id))}>Open mailbox</button>
                    <button role="menuitem" on:click={(e) => runAction(e, () => { expandedId = r.id; testAccount(r.account); })}>Test connection</button>
                    <button role="menuitem" on:click={(e) => runAction(e, () => beginEdit(r.account))}>Edit…</button>
                    {#if !r.isDefault}<button role="menuitem" on:click={(e) => runAction(e, () => setDefault(r.account))}>Make default</button>{/if}
                    <hr />
                    <button role="menuitem" class="danger-item" on:click={(e) => runAction(e, () => deleteAccount(r.account))}>Delete…</button>
                  </div>
                {/if}
              </span>
            </div>
            {#if open}
              <div class="detail" role="row">
                <dl class="dgrid">
                  {#if r.servers}
                    <div><dt>IMAP (incoming)</dt><dd class="mono">{r.servers.imap}</dd></div>
                    <div><dt>SMTP (outgoing)</dt><dd class="mono">{r.servers.smtp}</dd></div>
                    <div><dt>Login</dt><dd class="mono">{r.servers.user || '—'}</dd></div>
                  {:else}
                    <div><dt>Provider</dt><dd>{providerLabel(r.account.provider)}</dd></div>
                  {/if}
                  {#if r.company}<div><dt>Company</dt><dd>{r.company}</dd></div>{/if}
                  <div><dt>Sync</dt><dd>{r.health.text}{r.health.at ? ` · ${fmtRelTime(r.health.at)}` : ''}</dd></div>
                </dl>
                {#if r.health.state === 'error'}
                  <p class="derr"><b>Last sync error:</b> {r.health.detail}</p>
                {/if}
                {#if test}
                  <div class="test-result" class:ok={test.ok} class:err={!test.ok}>
                    {test.details?.status === 'testing...' ? 'Testing connection…' : test.ok ? '✓ Connection OK' : '✗ Connection failed'}
                    {#if test.details && test.details.status !== 'testing...' && Object.keys(test.details).length > 0}
                      <pre>{JSON.stringify(test.details, null, 2)}</pre>
                    {/if}
                  </div>
                {/if}
                <div class="dactions">
                  <button class="primary small" on:click|stopPropagation={() => openMailbox(r.id)}>Open mailbox →</button>
                  <button class="tertiary" on:click|stopPropagation={() => testAccount(r.account)}>Test connection</button>
                  <button class="tertiary" on:click|stopPropagation={() => beginEdit(r.account)}>Edit…</button>
                  {#if !r.isDefault}<button class="tertiary" on:click|stopPropagation={() => setDefault(r.account)}>Make default</button>{/if}
                </div>
              </div>
            {/if}
          {/each}
        {:else}
          <div class="empty small">No accounts match {query ? `“${query}”` : 'this filter'}.</div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  /* Full width, dense: every mailbox and its health fit one screen. */
  /* /mail is a full-bleed view: the layout doesn't scroll it, so the page does. */
  .accounts-page { padding: 12px 20px; height: 100%; overflow-y: auto; box-sizing: border-box; }
  .page-header { display: flex; align-items: center; gap: 18px; margin-bottom: 12px; flex-wrap: wrap; }
  .ph-title { display: flex; align-items: baseline; gap: 12px; }
  .page-header h1 { font-size: 19px; margin: 0; color: var(--text-1); }
  .back-btn { background: none; border: none; color: var(--text-2); font-size: 12px; cursor: pointer; padding: 0; }
  .back-btn:hover { color: var(--text-1); }
  .ph-stats { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
  .st { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font-size: 12px; color: var(--text-2); background: var(--surface-1); border: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .st b { color: var(--text-1); font-weight: 700; }
  .st .dot, .health .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex-shrink: 0; }
  .st-ok .dot { background: #22c55e; }
  .st-bad { border-color: rgba(239,68,68,.45); background: rgba(239,68,68,.08); }
  .st-bad .dot { background: #ef4444; }
  .st-run .dot { background: #3b82f6; }

  button.primary { background: var(--gold); color: #17181B; border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; font-weight: 600; font-size: 13px; }
  button.primary:disabled { opacity: 0.6; cursor: not-allowed; }
  button.primary:hover:not(:disabled) { filter: brightness(1.1); }
  button.secondary { background: var(--surface-1); color: var(--text-1); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; cursor: pointer; font-size: 13px; }
  button.tertiary { background: none; color: var(--text-2); border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
  button.tertiary:hover { background: var(--surface-1); color: var(--text-1); }

  .form-section {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 22px;
    margin-bottom: 22px;
  }
  .form-section h2 { font-size: 16px; margin: 0 0 14px; color: var(--text-1); }
  .form-section h3 { font-size: 13px; margin: 18px 0 8px; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.5px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; }
  .form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-2); }
  .form-grid label.full { grid-column: 1 / -1; }
  .form-grid label.checkbox { flex-direction: row; align-items: center; gap: 8px; padding-top: 18px; }
  .form-grid input[type="text"], .form-grid input[type="email"], .form-grid input[type="password"], .form-grid input[type="number"], .form-grid select, .form-grid textarea {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 10px; color: var(--text-1); font-size: 13px; font-family: inherit;
  }
  .form-grid input:focus, .form-grid select:focus, .form-grid textarea:focus { border-color: var(--gold); outline: none; }
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

  .accounts-list { display: flex; flex-direction: column; gap: 8px; }
  .empty { text-align: center; padding: 40px 20px; color: var(--text-3); background: var(--surface-1); border: 1px dashed var(--border); border-radius: 12px; }
  .empty.small { padding: 18px; border: none; background: none; }

  .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .search { flex: 0 1 280px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; color: var(--text-1); font-size: 13px; }
  .search:focus { outline: none; border-color: var(--gold); }
  .filters { display: flex; gap: 4px; flex-wrap: wrap; }
  .filters button { background: none; border: 1px solid var(--border); color: var(--text-2); border-radius: 7px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .filters button span { color: var(--text-3); margin-left: 3px; font-variant-numeric: tabular-nums; }
  .filters button.on { color: var(--text-1); background: var(--surface-1); border-color: var(--gold); }
  .filters button.f-bad:not(:disabled) { color: #f87171; border-color: rgba(239,68,68,.4); }
  .filters button.f-bad.on { background: rgba(239,68,68,.1); }
  .filters button:disabled { opacity: .45; cursor: default; }

  /* One grid for header and rows so the columns line up. */
  .table { border: 1px solid var(--border); border-radius: 10px; overflow: visible; background: var(--surface-1); }
  .thead, .row { display: grid; grid-template-columns: 170px 130px minmax(260px, 1.4fr) 90px minmax(140px, 1fr) 80px 70px 90px 74px 36px; align-items: center; column-gap: 12px; padding: 0 12px; }
  .thead { height: 32px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .6px; color: var(--text-3); border-bottom: 1px solid var(--border); }
  .r { text-align: right; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  /* Domain shown once per group; a heavier rule marks where a group starts. */
  .row.gfirst { border-top: 1px solid color-mix(in srgb, var(--text-3) 45%, var(--border)); }
  .dom { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--text-1); white-space: nowrap; overflow: hidden; }
  .dom b { font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
  .dcount { font-size: 10.5px; color: var(--text-3); background: var(--bg); border: 1px solid var(--border); border-radius: 5px; padding: 0 5px; }
  .dbad { font-size: 10.5px; font-weight: 700; color: #f87171; }
  .srv { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .row { min-height: 34px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 13px; position: relative; }
  .row:hover, .row.open { background: color-mix(in srgb, var(--gold) 6%, transparent); }
  .row:focus-visible { outline: 2px solid var(--gold); outline-offset: -2px; }
  .row.h-error { box-shadow: inset 3px 0 0 #ef4444; }
  .health { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: var(--text-2); white-space: nowrap; }
  .h-ok .health .dot { background: #22c55e; }
  .h-ok .health { color: #4ade80; }
  .h-error .health .dot { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.18); }
  .h-error .health { color: #f87171; }
  .h-syncing .health .dot { background: #3b82f6; animation: pulse 1.2s ease-in-out infinite; }
  .h-syncing .health { color: #60a5fa; }
  .h-never .health .dot { background: #f59e0b; }
  .h-never .health { color: #fbbf24; }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .h-syncing .health .dot { animation: none; } }

  .mbox { display: grid; grid-template-columns: 22px auto minmax(0, 1fr); align-items: center; column-gap: 8px; min-width: 0; }
  .prov { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; font-size: 11px; font-weight: 800; color: #fff; background: #3b82f6; }
  .prov-gmail { background: #ea4335; }
  .prov-resend { background: #111; border: 1px solid var(--border); }
  .mname { font-weight: 600; color: var(--text-1); white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
  .def { font-size: 10px; font-weight: 700; color: #facc15; background: rgba(250,204,21,.1); border: 1px solid rgba(250,204,21,.3); border-radius: 5px; padding: 0 5px; }
  .memail { color: var(--text-3); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .type { font-size: 12px; color: var(--text-2); }
  .n { font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 12.5px; }
  .n.hot { color: var(--text-1); font-weight: 700; }
  .when { font-size: 12px; color: var(--text-3); white-space: nowrap; }
  .unread-link { background: none; border: none; padding: 2px 4px; margin: -2px -4px; border-radius: 5px; cursor: pointer; font: inherit; font-weight: 700; color: var(--text-1); }
  .unread-link:hover { background: color-mix(in srgb, var(--gold) 14%, transparent); color: var(--gold); }
  .open-btn { justify-self: start; white-space: nowrap; padding: 3px 9px; border-radius: 6px; cursor: pointer; font-size: 11.5px; font-weight: 600; color: var(--gold); background: color-mix(in srgb, var(--gold) 8%, transparent); border: 1px solid color-mix(in srgb, var(--gold) 35%, transparent); }
  .open-btn:hover { background: color-mix(in srgb, var(--gold) 18%, transparent); }
  .unread-link:focus-visible, .open-btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
  button.primary.small { padding: 5px 12px; font-size: 12px; border-radius: 6px; }

  .act { position: relative; display: flex; justify-content: flex-end; }
  .kebab { width: 30px; height: 28px; border-radius: 6px; border: 1px solid transparent; background: none; color: var(--text-2); font-size: 16px; cursor: pointer; line-height: 1; }
  .kebab:hover, .kebab[aria-expanded="true"] { border-color: var(--border); background: var(--bg); color: var(--text-1); }
  .menu { position: absolute; right: 0; top: 32px; z-index: 20; min-width: 170px; padding: 4px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); box-shadow: 0 10px 30px rgba(0,0,0,.35); display: flex; flex-direction: column; }
  .menu button { text-align: left; background: none; border: none; color: var(--text-1); font-size: 12.5px; padding: 7px 10px; border-radius: 5px; cursor: pointer; }
  .menu button:hover { background: var(--bg); }
  .menu hr { border: none; border-top: 1px solid var(--border); margin: 4px 0; }
  .menu .danger-item { color: #f87171; }
  .menu .danger-item:hover { background: rgba(239,68,68,.1); }

  .detail { padding: 10px 12px 12px 326px; border-bottom: 1px solid var(--border); background: var(--bg); display: flex; flex-direction: column; gap: 8px; cursor: default; }
  .dgrid { margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px 18px; }
  .dgrid dt { font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; color: var(--text-3); }
  .dgrid dd { margin: 1px 0 0; font-size: 12.5px; color: var(--text-1); word-break: break-word; }
  .dgrid dd.mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .derr { margin: 0; padding: 7px 10px; border-radius: 6px; font-size: 12.5px; color: #fca5a5; background: rgba(239,68,68,.08); border-left: 3px solid #ef4444; }
  .derr b { color: #f87171; }
  .dactions { display: flex; gap: 8px; flex-wrap: wrap; }

  .test-result { padding: 8px 12px; border-radius: 6px; font-size: 12px; }
  .test-result.ok { background: rgba(34,197,94,.1); color: #22c55e; border: 1px solid rgba(34,197,94,.3); }
  .test-result.err { background: rgba(239,68,68,.1); color: #ef4444; border: 1px solid rgba(239,68,68,.3); }
  .test-result pre { margin: 6px 0 0; font-size: 11px; color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
</style>
