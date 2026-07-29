<script lang="ts">
  // /crm — migrated from services/dashboard/src/routes/crm/+page.svelte
  // (Fase 2b). The shell keeps hydrating data/analytics/comms for this path;
  // contact CRUD goes through ctx.rpc with HTTP fallbacks (rpcOrCall
  // semantics preserved).
  import { onMount } from 'svelte';
  import Badge from '$shared/components/Badge.svelte';
  import { timeAgo } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const data = ctx.getStore('data') as any;
  const analytics = ctx.getStore('analytics') as any;
  const comms = ctx.getStore('comms') as any;

  const post = (url: string, body: unknown) =>
    ctx.fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function fetchContacts(opts: { q?: string; relationship?: string; page?: number; limit?: number } = {}): Promise<{ contacts: any[]; total: number; page: number }> {
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.relationship) params.set('relationship', opts.relationship);
    if (opts.page) params.set('page', String(opts.page));
    if (opts.limit) params.set('limit', String(opts.limit));
    const r = await ctx.rpc('contacts.list', opts, () => ctx.fetchJson('/api/contacts/all?' + params.toString()));
    return r as any;
  }
  const fetchContactDetail = (id: string) =>
    ctx.rpc('contacts.detail', { id }, () => ctx.fetchJson('/api/contacts/detail?id=' + encodeURIComponent(id)));
  const createContact = (c: { name: string; email?: string; phone?: string; company?: string; relationship?: string; notes?: string }) =>
    ctx.rpc('contacts.create', c, () => post('/api/contacts/create', c));
  const updateContact = (c: { id: string; name?: string; email?: string; phone?: string; company?: string; relationship?: string; notes?: string }) =>
    ctx.rpc('contacts.update', c, () => post('/api/contacts/update', c));
  const deleteContact = (id: string) =>
    ctx.rpc('contacts.delete', { id }, () => post('/api/contacts/delete', { id }));
  const logInteraction = (contact_id: string, type: string, summary: string, date?: string) =>
    ctx.rpc('contacts.logInteraction', { contact_id, type, summary, date }, () => post('/api/contacts/log-interaction', { contact_id, type, summary, date }));

  // ── Dashboard stores ──
  $: d = ($data as any);
  $: a = ($analytics as any);
  $: cm = ($comms as any);
  $: crm = d?.crm ?? {};
  $: contactInsights = a?.contactInsights ?? {};

  // ── Contacts list ──
  let contacts: any[] = [];
  let total = 0;
  let page = 1;
  let search = '';
  let relFilter = '';
  let loading = true;

  // ── Detail ──
  let selectedId: string | null = null;
  let detail: any = null;
  let detailInteractions: any[] = [];
  let editMode = false;
  let editData: Record<string, string> = {};

  // ── New contact form ──
  let showNew = false;
  let newName = ''; let newEmail = ''; let newPhone = ''; let newCompany = '';
  let newRelationship = 'acquaintance'; let newNotes = '';

  // ── Interaction form ──
  let showInteraction = false;
  let ixType = 'other'; let ixSummary = ''; let ixDate = new Date().toISOString().split('T')[0];

  // ── Action state ──
  let actionLoading: Record<string, boolean> = {};

  const RELATIONSHIPS = ['personal', 'professional', 'family', 'acquaintance'];
  const IX_TYPES = ['email', 'call', 'meeting', 'message', 'social', 'other'];
  const REL_COLORS: Record<string, string> = { personal: 'var(--blue)', professional: 'var(--green)', family: 'var(--purple)', acquaintance: 'var(--text-3)' };

  // ── Load data ──
  async function loadContacts() {
    loading = true;
    try {
      const r = await fetchContacts({ q: search, relationship: relFilter, page, limit: 50 });
      contacts = r.contacts; total = r.total; page = r.page;
    } catch (e) { console.error(e); }
    loading = false;
  }

  async function loadDetail(id: string) {
    selectedId = id;
    editMode = false;
    showInteraction = false;
    try {
      const r = await fetchContactDetail(id);
      detail = r.contact;
      detailInteractions = r.interactions ?? [];
      editData = { ...detail };
    } catch (e) { console.error(e); detail = null; }
  }

  onMount(loadContacts);

  function doSearch() { page = 1; loadContacts(); }
  function nextPage() { if (page * 50 < total) { page++; loadContacts(); } }
  function prevPage() { if (page > 1) { page--; loadContacts(); } }

  // ── Actions ──
  async function doAction(key: string, fn: () => Promise<unknown>) {
    actionLoading[key] = true; actionLoading = actionLoading;
    try { await fn(); } catch (e) { console.error(e); }
    finally { delete actionLoading[key]; actionLoading = actionLoading; }
  }

  async function addContact() {
    if (!newName.trim()) return;
    await doAction('new', () => createContact({
      name: newName.trim(), email: newEmail, phone: newPhone,
      company: newCompany, relationship: newRelationship, notes: newNotes,
    }));
    newName = ''; newEmail = ''; newPhone = ''; newCompany = ''; newRelationship = 'acquaintance'; newNotes = '';
    showNew = false;
    await loadContacts();
    refreshDashboard();
  }

  async function saveEdit() {
    if (!detail?.id) return;
    await doAction('save', () => updateContact({
      id: detail.id, name: editData.name, email: editData.email,
      phone: editData.phone, company: editData.company,
      relationship: editData.relationship, notes: editData.notes,
    }));
    editMode = false;
    await loadDetail(detail.id);
    await loadContacts();
    refreshDashboard();
  }

  async function removeContact() {
    if (!detail?.id) return;
    await doAction('del', () => deleteContact(detail.id));
    selectedId = null; detail = null;
    await loadContacts();
    refreshDashboard();
  }

  async function addInteraction() {
    if (!detail?.id || !ixSummary.trim()) return;
    await doAction('ix', () => logInteraction(detail.id, ixType, ixSummary.trim(), ixDate));
    ixSummary = ''; showInteraction = false;
    await loadDetail(detail.id);
    await loadContacts();
  }

  async function refreshDashboard() {
    try {
      const d = await ctx.rpc('dashboard.full', {}, async () => {
        const r = await ctx.fetchRaw('/api/dashboard');
        return r.ok ? r.json() : null;
      });
      if (d) data.set(d);
    } catch {}
  }

  // ── Stats ──
  $: totalContacts = crm.total ?? total;
  $: byRel = crm.byRelationship ?? {};
  $: recentIx = (crm.recentInteractions ?? []) as any[];
  $: stale = (crm.staleContacts ?? []) as any[];
  $: emailPct = contactInsights.emailPct ?? 0;
  $: phonePct = contactInsights.phonePct ?? 0;
  $: companyPct = contactInsights.companyPct ?? 0;

  $: pages = Math.ceil(total / 50);
