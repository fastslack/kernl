<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { rpcOrCall } from '$lib/ws.js';
  import { listEmailSuggestions, fetchGoogleSyncStatus } from '$lib/api';
  import AccountSwitcher from '$lib/components/AccountSwitcher.svelte';

  // ── Types ────────────────────────────────────────
  interface EmailListItem {
    gmail_id: string; thread_id: string; from_email: string; from_name: string;
    to_emails: string; subject: string; snippet: string; date: string;
    is_read: number; is_starred: number; has_attachments: number;
    labels: string; message_count: number; contact_name?: string;
    urgency?: string; attention_needed?: number; ai_summary?: string; draft_comm_id?: string;
  }
  interface EmailDetail extends EmailListItem {
    cc_emails: string; body_text: string; size_bytes: number;
    actions: Array<{ id: string; gmail_id: string; action_type: string; value: string; created_at: string }>;
    email_labels: Array<{ id: string; name: string; color: string }>;
    linked_tasks: Array<{ id: string; title: string; status: string }>;
    linked_contacts: Array<{ id: string; name: string; email: string }>;
  }
  interface AttentionItem {
    gmail_id: string; thread_id: string; from_email: string; from_name: string;
    subject: string; snippet: string; date: string; urgency: string;
    ai_summary: string; draft_comm_id: string; draft_body: string; draft_status: string;
  }
  interface TriageStats { unclassified: number; attention_needed: number; critical: number; high: number; drafts_pending: number }
  interface Counts { inbox: number; unread: number; starred: number; sent: number; drafts: number; trash: number; archived: number; snoozed: number; important: number; attention: number }
  interface EmailLabel { id: string; name: string; color: string; created_at: string }

  type Folder = 'inbox' | 'sent' | 'starred' | 'important' | 'drafts' | 'trash' | 'archived' | 'snoozed' | 'all' | 'attention';

  // ── State ────────────────────────────────────────
  let folder: Folder = 'inbox';
  let selectedAccountId = '';
  let emails: EmailListItem[] = [];
  let total = 0;
  let page = 1;
  let pageSize = 50;
  let query = '';
  let counts: Counts = { inbox: 0, unread: 0, starred: 0, sent: 0, drafts: 0, trash: 0, archived: 0, snoozed: 0, important: 0, attention: 0 };
  let labels: EmailLabel[] = [];
  let selectedId: string | null = null;
  let selectedEmail: EmailDetail | null = null;
  let thread: { thread_id: string; subject: string; messages: EmailDetail[] } | null = null;
  let moreOpen = false;
  let loading = false;

  // Attention queue state
  let attentionItems: AttentionItem[] = [];
  let triageStats: TriageStats = { unclassified: 0, attention_needed: 0, critical: 0, high: 0, drafts_pending: 0 };
  let editingDraftId: string | null = null;
  let editDraftBody = '';
  let sendingDraft = false;

  // Pending AI-extracted suggestions count (cheap RPC, refreshed on mount only).
  let suggestionsPending = 0;

  // Gmail connection health — drives the reconnect banner when the token is dead.
  let googleSync: { status?: string; needsReauth?: boolean; authUrl?: string } | null = null;
  async function loadGoogleSync() {
    try { googleSync = await fetchGoogleSyncStatus() as typeof googleSync; }
    catch { googleSync = null; }
  }
  async function loadSuggestionsCount() {
    try {
      const r = await listEmailSuggestions(100) as { total?: number };
      suggestionsPending = r?.total ?? 0;
    } catch {
      suggestionsPending = 0;
    }
  }

  // ── API helpers ──────────────────────────────────
  function urlToRpcAction(url: string, method: string): string | null {
    const u = url.split('?')[0];
    if (method === 'GET' && u === '/api/emails') return 'emails.list';
    const m = u.match(/^\/api\/emails\/(.+)/);
    if (!m) return null;
    const seg = m[1];
    const actionMap: Record<string, string> = {
      counts: 'emails.counts', labels: 'emails.labels', attention: 'emails.attention',
      'approve-draft': 'emails.approveDraft', 'dismiss-draft': 'emails.dismissDraft',
      'edit-draft': 'emails.editDraft', detail: 'emails.detail', thread: 'emails.thread',
    };
    if (actionMap[seg]) return actionMap[seg];
    return 'emails.' + seg.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  function urlArgs(url: string, opts?: RequestInit): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      for (const [k, v] of new URLSearchParams(url.slice(qIdx + 1))) args[k] = v;
    }
    if (opts?.body) {
      try { Object.assign(args, JSON.parse(opts.body as string)); } catch {}
    }
    return args;
  }

  async function api(url: string, opts?: RequestInit) {
    const method = opts?.method ?? 'GET';
    const action = urlToRpcAction(url, method);
    const args = urlArgs(url, opts);
    if (action) {
      return rpcOrCall(action, args, async () => {
        const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
        return r.ok ? r.json() : null;
      });
    }
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    return r.ok ? r.json() : null;
  }
  function post(url: string, body: unknown) { return api(url, { method: 'POST', body: JSON.stringify(body) }); }

  async function loadFolder() {
    loading = true;
    let qs = `folder=${folder}&page=${page}&pageSize=${pageSize}`;
    if (query) qs += `&q=${encodeURIComponent(query)}`;
    if (selectedAccountId) qs += `&account_id=${encodeURIComponent(selectedAccountId)}`;
    const d = await api('/api/emails?' + qs);
    if (d) { emails = d.emails; total = d.total; page = d.page; }
    loading = false;
  }
  async function loadCounts() {
    const qs = selectedAccountId ? `?account_id=${encodeURIComponent(selectedAccountId)}` : '';
    const d = await api('/api/emails/counts' + qs);
    if (d) counts = d;
  }
  function onAccountChange(accountId: string) {
    selectedAccountId = accountId;
    page = 1;
    selectedId = null;
    selectedEmail = null;
    thread = null;
    loadFolder();
    loadCounts();
  }
  async function loadLabels() {
    const d = await api('/api/emails/labels');
    if (d) labels = d;
  }
  async function loadAttention() {
    const d = await api('/api/emails/attention');
    if (d) { attentionItems = d.items ?? []; triageStats = d.stats ?? triageStats; }
  }
  async function approveDraft(commId: string) {
    sendingDraft = true;
    const d = await post('/api/emails/approve-draft', { comm_id: commId });
    sendingDraft = false;
    if (d?.ok) { loadAttention(); loadCounts(); }
  }
  async function dismissDraft(gmailId: string) {
    await post('/api/emails/dismiss-draft', { gmail_id: gmailId });
    loadAttention(); loadCounts();
  }
  async function saveDraftEdit(commId: string) {
    await post('/api/emails/edit-draft', { comm_id: commId, body: editDraftBody });
    editingDraftId = null;
    loadAttention();
  }

  async function loadDetail(gmailId: string) {
    const d = await api('/api/emails/detail?gmail_id=' + encodeURIComponent(gmailId));
    if (d) { selectedEmail = d; selectedId = d.gmail_id; thread = null; }
  }
  async function loadThread() {
    if (!selectedEmail?.thread_id) return;
    const d = await api('/api/emails/thread?thread_id=' + encodeURIComponent(selectedEmail.thread_id));
    if (d) thread = d;
  }

  // ── Actions ──────────────────────────────────────
  async function doAction(endpoint: string, body: Record<string, unknown>, cb?: (d: unknown) => void) {
    const d = await post('/api/emails/' + endpoint, body);
    if (cb) cb(d);
    loadCounts();
    loadFolder();
  }
  function toggleStar(gmailId: string) { doAction('star', { gmail_id: gmailId }, (d: any) => { if (selectedEmail?.gmail_id === gmailId) selectedEmail.is_starred = d?.starred ? 1 : 0; }); }
  function toggleRead(gmailId: string) { doAction('read', { gmail_id: gmailId }); }
  function archive(gmailId: string) { doAction('archive', { gmail_id: gmailId }, () => { selectedId = null; selectedEmail = null; }); }
  function trash(gmailId: string) { doAction('trash', { gmail_id: gmailId }, () => { selectedId = null; selectedEmail = null; }); }
  function restore(gmailId: string) { doAction('restore', { gmail_id: gmailId }, () => { selectedId = null; selectedEmail = null; }); }
  function markImportant(gmailId: string) { doAction('important', { gmail_id: gmailId }); }
  function snooze(gmailId: string, days: number) { doAction('snooze', { gmail_id: gmailId, until: new Date(Date.now() + days * 86400000).toISOString() }); }
  function blockSender(email: string) { doAction('block', { email }); }
  function addNote(gmailId: string) {
    const note = prompt('Add a note:');
    if (note?.trim()) doAction('note', { gmail_id: gmailId, note: note.trim() }, () => loadDetail(gmailId));
  }
  function createTask(gmailId: string) { doAction('action', { gmail_id: gmailId, action: 'create_task' }, () => loadDetail(gmailId)); }
  function createReminder(gmailId: string) { doAction('action', { gmail_id: gmailId, action: 'create_reminder' }); }
  function forwardChannel(gmailId: string) { doAction('action', { gmail_id: gmailId, action: 'forward_channel', params: { channel: 'all' } }); }

  function reply(em: EmailDetail, all = false) {
    const to = em.from_email;
    const subj = em.subject?.startsWith('Re:') ? em.subject : 'Re: ' + em.subject;
    post('/api/dashboard/comms/create', {
      channel: 'email', direction: 'outbound', subject: subj,
      recipients_to: all ? (em.to_emails || to) : to,
      recipients_cc: all ? (em.cc_emails || '') : '',
      gmail_thread_id: em.thread_id || '',
      metadata: JSON.stringify({ reply_to_message_id: em.gmail_id, quoted_text: em.snippet || '' }),
    }).then((d: any) => { if (d?.id) goto('/comms/edit/' + d.id); });
  }
  function forward(em: EmailDetail) {
    const subj = em.subject?.startsWith('Fwd:') ? em.subject : 'Fwd: ' + em.subject;
    const body = '\n\n---------- Forwarded ----------\nFrom: ' + (em.from_name || em.from_email) + '\nDate: ' + em.date + '\nSubject: ' + em.subject + '\n\n' + (em.body_text || em.snippet || '');
    post('/api/dashboard/comms/create', { channel: 'email', direction: 'outbound', subject: subj, body }).then((d: any) => { if (d?.id) goto('/comms/edit/' + d.id); });
  }

  function selectFolder(f: Folder) {
    folder = f; page = 1; selectedId = null; selectedEmail = null; thread = null;
    if (f === 'attention') { loadAttention(); } else { loadFolder(); }
  }
  function selectEmail(gmailId: string) { selectedId = gmailId; loadDetail(gmailId); }
  function doSearch() { page = 1; loadFolder(); }

  // ── Formatting ───────────────────────────────────
  function fmtDate(d: string): string {
    if (!d) return '';
    try {
      const dt = new Date(d);
      const diff = Math.floor((Date.now() - dt.getTime()) / 86400000);
      if (diff === 0) return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (diff === 1) return 'Yesterday';
      if (diff < 7) return dt.toLocaleDateString([], { weekday: 'short' });
      return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch { return d.substring(0, 10); }
  }
  function initials(name: string): string {
    if (!name) return '?';
    const p = name.split(' ');
    return p.length > 1 ? (p[0][0] + p[p.length-1][0]).toUpperCase() : name.substring(0, 2).toUpperCase();
  }

  function urgencyColor(u?: string): string {
    switch (u) {
      case 'critical': return '#ef4444';
      case 'high': return '#f97316';
      case 'normal': return '#6b7280';
      case 'low': return '#3b82f6';
      default: return '';
    }
  }

  $: start = (page - 1) * pageSize + 1;
  $: end = Math.min(page * pageSize, total);
  $: notes = selectedEmail?.actions?.filter(a => a.action_type === 'note') ?? [];

  // ── Keyboard shortcuts ───────────────────────────
  function handleKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!selectedEmail) return;
    const id = selectedEmail.gmail_id;
    switch (e.key) {
      case 'r': reply(selectedEmail); break;
      case 'a': reply(selectedEmail, true); break;
      case 'f': forward(selectedEmail); break;
      case 's': toggleStar(id); break;
      case 'e': archive(id); break;
      case '#': trash(id); break;
      case 'u': toggleRead(id); break;
    }
  }

  onMount(() => {
    loadFolder(); loadCounts(); loadLabels(); loadAttention(); loadSuggestionsCount(); loadGoogleSync();
    document.addEventListener('keydown', handleKey);
  });
  onDestroy(() => { document.removeEventListener('keydown', handleKey); });

  // Folders config
  const FOLDERS: Array<{ id: Folder; label: string; icon: string; countKey?: keyof Counts }> = [
    { id: 'inbox', label: 'Inbox', icon: '📥', countKey: 'unread' },
    { id: 'attention', label: 'Attention', icon: '🔔', countKey: 'attention' },
    { id: 'starred', label: 'Starred', icon: '⭐', countKey: 'starred' },
    { id: 'snoozed', label: 'Snoozed', icon: '⏰', countKey: 'snoozed' },
    { id: 'sent', label: 'Sent', icon: '📤' },
    { id: 'drafts', label: 'Drafts', icon: '📝', countKey: 'drafts' },
    { id: 'important', label: 'Important', icon: '🔖', countKey: 'important' },
  ];
  const FOLDERS2: Array<{ id: Folder; label: string; icon: string; countKey?: keyof Counts }> = [
    { id: 'archived', label: 'Archive', icon: '📦', countKey: 'archived' },
    { id: 'trash', label: 'Trash', icon: '🗑️', countKey: 'trash' },
    { id: 'all', label: 'All Mail', icon: '📋' },
  ];
