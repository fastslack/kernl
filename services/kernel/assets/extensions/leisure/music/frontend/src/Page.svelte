<script lang="ts">
  /**
   * /music — archive.org audio browser (extension page bundle).
   *
   * Playback lives in the SHELL's global music player (mounted in the
   * dashboard root layout so it survives navigation). This page lists
   * items and drives the player over the `kernl:music:*` event bus:
   *   - emit  "music:play"      { album, startIndex } after fetching
   *           /api/music/details itself (the shell stays generic)
   *   - emit  "music:state:get" on mount to sync the "Now playing" ring
   *   - on    "music:state"     to highlight the currently loaded album
   *   - on    "navigate"        to pick up ?creator= deep-links from the
   *           persistent player (same-view URL changes don't remount).
   *
   * Filtering: tag chips (subject-derived from the cached search index),
   * tag autocomplete, year-min/year-max inputs, and full-text query.
   */
  import { onMount, onDestroy } from 'svelte';
  import type { ExtPageContext } from './types.js';

  /** Host-provided context — auth-aware fetch, events bus, navigation. */
  export let ctx: ExtPageContext;

  type FormatKind = 'vinyl_78' | 'vinyl_lp' | 'netlabel' | 'live' | 'radio' | 'audiobook' | 'audio';

  interface MusicItem {
    identifier: string;
    title: string;
    creator: string;
    year: number | null;
    description: string;
    language: string;
    subject: string[];
    collection: string[];
    downloads: number;
    cover_url: string;
    details_url: string;
    format_kind: FormatKind;
    in_library?: boolean;
  }

  interface LibraryEntry {
    identifier: string;
    title: string;
    creator: string;
    year: number | null;
    cover_url: string;
    format_kind: FormatKind;
    collection: string;
    added_at: string;
    play_count: number;
    last_played_at: string | null;
    last_position: number;
  }

  interface MusicTag { tag_norm: string; tag_display: string; count: number; rank: number; }

  // ── State ───────────────────────────────────────────────────────
  // Kind chips were removed (Vinyl 78 / LP / Netlabels / Live / Radio /
  // Audiobooks): they were coarse, format-jargon-heavy, and the subject-tag
  // search makes them redundant. The backend still accepts ?kind= for
  // power-user URLs but the UI doesn't surface it.
  let query = '';
  let kind: FormatKind | 'any' = 'any';
  let sortMode: 'downloads' | 'year_desc' | 'year_asc' | 'date_added' | 'title_asc' = 'downloads';
  let yearMin: number | null = null;
  let yearMax: number | null = null;
  let activeTags: string[] = [];
  let tagsMatch: 'all' | 'any' = 'all';
  /**
   * Active creator/uploader filter. Driven by clicking a creator on a
   * card (or by the persistent player navigating here with ?creator=).
   * Reflected to the URL so the filter survives a refresh + can be
   * shared as a link.
   */
  let activeCreator = '';
  let curPage = 1;
  let total = 0;
  let items: MusicItem[] = [];
  let busy = false;
  let err = '';
  let mode: 'search' | 'library' = 'search';
  let libraryItems: LibraryEntry[] = [];

  // ── Global player bridge ────────────────────────────────────────
  /** Identifier of the album loaded in the shell player (or null). */
  let nowPlayingId: string | null = null;
  const offState = ctx.events.on('music:state', (d: { identifier?: string | null }) => {
    nowPlayingId = d?.identifier ?? null;
  });

  /** Identifier currently being materialized for playback (busy state). */
  let playPending = '';
  async function playAlbum(identifier: string): Promise<void> {
    if (playPending) return;
    playPending = identifier;
    err = '';
    try {
      const album = await ctx.fetchJson(`/api/music/details?id=${encodeURIComponent(identifier)}`);
      if (!album || !Array.isArray(album.tracks) || album.tracks.length === 0) {
        throw new Error('No streamable tracks in this item.');
      }
      // Hand the materialized album to the shell player (music-bridge).
      ctx.events.emit('music:play', { album, startIndex: 0 });
    } catch (e: any) {
      err = e?.message ?? String(e);
    } finally {
      playPending = '';
    }
  }

  // ── Search ──────────────────────────────────────────────────────
  async function runSearch(): Promise<void> {
    if (busy) return;
    busy = true; err = '';
    try {
      const params = new URLSearchParams({
        q: query.trim(),
        sort: sortMode,
        page: String(curPage),
        limit: '24',
      });
      if (kind !== 'any') params.set('kind', kind);
      if (yearMin) params.set('yearMin', String(yearMin));
      if (yearMax) params.set('yearMax', String(yearMax));
      if (activeTags.length > 0) {
        params.set('tags', activeTags.join(','));
        params.set('tags_match', tagsMatch);
      }
      if (activeCreator) params.set('creator', activeCreator);
      const json = await ctx.fetchJson(`/api/music/search?${params.toString()}`);
      items = json?.items ?? [];
      total = json?.total ?? 0;
    } catch (e: any) {
      err = e?.message ?? String(e);
      items = [];
    } finally {
      busy = false;
    }
  }

  async function loadLibrary(): Promise<void> {
    try {
      const j = await ctx.fetchJson('/api/music/library');
      libraryItems = j?.items ?? [];
    } catch { /* */ }
  }

  // ── Library star toggle ────────────────────────────────────────
  async function toggleLibrary(b: MusicItem | LibraryEntry): Promise<void> {
    if (!('in_library' in b)) return;
    const m = b as MusicItem;
    try {
      if (m.in_library) {
        await ctx.fetchJson(`/api/music/library?id=${encodeURIComponent(m.identifier)}`, { method: 'DELETE' });
        m.in_library = false;
      } else {
        await ctx.fetchJson('/api/music/library', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            identifier: m.identifier, title: m.title, creator: m.creator,
            year: m.year, cover_url: m.cover_url,
            format_kind: m.format_kind, collection: m.collection?.[0] ?? '',
          }),
        });
        m.in_library = true;
      }
    } catch { /* toggle failed — leave state as-is */ }
    items = items;
    await loadLibrary();
  }

  // ── Filter changes ─────────────────────────────────────────────
  function nextPage(): void { curPage++; runSearch(); window.scrollTo(0, 0); }
  function prevPage(): void { if (curPage > 1) { curPage--; runSearch(); window.scrollTo(0, 0); } }
  function onSearchKey(e: KeyboardEvent): void { if (e.key === 'Enter') { curPage = 1; runSearch(); } }
  function onYearKey(e: KeyboardEvent): void { if (e.key === 'Enter') { curPage = 1; runSearch(); } }

  // ── Tag chip row + autocomplete ────────────────────────────────
  // Tags come live from archive.org's facet aggregation, scoped to the
  // current `kind`. Cached server-side for 24h so the round-trip happens
  // at most once a day per kind.
  let topTags: MusicTag[] = [];
  let tagsLoading = false;
  async function loadTopTags(): Promise<void> {
    tagsLoading = true;
    try {
      const params = new URLSearchParams({ limit: '40' });
      if (kind !== 'any') params.set('kind', kind);
      const body = await ctx.fetchJson(`/api/music/tags?${params.toString()}`);
      topTags = (body?.tags ?? []) as MusicTag[];
    } catch { /* non-fatal */ }
    finally { tagsLoading = false; }
  }
  function pickTag(tag: string): void {
    if (activeTags.includes(tag)) activeTags = activeTags.filter((t) => t !== tag);
    else activeTags = [...activeTags, tag];
    curPage = 1;
    runSearch();
  }
  function clearTags(): void { activeTags = []; curPage = 1; runSearch(); }

  // ── Creator filter ─────────────────────────────────────────────
  function readCreatorFromUrl(): string {
    try {
      return new URL(window.location.href).searchParams.get('creator') ?? '';
    } catch { return ''; }
  }

  /** Click a creator name → narrow the grid to their uploads. */
  function pickCreator(name: string): void {
    const c = name.trim();
    if (!c) return;
    activeCreator = c;
    curPage = 1;
    // Reflect to URL so refresh/back/forward keeps the filter and the
    // link is shareable. The `navigate` handler below no-ops because
    // activeCreator already matches.
    ctx.navigate(`${ctx.basePath}?creator=${encodeURIComponent(c)}`);
    runSearch();
  }
  function clearCreator(): void {
    activeCreator = '';
    curPage = 1;
    ctx.navigate(ctx.basePath);
    runSearch();
  }
  function toggleTagsMatch(): void {
    tagsMatch = tagsMatch === 'all' ? 'any' : 'all';
    if (activeTags.length >= 2) runSearch();
  }

  // React to same-view URL changes (someone clicks a creator inside the
  // persistent music player, which navigates to /music?creator=… — the
  // host does NOT remount this bundle, it broadcasts `kernl:navigate`).
  const offNavigate = ctx.events.on('navigate', () => {
    const c = readCreatorFromUrl();
    if (c !== activeCreator) {
      activeCreator = c;
      curPage = 1;
      runSearch();
    }
  });

  let tagSearchQuery = '';
  let tagSearchHits: MusicTag[] = [];
  let tagSearchOpen = false;
  let tagSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let tagSearchBusy = false;

  function onTagSearchInput(): void {
    tagSearchOpen = true;
    if (tagSearchTimer) clearTimeout(tagSearchTimer);
    const q = tagSearchQuery.trim();
    if (!q) { tagSearchHits = []; return; }
    tagSearchTimer = setTimeout(async () => {
      tagSearchBusy = true;
      try {
        const params = new URLSearchParams({ q, limit: '30' });
        if (kind !== 'any') params.set('kind', kind);
        const body = await ctx.fetchJson(`/api/music/tags?${params.toString()}`);
        tagSearchHits = (body?.tags ?? []) as MusicTag[];
      } catch { /* */ }
      finally { tagSearchBusy = false; }
    }, 200);
  }
  function pickTagFromSearch(t: MusicTag): void {
    pickTag(t.tag_norm);
    tagSearchQuery = '';
    tagSearchHits = [];
    tagSearchOpen = false;
  }
  function closeTagSearchSoon(): void {
    setTimeout(() => { tagSearchOpen = false; }, 150);
  }

  // ── Helpers ─────────────────────────────────────────────────────
  function onCoverError(e: Event): void {
    const img = e.target as HTMLImageElement | null;
    if (img) img.style.opacity = '0.2';
  }
  // Pretty label for the format_kind shown on each card. Kept tiny — the
  // chip row was removed but cards still surface what kind of recording
  // this is at a glance.
  const KIND_LABELS: Record<string, string> = {
    vinyl_78: 'Vinyl 78', vinyl_lp: 'Vinyl LP', netlabel: 'Netlabel',
    live: 'Live', radio: 'Radio', audiobook: 'Audiobook', audio: 'Audio',
  };
  function kindLabel(k: FormatKind): string { return KIND_LABELS[k] ?? 'Audio'; }
  function getDownloads(b: any): number { return Number(b?.downloads ?? 0); }
  function getPlayCount(b: any): number { return Number(b?.play_count ?? 0); }
  function getInLibrary(b: any): boolean { return Boolean(b?.in_library); }

  onMount(() => {
    // Seed activeCreator from the URL so deep-links (e.g. someone
    // sharing `/music?creator=Charly+García`) land already filtered.
    const c = readCreatorFromUrl();
    if (c) activeCreator = c;
    runSearch();
    loadLibrary();
    loadTopTags();
    // Sync the "Now playing" highlight with the shell player — its state
    // may predate this page (music keeps playing across navigation).
    ctx.events.emit('music:state:get');
  });

  onDestroy(() => {
    offState();
    offNavigate();
    if (tagSearchTimer) clearTimeout(tagSearchTimer);
  });

  $: shown = mode === 'search' ? items : libraryItems;
  $: shownIsItems = mode === 'search';
