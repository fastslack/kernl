<script lang="ts">
  /*
    /cinema — archive.org movie importer with poster-driven UI.

    Each item from archive.org has a canonical thumbnail at
    `https://archive.org/services/img/<identifier>` — we use it as the card
    background. Cards fade-in lazy, support hover zoom + selection toggle,
    and bulk import via the /api/cinema/media/import-archive/run endpoint.

    Split into pieces that own their markup and CSS: HeaderChrome (the
    sticky header), PosterGrid, PlayerModal, FilmSheet and SaveToDirectory,
    plus subs-pipeline.ts for everything about captions. Filter, search,
    watchlist and player state still live here and go down as props.
  */
  import { onMount, onDestroy, tick } from 'svelte';
  import type { ExtPageContext } from '$shared/types';
  import {
    loadCaptionStyle, saveCaptionStyle, captionInlineStyle as capStyleOf,
    CAPTION_FAMILIES as SHARED_FAMILIES,
    type CaptionStyle,
  } from '$shared/media/caption-style';
  import { createI18n } from '$shared/i18n';
  import { jsonApi } from '$shared/api';
  import { dicts, languageName } from './i18n/index.js';
  import type { ArchiveItem, PlayFile, CanonRail, CinemaTag, ActiveChip } from './types.js';
  import { fileKind, KIND_ORDER, pickDefaultPlayIdx, archiveDownloadUrl, authQuery, buildPlayUrl } from './media.js';
  import { createSubsPipeline } from './subs-pipeline.js';
  import HeaderChrome from './HeaderChrome.svelte';
  import PosterGrid from './PosterGrid.svelte';
  import PlayerModal from './PlayerModal.svelte';
  import FilmSheet from './FilmSheet.svelte';
  import SaveToDirectory from './SaveToDirectory.svelte';

  /** Host-provided context — auth token, locale, navigation. */
  export let ctx: ExtPageContext;

  // ── i18n ───────────────────────────────────────────────────────
  // ctx.locale is a snapshot taken when the host called mount(), and the host
  // does NOT remount ext views when the language changes — so the store also
  // listens for the shell's `kernl:locale` broadcast and re-renders in place.
  const i18n = createI18n({ initial: ctx.locale, dicts, events: ctx.events });
  const t = i18n.t;
  const uiLocale = i18n.locale;
  onDestroy(i18n.destroy);

  /**
   * Same-origin /api fetch with the host auth token attached. This page
   * relies heavily on Response semantics (r.ok / r.status / r.text() /
   * headers), so instead of rewriting every call site to ctx.fetchJson
   * (which throws on !ok and returns parsed JSON only), we keep raw
   * fetch semantics and inject the Authorization header ourselves.
   * Non-/api URLs pass through untouched.
   */
  function apiFetch(input: string, init?: RequestInit): Promise<Response> {
    if (!input.startsWith('/api/')) return fetch(input, init);
    const headers = new Headers(init?.headers);
    if (ctx?.authToken && !headers.has('Authorization')) {
      headers.set('Authorization', 'Bearer ' + ctx.authToken);
    }
    return fetch(input, { ...init, headers });
  }
  /** JSON calls over apiFetch; errors read `{ error }`, else `http <status>`. */
  const api = jsonApi(apiFetch, { statusMessage: (s) => `http ${s}` });

  // The hardcoded collection chip row was removed in Stage 6: those slugs
  // came directly from archive.org's internal taxonomy and were confusing
  // (what's "prelinger"? "moviesandfilms"?). The catalog is now searchable
  // by tag (data-driven, see top tags below) + year range + free-text +
  // semantic. Power users can still filter by collection via the API
  // (`?collection=…`) but it's not surfaced in the UI by default.

  let collection = '';      // empty = no collection filter
  let query = '';
  let yearMin: number | null = null;
  let yearMax: number | null = null;
  let rows = 60;
  // Active tag chips — multi-select. Click a tag to add it; click again
  // to remove. When 2+ are active, the AND/OR toggle decides the match
  // mode that goes to the API as `tags_match`.
  let activeTags: string[] = [];
  let tagsMatch: 'all' | 'any' = 'all';
  // ── Header chrome state ──────────────────────────────────────
  // The hard filters (year, language, type, duration, sort, the four content
  // toggles) live in a panel instead of strung along one wrapping row. Not
  // because they are rare — they are used constantly — but because eight loose
  // controls with placeholder text where their labels should be told you
  // nothing about what was actually applied. In the panel every control has a
  // visible label; outside it, the "Showing" row names every filter that is on.
  //
  // Open/closed is remembered: someone who filters on every visit keeps the
  // panel open and pays nothing for it, and someone who never does never sees
  // it. A session-scoped default would have made that choice for both of them.
  const FILTERS_OPEN_KEY = 'cinema:filtersOpen';
  let filtersOpen = false;
  // Tag section inside the panel, holding the searchable long tail. The row
  // outside the panel carries the top tags only.
  let tagPanelOpen = false;
  // Set once the user scrolls into the grid: bands ③ and ④ fold away and the
  // command bar plus the active-filter row stay. Everything is still one
  // keystroke away, but the posters get the screen back.
  let condensed = false;
  let scrollEl: HTMLDivElement | null = null;

  function toggleFilters(): void {
    filtersOpen = !filtersOpen;
    try { localStorage.setItem(FILTERS_OPEN_KEY, filtersOpen ? '1' : '0'); } catch { /* private mode */ }
  }

  // The tag band expands in place — it no longer lives inside the filters
  // panel, so opening it must not drag the filters open with it.
  function openTagPanel(): void {
    tagPanelOpen = true;
  }

  function closeTagPanel(): void {
    tagPanelOpen = false;
    tagSearchOpen = false;
    tagSearchQuery = '';
  }

  function onPageScroll(e: Event): void {
    const top = (e.currentTarget as HTMLElement).scrollTop;
    // Hysteresis. Collapsing the header shortens the document, which can pull
    // the scroll position back across a single threshold and start the whole
    // thing flickering. Two thresholds 90px apart cannot oscillate.
    if (!condensed && top > 180) {
      condensed = true;
      // The expanded cloud opts out of `band-collapsible` — it is taller than
      // the 56px that rule folds away. Without this it would be the one band
      // that refuses to get out of the way once you are reading posters,
      // which is the whole point of condensing.
      if (tagPanelOpen) closeTagPanel();
    } else if (condensed && top < 90) condensed = false;
  }
  // Language ISO 2-letter code, empty = any.
  let langFilter = '';
  // Sort dropdown — exposed inline so the user doesn't have to dig.
  let sortMode: 'downloads' | 'year_desc' | 'year_asc' | 'added_desc' | 'rating' | 'best' = 'downloads';

  // ── Identified titles only ───────────────────────────────────
  // Off by default and staying that way. The unidentified tail is not junk:
  // Prelinger, educationalfilms and culturalandacademicfilms are legitimate
  // industrial cinema that Wikidata simply does not catalogue as works, and
  // defaulting this on would hide some of the best material in the archive.
  // The ★ order already floats identified titles up without anyone opting in.
  let identifiedOnly = false;

  // ── Collapse copies of the same film ─────────────────────────
  // ON by default, unlike the identified filter — and the difference is
  // deliberate. Hiding the unidentified tail would lose real material;
  // hiding the fifth upload of Metropolis loses nothing, because the film is
  // still on screen and its other copies are one click away on the card.
  // Collapsed rows also carry the work's SUMMED downloads and votes, which is
  // the count that was always true.
  let collapseWorks = true;

  // ── File-level filters ───────────────────────────────────────
  // These read what the item actually CONTAINS, probed from archive.org's
  // metadata endpoint — not the catalogue's runtime_sec, which is 0 on a
  // large part of the table. A minimum duration is the bluntest and most
  // effective quality filter available: it removes the things that are not
  // films at all, which no amount of reranking can do.
  //
  // All default to off. A title nobody has probed yet cannot satisfy them,
  // so switching one on mid-probe narrows the grid to what has been looked
  // at — correct, but surprising if it happened without being asked for.
  let minMinutes = 0;
  let playableOnly = false;
  let subsOnly = false;

  // ── Canon rails ──────────────────────────────────────────────
  // Editorial rather than statistical: the National Film Registry is a
  // decision by people whose job is film preservation, which no ranking over
  // downloads or ratings can express. Rails the catalogue holds nothing from
  // are hidden — an empty shelf is worse than no shelf.
  let canonRails: CanonRail[] = [];
  let activeRail = '';

  // ── Discovery from the vectors ───────────────────────────────
  // Neither of these depends on canonical identification, which is why they
  // reach the 81 cartoons Wikidata ignores — the most-downloaded material in
  // this catalogue and invisible to every other quality signal here.
  let similarItems: ArchiveItem[] = [];
  // The strip eats ~200px at the bottom of the player modal. On a laptop that
  // is the difference between a video with room and a video squeezed, so the
  // row folds to its single header line and remembers the choice — same deal
  // the filters panel makes upstairs.
  const SIMILAR_OPEN_KEY = 'cinema:similarOpen';
  let similarOpen = true;

  function toggleSimilar(): void {
    similarOpen = !similarOpen;
    try { localStorage.setItem(SIMILAR_OPEN_KEY, similarOpen ? '1' : '0'); } catch { /* private mode */ }
  }

  let forYouMode = false;
  // Distinguishes "save a few films first" from "run the embed runner".
  let forYouReason: 'ok' | 'no_profile' | 'no_vectors' | 'no_direction' | '' = '';
  let forYouProfileSize = 0;

  async function loadSimilar(identifier: string) {
    try {
      const r = await apiFetch(`/api/cinema/similar/${encodeURIComponent(identifier)}?limit=12`);
      if (!r.ok) return;
      const body = await r.json();
      // Guard against a slow response for a film the user already closed.
      if (playItem?.identifier !== identifier) return;
      // Cosine ranks uploads, not works: the same film mirrored three times
      // scores three near-identical hits and the strip showed the same poster
      // three times in a row. Collapse by title, keep the best-ranked copy,
      // and never offer the film that is already playing.
      const titleKey = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');
      // Seeded with what is playing: the nearest vector to a film is almost
      // always another upload of that same film, under a different id.
      const seen = new Set<string>([titleKey(playItem?.title ?? '')]);
      similarItems = ((body.items ?? []) as ArchiveItem[]).filter((s) => {
        if (s.identifier === identifier) return false;
        const key = titleKey(s.title || s.identifier);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch {
      // Embeddings absent or Neo4j down. The strip just does not appear;
      // there is nothing here worth interrupting playback for.
      similarItems = [];
    }
  }

  async function toggleForYou() {
    forYouMode = !forYouMode;
    if (!forYouMode) { forYouReason = ''; runSearch(); return; }
    busy = true;
    try {
      const body = await api.getJson('/api/cinema/for-you?limit=48');
      items = body.items ?? [];
      forYouReason = body.reason ?? '';
      forYouProfileSize = body.profile_size ?? 0;
      page = 1;
      // One ranked set, not a paged query — the infinite-scroll sentinel must
      // not try to fetch a second page of it.
      hasMore = false;
    } catch (e) {
      forYouReason = 'no_vectors';
      items = [];
      hasMore = false;
    } finally {
      busy = false;
    }
  }

  async function loadCanonRails() {
    try {
      const r = await apiFetch('/api/cinema/canon/rails');
      if (!r.ok) return;
      const body = await r.json();
      canonRails = (body.rails ?? []).filter((x: { held: number }) => x.held > 0);
    } catch {
      // A missing rail row is not worth interrupting the page for.
      canonRails = [];
    }
  }

  function toggleRail(key: string) {
    activeRail = activeRail === key ? '' : key;
    runSearch();
  }

  // ── Films or series ──────────────────────────────────────────
  // archive.org has no such field: a serial lives in the television
  // collections and a feature does not. The kernel derives it from that
  // membership; here it is just the question people actually ask.
  let kindFilter: '' | 'film' | 'series' = '';

  // ── Top-tag chip row ─────────────────────────────────────────
  // Populated from /api/cinema/tags. Cached at module scope so reloading
  // /cinema doesn't re-fetch the same data, but refresh on demand after
  // a big ingest via the "Embed all" panel below.
  let topTags: CinemaTag[] = [];
  let tagsLoading = false;
  async function loadTopTags(): Promise<void> {
    tagsLoading = true;
    try {
      const body = await api.getJson('/api/cinema/tags?limit=30');
      topTags = (body.tags ?? []) as CinemaTag[];
    } catch { /* non-fatal — chip row stays empty */ }
    finally { tagsLoading = false; }
  }
  function pickTag(tag: string) {
    if (activeTags.includes(tag)) {
      activeTags = activeTags.filter(t => t !== tag);
    } else {
      activeTags = [...activeTags, tag];
    }
    // Picking a genre is a "show me the good ones" gesture, not a "show me
    // the most downloaded" one — and downloads here mostly track how long a
    // file has been online rather than whether it is worth watching.
    if (activeTags.length > 0 && sortMode === 'downloads') sortMode = 'best';
    page = 1;
    runSearch();
  }
  // clearTags() lived here. Orphaned by the header redesign: tags are now
  // removed one at a time from the "Showing" row, and the only "clear
  // everything" affordance is clearAllFilters(), which resets the rail, the
  // kind, the duration floor and the content toggles as well — the four things
  // a tags-only clear used to leave silently applied.
  function toggleTagsMatch() {
    tagsMatch = tagsMatch === 'all' ? 'any' : 'all';
    if (activeTags.length >= 2) runSearch();
  }

  // ── Tag search (autocomplete) ────────────────────────────────
  // The chip row only surfaces the top 30 most-used tags (Drama,
  // Comedy, Crime, …). For the long tail — "Cine argentino" #15,
  // "Third Reich Cinema" #18, "telewizja polska" #30, plus 136k other
  // tags below the cut — the user types a prefix here and picks from
  // ranked matches via /api/cinema/tags?q=.
  let tagSearchQuery = '';
  let tagSearchHits: CinemaTag[] = [];
  let tagSearchOpen = false;
  let tagSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let tagSearchBusy = false;

  function onTagSearchInput() {
    tagSearchOpen = true;
    if (tagSearchTimer) clearTimeout(tagSearchTimer);
    const q = tagSearchQuery.trim();
    if (!q) { tagSearchHits = []; return; }
    tagSearchTimer = setTimeout(async () => {
      tagSearchBusy = true;
      try {
        const body = await api.getJson(`/api/cinema/tags?q=${encodeURIComponent(q)}&limit=20`);
        tagSearchHits = (body.tags ?? []) as CinemaTag[];
      } catch { /* */ }
      finally { tagSearchBusy = false; }
    }, 200);
  }
  function pickTagFromSearch(tag: CinemaTag) {
    pickTag(tag.tag_norm);
    tagSearchQuery = '';
    tagSearchHits = [];
    tagSearchOpen = false;
  }
  function closeTagSearchSoon() {
    // Delay so the click on a result fires before we hide it.
    setTimeout(() => { tagSearchOpen = false; }, 150);
  }

  // ── "+ to directory" dialog and the film sheet ─────────────────
  // Both own their state (the directory list, the synopsis translation and
  // its cache) and outlive every open, so what they fetched is kept for the
  // next one. Opened from a card, and from each other.
  let dirDialog: SaveToDirectory;
  let filmSheet: FilmSheet;
  function openDirPicker(item: ArchiveItem, ev: Event) {
    dirDialog.openDirPicker(item, ev);
  }
  function openInfo(item: ArchiveItem, ev: Event) {
    filmSheet.openInfo(item, ev);
  }

  // ── Embed runner state (drives the progress bar in the admin panel) ──
  interface EmbedSnapshot {
    status: 'idle' | 'running' | 'stopping' | 'stopped' | 'done' | 'failed';
    total_titles: number;
    embedded: number;
    pending: number;
    this_run_embedded: number;
    batch_size: number;
    last_batch_ms: number;
    rate: number;
    eta_seconds: number | null;
    started_at: string | null;
    finished_at: string | null;
    error: string;
    model: string;
    dim: number;
  }
  let embedSnap: EmbedSnapshot | null = null;
  let embedPanelOpen = false;
  let embedPollTimer: ReturnType<typeof setInterval> | null = null;
  async function refreshEmbedStatus(): Promise<void> {
    try {
      embedSnap = await api.getJson('/api/cinema/embed/status');
    } catch { /* silent */ }
  }
  async function startEmbed(): Promise<void> {
    try {
      const r = await apiFetch('/api/cinema/embed/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batch_size: 128 }),
      });
      if (r.ok) embedSnap = await r.json();
    } catch (err: any) {
      console.error('startEmbed failed', err);
    }
  }
  async function stopEmbed(): Promise<void> {
    try {
      embedSnap = await api.postJson('/api/cinema/embed/stop');
    } catch { /* */ }
  }
  function fmtEta(sec: number | null): string {
    if (sec == null || !isFinite(sec)) return '—';
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
  }
  // Poll embed status whenever the panel is open OR the runner is active.
  $: if (typeof window !== 'undefined') {
    const shouldPoll = embedPanelOpen
      || (embedSnap?.status === 'running' || embedSnap?.status === 'stopping');
    if (shouldPoll && !embedPollTimer) {
      embedPollTimer = setInterval(refreshEmbedStatus, 2000);
    } else if (!shouldPoll && embedPollTimer) {
      clearInterval(embedPollTimer);
      embedPollTimer = null;
    }
  }
  let busy = false;
  let loadingMore = false;
  let lastError = '';
  let items: ArchiveItem[] = [];
  let page = 1;
  let hasMore = true;
  let sentinelEl: HTMLDivElement | null = null;

  // ── Watchlist (browser-local, persistent via localStorage) ──────────
  // Saved items survive page reloads. Keyed by identifier so adding the
  // same movie twice is idempotent. Stored items keep enough metadata to
  // render the watchlist view without re-fetching from archive.org.
  interface WatchItem {
    identifier: string;
    title: string;
    date?: string;
    creator?: string;
    description?: string;
    subject?: string[];
    addedAt: number;
  }
  const WATCHLIST_KEY = 'cinema:watchlist';
  let watchlist: WatchItem[] = [];
  let viewWatchlist = false;

  // Watchlist is server-truth (cinema_titles.watchlist column) since
  // Stage 5. localStorage stays as a hot cache so the star state
  // renders before /api/cinema/titles?watchlist=1 returns. Migrations:
  // on first mount, if localStorage has items NOT yet on the server,
  // POST each one through /watchlist so older installs are recovered.
  function loadLocalWatchlist(): WatchItem[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  function persistLocal() {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist)); }
    catch { /* quota or private mode — skip */ }
  }

  /** Pull the server-side watchlist and merge with anything localStorage
   *  still has (one-way migration from legacy localStorage rows). After
   *  this runs, localStorage mirrors the server state. */
  async function syncWatchlistFromServer(): Promise<void> {
    let serverItems: WatchItem[] = [];
    try {
      const body = await api.getJson('/api/cinema/titles?watchlist=1&limit=200');
      serverItems = (body.items ?? []).map((t: any) => ({
        identifier: t.identifier,
        title: t.title,
        date: t.date,
        creator: t.creator,
        description: t.description,
        subject: t.subject,
        addedAt: t.last_seen_at ? new Date(t.last_seen_at).getTime() : Date.now(),
      }));
    } catch { /* offline — use local cache */ }

    const local = loadLocalWatchlist();
    const serverIds = new Set(serverItems.map(w => w.identifier));
    // Migrate: any item still in localStorage not on the server gets
    // pushed up so older installs don't lose data.
    const orphans = local.filter(w => !serverIds.has(w.identifier));
    for (const w of orphans) {
      try {
        await apiFetch('/api/cinema/watchlist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ identifier: w.identifier, watchlist: true }),
        });
      } catch { /* keep going — orphan stays in localStorage as fallback */ }
    }
    // Final state: server union local-orphans (orphans land on server
    // best-effort; if push failed they're still visible from local cache).
    watchlist = [...serverItems, ...orphans];
    persistLocal();
  }

  function isSaved(id: string): boolean {
    return watchlist.some(w => w.identifier === id);
  }

  async function toggleWatch(it: ArchiveItem | WatchItem) {
    const wantsRemove = isSaved(it.identifier);
    // Optimistic local update so the star flips instantly.
    if (wantsRemove) {
      watchlist = watchlist.filter(w => w.identifier !== it.identifier);
    } else {
      watchlist = [
        {
          identifier: it.identifier,
          title: it.title,
          date: it.date,
          creator: it.creator,
          description: it.description,
          subject: it.subject,
          addedAt: Date.now(),
        },
        ...watchlist,
      ];
    }
    persistLocal();
    // Persist server-side. On failure we keep the optimistic state —
    // the next mount's syncWatchlistFromServer reconciles.
    try {
      await apiFetch('/api/cinema/watchlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: it.identifier, watchlist: !wantsRemove }),
      });
    } catch { /* offline — local-only until next sync */ }
  }

  // Items shown in the grid: search results when normal, watchlist when toggled.
  $: shownItems = viewWatchlist ? (watchlist as ArchiveItem[]) : items;

  // ── Player modal state ─────────────────────────────────────
  /**
   * Chatty tracing, off unless asked for.
   *
   * These 27 call sites were plain console.log, and `maybeLoadTranscript`
   * alone fires on every reactive update — opening one film printed dozens of
   * lines. A console that is always full is a console nobody reads, so a real
   * error in there goes unnoticed. Warnings and errors are untouched; only the
   * play-by-play is gated.
   *
   * Turn it on with `localStorage.setItem('cinema:debug', '1')` and reload.
   */
  const CINEMA_DEBUG = typeof window !== 'undefined'
    && (() => { try { return localStorage.getItem('cinema:debug') === '1'; } catch { return false; } })();
  function dbg(...args: unknown[]): void {
    if (CINEMA_DEBUG) console.log(...args);
  }

  let playOpen = false;
  // Description panel — collapsed by default so the description doesn't
  // sit below the player as permanent visual noise. Toggle from header.
  let descOpen = false;
  let filesOpen = false;          // file list collapsed by default; users
                                   // toggle via the FILES button to keep
                                   // the player area clean.
  let playLoading = false;
  let playError = '';
  let playItem: ArchiveItem | null = null;
  let playFiles: PlayFile[] = [];
  let playActiveIdx = 0;
  let playNeedsTranscode = false;
  let playSrc = '';
  // Real total duration of the upstream file (probed via ffprobe on the
  // backend). When transcoding to fragmented MP4 the browser only learns
  // the elapsed-so-far length — without this override the scrubber grows
  // as bytes arrive instead of showing the real total. Reset on every
  // src/file change.
  let probedDurationSec = 0;
  let probedDurationToken = 0;

  // ── Subtitles ──────────────────────────────────────────────
  // Bound to the playing <video>. Used to (a) auto-enable text tracks once
  // the browser has parsed them and (b) compute a per-engine ETA based on
  // the actual video duration the moment we have it.
  let videoEl: HTMLVideoElement | null = null;

  // Finding, generating, translating and showing captions — see
  // subs-pipeline.ts. It reads the player through these getters; the state it
  // hands back is stores, so the reactive blocks below keep the per-variable
  // dependencies they had when all of this lived in this file.
  const subs = createSubsPipeline({
    apiFetch, api, dbg,
    item: () => playItem,
    files: () => playFiles,
    activeIdx: () => playActiveIdx,
    video: () => videoEl,
  });
  const {
    subsCtl, subSource, translateActive, subTrack, subEngine, subTargetLang, subSourceLang,
    generateRequested, transcribeAvailable, transcribeEngine, transcribeModel,
  } = subs;

  // Internal: the current subtitle "track" identifier the URL builder
  // understands. Computed reactively from (subSource, translateActive,
  // subTargetLang, subEngine).
  $: {
    void $subSource; void $translateActive; void $subTargetLang; void $subEngine;
    if ($subSource === 'off') {
      $subTrack = 'off';
    } else if ($subSource === 'orig' && !$translateActive) {
      $subTrack = 'orig';
    } else if ($subSource === 'orig' && $translateActive) {
      // Any string that isn't off/orig/transcribed/transcribed-translated
      // routes through translate-srt with the shipped .srt as upstream.
      $subTrack = `${$subTargetLang}-${$subEngine}`;
    } else if ($subSource === 'auto' && !$translateActive) {
      $subTrack = 'transcribed';
    } else if ($subSource === 'auto' && $translateActive) {
      $subTrack = 'transcribed-translated';
    }
  }

  // Re-probe whenever the player opens, the file list arrives, the active
  // file changes, or the user fiddles with engine/model/lang. `playFiles`
  // MUST be in the dep list — without it the probe runs once on `playOpen`
  // (when the list is still empty), early-returns with transcribeAvailable
  // = false, and never re-checks once files load. Cheap GET, no harm in
  // re-firing.
  $: if (typeof window !== 'undefined' && playOpen && playItem) {
    void playFiles; void playActiveIdx;
    void $transcribeEngine; void $transcribeModel; void $subSourceLang;
    subs.probeTranscribeCache();
  }
  // Auto-enable the matching subtitle source once the probe finds a
  // cached VTT (or once an external .srt shows up in playFiles). Only
  // fires while `subSource === 'off'` so we don't override the user's
  // explicit choice mid-session.
  // GATE on `!playLoading` so it doesn't fire mid-openPlayer — otherwise
  // it sets subSource='orig' the moment hasSrt becomes true, then
  // openPlayer's explicit code overrides to 'auto' a tick later. Two
  // state mutations in rapid succession cause Svelte to patch already-
  // destroyed conditional blocks ("Cannot read properties of null").
  $: if (typeof window !== 'undefined' && playOpen && !playLoading && $subSource === 'off') {
    if ($transcribeAvailable) {
      dbg('[cinema] auto-enabling cached transcribed subs');
      $subSource = 'auto';
    } else if (hasSrt) {
      dbg('[cinema] auto-enabling shipped SRT subs');
      $subSource = 'orig';
    }
  }

  // ── Custom HTML5 player state ──────────────────────────────────────
  // We hide the browser's native <video controls> and draw our own UI so
  // we can (a) style captions however we want (font/size/colour from a
  // settings menu) and (b) keep all controls inside the page chrome
  // instead of the rigid native bar. The browser's track rendering is
  // disabled — we set `mode='hidden'` so cuechange events still fire and
  // we read `activeCues` ourselves into `.captions-overlay`.
  let playerCurrentTime = 0;
  let playerDuration = 0;
  let playerIsPlaying = false;
  let playerVolume = 1;
  let playerMuted = false;
  let playerRate = 1;
  let playerSeeking = false;       // true while user drags the scrub bar
  let isFullscreen = false;
  let controlsVisible = true;       // auto-hides during playback
  let controlsHideTimer: ReturnType<typeof setTimeout> | null = null;
  // ── Caption styling — now shared with /tv and /torrents ──────────
  // The store lives in $shared/media/caption-style, so a viewer's font/size/
  // colour choice follows them across every Kernl player instead of being
  // remembered only here. The individual `caption*` names below are kept as
  // views onto that object so the existing settings markup is untouched.
  const CAPTION_FAMILIES = SHARED_FAMILIES;
  let captionStyle: CaptionStyle = loadCaptionStyle();
  let captionFontSize = captionStyle.fontSize;
  let captionFontFamily: 'sans' | 'serif' | 'mono' = captionStyle.fontFamily;
  let captionTextColor = captionStyle.textColor;
  let captionBgOpacity = captionStyle.bgOpacity;
  let captionEdgeStyle: 'none' | 'outline' | 'shadow' = captionStyle.edge;
  let captionPosition: 'bottom' | 'top' = captionStyle.position;

  // Persist on every change. The reads pin them as Svelte deps.
  $: if (typeof window !== 'undefined') {
    captionStyle = {
      fontSize: captionFontSize,
      fontFamily: captionFontFamily,
      textColor: captionTextColor,
      bgOpacity: captionBgOpacity,
      edge: captionEdgeStyle,
      position: captionPosition,
    };
    saveCaptionStyle(captionStyle);
  }

  // Reactive: re-fire when ANY input that affects trackSrc() or videoEl
  // changes. We list all deps as real reads (no void) so Svelte tracks
  // them properly and the reactive block ends up AFTER trackSrc()'s deps
  // in topological order.
  $: {
    if (videoEl || $subTrack || playItem || $transcribeAvailable
        || $transcribeEngine || $transcribeModel || $subEngine
        || $subTargetLang || $subSourceLang || playFiles || playActiveIdx
        || $generateRequested) {
      subs.maybeLoadTranscript();
    }
  }

  // Legacy hook kept so existing on:loadedmetadata / on:load callers
  // don't break — used to do `mode='showing'` on the `<track>` element.
  // We do the work in `loadTranscriptManual` now; this is a no-op.
  function enableAllTextTracks(): void { /* superseded by loadTranscriptManual */ }

  // ── Player controls (called from custom UI buttons) ─────────────────
  function seek(t: number): void {
    const v = videoEl;
    if (!v || !Number.isFinite(t)) return;
    v.currentTime = Math.max(0, Math.min(t, v.duration || 0));
  }

  // ── Video element event handlers ────────────────────────────────────
  function onTimeUpdate(): void {
    if (!videoEl || playerSeeking) return;
    playerCurrentTime = videoEl.currentTime;
  }
  function onDurationChange(): void {
    if (!videoEl) return;
    // For transcoded fragmented MP4 the browser reports either Infinity
    // (live-stream interpretation) or whatever has streamed so far. The
    // probed upstream duration is authoritative in those cases.
    const native = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
    playerDuration = probedDurationSec > 0 ? probedDurationSec : native;
  }
  // Probe the kernel for the upstream duration whenever the playing src
  // changes. Necessary for transcoded fragmented MP4 (no real moov
  // duration) but also useful for any source where the browser reports
  // Infinity / NaN (live MJPEG, broken MP4 indices, partial range loads).
  $: if (playSrc) {
    probedDurationSec = 0;
    playerDuration = 0;
    void probeUpstreamDuration(playSrc);
  }
  // Run an ffprobe lookup against the upstream URL embedded in `src` and
  // store it in `probedDurationSec`. Token-guarded so that switching files
  // mid-flight discards the stale response.
  async function probeUpstreamDuration(src: string): Promise<void> {
    const myToken = ++probedDurationToken;
    try {
      const u = new URL(src, window.location.origin);
      const upstream = u.searchParams.get('url');
      if (!upstream) return;
      const j = await api.getJson(`/api/cinema/media/probe?url=${encodeURIComponent(upstream)}`);
      if (myToken !== probedDurationToken) return;

      // The same probe now reports the codecs, so an unplayable file is known
      // BEFORE the browser has had a chance to choke on it. Switching here
      // replaces the old reactive path — load raw, wait for `on:error` or a
      // 2.5s black-frame watchdog, tear down, reload through ffmpeg — which
      // cost two loads and put an alarming "Codec not supported" banner on
      // screen for what is a routine property of half this catalog.
      lastProbeVerdict = {
        playable: j?.browser_playable !== false,
        video: String(j?.video_codec ?? ''),
        audio: String(j?.audio_codec ?? ''),
      };
      if (j?.browser_playable === false && !codecFallbackUsed && !playNeedsTranscode) {
        dbg('[cinema] probe says not browser-playable:', j.reason, '→ transcoding up front');
        switchToTranscode(j.reason || 'codec not supported', { expected: true });
        return;   // playSrc changed; the reactive will re-probe the new src
      }

      const d = Number(j?.duration_sec);
      if (Number.isFinite(d) && d > 0) {
        probedDurationSec = d;
        // Re-apply: the durationchange event already fired before the
        // probe came back, so push the value through manually.
        if (videoEl) {
          const native = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
          playerDuration = probedDurationSec > 0 ? probedDurationSec : native;
        }
      }
    } catch { /* probe failure is non-fatal — fall back to native duration */ }
  }
  function onPlayState(): void {
    if (!videoEl) return;
    playerIsPlaying = !videoEl.paused && !videoEl.ended;
    showControls();
    // Silent-fail codec detector: when playback actually starts (audio is
    // running, currentTime is advancing) but the video track has 0×0
    // dimensions, the container is being parsed but the video codec
    // isn't being decoded. Brave/Chrome don't fire `error` for this —
    // they just paint a black frame forever. Wait 2.5s of confirmed
    // playback then check. Audio-only files report videoWidth=0 too,
    // but those mount as <audio>, not here.
    if (videoEl && playerIsPlaying && !codecFallbackUsed && !playNeedsTranscode) {
      const startCt = videoEl.currentTime;
      setTimeout(() => {
        const v = videoEl;
        if (!v || codecFallbackUsed || playNeedsTranscode) return;
        const advanced = v.currentTime > startCt + 0.3;       // playback genuinely moved
        const noVideo = v.videoWidth === 0 || v.videoHeight === 0;
        if (advanced && noVideo) {
          fallbackToTranscode('audio plays but video stays 0×0');
        }
      }, 2500);
    }
  }
  function onVolumeChange(): void {
    if (!videoEl) return;
    playerVolume = videoEl.volume;
    playerMuted = videoEl.muted;
  }
  function onRateChange(): void {
    if (!videoEl) return;
    playerRate = videoEl.playbackRate;
  }
  function onFullscreenChange(): void {
    isFullscreen = !!document.fullscreenElement;
  }

  // Auto-hide controls after 2.5s of no mouse activity during playback.
  // Always visible while paused, while settings open, or on hover.
  function showControls(): void {
    controlsVisible = true;
    if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
    controlsHideTimer = setTimeout(() => {
      if (playerIsPlaying) controlsVisible = false;
    }, 2500);
  }

  // Computed CSS for the caption overlay — derived from the user's style
  // settings. Reactivity makes the overlay re-paint instantly when the
  // user drags a slider in the settings popover.
  $: captionInlineStyle = capStyleOf(captionStyle);

  // The fullscreen listener is added in onMount further down so it's
  // properly removed on component teardown (avoids leaks across HMR).
  // Re-run when the track URL changes (sub language switch / generation
  // finishes). The {#key subTrack} block remounts the <video>, which
  // re-fires onloadedmetadata, but if only the source language changes
  // without remount, this catches it.
  /**
   * Cinema's own media wiring. KernlPlayer renders the <video>, so these can no
   * longer be inline attributes — they're attached to the bound element the
   * moment it exists. The codec watchdog and on:error fallback are what let a
   * non-browser-native stream recover, so they must survive the swap.
   */
  let cineMediaEl: HTMLVideoElement | null = null;
  $: if (videoEl && videoEl !== cineMediaEl) {
    cineMediaEl = videoEl;
    videoEl.addEventListener('loadedmetadata', onLoadedMetaWithGuard);
    videoEl.addEventListener('loadstart', armCodecWatchdog);
    videoEl.addEventListener('durationchange', onDurationChange);
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('play', onPlayState);
    videoEl.addEventListener('pause', onPlayState);
    videoEl.addEventListener('ended', onPlayState);
    videoEl.addEventListener('volumechange', onVolumeChange);
    videoEl.addEventListener('ratechange', onRateChange);
    videoEl.addEventListener('error', onVideoError);
    // Startup states, for the preloader below.
    videoEl.addEventListener('loadstart', onStartupLoadStart);
    videoEl.addEventListener('progress', onStartupProgress);
    videoEl.addEventListener('waiting', onStartupWaiting);
    videoEl.addEventListener('stalled', onStartupWaiting);
    videoEl.addEventListener('canplay', onStartupReady);
    videoEl.addEventListener('playing', onStartupReady);
    $subsCtl?.setVideo(videoEl);
  }

  // ── Startup preloader ──────────────────────────────────────────────
  //
  // Opening a film used to be a black rectangle with `0:00 / 0:00` and a
  // static play glyph for several seconds — nothing said whether it was
  // working, stuck, or broken. Long by nature: archive.org is cold-cache
  // slow, and a transcoded source waits on ffmpeg before a single byte of
  // playable video exists.
  //
  // So this reports what is actually happening rather than spinning: the
  // phase, how long it has been going, and the real buffered fraction read
  // off `video.buffered` when the browser knows one.
  type StartupPhase = 'idle' | 'connecting' | 'buffering' | 'ready';
  let startupPhase: StartupPhase = 'idle';
  let startupBufferedFrac = 0;
  let startupElapsedMs = 0;
  let startupTimer: ReturnType<typeof setInterval> | null = null;
  let startupStartedAt = 0;

  function startupTick(): void {
    if (startupTimer) return;
    startupStartedAt = Date.now();
    startupElapsedMs = 0;
    startupTimer = setInterval(() => {
      startupElapsedMs = Date.now() - startupStartedAt;
    }, 100);
  }
  function startupStop(): void {
    if (startupTimer) { clearInterval(startupTimer); startupTimer = null; }
  }
  function onStartupLoadStart(): void {
    startupPhase = 'connecting';
    startupBufferedFrac = 0;
    startupTick();
  }
  function onStartupWaiting(): void {
    if (startupPhase === 'ready') return;   // mid-playback rebuffer: the bar owns it
    startupPhase = 'buffering';
    startupTick();
  }
  function onStartupReady(): void {
    startupPhase = 'ready';
    startupStop();
  }
  function onStartupProgress(): void {
    const v = videoEl;
    if (!v) return;
    if (startupPhase === 'connecting') startupPhase = 'buffering';
    // `duration` is Infinity/NaN on a live transcode, so a fraction is only
    // meaningful once we have a real length — from the element or the probe.
    const total = Number.isFinite(v.duration) && v.duration > 0
      ? v.duration
      : probedDurationSec;
    if (!total || v.buffered.length === 0) return;
    startupBufferedFrac = Math.min(1, v.buffered.end(v.buffered.length - 1) / total);
  }

  /**
   * Visible while the first frame is still out of reach.
   *
   * `idle` counts as busy: there is a gap between the element receiving a src
   * and the browser firing `loadstart`, and leaving it out let the transport
   * bar flash a `0:00 / 0:00` before the preloader took over — the exact
   * frame this is meant to replace.
   */
  $: startupBusy = playOpen && !playLoading && !playError && !!playSrc && startupPhase !== 'ready';
  /** A transcode has no seekable buffer to report — say so instead of faking one. */
  // A conversion DOES know its fraction — bytes downloaded, then seconds
  // encoded — so it gets a real bar rather than the sweeping line reserved
  // for "we genuinely cannot say".
  $: startupIndeterminate = convertBusy
    ? convertFrac <= 0
    : (playNeedsTranscode || startupBufferedFrac <= 0);

  $: if (typeof window !== 'undefined' && trackUrl) {
    setTimeout(enableAllTextTracks, 120);
  }

  // The URL the player should fetch for the currently-applied subtitle
  // config — trackSrc() in subs-pipeline.ts. Recomputed when any of these
  // change; listed explicitly so Svelte picks them up as dependencies.
  $: trackUrl = (() => {
    void $subTrack; void $subEngine; void $subTargetLang; void $subSourceLang;
    void playItem; void playFiles; void playActiveIdx;
    void $transcribeAvailable; void $transcribeEngine; void $transcribeModel;
    void $generateRequested;
    return subs.trackSrc();
  })();
  $: hasSrt = playFiles.some(f => /\.srt$/i.test(f.name));

  // Watchdog for "MP4 plays but black screen" (codec inside the container
  // not browser-supported — common with archive.org rips that use H.265,
  // MPEG4 Part 2, DivX, or pixel formats like yuv422p10le). After
  // loadedmetadata fires we check `videoWidth`; if it's 0, the decoder
  // didn't take. Same goes for `<video on:error>`. Either path triggers
  // an auto-fallback to /api/cinema/media/transcode so ffmpeg re-mux/re-
  // encodes to a profile every browser eats.
  let codecFallbackUsed = false;        // avoid infinite loop
  let codecFallbackHint = '';            // banner message
  let codecFallbackExpected = false;     // probe knew up front → informational, not an error
  let videoLoadWatchdog: ReturnType<typeof setTimeout> | null = null;

  /**
   * Move playback onto the transcoder.
   *
   * `expected: true` means we knew before loading — the probe told us the
   * codec is undecodable — so this is a routine routing decision, not a
   * failure, and it gets a quiet one-line note instead of the red-alert
   * banner. `expected: false` is the old reactive path: the browser already
   * tried and failed, the user watched a black frame, and saying so is
   * warranted.
   */
  // ── Conversion fallback ────────────────────────────────────────────────
  // Reached only when nothing in the item is decodable — pickDefaultPlayIdx
  // takes the h264 derivative whenever one exists, which is most of the time.
  // What happens here is a download-then-convert job, not a live transcode:
  // streaming ffmpeg straight from archive.org runs at 0.0665x realtime
  // because it reopens a TLS connection per seek, so it never finishes. The
  // job fetches once (sequential, ~6x faster), converts off local disk, and
  // leaves a cached file that plays and, unlike the stream, seeks.
  let convertKey = '';
  let convertPhase = '';
  let convertFrac = 0;
  let convertBusy = false;
  let convertError = '';
  let convertPoll: ReturnType<typeof setInterval> | null = null;

  function stopConvertPoll(): void {
    if (convertPoll) { clearInterval(convertPoll); convertPoll = null; }
  }

  /** Human phase label for the overlay. */
  $: convertLabel =
    convertPhase === 'download' ? 'Descargando el original'
    : convertPhase === 'convert' ? 'Convirtiendo para tu navegador'
    : 'Preparando';

  async function startConversion(upstream: string): Promise<void> {
    stopConvertPoll();
    convertBusy = true;
    convertError = '';
    convertFrac = 0;
    convertPhase = 'download';
    try {
      const r = await apiFetch(`/api/cinema/media/convert/start?url=${encodeURIComponent(upstream)}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({} as any));
        convertError = e.error ?? `no se pudo iniciar la conversión (http ${r.status})`;
        convertBusy = false;
        return;
      }
      const job = await r.json();
      convertKey = job?.key ?? '';
      if (!convertKey) { convertError = 'el kernel no devolvió una clave'; convertBusy = false; return; }
      if (job?.status === 'ready') { adoptConverted(); return; }

      convertPoll = setInterval(async () => {
        try {
          // A non-2xx throws into the catch below: a restart answers 5xx briefly.
          const j = await api.getJson(`/api/cinema/media/convert/status?key=${encodeURIComponent(convertKey)}`);
          convertPhase = j?.phase ?? convertPhase;
          convertFrac = typeof j?.frac === 'number' ? j.frac : convertFrac;
          if (j?.status === 'ready') { adoptConverted(); }
          else if (j?.status === 'error') {
            stopConvertPoll();
            convertBusy = false;
            convertError = j?.error || 'la conversión falló';
          } else if (j?.status === 'interrupted') {
            stopConvertPoll();
            convertBusy = false;
            convertError = 'la conversión se cortó porque el kernel se reinició — reintentá';
          }
        } catch { /* keep polling; the job outlives a hiccup */ }
      }, 2000);
    } catch (err: any) {
      convertBusy = false;
      convertError = `no se pudo iniciar la conversión: ${err?.message ?? String(err)}`;
    }
  }

  /** Point the <video> at the finished file. Seekable, cached, local. */
  function adoptConverted(): void {
    stopConvertPoll();
    convertBusy = false;
    convertFrac = 1;
    const origin = (typeof window !== 'undefined' ? window.location.origin : '');
    playSrc = `${origin}/api/cinema/media/convert/file?key=${encodeURIComponent(convertKey)}${authQuery()}`;
    // No longer a forward-only stream, so the scrubber works again.
    playNeedsTranscode = false;
  }

  function switchToTranscode(reason: string, opts?: { expected?: boolean }): void {
    if (codecFallbackUsed) return;
    if (!playItem || !playFiles[playActiveIdx]) return;
    codecFallbackUsed = true;
    const expected = opts?.expected === true;
    codecFallbackHint = expected
      ? `${reason} — preparando una copia reproducible`
      : `Codec not supported (${reason}) — preparando una copia reproducible…`;
    codecFallbackExpected = expected;
    if (expected) dbg('[cinema] converting up front:', reason);
    else console.warn('[cinema] codec fallback:', reason);
    playNeedsTranscode = true;
    void startConversion(archiveDownloadUrl(playItem.identifier, playFiles[playActiveIdx].name));
    // Auto-clear once the job is under way. The expected case is
    // informational, so it goes sooner.
    setTimeout(() => { codecFallbackHint = ''; }, expected ? 3500 : 6000);
  }
  /** Reactive failure path — kept as the backstop for what the probe misses. */
  function fallbackToTranscode(reason: string): void {
    switchToTranscode(reason, { expected: false });
  }

  /**
   * What ffprobe said about the file currently in `playSrc`, or null before
   * the probe lands. `<video>` reports MEDIA_ERR_SRC_NOT_SUPPORTED (code 4)
   * for a failed *request* just as readily as for an undecodable codec, and
   * the old handler called every one of them "Codec not supported". When the
   * probe has already confirmed h264/aac/yuv420p, that message is simply
   * false and sends whoever reads it looking in the wrong place.
   */
  let lastProbeVerdict: { playable: boolean; video: string; audio: string } | null = null;
  function onVideoError(e: Event): void {
    const v0 = e.currentTarget as HTMLVideoElement;
    if (codecFallbackUsed) {
      // Second failure — the transcoder was already the recovery and it did
      // not work either. Say so. Silently returning left the preloader
      // spinning forever with the controls hidden behind it, which is a
      // worse dead end than the black rectangle this all started as.
      const code0 = v0.error?.code;
      console.error('[cinema] playback failed after transcode fallback', { code: code0, src: playSrc });
      playError = playNeedsTranscode
        ? `Playback failed even through the transcoder (media error ${code0 ?? '?'}). Try another file from FILES.`
        : `Playback failed (media error ${code0 ?? '?'}).`;
      startupPhase = 'ready';   // release the preloader so the error is visible
      startupStop();
      return;
    }
    const v = e.currentTarget as HTMLVideoElement;
    const code = v.error?.code;
    const msgs: Record<number, string> = {
      1: 'aborted', 2: 'network', 3: 'decode error', 4: 'src not supported',
    };
    let msg = msgs[code ?? 0] ?? `error ${code}`;
    // Code 4 with a probe that says the codecs are fine means the *fetch*
    // failed, not the decoder. Same recovery (the transcoder is a different
    // endpoint and often just works), honest wording.
    if (code === 4 && lastProbeVerdict?.playable) {
      msg = `could not load the source (${lastProbeVerdict.video || 'unknown'}/${lastProbeVerdict.audio || 'unknown'} decodes fine)`;
    }
    console.warn('[cinema] video error', { code, probe: lastProbeVerdict, src: playSrc });
    fallbackToTranscode(msg);
  }
  // Auto-fallback was checking videoWidth here, but that's premature —
  // some MP4 containers don't expose dimensions until `loadeddata` or
  // `canplay`. Checking at `loadedmetadata` produced false positives on
  // perfectly playable videos (Get Smart, etc). The reliable signal is
  // `<video on:error>` with code 4 ("src not supported"), which Chrome
  // does fire for genuinely-unplayable codecs. For the silent-fail case
  // (renders black with no error event) the user can flip the manual
  // "Force transcode" toggle in settings.
  function onLoadedMetaWithGuard(): void {
    if (videoLoadWatchdog) { clearTimeout(videoLoadWatchdog); videoLoadWatchdog = null; }
    onDurationChange();
    enableAllTextTracks();
    subs.maybeLoadTranscript();
  }
  // No watchdog — early versions checked `currentTime === 0` after 10s
  // which fired for any paused / autoplay-blocked video (false positive,
  // surfaced as a misleading "Codec not supported" banner on perfectly-
  // playable MP4s). The real codec failure paths are:
  //   1. `<video on:error>` with error.code === 4 (src not supported)
  //   2. `loadedmetadata` reports videoWidth === 0 (decoder init failed)
  // Both are checked above; nothing else needed.
  function armCodecWatchdog(): void { /* kept as no-op for binding compat */ }

  async function openPlayer(item: ArchiveItem) {
    playItem = item;
    playOpen = true;
    playLoading = true;
    playError = '';
    // Cleared immediately so the previous film's row never shows under the
    // new one, then refilled in the background — the strip is a nicety and
    // must never hold up playback.
    similarItems = [];
    loadSimilar(item.identifier);
    playFiles = [];
    playActiveIdx = 0;
    playSrc = '';
    codecFallbackUsed = false;
    codecFallbackHint = '';
    codecFallbackExpected = false;
    lastProbeVerdict = null;
    startupPhase = 'idle';
    startupBufferedFrac = 0;
    startupStop();
    subs.resetForOpen();              // a run from the previous video must not leak into this one
    try {
      const body = await api.getJson(`/api/cinema/media/import-archive/files?id=${encodeURIComponent(item.identifier)}`);
      const all = (body.files ?? []) as Omit<PlayFile, 'kind'>[];
      // Show videos / audio / images / text in the modal — skip raw archive
      // metadata blobs (xml manifests etc are noisy, but keep .srt/.vtt).
      playFiles = all
        .map(f => ({ ...f, kind: fileKind(f.name) }))
        .filter(f => ['video', 'audio', 'image', 'text'].includes(f.kind))
        // Hide archive.org's internal _meta.xml / _files.xml junk.
        .filter(f => !/_(meta|files|reviews)\.xml$/i.test(f.name))
        // Sort: video > audio > image > text, and within each kind largest
        // first so the most relevant file (the actual movie) is at the top.
        .sort((a, b) => {
          const ka = KIND_ORDER[a.kind] ?? 9;
          const kb = KIND_ORDER[b.kind] ?? 9;
          if (ka !== kb) return ka - kb;
          return (b.size ?? 0) - (a.size ?? 0);
        });
      if (!playFiles.length) {
        playError = 'no playable files in this item.';
        return;
      }
      playActiveIdx = pickDefaultPlayIdx(playFiles);
      const built = buildPlayUrl(item, playFiles[playActiveIdx]);
      playSrc = built.src;
      playNeedsTranscode = built.needsTranscode;

      // Captions this film already has: shipped, cached, or downloaded from
      // the federated index — see recoverOnOpen() in subs-pipeline.ts.
      await subs.recoverOnOpen();
    } catch (err: any) {
      playError = err?.message ?? String(err);
    } finally {
      // CRITICAL: flip playLoading BEFORE the transcript-load attempt so the
      // {#if playLoading} guard releases and the <video> actually mounts.
      // Without this, videoEl stays null and the manual track loader can't
      // run.
      playLoading = false;
    }
    // Now the video block has rendered. tick() flushes the DOM so videoEl
    // is set, then we trigger the transcript fetch + addTextTrack injection.
    await tick();
    subs.maybeLoadTranscript();
  }
  function selectPlayFile(idx: number) {
    if (!playItem || !playFiles[idx]) return;
    playActiveIdx = idx;
    codecFallbackUsed = false;
    codecFallbackHint = '';
    codecFallbackExpected = false;
    lastProbeVerdict = null;
    startupPhase = 'idle';
    startupBufferedFrac = 0;
    startupStop();
    subs.resetForFile();              // a run from the previous video must not leak into this one
    const built = buildPlayUrl(playItem, playFiles[idx]);
    playSrc = built.src;
    playNeedsTranscode = built.needsTranscode;
  }
  function closePlayer() {
    // Stop watching a conversion, but leave it running: it is server-side
    // work whose result is cached, so reopening the title later is instant
    // instead of starting the whole download again.
    stopConvertPoll();
    convertBusy = false;
    convertError = '';
    convertFrac = 0;
    convertPhase = '';
    convertKey = '';
    playOpen = false;
    playItem = null;
    playFiles = [];
    playSrc = '';
    playError = '';
    descOpen = false;
    probedDurationSec = 0;
    probedDurationToken++;            // cancel any in-flight probe
    filesOpen = false;
    startupPhase = 'idle';
    startupStop();                    // don't leave a 100ms interval running
    subs.resetOnClose();              // closing mid-translation must not poison the next film
  }
  function onPlayerKeydown(e: KeyboardEvent) {
    if (!playOpen) return;
    if (e.key === 'Escape') {
      // One Esc, one meaning: close the player. There used to be a
      // settings popover that swallowed the first press.
      closePlayer();
      return;
    }
    // Skip if user is typing in an input (search box, etc).
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    // Player keyboard shortcuts (only for video, not search results).
    const v = videoEl;
    if (!v) return;
    // KernlPlayer binds its own window-level shortcuts for play/pause (k,
    // space), mute (m), fullscreen (f), captions (c) and ±5s (arrows). Handling
    // them here as well fired BOTH handlers on one keypress, so every toggle
    // cancelled itself out and the arrows seeked twice. Only the keys the
    // shared player does not own stay here.
    switch (e.key.toLowerCase()) {
      case 'j': seek((v.currentTime || 0) - 10); break;
      case 'l': seek((v.currentTime || 0) + 10); break;
    }
  }

  let observer: IntersectionObserver | null = null;
  onMount(async () => {
    // Whether the filters panel was left open last visit. Read before the
    // first paint so the panel does not slide open a frame after the header.
    try { filtersOpen = localStorage.getItem(FILTERS_OPEN_KEY) === '1'; } catch { /* private mode */ }
    // Similar-titles strip defaults to open; only an explicit '0' folds it.
    try { similarOpen = localStorage.getItem(SIMILAR_OPEN_KEY) !== '0'; } catch { /* private mode */ }
    // Hot-render from localStorage (instant) then reconcile with server.
    watchlist = loadLocalWatchlist();
    syncWatchlistFromServer();
    loadTopTags();
    loadCanonRails();
    refreshEmbedStatus();
    runSearch();
    subs.loadSubInfo();
    subs.loadTranscribeInfo();
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onPlayerKeydown);
      document.addEventListener('fullscreenchange', onFullscreenChange);
    }

    // Deep-link: /cinema?identifier=X auto-opens the player for that
    // archive.org id. Used by /social directory modal items, magnet
    // previews and any future "open in /cinema" links across the app.
    if (typeof window !== 'undefined') {
      const qs = new URLSearchParams(window.location.search);
      const deep = qs.get('identifier');
      if (deep) {
        try {
          // Fetch the title row from our local catalog so the player
          // gets full metadata (description, year, subjects). Falls back
          // to a stub if the row isn't ingested yet — the player only
          // strictly needs `identifier` + `title` to start.
          const r = await apiFetch(`/api/cinema/title/${encodeURIComponent(deep)}`);
          let item: ArchiveItem;
          if (r.ok) {
            const body = await r.json();
            item = body.title as ArchiveItem;
          } else {
            item = { identifier: deep, title: deep } as ArchiveItem;
          }
          // Strip the query string so a manual reload doesn't re-fire.
          history.replaceState({}, '', window.location.pathname);
          openPlayer(item);
        } catch {
          openPlayer({ identifier: deep, title: deep } as ArchiveItem);
        }
      }
    }

    // Infinite scroll: observe a sentinel after the grid; when ≥10% visible,
    // pull the next page. Skips watchlist mode (local items, no fetch).
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) loadMore();
        }
      }, { rootMargin: '300px 0px', threshold: 0 });
    }
  });

  // Teardown lives here, not in onMount's return: an async onMount returns a
  // promise, so Svelte never ran that cleanup — the key and fullscreen
  // listeners outlived the page and the subtitle controller was never
  // destroyed.
  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', onPlayerKeydown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    }
    observer?.disconnect();
    if (controlsHideTimer) clearTimeout(controlsHideTimer);
    $subsCtl?.destroy();
  });

  // Re-attach observer when sentinel mounts/unmounts (it disappears in
  // watchlist mode and reappears in search mode).
  $: if (observer && sentinelEl) {
    observer.disconnect();
    observer.observe(sentinelEl);
  }

  // Removed in Stage 7: the explicit "semantic" toggle. The /titles
  // endpoint now runs hybrid search (FTS5 + bge-m3 + RRF) by default
  // when the user types a query, and falls back to plain listing when
  // the input is empty. One input box, no modes.
  // Kept these vars (always falsey) so old conditional paths in this
  // file compile cleanly while we strip the flag completely.
  const semanticMode = false;
  const lastSearchWasSemantic = false;
  let semanticHint = '';
  void lastSearchWasSemantic;

  async function fetchPage(targetPage: number): Promise<ArchiveItem[]> {
    const params = new URLSearchParams();
    if (collection) params.set('collection', collection);
    if (query.trim()) params.set('q', query.trim());
    if (yearMin) params.set('year_min', String(yearMin));
    if (yearMax) params.set('year_max', String(yearMax));
    if (activeTags.length === 1) {
      params.set('tag', activeTags[0]);
    } else if (activeTags.length > 1) {
      params.set('tags', activeTags.join(','));
      params.set('tags_match', tagsMatch);
    }
    if (langFilter) params.set('language', langFilter);
    if (kindFilter) params.set('kind', kindFilter);
    if (identifiedOnly) params.set('identified_only', '1');
    if (collapseWorks) params.set('collapse', '1');
    if (minMinutes > 0) params.set('min_minutes', String(minMinutes));
    if (playableOnly) params.set('playable_only', '1');
    if (subsOnly) params.set('has_subtitles', '1');
    if (activeRail) params.set('canon_list', activeRail);
    params.set('limit', String(rows));
    params.set('offset', String((targetPage - 1) * rows));
    params.set('sort', sortMode);
    const body = await api.getJson(`/api/cinema/titles?${params.toString()}`);
    return body.items ?? [];
  }

  // Reset + fetch first page. Single path now — the /titles endpoint
  // runs hybrid (FTS5+semantic+RRF) when there's a query, classic
  // listing when there isn't. Filters always layer on top.
  /**
   * Pull `#tag` tokens out of the search box and turn them into real tag
   * filters. This is what makes the long tail reachable: the catalogue holds
   * ~136k tags and the row outside can show twelve, so anything else used to
   * need the autocomplete popover. Typing `#film-noir` now does it directly,
   * and the tag shows up in the "Showing" row like any other filter.
   *
   * Hyphens and underscores become spaces so `#cine-argentino` finds the tag
   * actually stored as "cine argentino".
   */
  const TAG_TOKEN = /#[\p{L}\p{N}_-]+/gu;
  function absorbTagTokens(): void {
    const found = query.match(TAG_TOKEN);
    if (!found) return;
    for (const token of found) {
      const norm = token.slice(1).toLowerCase().replace(/[-_]+/g, ' ').trim();
      if (norm && !activeTags.includes(norm)) activeTags = [...activeTags, norm];
    }
    query = query.replace(TAG_TOKEN, ' ').replace(/\s+/g, ' ').trim();
  }

  async function runSearch() {
    absorbTagTokens();
    busy = true;
    lastError = '';
    semanticHint = '';
    items = [];
    page = 1;
    hasMore = true;
    try {
      const got = await fetchPage(1);
      items = got;
      hasMore = got.length >= rows;
    } catch (err: any) {
      lastError = err?.message ?? String(err);
    } finally {
      busy = false;
    }
  }

  // Append next page — wired to the IntersectionObserver sentinel.
  // Pagination always works now (no separate "semantic mode" cap).
  async function loadMore() {
    if (loadingMore || busy || !hasMore || viewWatchlist) return;
    loadingMore = true;
    try {
      const next = page + 1;
      const got = await fetchPage(next);
      if (got.length === 0) {
        hasMore = false;
      } else {
        // Dedupe by identifier in case archive.org serves the same row twice.
        const seen = new Set(items.map(i => i.identifier));
        items = [...items, ...got.filter(g => !seen.has(g.identifier))];
        page = next;
        if (got.length < rows) hasMore = false;
      }
    } catch (err: any) {
      lastError = err?.message ?? String(err);
      // Don't immediately retry on the same scroll position — the user
      // can retry by scrolling away and back.
      hasMore = false;
    } finally {
      loadingMore = false;
    }
  }

  function clearAllFilters() {
    collection = '';
    activeTags = [];
    tagsMatch = 'all';
    langFilter = '';
    yearMin = null;
    yearMax = null;
    query = '';
    sortMode = 'downloads';
    viewWatchlist = false;
    // These four were missing, which is why "clear" used to leave the grid
    // filtered: the rail, the kind, the duration floor and the three content
    // toggles all survived a clear-all and there was nothing on screen saying
    // so. Reset to the same defaults the page starts at — collapseWorks is the
    // only one whose default is on.
    activeRail = '';
    kindFilter = '';
    minMinutes = 0;
    playableOnly = false;
    subsOnly = false;
    identifiedOnly = false;
    collapseWorks = true;
    forYouMode = false;
    forYouReason = '';
    page = 1;
    runSearch();
  }

  // ── Active filters, as one readable row ──────────────────────
  // The single largest usability hole this page had: seven controls plus a tag
  // row plus a rail could all be narrowing the grid at once, and nothing said
  // which. Reading the state meant reading every control. This turns the whole
  // filter state into one sentence of removable chips.

  /** Human label for a duration floor, e.g. "60 min or more". */
  function durationLabel(tr: (k: string, p?: Record<string, string | number>) => string, mins: number): string {
    return tr('active.duration', { n: mins });
  }

  // Referenced top-level state is tracked by Svelte, so this rebuilds whenever
  // any filter changes — including a locale switch, via $t.
  $: activeChips = ((): ActiveChip[] => {
    const tr = $t;
    const out: ActiveChip[] = [];
    if (query.trim()) {
      out.push({ id: 'q', label: tr('active.query', { q: query.trim() }), tone: 'query', act: 'query' });
    }
    if (activeRail) {
      const rail = canonRails.find((r) => r.key === activeRail);
      out.push({ id: 'rail', label: tr('active.rail', { x: rail?.label ?? activeRail }), tone: 'rail', act: 'rail' });
    }
    for (const tag of activeTags) {
      const meta = topTags.find((x) => x.tag_norm === tag);
      out.push({ id: 'tag:' + tag, label: meta?.tag_display ?? tag, tone: 'tag', act: 'tag', value: tag });
    }
    if (yearMin && yearMax) {
      out.push({ id: 'year', label: tr('active.year.between', { a: yearMin, b: yearMax }), tone: 'filter', act: 'year' });
    } else if (yearMin) {
      out.push({ id: 'year', label: tr('active.year.from', { a: yearMin }), tone: 'filter', act: 'year' });
    } else if (yearMax) {
      out.push({ id: 'year', label: tr('active.year.to', { b: yearMax }), tone: 'filter', act: 'year' });
    }
    if (langFilter) {
      out.push({ id: 'lang', label: languageName(langFilter, $uiLocale), tone: 'filter', act: 'lang' });
    }
    if (kindFilter) {
      out.push({ id: 'kind', label: tr('active.kind.' + kindFilter), tone: 'filter', act: 'kind' });
    }
    if (minMinutes > 0) {
      out.push({ id: 'dur', label: durationLabel(tr, minMinutes), tone: 'filter', act: 'duration' });
    }
    if (playableOnly) out.push({ id: 'playable', label: tr('active.playable'), tone: 'filter', act: 'playable' });
    if (subsOnly) out.push({ id: 'subs', label: tr('active.subs'), tone: 'filter', act: 'subs' });
    if (identifiedOnly) out.push({ id: 'identified', label: tr('active.identified'), tone: 'filter', act: 'identified' });
    // Only surfaced when it is NOT the default. Grouping is on out of the box,
    // and a chip that is always present is not information.
    if (!collapseWorks) out.push({ id: 'collapse', label: tr('active.ungrouped'), tone: 'filter', act: 'collapse' });
    if (sortMode !== 'downloads') {
      out.push({ id: 'sort', label: tr('filters.sort.' + sortMode), tone: 'filter', act: 'sort' });
    }
    return out;
  })();

  /**
   * Count of filters living in the panel — what the "Filters" button badges.
   * Tags and rails are excluded: they have their own visible rows, so counting
   * them here would double-report them.
   */
  $: panelFilterCount =
    (yearMin ? 1 : 0) +
    (yearMax ? 1 : 0) +
    (langFilter ? 1 : 0) +
    (kindFilter ? 1 : 0) +
    (minMinutes > 0 ? 1 : 0) +
    (sortMode !== 'downloads' ? 1 : 0) +
    (collapseWorks ? 0 : 1) +
    (playableOnly ? 1 : 0) +
    (subsOnly ? 1 : 0) +
    (identifiedOnly ? 1 : 0);

  /**
   * Undo one chip. A dispatcher rather than a closure carried on each chip:
   * closures built inside the reactive block would be assigning to the very
   * state that block reads, which Svelte rejects as a cyclical dependency.
   */
  function removeActive(chip: ActiveChip): void {
    switch (chip.act) {
      case 'query': query = ''; break;
      case 'tag': activeTags = activeTags.filter((x) => x !== chip.value); break;
      case 'rail': activeRail = ''; break;
      case 'year': yearMin = null; yearMax = null; break;
      case 'lang': langFilter = ''; break;
      case 'kind': kindFilter = ''; break;
      case 'duration': minMinutes = 0; break;
      case 'playable': playableOnly = false; break;
      case 'subs': subsOnly = false; break;
      case 'identified': identifiedOnly = false; break;
      case 'collapse': collapseWorks = true; break;
      case 'sort': sortMode = 'downloads'; break;
    }
    page = 1;
    // "for you" is a ranked one-shot set, not a query — leaving it on while the
    // user edits filters would show a grid that ignores the edit.
    if (forYouMode) { forYouMode = false; forYouReason = ''; }
    runSearch();
  }

  // toggleSemanticMode kept as a no-op for any leftover references —
  // safe to remove later once we audit. Hybrid search is now the only
  // path for non-empty queries.
  function toggleSemanticMode() { runSearch(); }
</script>

<svelte:head><title>cinema — Kernl</title></svelte:head>

<div class="page" bind:this={scrollEl} on:scroll={onPageScroll}>
  <HeaderChrome
    {t} {uiLocale}
    bind:query bind:yearMin bind:yearMax bind:langFilter bind:kindFilter bind:sortMode
    bind:minMinutes bind:collapseWorks bind:playableOnly bind:subsOnly bind:identifiedOnly
    bind:viewWatchlist bind:embedPanelOpen bind:tagSearchQuery bind:tagSearchOpen
    {condensed} {filtersOpen} {tagPanelOpen} {watchlist} {busy} {items} {embedSnap}
    {panelFilterCount} {activeChips} {activeTags} {tagsMatch} {semanticMode}
    {forYouMode} {forYouReason} {forYouProfileSize} {canonRails} {activeRail} {topTags}
    {tagSearchHits} {tagSearchBusy}
    {runSearch} {toggleFilters} {removeActive} {toggleTagsMatch} {clearAllFilters}
    {toggleForYou} {toggleRail} {pickTag} {openTagPanel} {closeTagPanel}
    {onTagSearchInput} {closeTagSearchSoon} {pickTagFromSearch} {refreshEmbedStatus}
  />

  <!-- ── EMBED ADMIN PANEL ────────────────────────────────────── -->
  {#if embedPanelOpen && embedSnap}
    <section class="embed-panel">
      <div class="embed-row-top">
        <strong>Embeddings</strong>
        <span class="dim mini">
          {embedSnap.embedded.toLocaleString()} / {embedSnap.total_titles.toLocaleString()} indexadas ·
          {embedSnap.model || 'sin modelo'} · {embedSnap.dim}d
        </span>
        <span class="spacer" />
        <button class="ghost sm" on:click={() => embedPanelOpen = false}>×</button>
      </div>
      <div class="embed-progress" class:active={embedSnap.status === 'running'}>
        <div
          class="embed-progress-bar"
          style="width: {embedSnap.total_titles > 0 ? (embedSnap.embedded / embedSnap.total_titles * 100).toFixed(1) : 0}%"
        ></div>
        {#if embedSnap.status === 'running'}
          <div class="embed-progress-shimmer"></div>
        {/if}
      </div>
      <div class="embed-row-bottom">
        <span class="embed-status status-{embedSnap.status}">
          {#if embedSnap.status === 'running'}🟢 running
          {:else if embedSnap.status === 'stopping'}🟡 stopping
          {:else if embedSnap.status === 'done'}✓ completo
          {:else if embedSnap.status === 'failed'}✗ error
          {:else if embedSnap.status === 'stopped'}⏸ detenido
          {:else}○ idle{/if}
        </span>
        {#if embedSnap.pending > 0}
          <span class="dim mini">pending: {embedSnap.pending.toLocaleString()}</span>
        {/if}
        {#if embedSnap.status === 'running'}
          <span class="dim mini">{embedSnap.rate.toFixed(1)} emb/s · ETA {fmtEta(embedSnap.eta_seconds)}</span>
        {/if}
        {#if embedSnap.error}
          <span class="err mini">{embedSnap.error.slice(0, 100)}</span>
        {/if}
        <span class="spacer" />
        {#if embedSnap.status === 'running' || embedSnap.status === 'stopping'}
          <button class="ghost sm" disabled={embedSnap.status === 'stopping'} on:click={stopEmbed}>
            {embedSnap.status === 'stopping' ? '…' : 'detener'}
          </button>
        {:else if embedSnap.pending > 0}
          <button class="primary sm" on:click={startEmbed}>
            embed {embedSnap.pending.toLocaleString()} pending
          </button>
        {:else}
          <span class="dim mini">catalog up to date</span>
        {/if}
      </div>
    </section>
  {/if}

  {#if lastError}
    <div class="err">⚠ {lastError}</div>
  {/if}
  {#if semanticHint && !lastError}
    <div class="hint">💡 {semanticHint}</div>
  {/if}

  <!-- ── POSTER GRID ─────────────────────────────────────────── -->
  <PosterGrid
    {shownItems} {canonRails} {busy} {lastError} {viewWatchlist} {isSaved}
    {openPlayer} {toggleWatch} {openDirPicker} {openInfo}
  />

  {#if !viewWatchlist}
    <div class="sentinel" bind:this={sentinelEl}>
      {#if loadingMore}
        <span class="dim mini">▮ loading more…</span>
      {:else if !hasMore && items.length > 0}
        <span class="dim mini">— end of results —</span>
      {/if}
    </div>
  {/if}

  <!-- ── PLAYER MODAL ─────────────────────────────────────── -->
  <PlayerModal
    {t} {subs}
    {playOpen} {playItem} {playFiles} {playActiveIdx} {playLoading} {playError} {playSrc}
    {playNeedsTranscode}
    bind:descOpen bind:filesOpen bind:controlsVisible bind:videoEl
    {isFullscreen} {playerIsPlaying} {trackUrl}
    {startupBusy} {startupPhase} {startupIndeterminate} {startupBufferedFrac} {startupElapsedMs}
    {convertBusy} {convertLabel} {convertFrac} {convertError}
    {codecFallbackHint} {codecFallbackExpected}
    {similarItems} {similarOpen}
    {closePlayer} {selectPlayFile} {showControls} {toggleSimilar} {openPlayer}
  />

  <!-- ── FILM SHEET ─────────────────────────────────────────── -->
  <FilmSheet bind:this={filmSheet} {api} {openPlayer} {openDirPicker} />

  <!-- ── SAVE TO A DIRECTORY ───────────────────────────────── -->
  <SaveToDirectory bind:this={dirDialog} {apiFetch} {api} />
</div>


<style>
  :global(body) { background: #050807; }

  /* ── Bridge to the dashboard's design tokens ──────────────────────
     This page was written against variable names that exist nowhere:
     --amber (175 uses), --green-dim (58), --cyan (57), --bg-1/--bg-2 (11).
     None of them are defined in app.css, so every one of those ~330
     references silently fell through to the hardcoded hex in its var()
     fallback. The page was not participating in the design system at all —
     it ran on 330 loose constants, which is why its green (#33ff77) and the
     system's (#3DD68C) were two different greens nobody had compared, and
     why the theme switcher could not touch it.

     Rather than rewrite 330 call sites, the invented names are declared here
     ONCE as aliases of the real tokens. Every existing reference now resolves
     through the system, the theme reaches this page, and there is a single
     place that states what cinema's "amber" actually is.

     Declared on .page rather than :root so the aliases stay scoped to this
     extension instead of leaking into every other page. */
  .page {
    --amber: var(--gold);
    --green-dim: var(--text-3);
    --cyan: var(--teal);
    --bg-1: var(--surface-1);
    --bg-2: var(--surface-2);
    --line: var(--border);
    --dim-fg: var(--text-2);

    padding: 0 0 60px;
    color: var(--text-1);
    /* Body copy in the body font. Monospace everywhere was why long
       descriptions and creator names read as terminal output rather than
       as text; it is kept below for the places where it earns its keep —
       counts, durations, identifiers. */
    font-family: var(--font-body);
    background:
      radial-gradient(circle at top right, color-mix(in srgb, var(--green) 5%, transparent), transparent 40%),
      radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--gold) 4%, transparent), transparent 50%),
      var(--bg);
    /* full-bleed parent (.main-inner) is a flex column with overflow:hidden,
       so this element must own its own scroll container — otherwise the
       grid grows past the viewport and gets clipped with no scrollbar. */
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .spacer { flex: 1; }

  /* ─── BUTTONS ────────────────────────────────────────────── */
  /* What makes a control look built rather than declared, in four layers:
     a fill with a slight vertical gradient so it has a light source; a 1px
     inset highlight along the top edge (the inset shadow below) so it reads
     as a raised surface; a drop shadow beneath it; and a press state that
     actually moves. None of this is decoration — it is the difference
     between a rectangle with a border and something that looks pressable. */
  button.primary {
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--green) 22%, transparent),
        color-mix(in srgb, var(--green) 11%, transparent)
      );
    border: 1px solid color-mix(in srgb, var(--green) 55%, transparent);
    color: var(--green);
    padding: 0 16px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    letter-spacing: 0.01em;
    height: 32px;
    box-sizing: border-box;
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--green) 30%, transparent),
      0 1px 2px rgba(0, 0, 0, 0.5);
    transition: background 0.15s, box-shadow 0.15s, transform 0.08s, border-color 0.15s;
  }
  /* Pressing moves the control and pulls its shadow in. A button that does
     not react to being pressed feels broken even when it works. */
  button.primary:active:not(:disabled) {
    transform: translateY(1px);
    box-shadow:
      inset 0 1px 3px rgba(0, 0, 0, 0.45),
      0 0 0 rgba(0, 0, 0, 0);
  }
  button.primary:focus-visible {
    outline: 2px solid var(--gold);
    outline-offset: 2px;
  }
  button.primary:hover:not(:disabled) {
    background: var(--green);
    border-color: var(--green);
    color: var(--bg);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.25),
      0 2px 10px color-mix(in srgb, var(--green) 35%, transparent);
  }
  button.primary:disabled { opacity: 0.3; cursor: not-allowed; }
  button.ghost {
    background: transparent;
    border: 1px solid var(--line, #1d3a26);
    color: var(--green-dim, #4d8a5a);
    padding: 5px 10px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    border-radius: var(--radius-sm);
    text-transform: lowercase;
  }
  button.ghost:hover:not(:disabled) { color: var(--green, #33ff77); border-color: var(--green-dim, #4d8a5a); }
  button.ghost.sm { padding: 3px 8px; }
  button.ghost:disabled { opacity: 0.3; cursor: not-allowed; }

  .err {
    margin: 12px 32px;
    padding: 8px 14px;
    border: 1px solid var(--red, #f55);
    color: var(--red, #f55);
    background: rgba(255, 60, 60, 0.06);
    border-radius: var(--radius-sm);
  }
  .hint {
    margin: 12px 32px;
    padding: 8px 14px;
    border: 1px dashed var(--dim-fg, #6a7a6a);
    color: var(--dim-fg, #99a);
    background: rgba(255, 255, 255, 0.02);
    border-radius: var(--radius-sm);
    font-size: 0.92em;
  }
  .embed-panel {
    margin: 0 32px 12px;
    padding: 12px 16px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 176, 0, 0.25);
    border-radius: var(--radius-sm);
  }
  .embed-row-top {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
    font-size: 13px;
  }
  .embed-row-top .spacer { flex: 1; }
  .embed-progress {
    position: relative;
    height: 7px;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 176, 0, 0.25);
    overflow: hidden;
    margin-bottom: 10px;
  }
  .embed-progress-bar {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, rgba(255, 176, 0, 0.85), #ffd76b);
    transition: width 280ms ease-out;
    box-shadow: 0 0 10px rgba(255, 176, 0, 0.65);
  }
  .embed-progress.active .embed-progress-bar {
    background: linear-gradient(90deg, var(--cyan, #4dd0e1), #88e8f5);
    box-shadow: 0 0 12px rgba(77, 208, 225, 0.55);
  }
  .embed-progress-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, transparent 0%, rgba(255, 255, 255, 0.22) 50%, transparent 100%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
    pointer-events: none;
  }
  .embed-row-bottom {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 12px;
  }
  .embed-row-bottom .spacer { flex: 1; }
  .embed-status { font-weight: 600; }
  .status-running { color: var(--cyan, #4dd0e1); }
  .status-done    { color: var(--green, #4d8); }
  .status-failed  { color: var(--red, #f55); }
  .status-stopped { color: var(--amber, #ffb000); }
  .status-stopping { color: var(--amber, #ffb000); }
  .status-idle    { color: var(--dim-fg, #888); }
  .err.mini { font-size: 11px; padding: 2px 8px; margin: 0; }
  .primary.sm, .ghost.sm {
    padding: 4px 10px;
    font-size: 12px;
  }
  .card.on {
    border-color: var(--amber, #ffb000);
    box-shadow: 0 0 0 2px var(--amber, #ffb000), 0 6px 20px rgba(0, 0, 0, 0.7);
  }
  .card.on:hover { transform: scale(1.04) translateY(-2px); }

  .chip-sep {
    width: 1px;
    height: 18px;
    background: var(--line, #1d3a26);
    align-self: center;
    margin: 0 4px;
  }
  .chip-star.on {
    background: rgba(255, 176, 0, 0.14);
    border-color: var(--amber, #ffb000);
    color: var(--amber, #ffb000);
    text-shadow: 0 0 8px rgba(255, 176, 0, 0.6);
  }
  @keyframes shimmer {
    from { background-position: -100% 0; }
    to   { background-position:  100% 0; }
  }

  .sentinel {
    padding: 30px 20px 50px;
    text-align: center;
    min-height: 60px;
  }
  .sentinel .dim { color: var(--green-dim, #4d8a5a); }

  .dim { color: var(--green-dim, #4d8a5a); }
  .mini { font-size: 11px; }

  /* ─── RESPONSIVE ─────────────────────────────────────────── */
  @media (max-width: 700px) {
    .hero, .filters { padding-left: 14px; padding-right: 14px; }
  }
</style>