</script>

{#if googleSync?.needsReauth}
  <div class="gmail-reauth-banner">
    <span>⚠️ Gmail sync disconnected (the Google token expired). No new email is coming in.</span>
    {#if googleSync.authUrl}
      <a class="gmail-reauth-btn" href={googleSync.authUrl}>Reconectar Gmail →</a>
    {/if}
  </div>
{/if}

<div class="mail-shell">
  <!-- ── Sidebar ──────────────────────── -->
  <aside class="mail-sidebar">
    <button class="compose-btn" on:click={() => goto('/comms/compose')}>+ Compose</button>

    <button class="folder-item suggestions-link" on:click={() => goto('/mail/suggestions')}>
      <span class="folder-icon">✨</span>
      <span class="folder-label">AI Suggestions</span>
      {#if suggestionsPending > 0}
        <span class="folder-count attention-badge">{suggestionsPending}</span>
      {/if}
    </button>

    {#each FOLDERS as f}
      <button class="folder-item" class:active={folder === f.id} on:click={() => selectFolder(f.id)}>
        <span class="folder-icon">{f.icon}</span>
        <span class="folder-label">{f.label}</span>
        {#if f.countKey && counts[f.countKey]}
          <span class="folder-count">{counts[f.countKey]}</span>
        {/if}
      </button>
    {/each}

    <div class="folder-sep"></div>

    {#each FOLDERS2 as f}
      <button class="folder-item" class:active={folder === f.id} on:click={() => selectFolder(f.id)}>
        <span class="folder-icon">{f.icon}</span>
        <span class="folder-label">{f.label}</span>
        {#if f.countKey && counts[f.countKey]}
          <span class="folder-count">{counts[f.countKey]}</span>
        {/if}
      </button>
    {/each}

    {#if labels.length}
      <div class="folder-sep"></div>
      <div class="labels-header">Labels</div>
      {#each labels as lb}
        <button class="folder-item" on:click={() => selectFolder('all')}>
          <span class="label-dot" style="background:{lb.color}"></span>
          <span class="folder-label">{lb.name}</span>
        </button>
      {/each}
    {/if}
  </aside>

  <!-- ── Email List ───────────────────── -->
  <div class="mail-list">
    <div class="mail-search">
      <AccountSwitcher bind:value={selectedAccountId} onChange={onAccountChange} />
      <input type="text" placeholder="Search emails..." bind:value={query} on:keydown={(e) => e.key === 'Enter' && doSearch()} />
      <button on:click={doSearch}>Search</button>
    </div>

    <div class="mail-list-header">
      <span class="folder-title">{folder.charAt(0).toUpperCase() + folder.slice(1)} ({total})</span>
      <span class="pagination">
        {#if total > 0}{start}–{end}{:else}0{/if}
        {#if page > 1}<button on:click={() => { page--; loadFolder(); }}>◀</button>{/if}
        {#if end < total}<button on:click={() => { page++; loadFolder(); }}>▶</button>{/if}
      </span>
    </div>

    <div class="mail-rows">
      {#if folder === 'attention'}
        <!-- Attention Queue -->
        {#if !attentionItems.length}
          <div class="mail-empty">No emails need attention</div>
        {:else}
          {#each attentionItems as item (item.gmail_id)}
            <button
              class="mail-row"
              class:selected={selectedId === item.gmail_id}
              on:click={() => selectEmail(item.gmail_id)}
            >
              {#if item.urgency}
                <span class="urgency-dot" style="background:{urgencyColor(item.urgency)}" title={item.urgency}></span>
              {/if}
              <div class="mail-row-content">
                <div class="mail-row-top">
                  <span class="mail-from">{item.from_name || item.from_email || 'Unknown'}</span>
                  <span class="mail-date">{fmtDate(item.date)}</span>
                </div>
                <div class="mail-subject">{item.subject || '(no subject)'}</div>
                <div class="mail-snippet">{item.ai_summary || item.snippet || ''}</div>
                {#if item.draft_comm_id && item.draft_status === 'draft'}
                  <div class="draft-actions">
                    <button class="draft-btn approve" on:click|stopPropagation={() => approveDraft(item.draft_comm_id)} disabled={sendingDraft}>
                      {sendingDraft ? 'Sending...' : '✓ Send'}
                    </button>
                    <button class="draft-btn edit" on:click|stopPropagation={() => { editingDraftId = item.draft_comm_id; editDraftBody = item.draft_body; }}>
                      ✎ Edit
                    </button>
                    <button class="draft-btn dismiss" on:click|stopPropagation={() => dismissDraft(item.gmail_id)}>
                      ✕ Dismiss
                    </button>
                  </div>
                {/if}
              </div>
            </button>
            {#if editingDraftId === item.draft_comm_id}
              <div class="draft-editor">
                <textarea bind:value={editDraftBody} rows="5"></textarea>
                <div class="draft-editor-actions">
                  <button class="draft-btn approve" on:click={() => saveDraftEdit(item.draft_comm_id)}>Save</button>
                  <button class="draft-btn dismiss" on:click={() => editingDraftId = null}>Cancel</button>
                </div>
              </div>
            {/if}
          {/each}
        {/if}
      {:else if loading}
        <div class="mail-empty">Loading...</div>
      {:else if !emails.length}
        <div class="mail-empty">No emails in this folder</div>
      {:else}
        {#each emails as em (em.gmail_id)}
          <button
            class="mail-row"
            class:selected={selectedId === em.gmail_id}
            class:unread={!em.is_read}
            on:click={() => selectEmail(em.gmail_id)}
          >
            <span class="star" class:starred={em.is_starred} on:click|stopPropagation={() => toggleStar(em.gmail_id)}>
              {em.is_starred ? '★' : '☆'}
            </span>
            {#if em.urgency && em.urgency !== ''}
              <span class="urgency-dot" style="background:{urgencyColor(em.urgency)}" title={em.urgency}></span>
            {/if}
            <div class="mail-row-content">
              <div class="mail-row-top">
                <span class="mail-from">{em.contact_name || em.from_name || em.from_email || 'Unknown'}</span>
                <span class="mail-date">{fmtDate(em.date)}</span>
              </div>
              <div class="mail-subject">
                {em.subject || '(no subject)'}
                {#if em.message_count > 1}<span class="thread-badge">{em.message_count}</span>{/if}
                {#if em.attention_needed === 1}<span class="attention-badge">needs reply</span>{/if}
              </div>
              <div class="mail-snippet">{em.ai_summary || em.snippet || ''}</div>
            </div>
            {#if em.has_attachments}<span class="attach-icon">📎</span>{/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>

  <!-- ── Detail Pane ──────────────────── -->
  <div class="mail-detail">
    {#if !selectedEmail}
      <div class="detail-empty">Select an email to read</div>
    {:else}
      <!-- Toolbar -->
      <div class="detail-toolbar">
        <button class="tb" on:click={() => reply(selectedEmail)} title="Reply (r)">↩ Reply</button>
        <button class="tb" on:click={() => reply(selectedEmail, true)} title="Reply All (a)">↩↩ All</button>
        <button class="tb" on:click={() => forward(selectedEmail)} title="Forward (f)">→ Fwd</button>
        <button class="tb" on:click={() => toggleStar(selectedEmail.gmail_id)} title="Star (s)">{selectedEmail.is_starred ? '★' : '☆'}</button>
        <button class="tb" on:click={() => archive(selectedEmail.gmail_id)} title="Archive (e)">📥</button>
        <button class="tb" on:click={() => trash(selectedEmail.gmail_id)} title="Trash (#)">🗑</button>

        {#if folder === 'trash' || folder === 'archived'}
          <button class="tb" on:click={() => restore(selectedEmail.gmail_id)}>↩ Restore</button>
        {/if}

        <div class="more-wrap">
          <button class="tb" on:click={() => moreOpen = !moreOpen}>⋯</button>
          {#if moreOpen}
            <div class="more-menu" on:mouseleave={() => moreOpen = false}>
              <button on:click={() => { toggleRead(selectedEmail.gmail_id); moreOpen = false; }}>{selectedEmail.is_read ? 'Mark Unread' : 'Mark Read'}</button>
              <button on:click={() => { markImportant(selectedEmail.gmail_id); moreOpen = false; }}>Important</button>
              <button on:click={() => { snooze(selectedEmail.gmail_id, 1); moreOpen = false; }}>Snooze 1d</button>
              <button on:click={() => { snooze(selectedEmail.gmail_id, 3); moreOpen = false; }}>Snooze 3d</button>
              <button on:click={() => { blockSender(selectedEmail.from_email); moreOpen = false; }}>Block Sender</button>
              <div class="menu-sep"></div>
              <button on:click={() => { addNote(selectedEmail.gmail_id); moreOpen = false; }}>Add Note</button>
              <button on:click={() => { createTask(selectedEmail.gmail_id); moreOpen = false; }}>Create Task</button>
              <button on:click={() => { createReminder(selectedEmail.gmail_id); moreOpen = false; }}>Create Reminder</button>
              <button on:click={() => { forwardChannel(selectedEmail.gmail_id); moreOpen = false; }}>Send to Channels</button>
            </div>
          {/if}
        </div>
      </div>

      <!-- Header -->
      <div class="detail-header">
        <h2 class="detail-subject">{selectedEmail.subject || '(no subject)'}</h2>
        <div class="detail-from-row">
          <div class="avatar">{initials(selectedEmail.from_name || selectedEmail.from_email)}</div>
          <div class="from-info">
            <div class="from-name">{selectedEmail.from_name || selectedEmail.from_email}</div>
            <div class="from-meta">{selectedEmail.from_email} · {fmtDate(selectedEmail.date)}</div>
          </div>
        </div>
        {#if selectedEmail.to_emails}<div class="detail-recipients">To: {selectedEmail.to_emails}</div>{/if}
        {#if selectedEmail.cc_emails}<div class="detail-recipients">Cc: {selectedEmail.cc_emails}</div>{/if}

        {#if selectedEmail.email_labels?.length}
          <div class="detail-labels">
            {#each selectedEmail.email_labels as lb}
              <span class="email-label" style="background:{lb.color}22;color:{lb.color};border-color:{lb.color}44">{lb.name}</span>
            {/each}
          </div>
        {/if}
      </div>

      <!-- AI Summary -->
      {#if selectedEmail.ai_summary}
        <div class="ai-summary">
          {#if selectedEmail.urgency}
            <span class="urgency-tag" style="background:{urgencyColor(selectedEmail.urgency)}22;color:{urgencyColor(selectedEmail.urgency)};border-color:{urgencyColor(selectedEmail.urgency)}44">
              {selectedEmail.urgency}
            </span>
          {/if}
          <span class="ai-text">AI: {selectedEmail.ai_summary}</span>
        </div>
      {/if}

      <!-- Draft Reply Preview -->
      {#if selectedEmail.draft_comm_id}
        {#await api('/api/dashboard/comms/get?id=' + encodeURIComponent(selectedEmail.draft_comm_id)) then draft}
          {#if draft && draft.status === 'draft'}
            <div class="draft-preview">
              <div class="draft-preview-header">AI Draft Reply</div>
              <div class="draft-preview-body">{draft.body || '(empty)'}</div>
              <div class="draft-preview-actions">
                <button class="draft-btn approve" on:click={() => approveDraft(selectedEmail.draft_comm_id)} disabled={sendingDraft}>
                  {sendingDraft ? 'Sending...' : '✓ Approve & Send'}
                </button>
                <button class="draft-btn edit" on:click={() => { editingDraftId = selectedEmail.draft_comm_id; editDraftBody = draft.body || ''; }}>
                  ✎ Edit Draft
                </button>
                <button class="draft-btn dismiss" on:click={() => dismissDraft(selectedEmail.gmail_id)}>
                  ✕ Dismiss
                </button>
              </div>
              {#if editingDraftId === selectedEmail.draft_comm_id}
                <div class="draft-editor">
                  <textarea bind:value={editDraftBody} rows="6"></textarea>
                  <div class="draft-editor-actions">
                    <button class="draft-btn approve" on:click={() => saveDraftEdit(selectedEmail.draft_comm_id)}>Save</button>
                    <button class="draft-btn dismiss" on:click={() => editingDraftId = null}>Cancel</button>
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        {/await}
      {/if}

      <!-- Body -->
      <div class="detail-body">{selectedEmail.body_text || selectedEmail.snippet || '(empty)'}</div>

      <!-- Thread -->
      {#if selectedEmail.thread_id}
        <button class="thread-btn" on:click={loadThread}>
          {thread ? 'Reload thread' : 'View full thread'}
        </button>
      {/if}
      {#if thread && thread.messages.length > 1}
        <div class="thread-panel">
          <div class="thread-title">Thread ({thread.messages.length} messages)</div>
          {#each thread.messages as tm}
            {#if tm.gmail_id !== selectedEmail.gmail_id}
              <button class="thread-msg" on:click={() => loadDetail(tm.gmail_id)}>
                <div class="thread-msg-from">{tm.from_name || tm.from_email} · {fmtDate(tm.date)}</div>
                <div class="thread-msg-snippet">{tm.snippet || ''}</div>
              </button>
            {/if}
          {/each}
        </div>
      {/if}

      <!-- Notes -->
      {#if notes.length}
        <div class="notes-panel">
          <div class="notes-title">Notes</div>
          {#each notes as n}
            <div class="note-item">{n.value}</div>
          {/each}
        </div>
      {/if}

      <!-- Linked items -->
      {#if selectedEmail.linked_tasks?.length || selectedEmail.linked_contacts?.length}
        <div class="linked-panel">
          <div class="linked-title">Linked Items</div>
          {#each selectedEmail.linked_tasks ?? [] as t}
            <button class="linked-item" on:click={() => goto('/tasks')}>☑ {t.title} [{t.status}]</button>
          {/each}
          {#each selectedEmail.linked_contacts ?? [] as c}
            <div class="linked-item">👤 {c.name}{c.email ? ` (${c.email})` : ''}</div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  /* ── Gmail reconnect banner (shown when the sync token is dead) ── */
  .gmail-reauth-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    background: rgba(240, 71, 112, 0.12);
    border: 1px solid var(--red, #f04770);
    color: var(--text-1);
    padding: 10px 16px;
    border-radius: 8px;
    margin: 0 0 10px;
    font-size: 13px;
  }
  .gmail-reauth-btn {
    background: var(--red, #f04770);
    color: #fff;
    padding: 6px 14px;
    border-radius: 6px;
    text-decoration: none;
    white-space: nowrap;
    font-weight: 600;
  }
  .gmail-reauth-btn:hover { filter: brightness(1.1); }

  /* ── Shell: 3-column Gmail layout ── */
  .mail-shell {
    display: flex;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }

  /* ── Sidebar ── */
  .mail-sidebar {
    width: 210px;
    min-width: 210px;
    border-right: 1px solid var(--border);
    padding: 10px 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .compose-btn {
    margin: 0 12px 10px;
    padding: 8px;
    border-radius: 20px;
    background: var(--primary);
    color: #fff;
    border: none;
    font-weight: 600;
    cursor: pointer;
    font-size: 13px;
  }
  .compose-btn:hover { filter: brightness(1.1); }
  .folder-item {
    display: flex;
    align-items: center;
    padding: 5px 14px;
    cursor: pointer;
    border: none;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    border-radius: 0 20px 20px 0;
    margin-right: 10px;
    text-align: left;
    width: calc(100% - 10px);
  }
  .folder-item:hover { background: var(--surface-hover, var(--surface)); }
  .folder-item.active { background: var(--surface); color: var(--text); font-weight: 600; }
  .folder-icon { margin-right: 10px; font-size: 14px; flex-shrink: 0; }
  .folder-label { flex: 1; }
  .folder-count { font-size: 11px; font-weight: 600; color: var(--text-3); }
  .folder-sep { border-top: 1px solid var(--border); margin: 6px 14px; }
  .labels-header { padding: 4px 14px; font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.5px; }
  .label-dot { width: 8px; height: 8px; border-radius: 50%; margin-right: 10px; flex-shrink: 0; }

  /* ── Email List ── */
  .mail-list {
    flex: 1;
    min-width: 260px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .mail-search {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 6px;
  }
  .mail-search input {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 5px 10px;
    color: var(--text);
    font-size: 13px;
    outline: none;
  }
  .mail-search input:focus { border-color: var(--primary); }
  .mail-search button {
    background: var(--primary);
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 5px 12px;
    cursor: pointer;
    font-size: 12px;
  }
  .mail-list-header {
    padding: 6px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-2);
  }
  .folder-title { font-weight: 600; }
  .pagination { display: flex; gap: 4px; align-items: center; }
  .pagination button { background: none; border: none; color: var(--text-2); cursor: pointer; font-size: 13px; padding: 2px 4px; }
  .pagination button:hover { color: var(--text); }
  .mail-rows { flex: 1; overflow-y: auto; }
  .mail-empty { padding: 40px; text-align: center; color: var(--text-3); font-size: 14px; }
  .mail-row {
    display: flex;
    align-items: flex-start;
    padding: 8px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
    background: transparent;
    border-left: 3px solid transparent;
    text-align: left;
    width: 100%;
    border-right: none;
    border-top: none;
    color: var(--text);
  }
  .mail-row:hover { background: var(--surface-hover, var(--surface)); }
  .mail-row.selected { background: var(--surface); }
  .mail-row.unread { border-left-color: var(--primary); }
  .star { cursor: pointer; margin-right: 6px; margin-top: 2px; color: var(--text-3); font-size: 14px; flex-shrink: 0; background: none; border: none; padding: 0; }
  .star.starred { color: var(--gold, #e8b931); }
  .mail-row-content { flex: 1; min-width: 0; }
  .mail-row-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1px; }
  .mail-from { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mail-row.unread .mail-from { font-weight: 700; }
  .mail-date { font-size: 11px; color: var(--text-3); white-space: nowrap; margin-left: 8px; }
  .mail-subject { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 1px; }
  .mail-row.unread .mail-subject { color: var(--text); font-weight: 600; }
  .thread-badge { font-size: 10px; color: var(--text-3); margin-left: 6px; background: var(--surface); border-radius: 8px; padding: 1px 5px; }
  .mail-snippet { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach-icon { margin-left: 6px; font-size: 12px; color: var(--text-3); margin-top: 2px; }

  /* ── Detail Pane ── */
  .mail-detail {
    width: 40%;
    min-width: 300px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .detail-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-3); font-size: 14px; }
  .detail-toolbar {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .tb {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 7px;
    color: var(--text-2);
    cursor: pointer;
    font-size: 11px;
  }
  .tb:hover { background: var(--surface); color: var(--text); }
  .more-wrap { position: relative; }
  .more-menu {
    position: absolute;
    top: 100%;
    right: 0;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 0;
    z-index: 100;
    min-width: 160px;
    box-shadow: 0 4px 16px rgba(0,0,0,.3);
  }
  .more-menu button {
    display: block;
    width: 100%;
    padding: 6px 14px;
    font-size: 12px;
    cursor: pointer;
    color: var(--text-2);
    background: none;
    border: none;
    text-align: left;
  }
  .more-menu button:hover { background: var(--surface); }
  .menu-sep { border-top: 1px solid var(--border); margin: 3px 0; }

  .detail-header { padding: 14px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .detail-subject { font-size: 16px; font-weight: 700; color: var(--text); margin: 0 0 10px; }
  .detail-from-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .avatar {
    width: 34px; height: 34px; border-radius: 50%;
    background: var(--primary); color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 600; flex-shrink: 0;
  }
  .from-info { flex: 1; }
  .from-name { font-size: 13px; font-weight: 600; color: var(--text); }
  .from-meta { font-size: 11px; color: var(--text-3); }
  .detail-recipients { font-size: 11px; color: var(--text-3); margin-bottom: 2px; }
  .detail-labels { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
  .email-label { font-size: 10px; padding: 2px 8px; border-radius: 10px; border: 1px solid; }

  .detail-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .thread-btn {
    margin: 0 16px 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    color: var(--text-2);
    cursor: pointer;
    font-size: 12px;
    text-align: center;
    flex-shrink: 0;
  }
  .thread-btn:hover { background: var(--surface-hover, var(--surface)); }
  .thread-panel { border-top: 1px solid var(--border); padding: 10px 16px; flex-shrink: 0; overflow-y: auto; max-height: 200px; }
  .thread-title { font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
  .thread-msg { display: block; width: 100%; padding: 6px 8px; background: var(--surface); border-radius: 6px; margin-bottom: 4px; cursor: pointer; border: none; text-align: left; color: var(--text); }
  .thread-msg:hover { filter: brightness(1.1); }
  .thread-msg-from { font-size: 12px; font-weight: 600; }
  .thread-msg-snippet { font-size: 11px; color: var(--text-3); margin-top: 2px; max-height: 32px; overflow: hidden; }

  .notes-panel, .linked-panel { border-top: 1px solid var(--border); padding: 10px 16px; flex-shrink: 0; }
  .notes-title, .linked-title { font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
  .note-item { padding: 5px 8px; background: rgba(228,183,76,.07); border-left: 3px solid var(--gold, #e8b931); border-radius: 4px; margin-bottom: 4px; font-size: 12px; color: var(--text); }
  .linked-item { display: block; font-size: 12px; color: var(--text); padding: 3px 0; background: none; border: none; cursor: pointer; text-align: left; }

  /* ── Urgency & Triage ── */
  .urgency-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-right: 6px; margin-top: 4px; }
  .attention-badge { font-size: 9px; color: #f97316; margin-left: 6px; background: rgba(249,115,22,.1); border-radius: 8px; padding: 1px 6px; font-weight: 600; }
  .urgency-tag { font-size: 10px; padding: 2px 8px; border-radius: 10px; border: 1px solid; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }

  .ai-summary { padding: 8px 16px; background: rgba(59,130,246,.06); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .ai-text { font-size: 12px; color: var(--text-2); font-style: italic; }

  /* ── Draft Preview ── */
  .draft-preview { margin: 0 16px 8px; border: 1px solid rgba(34,197,94,.3); border-radius: 8px; overflow: hidden; flex-shrink: 0; }
  .draft-preview-header { padding: 6px 12px; background: rgba(34,197,94,.08); font-size: 11px; font-weight: 600; color: #22c55e; border-bottom: 1px solid rgba(34,197,94,.2); }
  .draft-preview-body { padding: 10px 12px; font-size: 12px; line-height: 1.5; color: var(--text); white-space: pre-wrap; max-height: 150px; overflow-y: auto; }
  .draft-preview-actions { padding: 6px 12px; display: flex; gap: 6px; border-top: 1px solid rgba(34,197,94,.15); }

  .draft-actions { display: flex; gap: 4px; margin-top: 4px; }
  .draft-btn { font-size: 11px; border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; cursor: pointer; background: none; color: var(--text-2); }
  .draft-btn:hover { background: var(--surface); }
  .draft-btn.approve { color: #22c55e; border-color: #22c55e44; }
  .draft-btn.approve:hover { background: rgba(34,197,94,.1); }
  .draft-btn.edit { color: #3b82f6; border-color: #3b82f644; }
  .draft-btn.edit:hover { background: rgba(59,130,246,.1); }
  .draft-btn.dismiss { color: #ef4444; border-color: #ef444444; }
  .draft-btn.dismiss:hover { background: rgba(239,68,68,.1); }
  .draft-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .draft-editor { padding: 8px 12px; border-top: 1px solid var(--border); }
  .draft-editor textarea { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px; color: var(--text); font-size: 12px; resize: vertical; font-family: inherit; }
  .draft-editor textarea:focus { border-color: var(--primary); outline: none; }
  .draft-editor-actions { display: flex; gap: 6px; margin-top: 6px; }

  /* ── Responsive ── */
  @media (max-width: 900px) {
    .mail-sidebar { width: 160px; min-width: 160px; }
    .mail-detail { display: none; }
  }
</style>