</script>

<div class="page">
  <!-- ── Header ── -->
  <header class="hero">
    <div class="hero-text">
      <div class="hero-kicker">archive.org / mediatype:audio</div>
      <h1 class="hero-title">Music</h1>
      <p class="hero-sub">
        Browse vinyls, netlabels, live shows and radio archives from
        <a href="https://archive.org/details/audio" target="_blank" rel="noopener">archive.org</a>.
        Click any cover to stream — the player keeps going as you roam the kernel.
      </p>
    </div>
    <div class="hero-stats">
      <div class="stat"><span class="stat-num">{total.toLocaleString()}</span><span class="stat-lbl">results</span></div>
      <div class="stat"><span class="stat-num">{libraryItems.length}</span><span class="stat-lbl">in library</span></div>
    </div>
  </header>

  <!-- ── Mode tabs ── -->
  <div class="mode-bar">
    <button class="mode-btn" class:on={mode === 'search'} on:click={() => mode = 'search'}>🔍 Search</button>
    <button class="mode-btn" class:on={mode === 'library'} on:click={() => { mode = 'library'; loadLibrary(); }}>
      🎼 My Library <span class="badge">{libraryItems.length}</span>
    </button>
  </div>

  {#if mode === 'search'}
    {#if activeCreator}
      <div class="creator-banner">
        <span class="cb-label">Filtering by uploader</span>
        <span class="cb-name">{activeCreator}</span>
        <button class="cb-clear" on:click={clearCreator} title="Clear filter">× clear</button>
      </div>
    {/if}

    <!-- Tag chip row -->
    {#if topTags.length > 0}
      <div class="tag-row">
        <span class="tag-row-label">Tags</span>
        {#each topTags as t (t.tag_norm)}
          <button class="tag-chip" class:on={activeTags.includes(t.tag_norm)} on:click={() => pickTag(t.tag_norm)}>
            {t.tag_display} <span class="tag-count">{t.count}</span>
          </button>
        {/each}
        {#if activeTags.length > 0}
          <button class="tag-clear" on:click={clearTags}>clear</button>
        {/if}
        {#if activeTags.length >= 2}
          <button class="tag-mode" on:click={toggleTagsMatch} title="Toggle AND/OR">{tagsMatch === 'all' ? 'AND' : 'OR'}</button>
        {/if}
      </div>
    {/if}

    <!-- Tag autocomplete -->
    <div class="tag-search">
      <input
        type="text"
        class="tag-search-input"
        placeholder="Search tags (e.g. blues, opera, jazz, cumbia)…"
        bind:value={tagSearchQuery}
        on:input={onTagSearchInput}
        on:focus={() => tagSearchOpen = true}
        on:blur={closeTagSearchSoon}
      />
      {#if tagSearchOpen && (tagSearchHits.length > 0 || tagSearchBusy)}
        <div class="tag-search-pop">
          {#if tagSearchBusy && tagSearchHits.length === 0}
            <div class="tag-search-empty">searching…</div>
          {:else}
            {#each tagSearchHits as t (t.tag_norm)}
              <button class="tag-search-hit" on:mousedown|preventDefault={() => pickTagFromSearch(t)}>
                <span>{t.tag_display}</span>
                <span class="dim mono">{t.count}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Search controls + year range -->
    <div class="ctrls">
      <input
        class="search-input"
        type="text"
        placeholder="Search albums, artists, labels…"
        bind:value={query}
        on:keydown={onSearchKey}
      />
      <input
        type="number"
        class="year-input"
        placeholder="from"
        min="1850" max="2100"
        bind:value={yearMin}
        on:keydown={onYearKey}
      />
      <span class="year-sep">→</span>
      <input
        type="number"
        class="year-input"
        placeholder="to"
        min="1850" max="2100"
        bind:value={yearMax}
        on:keydown={onYearKey}
      />
      <select class="select" bind:value={sortMode} on:change={() => { curPage = 1; runSearch(); }}>
        <option value="downloads">Most downloaded</option>
        <option value="date_added">Recently added</option>
        <option value="year_desc">Newest year</option>
        <option value="year_asc">Oldest year</option>
        <option value="title_asc">Title A→Z</option>
      </select>
      <button class="primary" disabled={busy} on:click={() => { curPage = 1; runSearch(); }}>
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
      {#if mode === 'library'}
        Your library is empty. Search for music and click ⭐ to save albums here.
      {:else}
        No results. Try a different search, kind, year range, or tag.
      {/if}
    </div>
  {:else}
    <div class="grid">
      {#each shown as b (b.identifier)}
        <article class="card" class:playing={nowPlayingId === b.identifier}>
          <button class="cover" on:click={() => playAlbum(b.identifier)} title="Play">
            <img src={b.cover_url} alt={b.title} loading="lazy" on:error={onCoverError} />
            <span class="play-overlay">{playPending === b.identifier ? '…' : '▶'}</span>
            {#if nowPlayingId === b.identifier}<span class="now-tag">Now playing</span>{/if}
          </button>
          <div class="card-body">
            <h3 class="card-title" title={b.title}>{b.title}</h3>
            {#if b.creator}
              <button class="card-author" title="See all uploads by {b.creator}" on:click|stopPropagation={() => pickCreator(b.creator)}>
                {b.creator}
              </button>
            {/if}
            <div class="card-meta">
              {#if b.year}<span>{b.year}</span>{/if}
              <span class="kind">{kindLabel(b.format_kind)}</span>
              {#if shownIsItems && getDownloads(b) > 0}<span class="dl">↓ {getDownloads(b).toLocaleString()}</span>{/if}
              {#if !shownIsItems && getPlayCount(b) > 0}<span class="dl">▶ {getPlayCount(b)}</span>{/if}
            </div>
            <div class="card-actions">
              <button class="ghost" on:click={() => playAlbum(b.identifier)}>▶ Play</button>
              {#if shownIsItems}
                <button class="ghost star" class:on={getInLibrary(b)} on:click={() => toggleLibrary(b)}>
                  {getInLibrary(b) ? '⭐' : '☆'}
                </button>
              {/if}
            </div>
          </div>
        </article>
      {/each}
    </div>

    {#if mode === 'search' && total > 24}
      <div class="pager">
        <button class="ghost" disabled={curPage === 1 || busy} on:click={prevPage}>← prev</button>
        <span class="page-info">page {curPage} of {Math.ceil(total / 24)}</span>
        <button class="ghost" disabled={curPage >= Math.ceil(total / 24) || busy} on:click={nextPage}>next →</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page {
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 32px 60px;
    /* /music is full-bleed: the shell clamps the route container to
       overflow:hidden. Re-enable vertical scroll on the inner page so
       grid contents past the viewport are reachable. */
    height: 100%;
    overflow-y: auto;
  }

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
  .hero-sub { color: var(--text-2); line-height: 1.55; max-width: 600px; margin: 0; }
  .hero-sub a { color: var(--teal); text-decoration: none; border-bottom: 1px dashed currentColor; }
  .hero-stats { display: flex; gap: 18px; flex-shrink: 0; }
  .stat {
    display: flex; flex-direction: column; align-items: flex-end;
    padding: 12px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    min-width: 96px;
  }
  .stat-num { font-family: var(--font-display); font-size: 24px; font-weight: 700; color: var(--text-1); letter-spacing: -0.01em; }
  .stat-lbl { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-3); margin-top: 2px; }

  .mode-bar { display: flex; gap: 4px; margin-bottom: 14px; border-bottom: 1px solid var(--border); }
  .mode-btn {
    background: transparent; border: 0; padding: 10px 18px;
    color: var(--text-2); font: inherit; font-family: var(--font-display);
    font-weight: 500; cursor: pointer;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
    transition: color 120ms;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .mode-btn:hover { color: var(--text-1); }
  .mode-btn.on { color: var(--text-1); border-bottom-color: var(--teal); }
  .badge {
    font-family: var(--font-mono); font-size: 10px;
    padding: 1px 7px; background: var(--surface-3);
    border-radius: 10px; color: var(--text-2);
  }

  /* ── Tag row + search ─────────────────────────────────────────── */
  .tag-row {
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 10px; flex-wrap: wrap;
  }
  .tag-row-label {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-3);
    margin-right: 4px;
  }
  .tag-chip {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 4px 10px;
    border-radius: 999px;
    font: inherit; font-size: 11px;
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
    transition: all 120ms;
  }
  .tag-chip:hover { color: var(--text-1); border-color: var(--border-h); }
  .tag-chip.on {
    background: color-mix(in srgb, var(--gold, #d4a056) 16%, transparent);
    border-color: var(--gold, #d4a056);
    color: var(--text-1);
  }
  .tag-count {
    font-family: var(--font-mono);
    font-size: 9px;
    opacity: 0.55;
  }
  .tag-clear, .tag-mode {
    background: transparent;
    border: 1px dashed var(--border-h);
    color: var(--text-3);
    padding: 4px 10px;
    border-radius: 999px;
    font: inherit; font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    cursor: pointer;
  }
  .tag-clear:hover, .tag-mode:hover { color: var(--text-1); border-color: var(--text-2); }
  .tag-mode { font-family: var(--font-mono); }

  .tag-search {
    position: relative;
    margin-bottom: 14px;
    max-width: 420px;
  }
  .tag-search-input {
    width: 100%;
    padding: 8px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font: inherit; font-size: 12px;
  }
  .tag-search-input:focus { outline: none; border-color: var(--teal); }
  .tag-search-pop {
    position: absolute;
    top: calc(100% + 4px);
    left: 0; right: 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    max-height: 280px;
    overflow-y: auto;
    z-index: 10;
    box-shadow: 0 12px 36px rgba(0,0,0,0.4);
  }
  .tag-search-hit, .tag-search-empty {
    display: flex; justify-content: space-between; align-items: center;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: 0;
    color: var(--text-1);
    font: inherit; font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .tag-search-hit:hover { background: var(--surface-2); }
  .tag-search-empty { color: var(--text-3); cursor: default; }
  .dim { color: var(--text-3); }
  .mono { font-family: var(--font-mono); font-size: 10px; }

  /* ── Search controls ──────────────────────────────────────────── */
  .ctrls { display: flex; gap: 10px; margin-bottom: 22px; flex-wrap: wrap; align-items: center; }
  .search-input {
    flex: 1; min-width: 240px;
    padding: 11px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font: inherit; font-size: 14px;
    transition: border-color 120ms;
  }
  .search-input:focus { outline: none; border-color: var(--teal); }
  .year-input {
    width: 80px;
    padding: 11px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font: inherit; font-size: 13px;
    text-align: center;
    -moz-appearance: textfield;
  }
  .year-input::-webkit-outer-spin-button,
  .year-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .year-input:focus { outline: none; border-color: var(--teal); }
  .year-sep { color: var(--text-3); font-family: var(--font-mono); font-size: 12px; }
  .select {
    padding: 11px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font: inherit; font-size: 13px; cursor: pointer;
  }
  .primary {
    padding: 11px 22px;
    background: var(--teal);
    color: #001;
    border: 0;
    border-radius: var(--radius-sm);
    font: inherit; font-weight: 600;
    cursor: pointer;
    transition: filter 120ms;
  }
  .primary:hover:not(:disabled) { filter: brightness(1.1); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Grid + cards ─────────────────────────────────────────────── */
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
    display: flex; flex-direction: column;
    transition: border-color 120ms, transform 160ms, box-shadow 200ms;
  }
  .card:hover { border-color: var(--border-h); transform: translateY(-2px); }
  .card.playing {
    border-color: #d4a056;
    box-shadow: 0 0 0 1px rgba(212,160,86,0.45), 0 8px 30px rgba(212,160,86,0.16);
  }
  .cover {
    background: var(--surface-3);
    border: 0; padding: 0;
    cursor: pointer;
    aspect-ratio: 1 / 1;
    overflow: hidden;
    position: relative;
  }
  .cover img {
    width: 100%; height: 100%;
    object-fit: cover; display: block;
    transition: opacity 200ms, transform 220ms;
  }
  .cover:hover img { transform: scale(1.04); }
  .play-overlay {
    position: absolute; inset: 0;
    display: grid; place-items: center;
    font-size: 42px; color: #fff;
    text-shadow: 0 2px 12px rgba(0,0,0,0.7);
    opacity: 0;
    background: rgba(0,0,0,0.32);
    transition: opacity 160ms;
  }
  .cover:hover .play-overlay { opacity: 1; }
  .now-tag {
    position: absolute; top: 8px; left: 8px;
    background: #d4a056; color: #1a1410;
    font-family: var(--font-mono); font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.14em;
    padding: 3px 8px;
    border-radius: 3px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  }

  .card-body { padding: 12px 12px 14px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .card-title {
    font-family: var(--font-display); font-size: 14px; font-weight: 600;
    letter-spacing: -0.01em; color: var(--text-1);
    margin: 0; line-height: 1.3;
    overflow: hidden; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    line-clamp: 2;
  }
  /* A real button (not a plain div) so it's clickable + keyboard
     reachable. Strip the default button chrome — visually identical to
     a text label but with hover affordance + underline on hover. */
  .card-author {
    font-size: 12px;
    color: var(--text-2);
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
    transition: color 120ms;
  }
  .card-author:hover {
    color: var(--gold, #d4a056);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* ── Creator filter banner ────────────────────────────────────── */
  .creator-banner {
    display: inline-flex;
    align-items: baseline;
    gap: 12px;
    padding: 10px 14px 10px 16px;
    margin-bottom: 14px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--gold, #d4a056) 18%, transparent), color-mix(in srgb, var(--gold, #d4a056) 6%, transparent));
    border: 1px solid color-mix(in srgb, var(--gold, #d4a056) 45%, transparent);
    border-radius: 999px;
    box-shadow: 0 0 18px color-mix(in srgb, var(--gold, #d4a056) 20%, transparent);
  }
  .cb-label {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-3);
  }
  .cb-name {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 16px;
    letter-spacing: -0.01em;
    color: var(--text-1);
  }
  .cb-clear {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 3px 10px;
    border-radius: 999px;
    font: inherit;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    cursor: pointer;
    transition: all 120ms;
  }
  .cb-clear:hover {
    color: var(--text-1);
    border-color: var(--gold, #d4a056);
    background: rgba(212,160,86,0.1);
  }
  .card-meta {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    font-family: var(--font-mono); font-size: 10px;
    color: var(--text-3); margin-top: 4px;
  }
  .card-meta .dl { color: var(--green); }
  .card-meta .kind {
    background: var(--surface-3); padding: 1px 6px; border-radius: 3px;
    text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-2);
  }
  .card-actions { display: flex; gap: 6px; margin-top: auto; padding-top: 8px; }
  .ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    font: inherit; font-size: 12px;
    cursor: pointer;
    transition: all 120ms;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .ghost:hover { color: var(--text-1); border-color: var(--border-h); background: var(--surface-2); }
  .ghost.star.on {
    color: var(--gold, #d4a056);
    border-color: var(--gold, #d4a056);
    background: color-mix(in srgb, var(--gold, #d4a056) 10%, transparent);
  }
  .card-actions .ghost:first-child { flex: 1; justify-content: center; }

  .pager {
    display: flex; justify-content: center; align-items: center; gap: 14px;
    margin-top: 32px;
  }
  .page-info { font-family: var(--font-mono); font-size: 12px; color: var(--text-2); }
  .err, .loading, .empty {
    padding: 60px 20px; text-align: center;
    color: var(--text-2); font-size: 14px;
  }
  .err { color: var(--red); }
  .loading { color: var(--teal); }
</style>
