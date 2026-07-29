<script lang="ts">
  import { onMount } from 'svelte';
  import { rssRegistry } from '$lib/stores.js';
  import { rpcOrCall } from '$lib/ws.js';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import Empty from '$lib/components/Empty.svelte';

  interface Feed {
    id: string; name: string; slug: string; description: string;
    feed_url: string; website_url: string;
    category_id: string | null; category_name: string | null; category_icon: string | null;
    language: string; country: string;
    update_frequency: 'realtime' | 'hourly' | 'daily' | 'weekly';
    status: 'active' | 'disabled' | 'error' | 'dead';
    last_check_at: string | null; last_check_ok: number | null;
    last_item_at: string | null;
    item_count: number; error_count: number; error_message: string;
    quality_score: number; tags: string;
  }
  interface Cat { id: string; name: string; icon: string; }

  let feeds: Feed[] = [];
  let cats: Cat[] = [];
  let stats: any = {};
  let search = '';
  let selectedCat = '';
  let selectedStatus: '' | 'active' | 'disabled' | 'error' | 'dead' = '';
  let togglingId: string | null = null;
  let testingId: string | null = null;
  let refreshing = false;
  let testResults: Record<string, { valid: boolean; msg: string; color: string }> = {};

  // Add-feed modal state
  let showAddModal = false;
  let addUrl = '';
  let addPreview: { ok: boolean; title: string; items: any[]; error?: string } | null = null;
  let addPreviewing = false;
  let addCategory = '';
  let addLang = 'en';
  let addFreq: 'hourly' | 'daily' | 'weekly' | 'realtime' = 'hourly';

  $: activeCount = feeds.filter(f => f.status === 'active').length;
  $: errorCount = feeds.filter(f => f.status === 'error' || f.status === 'dead').length;
  $: langs = (() => {
    const s = new Set<string>();
    feeds.forEach(f => { if (f.language) s.add(f.language); });
    return Array.from(s).sort();
  })();

  $: filtered = feeds.filter(f => {
    const q = search.toLowerCase();
    const mq = !q || f.name.toLowerCase().includes(q) ||
               f.description.toLowerCase().includes(q) ||
               (f.tags ?? '').toLowerCase().includes(q);
    const mc = !selectedCat || f.category_id === selectedCat;
    const ms = !selectedStatus || f.status === selectedStatus;
    return mq && mc && ms;
  });

  async function load() {
    try {
      const res = await fetch('/api/registry/rss');
      const data = await res.json();
      feeds = data.feeds ?? [];
      cats = data.categories ?? [];
      stats = data.stats ?? {};
      rssRegistry.set(data);
    } catch (err) {
      console.warn('RSS registry load failed', err);
    }
  }

  async function toggleFeed(feed: Feed) {
    togglingId = feed.id;
    try {
      const d = await rpcOrCall('registry.rss.toggle', { id: feed.id }, async () => {
        const r = await fetch(`/api/registry/rss/${feed.id}/toggle`, { method: 'POST' });
        return r.json();
      });
      if (d.feed) {
        feed.status = d.feed.status;
        feeds = [...feeds];
      }
    } catch (e: any) {
      alert('Toggle failed: ' + e.message);
    } finally {
      togglingId = null;
    }
  }

  async function testFeed(feed: Feed) {
    testingId = feed.id;
    testResults[feed.id] = { valid: false, msg: '…', color: 'var(--text-2)' };
    testResults = { ...testResults };
    try {
      const d = await rpcOrCall('registry.rss.test', { id: feed.id }, async () => {
        const r = await fetch(`/api/registry/rss/${feed.id}/test`, { method: 'POST' });
        return r.json();
      });
      if (d.valid) {
        testResults[feed.id] = { valid: true, msg: `${d.item_count ?? 0} items · ${d.response_time_ms}ms`, color: 'var(--green)' };
      } else {
        testResults[feed.id] = { valid: false, msg: d.error ?? 'failed', color: 'var(--red)' };
      }
    } catch {
      testResults[feed.id] = { valid: false, msg: 'error', color: 'var(--red)' };
    } finally {
      testingId = null;
      testResults = { ...testResults };
      setTimeout(() => { delete testResults[feed.id]; testResults = { ...testResults }; }, 5000);
    }
  }

  async function refreshFeed(feed: Feed) {
    try {
      await fetch(`/api/registry/rss/${feed.id}/refresh`, { method: 'POST' });
      await load();
    } catch (err) {
      alert('Refresh failed');
    }
  }

  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try {
      await fetch('/api/registry/rss/refresh', { method: 'POST' });
      await load();
    } finally {
      refreshing = false;
    }
  }

  async function deleteFeed(feed: Feed) {
    if (!confirm(`Delete feed "${feed.name}"? Items will be removed too.`)) return;
    try {
      await fetch(`/api/registry/rss/${feed.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      alert('Delete failed');
    }
  }

  // ── Add feed flow ──
  async function previewAddUrl() {
    if (!addUrl.trim()) return;
    addPreviewing = true;
    addPreview = null;
    try {
      const url = `/api/registry/rss/preview?url=${encodeURIComponent(addUrl.trim())}`;
      const r = await fetch(url);
      addPreview = await r.json();
    } catch (err: any) {
      addPreview = { ok: false, title: '', items: [], error: err.message ?? 'failed' };
    } finally {
      addPreviewing = false;
    }
  }

  async function commitAdd() {
    if (!addPreview?.ok) return;
    try {
      const r = await fetch('/api/registry/rss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addPreview.title || addUrl,
          feed_url: addUrl.trim(),
          category_id: addCategory || null,
          language: addLang,
          update_frequency: addFreq,
          quality_score: 60,
        }),
      });
      const d = await r.json();
      if (d.feed) {
        showAddModal = false;
        addUrl = ''; addPreview = null; addCategory = '';
        await load();
      } else {
        alert('Add failed: ' + (d.error ?? 'unknown'));
      }
    } catch (err: any) {
      alert('Add failed: ' + err.message);
    }
  }

  function statusColor(s: string): string {
    return s === 'active' ? 'var(--green)' :
           s === 'disabled' ? 'var(--text-3)' :
           s === 'error' ? 'var(--orange)' :
           s === 'dead' ? 'var(--red)' : 'var(--text-2)';
  }
  function timeAgo(iso: string | null): string {
    if (!iso) return 'never';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  onMount(load);
</script>

<ViewHeader title="RSS Sources" sub="Feed catalog · health · ingestion" />

<div class="kpi-row anim">
  <KpiCard label="Sources" value={stats.total_feeds ?? feeds.length} sub="feeds tracked" accent="--gold" color="var(--gold)" />
  <KpiCard label="Active" value={stats.active_feeds ?? activeCount} sub="enabled" accent="--green" color="var(--green)" />
  <KpiCard label="With errors" value={stats.error_feeds ?? errorCount} sub="need attention" accent="--orange" color="var(--orange)" />
  <KpiCard label="Items stored" value={stats.total_items ?? 0} sub="across all feeds" accent="--purple" color="var(--purple)" />
  <KpiCard label="Last 24h" value={stats.items_last_24h ?? 0} sub="new items" accent="--teal" color="var(--teal)" />
</div>

<Panel cls="anim" style="padding:12px;margin-bottom:16px">
  <div class="toolbar">
    <input class="search-input" type="text" placeholder="Search feeds…" bind:value={search} />
    <select class="search-input" bind:value={selectedCat}>
      <option value="">All categories</option>
      {#each cats as c}
        <option value={c.id}>{c.icon} {c.name}</option>
      {/each}
    </select>
    <select class="search-input" bind:value={selectedStatus}>
      <option value="">All statuses</option>
      <option value="active">Active</option>
      <option value="disabled">Disabled</option>
      <option value="error">Error</option>
      <option value="dead">Dead</option>
    </select>
    <button class="btn-primary" on:click={refreshAll} disabled={refreshing}>
      {refreshing ? 'Refreshing…' : '↻ Refresh all'}
    </button>
    <button class="btn-add" on:click={() => showAddModal = true}>+ Add feed</button>
  </div>
</Panel>

<Panel cls="anim" title="Feeds ({filtered.length})" dotColor="var(--gold)">
  {#if filtered.length === 0}
    <Empty message="No feeds match the filters." />
  {:else}
    <div class="feeds-table">
      <div class="th">
        <span>Source</span>
        <span class="num">Quality</span>
        <span>Status</span>
        <span>Last fetch</span>
        <span>Items</span>
        <span class="actions-col">Actions</span>
      </div>
      {#each filtered as feed (feed.id)}
        <div class="tr" class:err={feed.status === 'error' || feed.status === 'dead'}>
          <div class="src">
            <div class="src-line1">
              <span class="src-name">{feed.name}</span>
              {#if feed.language}<span class="lang">{feed.language.toUpperCase()}</span>{/if}
              {#if feed.category_name}
                <span class="cat-tag">{feed.category_icon ?? ''} {feed.category_name}</span>
              {/if}
            </div>
            <div class="src-line2">
              <a class="src-url" href={feed.feed_url} target="_blank" rel="noopener">{feed.feed_url}</a>
              {#if feed.error_message}
                <span class="err-msg" title={feed.error_message}>⚠ {feed.error_message.slice(0, 60)}</span>
              {/if}
            </div>
          </div>
          <div class="num quality">
            <div class="quality-bar"><div class="quality-fill" style="width:{feed.quality_score}%; background:{feed.quality_score >= 80 ? 'var(--green)' : feed.quality_score >= 60 ? 'var(--gold)' : 'var(--orange)'}"></div></div>
            <span class="quality-num">{feed.quality_score}</span>
          </div>
          <div>
            <button class="status-pill" style="--c:{statusColor(feed.status)}"
                    disabled={togglingId === feed.id}
                    on:click={() => toggleFeed(feed)}>
              {togglingId === feed.id ? '…' : feed.status}
            </button>
          </div>
          <div class="muted">{timeAgo(feed.last_check_at)}</div>
          <div class="muted">{feed.item_count}</div>
          <div class="actions">
            <button class="action-btn"
                    style="color:{testResults[feed.id]?.color ?? 'var(--text-2)'}"
                    disabled={testingId === feed.id}
                    on:click={() => testFeed(feed)}>
              {testResults[feed.id]?.msg ?? 'Test'}
            </button>
            <button class="action-btn" on:click={() => refreshFeed(feed)} title="Fetch now">↻</button>
            <button class="action-btn danger" on:click={() => deleteFeed(feed)} title="Delete">×</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</Panel>

<!-- ── Add feed modal ── -->
{#if showAddModal}
  <div class="modal-backdrop" role="presentation" on:click={() => showAddModal = false}></div>
  <div class="modal" role="dialog" aria-modal="true">
    <div class="modal-head">
      <h2>Add RSS feed</h2>
      <button class="x" on:click={() => showAddModal = false}>×</button>
    </div>

    <label class="field">
      <span>Feed URL</span>
      <div class="row-input">
        <input class="search-input" type="text"
               placeholder="https://example.com/feed.xml"
               bind:value={addUrl}
               on:keydown={(e) => e.key === 'Enter' && previewAddUrl()} />
        <button class="btn-primary" on:click={previewAddUrl} disabled={addPreviewing || !addUrl.trim()}>
          {addPreviewing ? '…' : 'Preview'}
        </button>
      </div>
    </label>

    {#if addPreview}
      {#if !addPreview.ok}
        <div class="preview err">⚠ {addPreview.error ?? 'invalid feed'}</div>
      {:else}
        <div class="preview ok">
          <div class="preview-title">✓ {addPreview.title || 'Untitled feed'}</div>
          <div class="preview-sub">{addPreview.items.length} items found</div>
          <div class="preview-list">
            {#each addPreview.items.slice(0, 5) as it}
              <div class="preview-item">{it.title || '(untitled)'}</div>
            {/each}
          </div>

          <div class="form-grid">
            <label class="field">
              <span>Category</span>
              <select class="search-input" bind:value={addCategory}>
                <option value="">—</option>
                {#each cats as c}
                  <option value={c.id}>{c.icon} {c.name}</option>
                {/each}
              </select>
            </label>
            <label class="field">
              <span>Language</span>
              <input class="search-input" type="text" maxlength="2" bind:value={addLang} />
            </label>
            <label class="field">
              <span>Update frequency</span>
              <select class="search-input" bind:value={addFreq}>
                <option value="realtime">Realtime</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
          </div>

          <div class="modal-actions">
            <button class="btn-ghost" on:click={() => showAddModal = false}>Cancel</button>
            <button class="btn-primary" on:click={commitAdd}>Add feed</button>
          </div>
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .toolbar .search-input { flex: 1; min-width: 180px; }
  .toolbar select.search-input { min-width: 130px; flex: 0 0 auto; }
  .btn-primary {
    background: linear-gradient(135deg, var(--gold), #C99840);
    color: #1a1410; border: none; padding: 8px 14px; border-radius: 8px;
    font-weight: 700; font-size: 12px; cursor: pointer;
  }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-primary:disabled { opacity: .5; cursor: wait; }
  .btn-add {
    background: transparent; border: 1px solid var(--gold);
    color: var(--gold); padding: 8px 14px; border-radius: 8px;
    font-weight: 700; font-size: 12px; cursor: pointer;
  }
  .btn-add:hover { background: rgba(212,168,75,.10); }
  .btn-ghost {
    background: transparent; border: 1px solid var(--border);
    color: var(--text-2); padding: 8px 14px; border-radius: 8px;
    font-size: 12px; cursor: pointer;
  }
  .btn-ghost:hover { border-color: var(--border-h); color: var(--text-1); }

  .feeds-table { display: grid; grid-template-columns: minmax(0,1fr) 130px 90px 100px 60px 200px; gap: 0; margin-top: 12px; }
  .th, .tr {
    display: contents;
  }
  .th > span {
    padding: 8px 10px;
    font-size: 10px; text-transform: uppercase; letter-spacing: .5px;
    color: var(--text-3); font-weight: 700;
    border-bottom: 1px solid var(--border);
  }
  .th .num { text-align: left; }
  .th .actions-col { text-align: right; }

  .tr > * {
    padding: 12px 10px;
    border-bottom: 1px solid var(--border);
    align-self: center;
    font-size: 12.5px;
  }
  .tr.err > * { background: rgba(240,136,62,.04); }
  .tr:hover > * { background: var(--surface-2); }

  .src-line1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .src-name { font-weight: 600; color: var(--text-1); }
  .lang { font-family: var(--font-mono); font-size: 9px; padding: 1px 5px; border-radius: 4px; background: var(--surface-3); color: var(--text-2); }
  .cat-tag { font-size: 11px; color: var(--text-3); }
  .src-line2 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11px; }
  .src-url { color: var(--text-3); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 360px; }
  .src-url:hover { color: var(--gold); }
  .err-msg { color: var(--orange); font-size: 11px; }

  .quality { display: flex; align-items: center; gap: 8px; }
  .quality-bar { flex: 1; height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
  .quality-fill { height: 100%; transition: width .3s; }
  .quality-num { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); width: 24px; text-align: right; }

  .status-pill {
    background: rgba(255,255,255,.04);
    color: var(--c, var(--text-2));
    border: 1px solid var(--c, var(--border));
    padding: 3px 10px; border-radius: 12px;
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    cursor: pointer; transition: all .15s;
  }
  .status-pill:hover { filter: brightness(1.2); }

  .muted { color: var(--text-3); font-family: var(--font-mono); font-size: 11px; }

  .actions { display: flex; justify-content: flex-end; gap: 4px; }
  .action-btn {
    background: transparent; border: 1px solid var(--border);
    color: var(--text-2); padding: 4px 10px; border-radius: 6px;
    font-size: 11px; cursor: pointer; transition: all .15s;
    min-width: 44px;
  }
  .action-btn:hover { border-color: var(--border-h); color: var(--text-1); }
  .action-btn.danger:hover { border-color: var(--red); color: var(--red); }
  .action-btn:disabled { opacity: .6; cursor: wait; }

  /* Modal */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,.65); backdrop-filter: blur(3px);
    z-index: 999;
  }
  .modal {
    position: fixed; top: 8%; left: 50%; transform: translateX(-50%);
    width: min(640px, calc(100vw - 32px));
    max-height: 84vh; overflow-y: auto;
    background: var(--surface-1); border: 1px solid var(--border-h);
    border-radius: 14px; padding: 24px;
    z-index: 1000;
    box-shadow: 0 20px 60px rgba(0,0,0,.6);
    animation: modalIn .2s ease;
  }
  @keyframes modalIn { from { opacity: 0; transform: translate(-50%, 12px); } to { opacity: 1; transform: translate(-50%, 0); } }

  .modal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .modal-head h2 { font-family: var(--font-display); font-size: 20px; font-weight: 700; }
  .x { background: transparent; border: none; color: var(--text-3); font-size: 22px; cursor: pointer; line-height: 1; }
  .x:hover { color: var(--text-1); }

  .field { display: block; margin-bottom: 14px; }
  .field span { display: block; font-size: 11px; text-transform: uppercase; color: var(--text-3); margin-bottom: 6px; font-weight: 600; letter-spacing: .4px; }
  .row-input { display: flex; gap: 8px; }
  .row-input .search-input { flex: 1; }

  .preview { padding: 14px; border-radius: 10px; margin-top: 12px; }
  .preview.err { background: rgba(240,71,112,.08); border: 1px solid rgba(240,71,112,.3); color: var(--red); }
  .preview.ok { background: rgba(61,214,140,.05); border: 1px solid rgba(61,214,140,.25); }
  .preview-title { font-weight: 700; font-size: 14px; margin-bottom: 4px; color: var(--text-1); }
  .preview-sub { color: var(--text-3); font-size: 12px; margin-bottom: 10px; }
  .preview-list { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; }
  .preview-item { font-size: 12px; color: var(--text-2); padding: 4px 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .form-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top: 14px; }
  .form-grid .field { margin-bottom: 0; }

  .modal-actions { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }
</style>
