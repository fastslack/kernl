<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    listEmailSuggestions,
    approveEmailSuggestion,
    dismissEmailSuggestion,
  } from '$lib/api';

  type SuggestionType = 'task' | 'reminder' | 'contact' | 'shopping';
  type Tab = 'all' | SuggestionType;

  interface Suggestion {
    id: string;
    comm_id: string;
    type: SuggestionType;
    status: 'pending' | 'approved' | 'dismissed';
    payload: Record<string, unknown>;
    subject?: string;
    from_email?: string;
    created_at: string;
  }

  let suggestions: Suggestion[] = [];
  let counts = { task: 0, reminder: 0, contact: 0, shopping: 0 };
  let loading = true;
  let busyId = '';
  let toast = '';
  let toastKind: 'ok' | 'err' = 'ok';
  let activeTab: Tab = 'all';

  $: filtered = activeTab === 'all'
    ? suggestions
    : suggestions.filter((s) => s.type === activeTab);

  async function load() {
    loading = true;
    try {
      const r = await listEmailSuggestions(100) as {
        suggestions: Suggestion[];
        counts: typeof counts;
      };
      suggestions = r.suggestions ?? [];
      counts = r.counts ?? counts;
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      loading = false;
    }
  }

  async function approve(s: Suggestion) {
    busyId = s.id;
    try {
      const r = await approveEmailSuggestion(s.id) as { ok?: boolean; error?: string; type?: string };
      if (r?.ok) {
        flash(`Approved → created ${r.type}`);
        suggestions = suggestions.filter((x) => x.id !== s.id);
        if (counts[s.type] > 0) counts[s.type]--;
      } else {
        flash(r?.error ?? 'Approve failed', 'err');
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      busyId = '';
    }
  }

  async function dismiss(s: Suggestion) {
    busyId = s.id;
    try {
      await dismissEmailSuggestion(s.id);
      flash('Dismissed');
      suggestions = suggestions.filter((x) => x.id !== s.id);
      if (counts[s.type] > 0) counts[s.type]--;
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      busyId = '';
    }
  }

  function flash(msg: string, kind: 'ok' | 'err' = 'ok') {
    toast = msg;
    toastKind = kind;
    setTimeout(() => { if (toast === msg) toast = ''; }, 3500);
  }

  function fmtDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString();
  }

  function priorityColor(p?: string): string {
    switch (p) {
      case 'urgent': return '#dc2626';
      case 'high': return '#f97316';
      case 'medium': return '#eab308';
      case 'low': return '#3b82f6';
      default: return '#6b7280';
    }
  }

  function typeIcon(t: SuggestionType): string {
    switch (t) {
      case 'task': return '✓';
      case 'reminder': return '⏰';
      case 'contact': return '👤';
      case 'shopping': return '🛒';
    }
  }

  function summarize(s: Suggestion): { title: string; meta: string } {
    const p = s.payload as Record<string, string>;
    if (s.type === 'task') {
      const due = p.due_date ? ` · due ${p.due_date}` : '';
      const ctx = p.context ? ` · ${p.context}` : '';
      return { title: p.title ?? '(no title)', meta: `${p.priority ?? 'medium'}${ctx}${due}` };
    }
    if (s.type === 'reminder') {
      return { title: p.title ?? '(no title)', meta: `${p.trigger_at ?? '?'}${p.repeat && p.repeat !== 'none' ? ` · ${p.repeat}` : ''}` };
    }
    if (s.type === 'contact') {
      return { title: p.name ?? '(no name)', meta: `${p.email ?? ''}${p.company ? ` · ${p.company}` : ''}` };
    }
    return { title: p.name ?? '(no name)', meta: `${p.quantity ?? 1} ${p.unit ?? ''}` };
  }

  onMount(load);
</script>

<svelte:head><title>Email Suggestions · Kernl</title></svelte:head>

