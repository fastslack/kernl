<script lang="ts">
  // /crm — migrated from services/dashboard/src/routes/crm/+page.svelte
  // (Fase 2b). The shell keeps hydrating data/analytics/comms for this path;
  // contact CRUD goes through ctx.rpc with HTTP fallbacks (rpcOrCall
  // semantics preserved).
  import { onMount } from 'svelte';
  import Badge from '$shared/components/Badge.svelte';
  import DirectoryStrip from '$shared/components/DirectoryStrip.svelte';
  import SearchBox from '$shared/components/SearchBox.svelte';
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

  $: pages = Math.ceil(total / 50);

  // ── Directory look (the Oficinas pattern) ──
  const es = (ctx.locale || 'es').startsWith('es');
  const L = es
    ? { eyebrow: 'Social · contactos', title: '¿Con quién querés hablar?', all: 'contactos', search: 'Buscar por nombre, email o empresa',
        shown: (n: number) => `${n} ${n === 1 ? 'contacto' : 'contactos'}`, add: 'Contacto', clear: 'Ver todos', close: 'Cerrar',
        rel: { personal: 'personales', professional: 'profesionales', family: 'familia', acquaintance: 'conocidos' } as Record<string, string>,
        never: 'sin trato', loading: 'Cargando…', none: 'No hay contactos con ese filtro.' }
    : { eyebrow: 'Social · contacts', title: 'Who do you want to talk to?', all: 'contacts', search: 'Search name, email or company',
        shown: (n: number) => `${n} ${n === 1 ? 'contact' : 'contacts'}`, add: 'Contact', clear: 'Show all', close: 'Close',
        rel: { personal: 'personal', professional: 'professional', family: 'family', acquaintance: 'acquaintances' } as Record<string, string>,
        never: 'no contact yet', loading: 'Loading…', none: 'No contacts match.' };
  const REL_HEX: Record<string, string> = { personal: '#60A5FA', professional: '#34D399', family: '#A78BFA', acquaintance: '#94A3B8' };
  $: kpis = [
    { key: '', n: totalContacts, label: L.all, color: '#22D3EE', on: !relFilter },
    ...RELATIONSHIPS.map((r) => ({ key: r, n: byRel[r] ?? 0, label: L.rel[r], color: REL_HEX[r], on: relFilter === r })),
  ];
  function pickRel(r: string) { relFilter = relFilter === r ? '' : r; doSearch(); }
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function onSearchInput() { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 250); }
  const initials = (n: string) => ((n ?? '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
  /** 1 = talked today, 0 = 90+ days ago or never. */
  const freshness = (iso?: string) => { if (!iso) return 0; const d = (Date.now() - Date.parse(iso)) / 86_400_000; return Number.isFinite(d) ? Math.max(0, Math.min(1, 1 - d / 90)) : 0; };
  $: open = showNew || !!detail;
  function closePane() { showNew = false; selectedId = null; detail = null; editMode = false; }
</script>

<div class="crm-page">
  <DirectoryStrip eyebrow={L.eyebrow} title={L.title} {kpis} on:pick={(e) => pickRel(e.detail.key)}>
    <button slot="aside" class="k-btn k-btn--primary cl-add" on:click={() => { showNew = !showNew; selectedId = null; detail = null; }}>
      <span aria-hidden="true">{showNew ? '✕' : '+'}</span> {L.add}
    </button>
    <svelte:fragment slot="tools">
      <SearchBox bind:value={search} placeholder={L.search} on:input={onSearchInput} on:keydown={(e) => e.key === 'Enter' && doSearch()} />
      <span class="cl-count">{L.shown(total)}</span>
      {#if relFilter || search}<button class="cl-clear" on:click={() => { relFilter = ''; search = ''; doSearch(); }}>{L.clear}</button>{/if}
      {#if pages > 1}
        <span class="cl-pagination">
          <button disabled={page <= 1} on:click={prevPage} aria-label="‹">‹</button>
          <span>{page} / {pages}</span>
          <button disabled={page >= pages} on:click={nextPage} aria-label="›">›</button>
        </span>
      {/if}
    </svelte:fragment>
  </DirectoryStrip>

<div class="crm-layout" class:open>
  <!-- ═══ LEFT: THE DIRECTORY ═══ -->
  <div class="crm-grid" aria-busy={loading}>
    {#if loading && !contacts.length}
      <p class="cl-empty">{L.loading}</p>
    {:else if !contacts.length}
      <p class="cl-empty">{L.none}</p>
    {:else}
      {#each contacts as c (c.id)}
        {@const col = REL_HEX[c.relationship] ?? '#94A3B8'}
        <button class="ct" class:selected={selectedId === c.id} style="--oc: {col}" on:click={() => loadDetail(c.id)} title={[c.name, c.company, c.email].filter(Boolean).join(' · ')}>
          <span class="ct-mark" aria-hidden="true">{initials(c.name)}</span>
          <span class="ct-name">{c.name}</span>
          <span class="ct-who">{[c.company, c.email].filter(Boolean).join(' · ')}</span>
          <span class="ct-st"><i aria-hidden="true"></i>{L.rel[c.relationship] ?? c.relationship}</span>
          <span class="ct-meter" aria-hidden="true"><i style="width: {freshness(c.last_interaction) * 100}%"></i></span>
          <span class="ct-time">{c.last_interaction ? timeAgo(c.last_interaction) : L.never}</span>
        </button>
      {/each}
    {/if}
  </div>

  <!-- ═══ RIGHT: DETAIL / NEW FORM ═══ -->
  {#if open}
  <div class="crm-detail">
    <button class="cd-close" on:click={closePane} aria-label={L.close} title={L.close}>✕</button>
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
        <div class="cd-avatar" style="--oc: {REL_HEX[detail.relationship] ?? '#94A3B8'}">{initials(detail.name)}</div>
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

    {/if}
  </div>
  {/if}
</div>
</div>

<style>
  /* ── Page: the Oficinas directory pattern ── */
  .crm-page { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 14px 20px 16px; box-sizing: border-box; overflow: hidden; background: var(--bg); }
  .crm-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .crm-layout.open { grid-template-columns: minmax(0, 1fr) minmax(360px, 440px); }
  .cl-add { display: inline-flex; align-items: center; gap: 6px; }
  .cl-count { color: var(--text-2); font-size: 12.5px; white-space: nowrap; }
  .cl-clear { background: none; border: 0; color: #93c5fd; font-size: 12px; cursor: pointer; text-decoration: underline; }
  .cl-pagination { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .cl-pagination button { width: 26px; height: 26px; border-radius: 8px; border: 1px solid var(--border-h, var(--border)); background: var(--surface-1); color: var(--text-1); cursor: pointer; }
  .cl-pagination button:disabled { opacity: .35; cursor: default; }
  .cl-empty { grid-column: 1 / -1; padding: 32px; text-align: center; color: var(--text-2); font-size: 13px; }

  /* One contact per row; the list is what scrolls. */
  .crm-grid { min-height: 0; overflow: auto; display: flex; flex-direction: column; padding: 4px; border-radius: 14px; border: 1px solid var(--border); background: var(--surface-1);
    scrollbar-width: thin; container-type: inline-size; }
  .ct { --oc: #94A3B8; flex: none; display: grid; grid-template-columns: 30px minmax(120px, 1.2fr) minmax(0, 1.6fr) 120px 90px 64px; align-items: center; column-gap: 14px;
    min-width: 0; padding: 6px 12px 6px 8px; border: 1px solid transparent; border-radius: 10px; background: none; text-align: left; color: var(--text-1); cursor: pointer; font: inherit;
    transition: background .15s, border-color .15s; }
  .ct + .ct { box-shadow: 0 -1px 0 color-mix(in srgb, var(--border) 70%, transparent); }
  .ct:hover { background: color-mix(in srgb, var(--oc) 8%, var(--surface-2)); box-shadow: none; }
  .ct:hover + .ct, .ct.selected + .ct { box-shadow: none; }
  .ct:focus-visible, .cd-close:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .ct.selected { border-color: var(--gold); box-shadow: none; background: linear-gradient(90deg, color-mix(in srgb, var(--gold) 14%, var(--surface-1)), var(--surface-1)); }
  .ct-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; font: 800 10.5px var(--font-display);
    color: color-mix(in srgb, var(--oc) 60%, white); background: color-mix(in srgb, var(--oc) 22%, var(--surface-2)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--oc) 40%, transparent); }
  .ct-name { font: 600 13.5px/1.2 var(--font-display); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ct-who { font-size: 12px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ct-st { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: color-mix(in srgb, var(--oc) 75%, white); text-transform: capitalize; white-space: nowrap; }
  .ct-st i { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--oc); box-shadow: 0 0 8px var(--oc); }
  .ct-meter { height: 4px; border-radius: 3px; background: color-mix(in srgb, var(--oc) 12%, var(--surface-2)); overflow: hidden; }
  .ct-meter i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #34D399, #22D3EE); box-shadow: 0 0 8px #34D399; }
  .ct-time { font-size: 11.5px; color: var(--text-3); white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
  /* Narrow (the detail pane is open): name, relationship and time are enough. */
  @container (max-width: 620px) {
    .ct { grid-template-columns: 28px minmax(0, 1fr) auto 56px; }
    .ct-who, .ct-meter { display: none; }
  }

  @media (max-height: 820px) {
    .crm-page { gap: 8px; padding: 10px 16px 12px; }
    .ct { padding-top: 4px; padding-bottom: 4px; } .ct-mark { width: 24px; height: 24px; font-size: 9.5px; border-radius: 7px; } .ct-name { font-size: 12.5px; }
  }
  @media (max-width: 900px) { .crm-layout.open { grid-template-columns: 1fr; } .crm-layout.open .crm-grid { display: none; } }
  @media (prefers-reduced-motion: reduce) { .ct { transition: none; } }

  /* ── Right: Detail ───────────────────────────── */
  .crm-detail {
    position: relative;
    min-height: 0;
    border-radius: 12px;
    border: 1px solid var(--border-h, var(--border));
    background: var(--surface-1);
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  .cd-close { position: absolute; top: 10px; right: 10px; z-index: 1; width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--border-h, var(--border)); background: var(--surface-2); color: var(--text-2); cursor: pointer; font-size: 11px; }
  .cd-close:hover { color: var(--text-1); }
  .cd-header {
    flex-wrap: wrap;
    padding-right: 44px !important;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--border);
  }
  .cd-avatar {
    width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0;
    display: grid; place-items: center; font: 800 15px var(--font-display);
    color: color-mix(in srgb, var(--oc) 60%, white); background: color-mix(in srgb, var(--oc) 22%, var(--surface-2));
    box-shadow: 0 0 18px -4px var(--oc), inset 0 0 0 1px color-mix(in srgb, var(--oc) 40%, transparent);
  }
  .cd-header-info { flex: 1; min-width: 0; }
  .cd-name {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-family: var(--font-display);
    font-size: 18px;
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
  .cd-last-ix { font-size: 11px; color: var(--text-3); white-space: nowrap; }
  .cd-header-actions { display: flex; gap: 6px; flex-basis: 100%; }

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

</style>