</script>

<div class="crm-layout">
  <!-- ═══ LEFT: LIST ═══ -->
  <div class="crm-list">
    <!-- Header -->
    <div class="cl-header">
      <div class="cl-title-row">
        <h1 class="cl-title">People</h1>
        <span class="cl-count">{total}</span>
      </div>
      <button class="cl-add" on:click={() => { showNew = !showNew; selectedId = null; detail = null; }}>
        {showNew ? '✕' : '+'}
      </button>
    </div>

    <!-- Search + filter -->
    <div class="cl-search">
      <input type="text" placeholder="Search name, email, company..."
        bind:value={search} on:keydown={e => e.key === 'Enter' && doSearch()} />
    </div>
    <div class="cl-filters">
      <button class="cf-pill" class:active={!relFilter} on:click={() => { relFilter = ''; doSearch(); }}>All</button>
      {#each RELATIONSHIPS as r}
        <button class="cf-pill" class:active={relFilter === r} style="--accent:{REL_COLORS[r]}"
          on:click={() => { relFilter = relFilter === r ? '' : r; doSearch(); }}>{r}</button>
      {/each}
    </div>

    <!-- Contact rows -->
    <div class="cl-rows">
      {#if loading}
        <div class="cl-empty">Loading...</div>
      {:else if !contacts.length}
        <div class="cl-empty">No contacts found</div>
      {:else}
        {#each contacts as c (c.id)}
          <button class="contact-row" class:selected={selectedId === c.id} on:click={() => loadDetail(c.id)}>
            <div class="cr-avatar" style="background:{REL_COLORS[c.relationship] ?? 'var(--text-3)'}">
              {(c.name ?? '?').charAt(0).toUpperCase()}
            </div>
            <div class="cr-body">
              <div class="cr-name">{c.name}</div>
              <div class="cr-meta">
                {#if c.company}<span>{c.company}</span>{/if}
                {#if c.email}<span>{c.email}</span>{/if}
              </div>
            </div>
            {#if c.last_interaction}
              <span class="cr-time">{timeAgo(c.last_interaction)}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>

    <!-- Pagination -->
    {#if pages > 1}
      <div class="cl-pagination">
        <button disabled={page <= 1} on:click={prevPage}>◀</button>
        <span>{page} / {pages}</span>
        <button disabled={page >= pages} on:click={nextPage}>▶</button>
      </div>
    {/if}
  </div>

  <!-- ═══ RIGHT: DETAIL / NEW FORM ═══ -->
  <div class="crm-detail">
    <!-- New contact form -->
    {#if showNew}
      <div class="cd-section">
        <h2 class="cd-title">New Contact</h2>
        <div class="cd-form">
          <div class="cdf-row">
            <label>Name *</label>
            <input bind:value={newName} placeholder="Full name" on:keydown={e => e.key === 'Enter' && addContact()} />
          </div>
          <div class="cdf-grid">
            <div class="cdf-row">
              <label>Email</label>
              <input bind:value={newEmail} placeholder="email@example.com" type="email" />
            </div>
            <div class="cdf-row">
              <label>Phone</label>
              <input bind:value={newPhone} placeholder="+31 6..." />
            </div>
          </div>
          <div class="cdf-grid">
            <div class="cdf-row">
              <label>Company</label>
              <input bind:value={newCompany} placeholder="Company name" />
            </div>
            <div class="cdf-row">
              <label>Relationship</label>
              <select bind:value={newRelationship}>
                {#each RELATIONSHIPS as r}<option value={r}>{r}</option>{/each}
              </select>
            </div>
          </div>
          <div class="cdf-row">
            <label>Notes</label>
            <textarea bind:value={newNotes} rows="2" placeholder="Notes..."></textarea>
          </div>
          <button class="cd-primary-btn" disabled={!newName.trim() || actionLoading['new']} on:click={addContact}>
            {actionLoading['new'] ? 'Creating...' : 'Create Contact'}
          </button>
        </div>
      </div>

    <!-- Contact detail -->
    {:else if detail}
      <div class="cd-header">
        <div class="cd-avatar" style="background:{REL_COLORS[detail.relationship] ?? 'var(--text-3)'}">
          {(detail.name ?? '?').charAt(0).toUpperCase()}
        </div>
        <div class="cd-header-info">
          {#if editMode}
            <input class="cd-name-edit" bind:value={editData.name} />
          {:else}
            <h2 class="cd-name">{detail.name}</h2>
          {/if}
          <div class="cd-rel">
            {#if editMode}
              <select bind:value={editData.relationship}>
                {#each RELATIONSHIPS as r}<option value={r}>{r}</option>{/each}
              </select>
            {:else}
              <Badge text={detail.relationship} />
            {/if}
            {#if detail.last_interaction}
              <span class="cd-last-ix">Last: {timeAgo(detail.last_interaction)}</span>
            {/if}
          </div>
        </div>
        <div class="cd-header-actions">
          {#if editMode}
            <button class="cd-btn save" on:click={saveEdit} disabled={actionLoading['save']}>Save</button>
            <button class="cd-btn" on:click={() => { editMode = false; editData = { ...detail }; }}>Cancel</button>
          {:else}
            <button class="cd-btn" on:click={() => editMode = true}>Edit</button>
            <button class="cd-btn" on:click={() => showInteraction = !showInteraction}>+ Interaction</button>
          {/if}
        </div>
      </div>

      <!-- Info fields -->
      <div class="cd-section">
        <div class="cd-fields">
          {#if editMode}
            <div class="cdf-grid">
              <div class="cdf-row"><label>Email</label><input bind:value={editData.email} /></div>
              <div class="cdf-row"><label>Phone</label><input bind:value={editData.phone} /></div>
            </div>
            <div class="cdf-row"><label>Company</label><input bind:value={editData.company} /></div>
            <div class="cdf-row"><label>Notes</label><textarea bind:value={editData.notes} rows="3"></textarea></div>
          {:else}
            <div class="cd-info-grid">
              {#if detail.email}
                <div class="cd-info-item"><span class="cd-info-label">Email</span><span class="cd-info-val">{detail.email}</span></div>
              {/if}
              {#if detail.phone}
                <div class="cd-info-item"><span class="cd-info-label">Phone</span><span class="cd-info-val">{detail.phone}</span></div>
              {/if}
              {#if detail.company}
                <div class="cd-info-item"><span class="cd-info-label">Company</span><span class="cd-info-val">{detail.company}</span></div>
              {/if}
            </div>
            {#if detail.notes}
              <div class="cd-notes">{detail.notes}</div>
            {/if}
          {/if}
        </div>
      </div>

      <!-- Log interaction form -->
      {#if showInteraction}
        <div class="cd-section ix-form">
          <h3 class="cd-section-title">Log Interaction</h3>
          <div class="cdf-grid">
            <div class="cdf-row">
              <label>Type</label>
              <select bind:value={ixType}>
                {#each IX_TYPES as t}<option value={t}>{t}</option>{/each}
              </select>
            </div>
            <div class="cdf-row">
              <label>Date</label>
              <input type="date" bind:value={ixDate} />
            </div>
          </div>
          <div class="cdf-row">
            <label>Summary</label>
            <input bind:value={ixSummary} placeholder="What happened?" on:keydown={e => e.key === 'Enter' && addInteraction()} />
          </div>
          <button class="cd-primary-btn" disabled={!ixSummary.trim() || actionLoading['ix']} on:click={addInteraction}>
            {actionLoading['ix'] ? 'Saving...' : 'Log Interaction'}
          </button>
        </div>
      {/if}

      <!-- Interaction history -->
      <div class="cd-section">
        <h3 class="cd-section-title">Interactions ({detailInteractions.length})</h3>
        {#if !detailInteractions.length}
          <div class="cd-empty">No interactions logged</div>
        {:else}
          <div class="ix-list">
            {#each detailInteractions as ix}
              <div class="ix-item">
                <div class="ix-dot" style="background:{ix.type === 'email' ? 'var(--blue)' : ix.type === 'call' ? 'var(--green)' : ix.type === 'meeting' ? 'var(--purple)' : 'var(--text-3)'}"></div>
                <div class="ix-body">
                  <div class="ix-top">
                    <Badge text={ix.type} />
                    <span class="ix-date">{ix.date}</span>
                  </div>
                  {#if ix.summary}<div class="ix-summary">{ix.summary}</div>{/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Danger zone -->
      {#if editMode}
        <div class="cd-section cd-danger">
          <button class="cd-delete" on:click={removeContact} disabled={actionLoading['del']}>
            {actionLoading['del'] ? 'Deleting...' : 'Delete Contact'}
          </button>
        </div>
      {/if}

    <!-- Empty state -->
    {:else}
      <div class="cd-empty-state">
        <div class="cd-empty-icon">👥</div>
        <h3>Select a contact</h3>
        <p>Choose someone from the list or create a new contact</p>

        <!-- Quick stats -->
        <div class="qs-grid">
          <div class="qs-card">
            <span class="qs-val">{totalContacts}</span>
            <span class="qs-label">Contacts</span>
          </div>
          {#if emailPct}
            <div class="qs-card">
              <span class="qs-val">{emailPct}%</span>
              <span class="qs-label">With email</span>
            </div>
          {/if}
          {#if phonePct}
            <div class="qs-card">
              <span class="qs-val">{phonePct}%</span>
              <span class="qs-label">With phone</span>
            </div>
          {/if}
          {#each Object.entries(byRel) as [rel, count]}
            <div class="qs-card">
              <span class="qs-val" style="color:{REL_COLORS[rel] ?? 'var(--text-1)'}">{count}</span>
              <span class="qs-label">{rel}</span>
            </div>
          {/each}
        </div>

        <!-- Recent interactions -->
        {#if recentIx.length}
          <div class="qs-section">
            <h4 class="qs-section-title">Recent Interactions</h4>
            {#each recentIx.slice(0, 6) as ix}
              <div class="qs-row">
                <span class="qs-row-name">{ix.contact_name}</span>
                <Badge text={ix.type} />
                <span class="qs-row-date">{timeAgo(ix.date)}</span>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Stale contacts -->
        {#if stale.length}
          <div class="qs-section">
            <h4 class="qs-section-title">Needs Follow-up ({stale.length})</h4>
            {#each stale.slice(0, 5) as c}
              <button class="qs-row clickable" on:click={() => loadDetail(c.id)}>
                <span class="qs-row-name">{c.name}</span>
                <span class="qs-row-date">{c.last_interaction ? timeAgo(c.last_interaction) : 'never'}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* ── Layout ──────────────────────────────────── */
  .crm-layout {
    display: flex;
    height: 100%;
    overflow: hidden;
  }

  /* ── Left: Contact List ──────────────────────── */
  .crm-list {
    width: 360px;
    min-width: 300px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .cl-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 8px;
  }
  .cl-title-row { display: flex; align-items: baseline; gap: 8px; }
  .cl-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-1);
  }
  .cl-count {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 2px 8px;
    border-radius: 10px;
  }
  .cl-add {
    width: 32px; height: 32px;
    border-radius: 50%;
    border: none;
    background: var(--gold);
    color: var(--bg);
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: opacity 0.15s;
  }
  .cl-add:hover { opacity: 0.85; }

  .cl-search {
    padding: 0 16px 8px;
  }
  .cl-search input {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-1);
    font-size: 12px;
    font-family: var(--font-body);
    padding: 7px 12px;
    outline: none;
  }
  .cl-search input:focus { border-color: var(--gold); }

  .cl-filters {
    display: flex;
    gap: 4px;
    padding: 0 16px 10px;
    flex-wrap: wrap;
  }
  .cf-pill {
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: none;
    color: var(--text-3);
    font-size: 10px;
    font-family: var(--font-body);
    cursor: pointer;
    text-transform: capitalize;
    transition: all 0.15s;
  }
  .cf-pill:hover { border-color: var(--border-h); color: var(--text-2); }
  .cf-pill.active {
    background: color-mix(in srgb, var(--accent, var(--gold)) 12%, transparent);
    border-color: var(--accent, var(--gold));
    color: var(--accent, var(--gold));
  }

  .cl-rows {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .cl-empty { text-align: center; color: var(--text-3); padding: 30px 0; font-size: 12px; }

  .contact-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    cursor: pointer;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
    transition: background 0.15s;
    font-family: var(--font-body);
  }
  .contact-row:hover { background: var(--surface-2); }
  .contact-row.selected { background: color-mix(in srgb, var(--gold) 8%, transparent); border-left: 3px solid var(--gold); }

  .cr-avatar {
    width: 34px; height: 34px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700;
    color: var(--bg);
    flex-shrink: 0;
  }
  .cr-body { flex: 1; min-width: 0; }
  .cr-name { font-size: 13px; font-weight: 500; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cr-meta { font-size: 10px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; gap: 6px; }
  .cr-time { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); flex-shrink: 0; }

  .cl-pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 8px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-3);
  }
  .cl-pagination button {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text-2); font-size: 10px; padding: 3px 8px; cursor: pointer;
  }
  .cl-pagination button:disabled { opacity: 0.3; cursor: default; }

  /* ── Right: Detail ───────────────────────────── */
  .crm-detail {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  .cd-header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--border);
  }
  .cd-avatar {
    width: 48px; height: 48px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; font-weight: 700;
    color: var(--bg);
    flex-shrink: 0;
  }
  .cd-header-info { flex: 1; min-width: 0; }
  .cd-name {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    color: var(--text-1);
    margin: 0;
  }
  .cd-name-edit {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    color: var(--text-1);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    width: 100%;
    outline: none;
  }
  .cd-rel { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .cd-rel select {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text-1); font-size: 12px; padding: 3px 8px; outline: none;
  }
  .cd-last-ix { font-size: 11px; color: var(--text-3); }
  .cd-header-actions { display: flex; gap: 6px; flex-shrink: 0; }

  .cd-btn {
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 12px;
    font-family: var(--font-body);
    cursor: pointer;
    transition: all 0.15s;
  }
  .cd-btn:hover { border-color: var(--border-h); color: var(--text-1); }
  .cd-btn.save { background: var(--gold); color: var(--bg); border-color: var(--gold); }
  .cd-btn.save:hover { opacity: 0.85; }
  .cd-btn:disabled { opacity: 0.4; cursor: default; }

  .cd-section { padding: 16px 24px; border-bottom: 1px solid var(--border); }
  .cd-section-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--text-3); margin-bottom: 10px;
  }

  /* Info grid */
  .cd-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .cd-info-item {}
  .cd-info-label { display: block; font-size: 10px; color: var(--text-3); text-transform: uppercase; margin-bottom: 2px; }
  .cd-info-val { font-size: 13px; color: var(--text-1); word-break: break-all; }
  .cd-notes { font-size: 12px; color: var(--text-2); margin-top: 10px; line-height: 1.5; background: var(--surface-2); border-radius: 8px; padding: 10px 12px; }

  /* Forms */
  .cd-form, .cd-fields { display: flex; flex-direction: column; gap: 10px; }
  .cdf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .cdf-row { display: flex; flex-direction: column; gap: 3px; }
  .cdf-row label { font-size: 10px; font-weight: 600; color: var(--text-3); text-transform: uppercase; }
  .cdf-row input, .cdf-row select, .cdf-row textarea {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text-1); font-size: 12px; font-family: var(--font-body);
    padding: 7px 10px; outline: none; transition: border-color 0.15s;
  }
  .cdf-row input:focus, .cdf-row select:focus, .cdf-row textarea:focus { border-color: var(--gold); }
  .cdf-row textarea { resize: vertical; }

  .cd-primary-btn {
    background: var(--gold); color: var(--bg); border: none; border-radius: 8px;
    padding: 8px 20px; font-size: 13px; font-weight: 600; font-family: var(--font-body);
    cursor: pointer; transition: opacity 0.15s; align-self: flex-start; margin-top: 4px;
  }
  .cd-primary-btn:hover { opacity: 0.85; }
  .cd-primary-btn:disabled { opacity: 0.4; cursor: default; }

  /* Interaction form */
  .ix-form { background: color-mix(in srgb, var(--teal) 4%, var(--surface-1)); }

  /* Interaction list */
  .ix-list { display: flex; flex-direction: column; gap: 0; }
  .ix-item {
    display: flex; gap: 10px; padding: 8px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }
  .ix-item:last-child { border-bottom: none; }
  .ix-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
  .ix-body { flex: 1; min-width: 0; }
  .ix-top { display: flex; align-items: center; gap: 6px; }
  .ix-date { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); }
  .ix-summary { font-size: 12px; color: var(--text-2); margin-top: 2px; }

  /* Delete */
  .cd-danger { display: flex; justify-content: flex-end; }
  .cd-delete {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--red); font-size: 11px; font-family: var(--font-body);
    padding: 6px 14px; cursor: pointer; transition: all 0.15s;
  }
  .cd-delete:hover { background: rgba(240,71,112,0.1); border-color: var(--red); }
  .cd-delete:disabled { opacity: 0.4; cursor: default; }
  .cd-empty { color: var(--text-3); font-size: 12px; text-align: center; padding: 16px 0; }

  /* ── Empty state ─────────────────────────────── */
  .cd-empty-state {
    padding: 40px 30px;
    text-align: center;
  }
  .cd-empty-icon { font-size: 48px; margin-bottom: 12px; }
  .cd-empty-state h3 { font-family: var(--font-display); font-size: 18px; color: var(--text-1); margin-bottom: 4px; }
  .cd-empty-state p { font-size: 13px; color: var(--text-3); margin-bottom: 24px; }

  .qs-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
    gap: 8px;
    margin-bottom: 24px;
    text-align: center;
  }
  .qs-card {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 6px;
  }
  .qs-val { display: block; font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--text-1); }
  .qs-label { font-size: 9px; color: var(--text-3); text-transform: uppercase; }

  .qs-section { text-align: left; margin-bottom: 20px; }
  .qs-section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-3); margin-bottom: 8px; }
  .qs-row {
    display: flex; align-items: center; gap: 8px; padding: 5px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
    font-size: 12px;
  }
  .qs-row:last-child { border-bottom: none; }
  .qs-row.clickable { cursor: pointer; border: none; background: none; width: 100%; text-align: left; font-family: var(--font-body); padding: 5px 0; }
  .qs-row.clickable:hover { color: var(--gold); }
  .qs-row-name { flex: 1; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qs-row-date { font-size: 10px; color: var(--text-3); font-family: var(--font-mono); flex-shrink: 0; }
</style>
