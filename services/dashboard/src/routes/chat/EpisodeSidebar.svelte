<script lang="ts">
  /**
   * The chat's conversation list: search, select, new, two-step delete and
   * the collapse toggle.
   *
   * The episodes and the selection belong to the page — the header, the
   * transcript and the model picker read them too — so they arrive as props
   * and every change goes back through a callback. `sidebarCollapsed` is
   * bound because the page paints it as well (`.cx.sidebar-collapsed`, and
   * the header's menu button that reopens the sidebar).
   */
  import { providerIcon, providerColor } from '$lib/chat-view.js';
  import { timeAgo } from '$shared/utils';
  import { readApiError } from '$lib/api.js';

  export let episodes: any[] = [];
  export let selectedEpisodeId: string | null = null;
  export let sidebarCollapsed = false;
  export let onSelect: (id: string) => Promise<void> | void = () => {};
  export let onNew: () => Promise<void> | void = () => {};
  /** Drops the episode from the page's list (and reselects); awaited, so a
   *  failure there is reported like a failed delete. */
  export let onDeleted: (id: string) => Promise<void> = async () => {};

  let searchQuery = '';
  let deleteConfirmId: string | null = null;

  $: filteredEpisodes = searchQuery
    ? episodes.filter(e => (e.title || '').toLowerCase().includes(searchQuery.toLowerCase()))
    : episodes;

  // ── Delete episode ─────────────────────────────────
  // Two-step: first click on trash arms `deleteConfirmId`, second click on
  // the same row's confirm icon actually deletes. Click anywhere else cancels.
  let deletingEpisodeId: string | null = null;

  function askDelete(id: string, ev: Event) {
    ev.stopPropagation();
    deleteConfirmId = deleteConfirmId === id ? null : id;
  }
  function cancelDelete(ev?: Event) {
    if (ev) ev.stopPropagation();
    deleteConfirmId = null;
  }
  async function confirmDelete(id: string, ev: Event) {
    ev.stopPropagation();
    deletingEpisodeId = id;
    try {
      const r = await fetch('/api/chat/episode/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episode_id: id }),
      });
      if (!r.ok) throw new Error((await readApiError(r)) ?? `HTTP ${r.status}`);
      await onDeleted(id);
      deleteConfirmId = null;
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    } finally {
      deletingEpisodeId = null;
    }
  }
</script>

