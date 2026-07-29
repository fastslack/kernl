<script lang="ts">
  // /news — migrated from services/dashboard/src/routes/news/+page.svelte
  // (Fase 3). The news store stays shell-owned (ctx.getStore); RPC keeps
  // rpcOrCall semantics via ctx.rpc; HTTP fallbacks use ctx.fetchRaw.
  import { onMount } from 'svelte';
  import { timeAgo } from '$shared/utils';
  import { sanitizeHtml } from '$shared/sanitize';
  import Empty from '$shared/components/Empty.svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const news = ctx.getStore('news') as any;
  const rpcOrCall = (action: string, params: Record<string, unknown>, fallback: () => Promise<any>) =>
    ctx.rpc(action, params, fallback);

  // Types
  interface Column {
    id: string;
    name: string;
    color: string;
    icon: string;
    sort_order: number;
    is_active: boolean;
    feed_ids: string[];
  }

  interface Feed {
    id: string;
    name: string;
    url: string;
    category: string;
    is_active: number | boolean;
    color: string;
  }

  interface Article {
    id: string;
    feedId: string;
    feedName: string;
    feedColor: string;
    category: string;
    title: string;
    description: string;
    link: string;
    pubDate: string;
    imageUrl?: string;
    author?: string;
  }

  // State
  $: n = $news as { columns?: Column[]; feeds?: Feed[]; articles?: Article[]; categories?: any[] } | null;
  $: columns = (n?.columns ?? []).filter(c => c.is_active).sort((a, b) => a.sort_order - b.sort_order);
  $: allFeeds = n?.feeds ?? [];
  $: allArticles = n?.articles ?? [];

  // Config modal state
  let showConfig = false;
  let configTab: 'columns' | 'feeds' = 'columns';
  let allFeedsForConfig: Feed[] = [];

  // Column edit state
  let editingColumn: Column | null = null;
  let newColumnName = '';
  let newColumnColor = '#5B9BF7';

  // Loading states
  let refreshing = false;
  let saving = false;

  // Article modal state
  let selectedArticle: Article | null = null;

  function openArticle(a: Article) {
    selectedArticle = a;
  }

  function closeArticle() {
    selectedArticle = null;
  }

  // Preset colors
  const COLORS = [
    '#5B9BF7', '#3DD6C8', '#8B7CF6', '#3DD68C',
    '#F0883E', '#F04770', '#D4A84B', '#06B6D4'
  ];

  // Get articles for a column
  function getColumnArticles(col: Column): Article[] {
    if (!col.feed_ids.length) return [];
    return allArticles
      .filter(a => col.feed_ids.includes(a.feedId))
      .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
      .slice(0, 50);
  }

  // Grid layout based on column count
  $: gridClass = columns.length <= 1 ? 'news-grid-1' :
                 columns.length === 2 ? 'news-grid-2' :
                 columns.length === 3 ? 'news-grid-3' :
                 columns.length === 4 ? 'news-grid-4' :
                 columns.length === 5 ? 'news-grid-5' : 'news-grid-6';

  // API calls
  async function doRefresh() {
    refreshing = true;
    try {
      await rpcOrCall('feeds.refresh', {}, async () => {
        const res = await ctx.fetchRaw('/api/feeds/refresh', { method: 'POST' });
        return res.json();
      });
      const data = await rpcOrCall('dashboard.news', {}, async () => {
        const res = await ctx.fetchRaw('/api/dashboard/news');
        return res.json();
      });
      news.set(data);
    } finally {
      refreshing = false;
    }
  }

  async function loadAllFeeds() {
    const data = await rpcOrCall('feeds.listAll', {}, async () => {
      const res = await ctx.fetchRaw('/api/news/all-feeds');
      return res.json();
    });
    allFeedsForConfig = data.feeds || [];
  }

  async function createColumn() {
    if (!newColumnName.trim()) return;
    saving = true;
    try {
      await rpcOrCall('news.columns.create', { name: newColumnName, color: newColumnColor }, async () => {
        const res = await ctx.fetchRaw('/api/news/columns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newColumnName, color: newColumnColor })
        });
        return res.json();
      });
      newColumnName = '';
      newColumnColor = '#5B9BF7';
      await reloadNews();
    } finally {
      saving = false;
    }
  }

  async function updateColumn(col: Column) {
    saving = true;
    try {
      await rpcOrCall('news.columns.update', { id: col.id, name: col.name, color: col.color, is_active: col.is_active }, async () => {
        const res = await ctx.fetchRaw(`/api/news/columns/${col.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: col.name, color: col.color, is_active: col.is_active })
        });
        return res.json();
      });
      await reloadNews();
    } finally {
      saving = false;
      editingColumn = null;
    }
  }

  async function deleteColumn(id: string) {
    if (!confirm('Delete this column?')) return;
    await rpcOrCall('news.columns.delete', { id }, async () => {
      const res = await ctx.fetchRaw(`/api/news/columns/${id}`, { method: 'DELETE' });
      return res.json();
    });
    await reloadNews();
  }

  async function toggleFeedInColumn(colId: string, feedId: string, currentFeeds: string[]) {
    const newFeeds = currentFeeds.includes(feedId)
      ? currentFeeds.filter(f => f !== feedId)
      : [...currentFeeds, feedId];

    await rpcOrCall('news.columns.assignFeeds', { id: colId, feed_ids: newFeeds }, async () => {
      const res = await ctx.fetchRaw(`/api/news/columns/${colId}/feeds`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feed_ids: newFeeds })
      });
      return res.json();
    });
    await reloadNews();
  }

  async function toggleFeedActive(feed: Feed) {
    await rpcOrCall('feeds.toggle', { id: feed.id }, async () => {
      const res = await ctx.fetchRaw(`/api/feeds/${feed.id}/toggle`, { method: 'POST' });
      return res.json();
    });
    await loadAllFeeds();
    await reloadNews();
  }

  async function reloadNews() {
    try {
      const data = await rpcOrCall('dashboard.news', {}, async () => {
        const res = await ctx.fetchRaw('/api/dashboard/news');
        return res.ok ? res.json() : {};
      });
      // Always set a non-null object so the page leaves the loading state and
      // renders its own empty state instead of an infinite spinner.
      news.set(data ?? {});
    } catch {
      news.set({});
    }
  }

  // Initial hydration — without this the `news` store stays null on a fresh
  // install (nothing calls reloadNews until a user action) and the page hangs
  // on "Loading…". Runs once on mount so first-run shows the empty state.
  onMount(() => { void reloadNews(); });

  function openConfig() {
    loadAllFeeds();
    showConfig = true;
  }

</script>

<div class="news-page">
  {#if !n}
    <div class="news-loading">Loading news…</div>
  {:else if columns.length === 0}
    <div class="news-empty">
      <Empty
        icon="📰"
        title="Build your news wall"
        hint="Group RSS feeds into colored columns — tech, world, a favorite blog — and read them side by side. Add your first stream to begin."
        cta="+ Add a stream"
        on:cta={openConfig}
      />
    </div>
  {:else}
    <div class="news-columns {gridClass}">
      {#each columns as col (col.id)}
        {@const articles = getColumnArticles(col)}
        <div class="news-col">
          <div class="news-col-head" style="--c: {col.color}">
            <span class="news-col-dot"></span>
            <span class="news-col-name">{col.name}</span>
            <span class="news-col-count">{articles.length}</span>
          </div>
          <div class="news-col-body">
            {#if articles.length === 0}
              <div class="news-col-empty">
                No articles<br>
                <button on:click={openConfig}>Configure</button>
              </div>
            {:else}
              {#each articles as a (a.id)}
                <button class="news-item" style="--c: {a.feedColor || col.color}" on:click={() => openArticle(a)}>
                  {#if a.imageUrl}
                    <div class="news-item-img" style="background-image: url({a.imageUrl})"></div>
                  {:else}
                    <div class="news-item-img news-item-img-none">
                      <span>{a.feedName.charAt(0)}</span>
                    </div>
                  {/if}
                  <div class="news-item-body">
                    <div class="news-item-title">{a.title}</div>
                    {#if a.description}
                      <div class="news-item-desc">{a.description.slice(0, 100)}{a.description.length > 100 ? '...' : ''}</div>
                    {/if}
                    <div class="news-item-meta">
                      <span class="news-item-source">{a.feedName}</span>
                      <span class="news-item-time">{timeAgo(a.pubDate)}</span>
                    </div>
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Floating buttons -->
  <div class="news-fab-group">
    <button class="news-fab" on:click={doRefresh} disabled={refreshing} title="Refresh">
      {#if refreshing}<span class="news-fab-spin"></span>{:else}↻{/if}
    </button>
    <button class="news-fab news-fab-config" on:click={openConfig} title="Configure">⚙</button>
  </div>
</div>

<!-- Config Modal -->
{#if showConfig}
  <div class="news-modal-bg" on:click|self={() => showConfig = false} role="presentation">
    <div class="news-modal">
      <div class="news-modal-head">
        <div class="news-modal-tabs">
          <button class:active={configTab === 'columns'} on:click={() => configTab = 'columns'}>Streams</button>
          <button class:active={configTab === 'feeds'} on:click={() => configTab = 'feeds'}>Feeds</button>
        </div>
        <button class="news-modal-close" on:click={() => showConfig = false}>×</button>
      </div>

      <div class="news-modal-body">
        {#if configTab === 'columns'}
          <div class="news-cfg-section">
            <div class="news-cfg-row">
              <input type="text" placeholder="Stream name..." bind:value={newColumnName} />
              <div class="news-cfg-colors">
                {#each COLORS as c}
                  <button class:active={newColumnColor === c} style="background:{c}" on:click={() => newColumnColor = c}></button>
                {/each}
              </div>
              <button class="news-cfg-add" on:click={createColumn} disabled={!newColumnName.trim()}>Add</button>
            </div>
          </div>

          {#each columns as col (col.id)}
            <div class="news-cfg-col">
              <div class="news-cfg-col-head">
                <span class="news-cfg-col-dot" style="background:{col.color}"></span>
                {#if editingColumn?.id === col.id}
                  <input type="text" bind:value={editingColumn.name} class="news-cfg-col-input" />
                  <div class="news-cfg-colors-sm">
                    {#each COLORS as c}
                      <button class:active={editingColumn?.color === c} style="background:{c}" on:click={() => { if(editingColumn) editingColumn.color = c; }}></button>
                    {/each}
                  </div>
                  <button class="news-cfg-save" on:click={() => { if(editingColumn) updateColumn(editingColumn); }}>Save</button>
                  <button class="news-cfg-cancel" on:click={() => editingColumn = null}>Cancel</button>
                {:else}
                  <span class="news-cfg-col-name">{col.name}</span>
                  <span class="news-cfg-col-cnt">{col.feed_ids.length}</span>
                  <button class="news-cfg-btn" on:click={() => editingColumn = {...col}}>Edit</button>
                  <button class="news-cfg-btn news-cfg-btn-del" on:click={() => deleteColumn(col.id)}>×</button>
                {/if}
              </div>
              <div class="news-cfg-feeds">
                {#each allFeeds.filter(f => f.is_active) as feed (feed.id)}
                  <label class="news-cfg-feed">
                    <input type="checkbox" checked={col.feed_ids.includes(feed.id)} on:change={() => toggleFeedInColumn(col.id, feed.id, col.feed_ids)} />
                    <span>{feed.name}</span>
                  </label>
                {/each}
              </div>
            </div>
          {/each}
        {:else}
          <div class="news-feeds-list">
            {#each allFeedsForConfig as feed (feed.id)}
              <div class="news-feed-row">
                <label class="news-feed-toggle">
                  <input type="checkbox" checked={!!feed.is_active} on:change={() => toggleFeedActive(feed)} />
                  <span class="news-feed-slider"></span>
                </label>
                <div class="news-feed-info">
                  <span class="news-feed-name">{feed.name}</span>
                  <span class="news-feed-cat">{feed.category}</span>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- Article Modal -->
{#if selectedArticle}
  <div class="article-modal-bg" on:click|self={closeArticle} on:keydown={(e) => e.key === 'Escape' && closeArticle()} role="presentation">
    <div class="article-modal">
      <div class="article-modal-head">
        <div class="article-modal-source" style="--c: {selectedArticle.feedColor || 'var(--text-3)'}">
          <span class="article-modal-dot"></span>
          {selectedArticle.feedName}
        </div>
        <span class="article-modal-time">{timeAgo(selectedArticle.pubDate)}</span>
        <button class="article-modal-close" on:click={closeArticle}>×</button>
      </div>

      <div class="article-modal-body">
        {#if selectedArticle.imageUrl}
          <img src={selectedArticle.imageUrl} alt="" class="article-modal-img" />
        {/if}

        <h1 class="article-modal-title">{selectedArticle.title}</h1>

        {#if selectedArticle.author}
          <div class="article-modal-author">By {selectedArticle.author}</div>
        {/if}

        <div class="article-modal-content">
          {#if selectedArticle.description}
            <p>{@html sanitizeHtml(selectedArticle.description)}</p>
          {:else}
            <p class="article-modal-no-content">No preview available for this article.</p>
          {/if}
        </div>
      </div>

      <div class="article-modal-footer">
        <a href={selectedArticle.link} target="_blank" rel="noopener" class="article-modal-link">
          Read full article ↗
        </a>
      </div>
    </div>
  </div>
{/if}

<style>
  .news-page {
    display: flex;
    flex-direction: column;
    /* The .full-bleed class in app.css handles the margins */
  }

  .news-loading {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    font-size: 13px;
  }

  .news-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
  }

  .news-empty-icon {
    width: 48px;
    height: 48px;
    border: 2px dashed var(--border-h);
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    color: var(--text-3);
  }

  .news-empty-text {
    color: var(--text-3);
    font-size: 13px;
  }

  .news-empty-btn {
    background: var(--gold);
    border: none;
    border-radius: 6px;
    color: var(--bg);
    font-size: 12px;
    font-weight: 600;
    padding: 8px 16px;
    cursor: pointer;
  }

  /* Grid layouts */
  .news-columns {
    flex: 1;
    display: grid;
    gap: 1px;
    background: var(--border);
    min-height: 0;
  }

  .news-grid-1 { grid-template-columns: 1fr; }
  .news-grid-2 { grid-template-columns: 1fr 1fr; }
  .news-grid-3 { grid-template-columns: 1fr 1fr 1fr; }
  .news-grid-4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .news-grid-5 { grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .news-grid-6 { grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr; }

  @media (max-width: 1000px) {
    .news-grid-3, .news-grid-5, .news-grid-6 { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 700px) {
    .news-columns { grid-template-columns: 1fr !important; grid-template-rows: auto !important; }
  }

  /* Column */
  .news-col {
    background: var(--surface-1);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .news-col-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .news-col-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c);
  }

  .news-col-name {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-1);
    flex: 1;
  }

  .news-col-count {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-3);
    background: var(--surface-3);
    padding: 2px 6px;
    border-radius: 8px;
  }

  .news-col-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .news-col-empty {
    padding: 32px 16px;
    text-align: center;
    color: var(--text-3);
    font-size: 12px;
    line-height: 2;
  }

  .news-col-empty button {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-2);
    font-size: 11px;
    padding: 4px 10px;
    cursor: pointer;
  }

  /* Article item */
  .news-item {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    border: none;
    border-bottom: 1px solid var(--border);
    background: none;
    text-align: left;
    width: 100%;
    cursor: pointer;
    transition: background 0.1s;
    font-family: inherit;
  }

  .news-item:hover {
    background: var(--surface-2);
  }

  .news-item-img {
    width: 56px;
    height: 56px;
    border-radius: 6px;
    background-size: cover;
    background-position: center;
    background-color: var(--surface-3);
    flex-shrink: 0;
  }

  .news-item-img-none {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .news-item-img-none span {
    font-size: 18px;
    font-weight: 700;
    color: var(--c);
    opacity: 0.6;
  }

  .news-item-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .news-item-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-1);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .news-item-desc {
    font-size: 11px;
    color: var(--text-2);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .news-item-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: auto;
  }

  .news-item-source {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--c);
  }

  .news-item-time {
    font-size: 9px;
    font-family: var(--font-mono);
    color: var(--text-3);
  }

  /* FAB buttons */
  .news-fab-group {
    position: fixed;
    bottom: 20px;
    right: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 100;
  }

  .news-fab {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: none;
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    transition: background 0.15s, color 0.15s, transform 0.1s;
  }

  .news-fab:hover {
    background: var(--surface-3);
    color: var(--text-1);
    transform: scale(1.05);
  }

  .news-fab:disabled {
    opacity: 0.5;
  }

  .news-fab-config {
    background: var(--gold);
    color: var(--bg);
  }

  .news-fab-config:hover {
    background: var(--gold);
    opacity: 0.9;
  }

  .news-fab-spin {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--text-1);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* Modal */
  .news-modal-bg {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: rgba(0,0,0,0.7);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .news-modal {
    background: var(--surface-1);
    border: 1px solid var(--border-h);
    border-radius: 10px;
    width: 600px;
    max-width: 95vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }

  .news-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .news-modal-tabs {
    display: flex;
  }

  .news-modal-tabs button {
    padding: 14px 16px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-3);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.1s;
  }

  .news-modal-tabs button:hover { color: var(--text-2); }
  .news-modal-tabs button.active { color: var(--gold); border-bottom-color: var(--gold); }

  .news-modal-close {
    background: none;
    border: none;
    color: var(--text-3);
    font-size: 20px;
    cursor: pointer;
    padding: 8px;
    line-height: 1;
  }

  .news-modal-close:hover { color: var(--text-1); }

  .news-modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  /* Config section */
  .news-cfg-section {
    margin-bottom: 16px;
  }

  .news-cfg-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  .news-cfg-row input[type="text"] {
    flex: 1;
    min-width: 150px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text-1);
    font-size: 13px;
    padding: 8px 10px;
    outline: none;
  }

  .news-cfg-row input:focus { border-color: var(--gold); }

  .news-cfg-colors {
    display: flex;
    gap: 4px;
  }

  .news-cfg-colors button {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
  }

  .news-cfg-colors button.active { border-color: var(--text-1); }

  .news-cfg-colors-sm {
    display: flex;
    gap: 3px;
  }

  .news-cfg-colors-sm button {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
  }

  .news-cfg-colors-sm button.active { border-color: var(--text-1); }

  .news-cfg-add {
    background: var(--gold);
    border: none;
    border-radius: 5px;
    color: var(--bg);
    font-size: 12px;
    font-weight: 600;
    padding: 8px 14px;
    cursor: pointer;
  }

  .news-cfg-add:disabled { opacity: 0.5; }

  /* Column config card */
  .news-cfg-col {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-bottom: 10px;
    overflow: hidden;
  }

  .news-cfg-col-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }

  .news-cfg-col-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .news-cfg-col-name {
    font-size: 13px;
    font-weight: 600;
    flex: 1;
  }

  .news-cfg-col-cnt {
    font-size: 10px;
    color: var(--text-3);
    font-family: var(--font-mono);
  }

  .news-cfg-col-input {
    background: var(--surface-3);
    border: 1px solid var(--border-h);
    border-radius: 4px;
    color: var(--text-1);
    font-size: 12px;
    padding: 4px 8px;
    width: 100px;
  }

  .news-cfg-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-2);
    font-size: 10px;
    padding: 3px 8px;
    cursor: pointer;
  }

  .news-cfg-btn:hover { border-color: var(--border-h); color: var(--text-1); }
  .news-cfg-btn-del:hover { border-color: var(--red); color: var(--red); }

  .news-cfg-save {
    background: var(--gold);
    border: none;
    border-radius: 4px;
    color: var(--bg);
    font-size: 10px;
    font-weight: 600;
    padding: 4px 10px;
    cursor: pointer;
  }

  .news-cfg-cancel {
    background: var(--surface-3);
    border: none;
    border-radius: 4px;
    color: var(--text-2);
    font-size: 10px;
    padding: 4px 10px;
    cursor: pointer;
  }

  .news-cfg-feeds {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 10px;
    max-height: 150px;
    overflow-y: auto;
  }

  .news-cfg-feed {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    background: var(--surface-3);
    border-radius: 12px;
    font-size: 10px;
    cursor: pointer;
  }

  .news-cfg-feed:hover { background: var(--border); }

  .news-cfg-feed input {
    width: 12px;
    height: 12px;
    accent-color: var(--gold);
  }

  .news-cfg-feed span { color: var(--text-1); }

  /* Feeds list */
  .news-feeds-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .news-feed-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 5px;
  }

  .news-feed-toggle {
    position: relative;
    width: 32px;
    height: 18px;
    cursor: pointer;
  }

  .news-feed-toggle input { opacity: 0; width: 0; height: 0; }

  .news-feed-slider {
    position: absolute;
    inset: 0;
    background: var(--surface-3);
    border-radius: 9px;
    transition: background 0.2s;
  }

  .news-feed-slider::before {
    content: '';
    position: absolute;
    width: 14px;
    height: 14px;
    left: 2px;
    top: 2px;
    background: var(--text-3);
    border-radius: 50%;
    transition: transform 0.2s, background 0.2s;
  }

  .news-feed-toggle input:checked + .news-feed-slider { background: rgba(61,214,140,0.2); }
  .news-feed-toggle input:checked + .news-feed-slider::before { transform: translateX(14px); background: var(--green); }

  .news-feed-info { flex: 1; min-width: 0; }

  .news-feed-name {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-1);
    display: block;
  }

  .news-feed-cat {
    font-size: 9px;
    color: var(--text-3);
    font-family: var(--font-mono);
  }

  /* ═══════════════════════════════════════════════════════════════════
     Article Modal
     ═══════════════════════════════════════════════════════════════════ */
  .article-modal-bg {
    position: fixed;
    inset: 0;
    z-index: 600;
    background: rgba(0,0,0,0.8);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .article-modal {
    background: var(--surface-1);
    border: 1px solid var(--border-h);
    border-radius: 12px;
    width: 700px;
    max-width: 100%;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 25px 80px rgba(0,0,0,0.6);
  }

  .article-modal-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .article-modal-source {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--c, var(--text-2));
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .article-modal-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--c, var(--text-3));
  }

  .article-modal-time {
    font-size: 11px;
    color: var(--text-3);
    font-family: var(--font-mono);
    flex: 1;
  }

  .article-modal-close {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-2);
    font-size: 18px;
    cursor: pointer;
    padding: 4px 10px;
    line-height: 1;
    transition: all 0.15s;
  }

  .article-modal-close:hover {
    background: var(--surface-3);
    color: var(--text-1);
  }

  .article-modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
  }

  .article-modal-img {
    width: 100%;
    max-height: 300px;
    object-fit: cover;
    border-radius: 8px;
    margin-bottom: 20px;
  }

  .article-modal-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    color: var(--text-1);
    line-height: 1.3;
    margin: 0 0 12px 0;
  }

  .article-modal-author {
    font-size: 12px;
    color: var(--text-3);
    margin-bottom: 16px;
    font-style: italic;
  }

  .article-modal-content {
    font-size: 14px;
    line-height: 1.7;
    color: var(--text-2);
  }

  .article-modal-content p {
    margin: 0 0 16px 0;
  }

  .article-modal-content p:last-child {
    margin-bottom: 0;
  }

  .article-modal-no-content {
    color: var(--text-3);
    font-style: italic;
  }

  .article-modal-footer {
    padding: 14px 20px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: center;
    flex-shrink: 0;
  }

  .article-modal-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 24px;
    background: var(--gold);
    color: var(--bg);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    border-radius: 6px;
    transition: all 0.15s;
  }

  .article-modal-link:hover {
    background: #e6b855;
    transform: translateY(-1px);
  }
</style>
