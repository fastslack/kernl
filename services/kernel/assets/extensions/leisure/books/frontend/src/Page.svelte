<script lang="ts">
  import { onMount } from 'svelte';
  import type { ExtPageContext } from './types.js';

  /** Host-provided context — auth-aware fetch, locale, navigation. */
  export let ctx: ExtPageContext;

  // ── Types ──────────────────────────────────────────────────────────
  interface BookItem {
    identifier: string;
    title: string;
    creator: string;
    year: number | null;
    description: string;
    language: string;
    subject: string[];
    downloads: number;
    cover_url: string;
    read_url: string;
    in_watchlist?: boolean;
    read_progress?: number;
  }

  interface BookFile {
    name: string;
    format: string;
    size: number;
    url: string;
  }

  interface BookDetails {
    identifier: string;
    title: string;
    creator: string;
    year: number | null;
    description: string;
    language: string;
    subject: string[];
    files: BookFile[];
    primary_file: BookFile | null;
  }

  // ── Search state ──────────────────────────────────────────────────
  let query = '';
  let language: 'any' | 'eng' | 'spa' | 'fre' | 'ger' | 'ita' | 'por' | 'rus' | 'jpn' | 'chi' = 'any';
  let sortMode: 'downloads' | 'year_desc' | 'year_asc' | 'date_added' = 'downloads';
  let page = 1;
  let total = 0;
  let items: BookItem[] = [];
  let busy = false;
  let err = '';
  let mode: 'search' | 'watchlist' = 'search';
  let watchlistItems: BookItem[] = [];

  // archive.org uses MARC 3-letter codes for language; map for the dropdown.
  const LANG_NAME: Record<string, string> = {
    eng: 'English', spa: 'Español', fre: 'Français', ger: 'Deutsch',
    ita: 'Italiano', por: 'Português', rus: 'Русский', jpn: '日本語', chi: '中文',
  };

  async function runSearch(): Promise<void> {
    if (busy) return;
    busy = true; err = '';
    try {
      const params = new URLSearchParams({
        q: query.trim(),
        sort: sortMode,
        page: String(page),
        limit: '24',
      });
      if (language !== 'any') params.set('language', language);
      const json = await ctx.fetchJson(`/api/books/search?${params.toString()}`);
      items = json?.items ?? [];
      total = json?.total ?? 0;
    } catch (e: any) {
      err = e?.message ?? String(e);
      items = [];
    } finally {
      busy = false;
    }
  }

  async function loadWatchlist(): Promise<void> {
    try {
      const j = await ctx.fetchJson('/api/books/watchlist');
      watchlistItems = j?.items ?? [];
    } catch { /* */ }
  }

  async function toggleWatchlist(b: BookItem): Promise<void> {
    try {
      if (b.in_watchlist) {
        await ctx.fetchJson(`/api/books/watchlist?id=${encodeURIComponent(b.identifier)}`, { method: 'DELETE' });
        b.in_watchlist = false;
      } else {
        await ctx.fetchJson('/api/books/watchlist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            identifier: b.identifier, title: b.title, creator: b.creator,
            year: b.year, cover_url: b.cover_url,
          }),
        });
        b.in_watchlist = true;
      }
    } catch { /* toggle failed — leave state as-is */ }
    items = items;            // force reactivity
    await loadWatchlist();
  }

  function nextPage(): void { page++; runSearch(); window.scrollTo(0, 0); }
  function prevPage(): void { if (page > 1) { page--; runSearch(); window.scrollTo(0, 0); } }
  function onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') { page = 1; runSearch(); }
  }

  // ── Reader modal ──────────────────────────────────────────────────
  let readerOpen = false;
  let readerLoading = false;
  let readerErr = '';
  let readerBook: BookDetails | null = null;
  let readerActiveFile: BookFile | null = null;

  // Cover failed to load → fade it. Inline `(e.target as HTMLImageElement)`
  // in the template trips Svelte's parser; lifting it to a function dodges
  // that.
  function onBookCoverError(e: Event): void {
    const img = e.target as HTMLImageElement | null;
    if (img) img.style.opacity = '0.2';
  }

  async function openReader(b: BookItem): Promise<void> {
    readerOpen = true;
    readerLoading = true;
    readerErr = '';
    readerBook = null;
    readerActiveFile = null;
    try {
      readerBook = await ctx.fetchJson(`/api/books/details?id=${encodeURIComponent(b.identifier)}`);
      readerActiveFile = readerBook?.primary_file ?? null;
    } catch (e: any) {
      readerErr = e?.message ?? String(e);
    } finally {
      readerLoading = false;
    }
  }

  function closeReader(): void {
    readerOpen = false;
    readerBook = null;
    readerActiveFile = null;
  }

  function pickReaderFile(f: BookFile): void { readerActiveFile = f; }

  function fmtBytes(n: number): string {
    if (!n) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && readerOpen) closeReader();
  }

  onMount(() => {
    runSearch();
    loadWatchlist();
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  });

  $: shown = mode === 'search' ? items : watchlistItems;