<aside class="cx-side">
  <div class="cx-side-head">
    <div class="cx-side-brand">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="cx-side-icon">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <span>Conversations</span>
    </div>
    <button class="cx-new" on:click={onNew} title="New conversation">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        <path d="M12 5v14M5 12h14"/>
      </svg>
    </button>
  </div>

  <!-- Search -->
  <div class="cx-search-wrap">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cx-search-icon">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    <input
      class="cx-search"
      type="text"
      bind:value={searchQuery}
      placeholder="Search chats..."
    />
  </div>

  <!-- Episode list -->
  <div class="cx-list">
    {#each filteredEpisodes as ep, i (ep.id)}
      <div
        class="cx-ep"
        class:active={ep.id === selectedEpisodeId}
        class:cx-ep-confirming={deleteConfirmId === ep.id}
        role="button"
        tabindex="0"
        on:click={() => onSelect(ep.id)}
        on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(ep.id); } }}
        style="animation-delay: {i * 30}ms"
      >
        <div class="cx-ep-avatar" style="color: {providerColor(ep.llm_provider)}">
          {providerIcon(ep.llm_provider)}
        </div>
        <div class="cx-ep-body">
          <div class="cx-ep-title">{ep.title || 'New conversation'}</div>
          <div class="cx-ep-sub">
            <span class="cx-ep-count">{ep.message_count}</span>
            <span class="cx-ep-time">{timeAgo(ep.updated_at)}</span>
          </div>
        </div>

        {#if deleteConfirmId === ep.id}
          <!-- Confirmation pair -->
          <div class="cx-ep-actions cx-ep-actions-confirm">
            <button
              class="cx-ep-act cx-ep-act-confirm"
              title="Confirm delete"
              aria-label="Confirm delete"
              disabled={deletingEpisodeId === ep.id}
              on:click={(e) => confirmDelete(ep.id, e)}
            >
              {#if deletingEpisodeId === ep.id}
                <svg viewBox="0 0 24 24" width="14" height="14" class="cx-ep-spin"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="14 28" stroke-linecap="round"/></svg>
              {:else}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="14" height="14" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
              {/if}
            </button>
            <button
              class="cx-ep-act cx-ep-act-cancel"
              title="Cancel"
              aria-label="Cancel delete"
              on:click={cancelDelete}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="14" height="14" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        {:else}
          <!-- Default: live dot + trash on hover -->
          <div class="cx-ep-actions">
            {#if ep.status !== 'archived'}
              <div class="cx-ep-live"></div>
            {/if}
            <button
              class="cx-ep-act cx-ep-act-trash"
              title="Delete conversation"
              aria-label="Delete conversation"
              on:click={(e) => askDelete(ep.id, e)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14" aria-hidden="true">
                <path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
          </div>
        {/if}
      </div>
    {/each}

    {#if !filteredEpisodes.length}
      <div class="cx-list-empty">
        {#if searchQuery}
          <span>No matches</span>
        {:else}
          <span>No conversations yet</span>
          <button class="cx-list-empty-btn" on:click={onNew}>Start one</button>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Sidebar toggle -->
  <button class="cx-collapse" on:click={() => sidebarCollapsed = !sidebarCollapsed} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
      {#if sidebarCollapsed}
        <path d="m9 18 6-6-6-6"/>
      {:else}
        <path d="m15 18-6-6 6-6"/>
      {/if}
    </svg>
  </button>
</aside>

<style>
  .cx-side {
    width: 280px;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
    transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s;
    position: relative;
    z-index: 2;
  }

  /* `.sidebar-collapsed` is set by the page, on its own `.cx` root. */
  :global(.cx.sidebar-collapsed) .cx-side {
    width: 0;
    border-right: none;
    overflow: hidden;
    opacity: 0;
  }

  .cx-side-head {
    padding: 16px 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: linear-gradient(180deg, var(--surface-2) 0%, var(--surface-1) 100%);
  }

  .cx-side-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
    color: var(--text-1);
    letter-spacing: -0.02em;
  }

  .cx-side-icon {
    width: 18px;
    height: 18px;
    color: var(--gold);
  }

  .cx-new {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition: all 0.2s;
  }

  .cx-new:hover {
    border-color: var(--gold);
    color: var(--gold);
    background: rgba(212, 168, 75, 0.06);
    transform: scale(1.05);
  }

  /* Search */
  .cx-search-wrap {
    padding: 12px 14px;
    position: relative;
    flex-shrink: 0;
  }

  .cx-search-icon {
    position: absolute;
    left: 24px;
    top: 50%;
    transform: translateY(-50%);
    width: 13px;
    height: 13px;
    color: var(--text-3);
    pointer-events: none;
  }

  .cx-search {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-1);
    font-size: 12px;
    font-family: var(--font-body);
    padding: 7px 10px 7px 30px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .cx-search::placeholder { color: var(--text-3); }
  .cx-search:focus {
    border-color: var(--gold);
    box-shadow: 0 0 0 2px rgba(212, 168, 75, 0.08);
  }

  /* Episode list */
  .cx-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 10px 10px;
  }

  .cx-list::-webkit-scrollbar { width: 3px; }
  .cx-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .cx-ep {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    color: var(--text-1);
    font-family: var(--font-body);
    margin-bottom: 2px;
    animation: fadeSlideIn 0.3s ease both;
  }

  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateX(-8px); }
    to { opacity: 1; transform: translateX(0); }
  }

  .cx-ep:hover {
    background: var(--surface-2);
    border-color: var(--border);
  }

  .cx-ep.active {
    background: var(--surface-3);
    border-color: rgba(212, 168, 75, 0.2);
    box-shadow: inset 3px 0 0 var(--gold);
  }

  .cx-ep-avatar {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: var(--surface-3);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 12px;
    flex-shrink: 0;
  }

  .cx-ep-body {
    flex: 1;
    min-width: 0;
  }

  .cx-ep-title {
    font-size: 12.5px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.3;
  }

  .cx-ep-sub {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    font-size: 10.5px;
    color: var(--text-3);
  }

  .cx-ep-count {
    background: var(--surface-3);
    border-radius: 4px;
    padding: 0 4px;
    font-family: var(--font-mono);
    font-size: 9.5px;
  }

  .cx-ep-live {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
    flex-shrink: 0;
    box-shadow: 0 0 6px rgba(61, 214, 140, 0.4);
  }

  /* ── Episode row actions (delete trash + confirm pair) ── */
  .cx-ep-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    margin-left: 4px;
  }
  .cx-ep-act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    padding: 0;
    transition: background 0.12s, color 0.12s, border-color 0.12s, opacity 0.12s;
  }
  .cx-ep-act:disabled { cursor: progress; opacity: 0.6; }
  .cx-ep-act:focus-visible { outline: none; border-color: var(--text-2); }

  /* Trash icon: hidden by default, fades in on row hover (or when row is active) */
  .cx-ep-act-trash { opacity: 0; }
  .cx-ep:hover .cx-ep-act-trash,
  .cx-ep.active .cx-ep-act-trash,
  .cx-ep-act-trash:focus-visible { opacity: 1; }
  .cx-ep-act-trash:hover {
    background: rgba(240, 71, 112, 0.12);
    color: var(--red, #f04770);
    border-color: rgba(240, 71, 112, 0.3);
  }

  /* Confirm row: green check + red X, always visible while confirming */
  .cx-ep-confirming { background: rgba(240, 71, 112, 0.06); }
  .cx-ep-actions-confirm { gap: 4px; }
  .cx-ep-act-confirm {
    color: var(--red, #f04770);
    background: rgba(240, 71, 112, 0.1);
    border-color: rgba(240, 71, 112, 0.25);
  }
  .cx-ep-act-confirm:hover:not(:disabled) {
    background: rgba(240, 71, 112, 0.22);
    color: var(--red, #f04770);
  }
  .cx-ep-act-cancel {
    color: var(--text-2);
    background: rgba(255, 255, 255, 0.04);
    border-color: var(--border);
  }
  .cx-ep-act-cancel:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-1);
  }
  .cx-ep-spin { animation: cx-ep-spin 0.7s linear infinite; }
  @keyframes cx-ep-spin { to { transform: rotate(360deg); } }


  .cx-list-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 32px 16px;
    color: var(--text-3);
    font-size: 12px;
  }

  .cx-list-empty-btn {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--gold);
    font-size: 11px;
    padding: 4px 12px;
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .cx-list-empty-btn:hover { border-color: var(--gold); }

  /* Collapse toggle */
  .cx-collapse {
    position: absolute;
    right: -12px;
    top: 50%;
    transform: translateY(-50%);
    width: 24px;
    height: 48px;
    border-radius: 0 8px 8px 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-left: none;
    color: var(--text-3);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3;
    transition: color 0.15s, background 0.15s;
    opacity: 0;
  }

  .cx-side:hover .cx-collapse,
  :global(.cx.sidebar-collapsed) .cx-collapse { opacity: 1; }

  :global(.cx.sidebar-collapsed) .cx-collapse {
    position: fixed;
    left: calc(var(--sidebar-w) + 0px);
    right: auto;
    border-radius: 0 8px 8px 0;
    border-left: 1px solid var(--border);
  }

  .cx-collapse:hover {
    color: var(--gold);
    background: var(--surface-3);
  }
</style>