<div class="page">
 <div class="inner">
  <header class="head">
    <button class="back" on:click={() => goto('/mail')}>← Mail</button>
    <h1>Email Suggestions</h1>
    <button class="reload" on:click={load} disabled={loading}>{loading ? 'Loading…' : '↻ Reload'}</button>
  </header>

  <p class="hint">
    AI-extracted action items from your inbox. Approve to create the entity in the kernel; dismiss to drop it.
  </p>

  <nav class="tabs">
    <button class="tab" class:active={activeTab === 'all'} on:click={() => (activeTab = 'all')}>
      All <span class="badge">{suggestions.length}</span>
    </button>
    <button class="tab" class:active={activeTab === 'task'} on:click={() => (activeTab = 'task')}>
      ✓ Tasks <span class="badge">{counts.task}</span>
    </button>
    <button class="tab" class:active={activeTab === 'reminder'} on:click={() => (activeTab = 'reminder')}>
      ⏰ Reminders <span class="badge">{counts.reminder}</span>
    </button>
    <button class="tab" class:active={activeTab === 'contact'} on:click={() => (activeTab = 'contact')}>
      👤 Contacts <span class="badge">{counts.contact}</span>
    </button>
    <button class="tab" class:active={activeTab === 'shopping'} on:click={() => (activeTab = 'shopping')}>
      🛒 Shopping <span class="badge">{counts.shopping}</span>
    </button>
  </nav>

  {#if toast}
    <div class="toast {toastKind}">{toast}</div>
  {/if}

  {#if loading && suggestions.length === 0}
    <div class="empty">Loading…</div>
  {:else if filtered.length === 0}
    <div class="empty">
      {#if suggestions.length === 0}
        No pending suggestions. The kernel will populate this list as new emails arrive.
      {:else}
        Nothing in this category.
      {/if}
    </div>
  {:else}
    <ul class="list">
      {#each filtered as s (s.id)}
        {@const view = summarize(s)}
        <li class="card" class:busy={busyId === s.id}>
          <div class="card-icon" title={s.type}>{typeIcon(s.type)}</div>
          <div class="card-body">
            <div class="card-top">
              <span class="card-title">{view.title}</span>
              <span class="card-date">{fmtDate(s.created_at)}</span>
            </div>
            <div class="card-meta">
              {#if s.type === 'task'}
                <span class="dot" style="background:{priorityColor(String(s.payload.priority ?? ''))}"></span>
              {/if}
              <span>{view.meta}</span>
            </div>
            {#if s.payload.description || s.payload.body || s.payload.notes}
              <div class="card-desc">
                {s.payload.description ?? s.payload.body ?? s.payload.notes}
              </div>
            {/if}
            <div class="card-source">
              ↳ from “{s.subject || '(no subject)'}”{s.from_email ? ` · ${s.from_email}` : ''}
            </div>
          </div>
          <div class="card-actions">
            <button class="btn approve" disabled={!!busyId} on:click={() => approve(s)}>✓ Approve</button>
            <button class="btn dismiss" disabled={!!busyId} on:click={() => dismiss(s)}>✕ Dismiss</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
 </div>
</div>

<style>
  /* /mail/* renders inside a full-bleed layout where the parent locks
   * overflow:hidden on .main-inner. We need to own scroll here so the
   * suggestion list can grow past the viewport. */
  .page {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    color: var(--fg, #e5e7eb);
  }
  .inner {
    max-width: 920px;
    margin: 0 auto;
    padding: 24px 20px 48px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 4px;
  }
  .head h1 {
    margin: 0;
    font-size: 22px;
    flex: 1;
  }
  .back, .reload {
    background: var(--surface, #1f2937);
    border: 1px solid var(--border, #374151);
    color: inherit;
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
  }
  .back:hover, .reload:hover { background: var(--surface-hover, #2d3748); }
  .hint { color: var(--muted, #9ca3af); font-size: 13px; margin: 0 0 16px; }

  .tabs {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border, #374151);
    padding-bottom: 8px;
  }
  .tab {
    background: transparent;
    border: 1px solid transparent;
    color: var(--muted, #9ca3af);
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tab:hover { background: var(--surface, #1f2937); color: inherit; }
  .tab.active {
    background: var(--surface, #1f2937);
    border-color: var(--border, #374151);
    color: inherit;
  }
  .badge {
    background: var(--badge-bg, #374151);
    color: var(--fg, #e5e7eb);
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 9px;
  }

  .toast {
    padding: 8px 12px;
    border-radius: 6px;
    margin-bottom: 12px;
    font-size: 13px;
  }
  .toast.ok { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; }
  .toast.err { background: rgba(239, 68, 68, 0.15); color: #fca5a5; }

  .empty {
    text-align: center;
    color: var(--muted, #9ca3af);
    padding: 48px 12px;
    font-size: 14px;
  }

  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .card {
    display: grid;
    grid-template-columns: 36px 1fr auto;
    gap: 12px;
    padding: 14px 16px;
    background: var(--surface, #1f2937);
    border: 1px solid var(--border, #374151);
    border-radius: 8px;
    transition: opacity 0.15s;
  }
  .card.busy { opacity: 0.5; pointer-events: none; }

  .card-icon {
    font-size: 20px;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-hover, #2d3748);
    border-radius: 8px;
  }

  .card-body { min-width: 0; }
  .card-top { display: flex; gap: 12px; align-items: baseline; }
  .card-title {
    font-weight: 600;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-date { font-size: 12px; color: var(--muted, #9ca3af); }
  .card-meta {
    font-size: 12px;
    color: var(--muted, #9ca3af);
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
  }
  .card-desc {
    font-size: 13px;
    color: var(--fg-soft, #d1d5db);
    margin-top: 6px;
    line-height: 1.4;
  }
  .card-source {
    font-size: 11px;
    color: var(--muted, #9ca3af);
    margin-top: 6px;
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .card-actions { display: flex; flex-direction: column; gap: 6px; align-self: center; }
  .btn {
    border: 1px solid var(--border, #374151);
    background: var(--surface-hover, #2d3748);
    color: inherit;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    min-width: 100px;
  }
  .btn:hover:not(:disabled) { filter: brightness(1.15); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.approve { color: #6ee7b7; }
  .btn.dismiss { color: #fca5a5; }
</style>