</script>

<div class="page">
  <!-- ── Header ── -->
  <header class="hero">
    <div class="hero-text">
      <div class="hero-kicker">archive.org / mediatype:texts</div>
      <h1 class="hero-title">Books</h1>
      <p class="hero-sub">
        Browse and read public-domain books from <a href="https://archive.org/details/booksbylanguage" target="_blank" rel="noopener">archive.org</a>.
        Search by title, author, or subject. Click any cover to read in-browser.
      </p>
    </div>
    <div class="hero-stats">
      <div class="stat"><span class="stat-num">{total.toLocaleString()}</span><span class="stat-lbl">results</span></div>
      <div class="stat"><span class="stat-num">{watchlistItems.length}</span><span class="stat-lbl">saved</span></div>
    </div>
  </header>

  <!-- ── Mode tabs ── -->
  <div class="mode-bar">
    <button class="mode-btn" class:on={mode === 'search'} on:click={() => mode = 'search'}>🔍 Search</button>
    <button class="mode-btn" class:on={mode === 'watchlist'} on:click={() => { mode = 'watchlist'; loadWatchlist(); }}>
      📚 My Watchlist <span class="badge">{watchlistItems.length}</span>
    </button>
  </div>

  {#if mode === 'search'}
    <!-- ── Search controls ── -->
    <div class="ctrls">
      <input
        class="search-input"
        type="text"
        placeholder="Search books, authors, subjects…"
        bind:value={query}
        on:keydown={onSearchKey}
      />
      <select class="select" bind:value={language} on:change={() => { page = 1; runSearch(); }}>
        <option value="any">All languages</option>
        {#each Object.entries(LANG_NAME) as [code, name]}
          <option value={code}>{name}</option>
        {/each}
      </select>
      <select class="select" bind:value={sortMode} on:change={() => { page = 1; runSearch(); }}>
        <option value="downloads">Most downloaded</option>
        <option value="date_added">Recently added</option>
        <option value="year_desc">Newest year</option>
        <option value="year_asc">Oldest year</option>
      </select>
      <button class="primary" disabled={busy} on:click={() => { page = 1; runSearch(); }}>
        {busy ? '…' : 'Search'}
      </button>
    </div>
  {/if}

  <!-- ── Grid ── -->
  {#if err}
    <div class="err">⚠ {err}</div>
  {:else if busy && shown.length === 0}
    <div class="loading">▮ loading…</div>
  {:else if shown.length === 0}
    <div class="empty">
      {#if mode === 'watchlist'}
        Your watchlist is empty. Search for books and click ⭐ to save them here.
      {:else}
        No results. Try a different search.
      {/if}
    </div>
  {:else}
    <div class="grid">
      {#each shown as b (b.identifier)}
        <article class="card">
          <button class="cover" on:click={() => openReader(b)} title="Read">
            <img src={b.cover_url} alt={b.title} loading="lazy" on:error={onBookCoverError} />
          </button>
          <div class="card-body">
            <h3 class="card-title" title={b.title}>{b.title}</h3>
            {#if b.creator}<div class="card-author">{b.creator}</div>{/if}
            <div class="card-meta">
              {#if b.year}<span>{b.year}</span>{/if}
              {#if b.downloads > 0}<span class="dl">↓ {b.downloads.toLocaleString()}</span>{/if}
              {#if b.language}<span class="lang">{b.language}</span>{/if}
            </div>
            <div class="card-actions">
              <button class="ghost" on:click={() => openReader(b)}>📖 Read</button>
              <button class="ghost star" class:on={b.in_watchlist} on:click={() => toggleWatchlist(b)}>
                {b.in_watchlist ? '⭐' : '☆'}
              </button>
            </div>
          </div>
        </article>
      {/each}
    </div>

    {#if mode === 'search' && total > 24}
      <div class="pager">
        <button class="ghost" disabled={page === 1 || busy} on:click={prevPage}>← prev</button>
        <span class="page-info">page {page} of {Math.ceil(total / 24)}</span>
        <button class="ghost" disabled={page >= Math.ceil(total / 24) || busy} on:click={nextPage}>next →</button>
      </div>
    {/if}
  {/if}
</div>

<!-- ── Reader modal ── -->
{#if readerOpen}
  <div class="reader-back" on:click|self={closeReader} role="presentation">
    <div class="reader-modal" role="dialog">
      <header class="reader-head">
        {#if readerBook}
          <span class="reader-title" title={readerBook.title}>{readerBook.title}</span>
          {#if readerBook.creator}<span class="dim">— {readerBook.creator}</span>{/if}
          {#if readerBook.year}<span class="badge">{readerBook.year}</span>{/if}
        {:else}
          <span class="reader-title dim">loading…</span>
        {/if}
        <span class="spacer" />
        {#if readerBook}
          <a class="ghost sm" href={`https://archive.org/details/${readerBook.identifier}`} target="_blank" rel="noopener">archive.org ↗</a>
        {/if}
        <button class="ghost sm" on:click={closeReader}>× close</button>
      </header>

      <div class="reader-body">
        {#if readerLoading}
          <div class="reader-msg loading">▮ loading metadata…</div>
        {:else if readerErr}
          <div class="reader-msg err">⚠ {readerErr}</div>
        {:else if readerBook && readerActiveFile}
          <!-- File picker (for items with multiple formats) -->
          {#if readerBook.files.length > 1}
            <div class="file-picker">
              {#each readerBook.files as f}
                <button class="ghost sm" class:on={readerActiveFile && f.name === readerActiveFile.name} on:click={() => pickReaderFile(f)}>
                  {f.format} <span class="dim mini">{fmtBytes(f.size)}</span>
                </button>
              {/each}
            </div>
          {/if}
          <!-- The reader: PDF/EPUB go through archive.org's BookReader iframe;
               plain text we surface as a download link. -->
          {#if /pdf|epub|html/i.test(readerActiveFile.format)}
            <iframe
              class="reader-frame"
              src={`https://archive.org/embed/${readerBook.identifier}`}
              title={readerBook.title}
              allowfullscreen
            ></iframe>
          {:else}
            <div class="reader-fallback">
              <p>Browser preview not available for {readerActiveFile.format}.</p>
              <a class="primary" href={readerActiveFile.url} target="_blank" rel="noopener">Download {readerActiveFile.format}</a>
            </div>
          {/if}
        {:else if readerBook}
          <div class="reader-msg">no readable file in this item.</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .page {
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 32px 60px;
    /* /books is in FULL_BLEED_VIEWS, which clamps the route container to
       overflow:hidden. Re-enable vertical scroll on the inner page so
       grid contents past the viewport are reachable. */
    height: 100%;
    overflow-y: auto;
  }

  /* ── Hero ── */
  .hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 32px;
    padding: 24px 0 28px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 22px;
  }
  .hero-text { flex: 1; min-width: 0; }
  .hero-kicker {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 6px;
  }
  .hero-title {
    font-family: var(--font-display);
    font-size: 42px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0 0 8px;
    color: var(--text-1);
  }
  .hero-sub {
    color: var(--text-2);
    line-height: 1.55;
    max-width: 600px;
    margin: 0;
  }
  .hero-sub a { color: var(--teal); text-decoration: none; border-bottom: 1px dashed currentColor; }
  .hero-stats { display: flex; gap: 18px; flex-shrink: 0; }
  .stat {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding: 12px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    min-width: 96px;
  }
  .stat-num {
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: -0.01em;
  }
  .stat-lbl {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-3);
    margin-top: 2px;
  }

  /* ── Mode tabs ── */
  .mode-bar {
    display: flex;
    gap: 4px;
    margin-bottom: 18px;
    border-bottom: 1px solid var(--border);
  }
  .mode-btn {
    background: transparent;
    border: 0;
    padding: 10px 18px;
    color: var(--text-2);
    font: inherit;
    font-family: var(--font-display);
    font-weight: 500;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 120ms;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .mode-btn:hover { color: var(--text-1); }
  .mode-btn.on {
    color: var(--text-1);
    border-bottom-color: var(--teal);
  }
  .badge {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 1px 7px;
    background: var(--surface-3);
    border-radius: 10px;
    color: var(--text-2);
  }

  /* ── Search controls ── */
  .ctrls {
    display: flex;
    gap: 10px;
    margin-bottom: 22px;
    flex-wrap: wrap;
  }
  .search-input {
    flex: 1;
    min-width: 240px;
    padding: 11px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font: inherit;
    font-size: 14px;
    transition: border-color 120ms;
  }
  .search-input:focus {
    outline: none;
    border-color: var(--teal);
  }
  .select {
    padding: 11px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .primary {
    padding: 11px 22px;
    background: var(--teal);
    color: #001;
    border: 0;
    border-radius: var(--radius-sm);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: filter 120ms;
  }
  .primary:hover:not(:disabled) { filter: brightness(1.1); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Grid + cards ── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 22px;
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: border-color 120ms, transform 160ms;
  }
  .card:hover {
    border-color: var(--border-h);
    transform: translateY(-2px);
  }
  .cover {
    background: var(--surface-3);
    border: 0;
    padding: 0;
    cursor: pointer;
    aspect-ratio: 2 / 3;
    overflow: hidden;
    position: relative;
  }
  .cover img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
    transition: opacity 200ms, transform 220ms;
  }
  .cover:hover img { transform: scale(1.04); }
  .card-body {
    padding: 12px 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
  }
  .card-title {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-1);
    margin: 0;
    line-height: 1.3;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .card-author {
    font-size: 12px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-meta {
    display: flex;
    gap: 8px;
    align-items: center;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-3);
    margin-top: 4px;
    flex-wrap: wrap;
  }
  .card-meta .dl { color: var(--green); }
  .card-meta .lang {
    background: var(--surface-3);
    padding: 1px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .card-actions {
    display: flex;
    gap: 6px;
    margin-top: auto;
    padding-top: 8px;
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: all 120ms;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .ghost:hover {
    color: var(--text-1);
    border-color: var(--border-h);
    background: var(--surface-2);
  }
  .ghost.sm { padding: 4px 9px; font-size: 11px; }
  .ghost.star { padding: 6px 10px; }
  .ghost.star.on { color: var(--gold); border-color: var(--gold); background: color-mix(in srgb, var(--gold) 10%, transparent); }
  .card-actions .ghost:first-child { flex: 1; justify-content: center; }

  /* ── Pager / states ── */
  .pager {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 14px;
    margin-top: 32px;
  }
  .page-info {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-2);
  }
  .err, .loading, .empty {
    padding: 60px 20px;
    text-align: center;
    color: var(--text-2);
    font-size: 14px;
  }
  .err { color: var(--red); }
  .loading { color: var(--teal); }

  /* ── Reader modal ── */
  .reader-back {
    position: fixed;
    inset: 0;
    background: rgba(7, 8, 12, 0.85);
    backdrop-filter: blur(8px);
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 20px;
  }
  .reader-modal {
    width: min(1200px, 100%);
    height: min(900px, 92vh);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 80px rgba(0,0,0,0.6);
  }
  .reader-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
  }
  .reader-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 600;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dim { color: var(--text-3); font-size: 13px; }
  .spacer { flex: 1; }
  .reader-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: #000;
    min-height: 0;
  }
  .file-picker {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .file-picker .ghost.on {
    background: var(--surface-3);
    color: var(--text-1);
    border-color: var(--teal);
  }
  .reader-frame {
    flex: 1;
    width: 100%;
    border: 0;
    background: #000;
  }
  .reader-fallback {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;
    justify-content: center;
    color: var(--text-2);
    text-align: center;
    padding: 40px;
  }
  .reader-msg {
    flex: 1;
    display: grid;
    place-items: center;
    color: var(--text-2);
  }
  .reader-msg.loading { color: var(--teal); }
  .reader-msg.err { color: var(--red); }
  .mini { font-size: 10px; opacity: 0.7; }
</style>
